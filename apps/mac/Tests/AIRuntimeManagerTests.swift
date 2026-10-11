import Foundation
import XCTest
@testable import TermRelay

final class AIRuntimeManagerTests: XCTestCase {
    func testOneShotReturnsOnlyFinalAnswerAndDeduplicatesExecution() async throws {
        let f = await fixture(lifecycle:"oneShot")
        await f.manager.handle(type:"ai.session.create",payload:try payload(f.create))
        await f.manager.handle(type:"ai.session.create",payload:try payload(f.create))
        let count = await f.runtime.turns.count
        XCTAssertEqual(count,1)
        await f.runtime.complete(text:"{\"answer\":\"final\"}")
        try await Task.sleep(for:.milliseconds(50))
        let updates = await f.sink.updates
        XCTAssertEqual(updates.first(where:{$0.status == "succeeded"})?.text,"{\"answer\":\"final\"}")
        let stopped = await f.runtime.stopCount
        XCTAssertEqual(stopped,1)
        await f.manager.handle(type:"ai.session.create",payload:try payload(f.create))
        let after = await f.runtime.turns.count
        XCTAssertEqual(after,1)
        await f.manager.disconnected()
    }

    func testLongConversationReusesRuntimeAndDisconnectClosesIt() async throws {
        let f = await fixture(lifecycle:"longLived")
        await f.manager.handle(type:"ai.session.create",payload:try payload(f.create))
        for snapshot in ["first","second"] {
            let turn = AiTurn(id:UUID().uuidString.lowercased(),sessionId:f.create.id,input:AiInput(facts:["snapshot":.string(snapshot)]),output:AiOutput(kind:"text"),deadlineAt:deadline())
            await f.manager.handle(type:"ai.turn.start",payload:try payload(turn))
            await f.manager.handle(type:"ai.turn.start",payload:try payload(turn))
            await f.runtime.complete(text:snapshot)
            try await Task.sleep(for:.milliseconds(50))
        }
        let turns = await f.runtime.turns
        XCTAssertEqual(turns.count,2)
        XCTAssertTrue(turns[0].contains("first")); XCTAssertTrue(turns[1].contains("second"))
        let before = await f.runtime.stopCount
        XCTAssertEqual(before,0)
        let result = await f.manager.action(sessionID:UUID(uuidString:f.create.id)!,action:.startTurn(TurnInput(text:"UI injection"),idempotencyKey:UUID()))
        XCTAssertFalse(result.succeeded)
        await f.manager.disconnected()
        let after = await f.runtime.stopCount
        XCTAssertEqual(after,1)
    }

    func testRejectedTurnReportsParentConversationAndTurnIDs() async throws {
        let f = await fixture(lifecycle:"longLived")
        await f.manager.handle(type:"ai.session.create",payload:try payload(f.create))
        let turn = AiTurn(id:UUID().uuidString.lowercased(),sessionId:f.create.id,input:AiInput(instructions:"expired"),output:AiOutput(kind:"text"),deadlineAt:"1970-01-01T00:00:00Z")
        await f.manager.handle(type:"ai.turn.start",payload:try payload(turn))
        let updates = await f.sink.updates
        XCTAssertTrue(updates.contains(where:{$0.id == f.create.id && $0.turnId == turn.id && $0.status == "failed"}))
    }

    func testFactsOnlySandboxDeniesForkExecAndWorkspaceWritesWhenExplicitlyEnabled() throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_AI_SANDBOX_PROBE"] == "1" else { throw XCTSkip("Opt-in OS sandbox probe; no model requests") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("termrelay-sandbox-test-\(UUID())")
        let state = root.appendingPathComponent("state")
        let workspace = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true)
        try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        let shell = URL(fileURLWithPath:"/bin/bash")
        let profile = try AIRuntimeSandbox(stateDirectory:state).profile(executable:shell)
        for command in ["echo modified > '\(workspace.path)/forbidden'", "/usr/bin/touch '\(state.path)/child'"] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath:"/usr/bin/sandbox-exec")
            process.arguments = ["-p",profile,shell.path,"-c",command]
            process.standardError = Pipe(); process.standardOutput = Pipe()
            try process.run(); process.waitUntilExit()
            XCTAssertNotEqual(process.terminationStatus,0)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath:workspace.appendingPathComponent("forbidden").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath:state.appendingPathComponent("child").path))
        let allowed = Process()
        allowed.executableURL = URL(fileURLWithPath:"/usr/bin/sandbox-exec")
        allowed.arguments = ["-p",profile,shell.path,"-c","echo provider > '\(state.path)/allowed'"]
        try allowed.run(); allowed.waitUntilExit()
        XCTAssertEqual(allowed.terminationStatus,0)
    }

    func testRealFactsOnlyCodexStartsWithoutModelRequestWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_AI_SANDBOX_PROBE"] == "1" else { throw XCTSkip("Opt-in sandboxed Codex startup; no model requests") }
        let installation = try await CodexStructuredAdapter().detect()
        guard let binary = AIRuntimeSandbox.nativeCodex(installation.executableURL) else { throw XCTSkip("Native Codex not installed") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("termrelay-ai-startup-\(UUID())")
        let state = root.appendingPathComponent("state")
        let workspace = root.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at:state,withIntermediateDirectories:true)
        try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:true)
        defer { try? FileManager.default.removeItem(at:root) }
        var environment = TerminalEnvironment.make(executableURL:binary)
        environment["CODEX_HOME"] = state.path
        environment["TMPDIR"] = state.path
        let id = UUID()
        let adapter = CodexStructuredAdapter(configuredExecutableURL:binary,aiSandbox:AIRuntimeSandbox(stateDirectory:state))
        let runtime = try await adapter.makeRuntime(configuration:AgentLaunchConfiguration(sessionID:id,workspaceURL:workspace,environment:environment))
        let coordinator = StructuredSessionCoordinator(runtime:runtime)
        do {
            try await coordinator.start(request:AgentSessionRequest(sessionID:id,workspaceURL:workspace))
            let status = await coordinator.state
            XCTAssertEqual(status,.ready)
            await coordinator.stop()
        } catch { await coordinator.stop(); throw error }
    }

    func testRealFactsOnlyDSHStartsWithoutModelRequestWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_AI_SANDBOX_PROBE"] == "1" else { throw XCTSkip("Opt-in sandboxed DSH startup; no model requests") }
        guard let executable = ExecutableLocator.find(named:"dsh") else { throw XCTSkip("DSH not installed") }
        let workspace = FileManager.default.temporaryDirectory.appendingPathComponent("termrelay-ai-dsh-startup-\(UUID())")
        try FileManager.default.createDirectory(at:workspace,withIntermediateDirectories:false)
        defer { try? FileManager.default.removeItem(at:workspace) }
        var environment = TerminalEnvironment.make(executableURL:executable)
        environment["DEEPSEEK_API_KEY"] = "termrelay-keyless-startup-probe"
        let id = UUID()
        let adapter = DSHStructuredAdapter(configuredExecutableURL:executable,transportFactory:{ executable,directory,environment in
            DSHACPProcess(executableURL:executable,directory:directory,environment:environment,aiSandbox:AIRuntimeSandbox(stateDirectory:URL(fileURLWithPath:environment["DSH_HOME"]!)))
        })
        let runtime = try await adapter.makeRuntime(configuration:AgentLaunchConfiguration(sessionID:id,workspaceURL:workspace,environment:environment))
        let coordinator = StructuredSessionCoordinator(runtime:runtime)
        do {
            try await coordinator.start(request:AgentSessionRequest(sessionID:id,workspaceURL:workspace))
            let status = await coordinator.state
            XCTAssertEqual(status,.ready)
            await coordinator.stop()
        } catch { await coordinator.stop(); throw error }
    }

    private func fixture(lifecycle: String) async -> AIFixture {
        let id = UUID()
        let runtime = TestAIRuntime(id:id)
        let sink = AISink()
        let manager = AIRuntimeManager(factory:{_,_,_ in AILaunchContext(adapter:TestAIAdapter(runtime:runtime),environment:[:])},announce:{_,_,_ in},eventHandler:{_ in},updateHandler:{u in await sink.record(u)})
        try! await manager.configure("[{\"id\":\"analysis\",\"version\":1,\"provider\":\"codex\",\"capacity\":2,\"policy\":\"factsOnly\"}]")
        await manager.connected()
        let turn = AiTurn(id:id.uuidString.lowercased(),sessionId:id.uuidString.lowercased(),input:AiInput(instructions:"Analyze"),output:AiOutput(kind:"json"),deadlineAt:deadline())
        let create = AiCreate(id:id.uuidString.lowercased(),projectId:"invest",profile:"analysis",profileVersion:1,provider:"codex",lifecycle:lifecycle,displayName:"test",turn:lifecycle == "oneShot" ? turn:nil)
        return AIFixture(manager:manager,runtime:runtime,sink:sink,create:create)
    }
    private func payload<T:Encodable>(_ value:T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self,from:JSONEncoder().encode(value)) }
    private func deadline() -> String { ISO8601DateFormatter().string(from:Date().addingTimeInterval(60)) }
}
private struct AIFixture: Sendable { let manager:AIRuntimeManager; let runtime:TestAIRuntime; let sink:AISink; let create:AiCreate }
private actor AISink { var updates:[AiUpdate] = []; func record(_ u:AiUpdate) { updates.append(u) } }
private struct TestAIAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID.codex
    let displayName = "Fake Codex"
    let runtime: TestAIRuntime
    func detect() async throws -> AgentInstallation { AgentInstallation(executableURL:URL(fileURLWithPath:"/usr/bin/false"),version:"test",supported:true,unsupportedReason:nil) }
    func makeRuntime(configuration:AgentLaunchConfiguration) async throws -> any StructuredAgentRuntime { runtime }
}
private actor TestAIRuntime: StructuredAgentRuntime {
    nonisolated let events:AsyncStream<ToolEvent>
    let descriptor = AgentDescriptor(providerID:.codex,providerVersion:"test",protocolName:"test",protocolVersion:"2",capabilities:[.streamingText])
    let id:UUID
    private let continuation:AsyncStream<ToolEvent>.Continuation
    private var sequence:UInt64 = 0
    private var active = ""
    var turns:[String] = []
    var stopCount = 0
    init(id:UUID) { self.id = id; let s = AsyncStream<ToolEvent>.makeStream(); events = s.stream; continuation = s.continuation }
    func start() async throws {}
    func createSession(_ request:AgentSessionRequest) async throws -> AgentSessionReference { AgentSessionReference(providerID:.codex,opaqueID:id.uuidString) }
    func send(_ action:ToolAction) async throws {
        if case .startTurn(let input,let key) = action { turns.append(input.text); active = key.uuidString; emit(.turnStarted(turnID:active)) }
        if case .interrupt = action { emit(.turnCompleted(turnID:active,status:.interrupted)) }
    }
    func complete(text:String) { emit(.reasoningDelta(text:"not a final answer")); emit(.assistantMessageCompleted(text:text)); emit(.turnCompleted(turnID:active,status:.completed)) }
    func stop() async { stopCount += 1; continuation.finish() }
    private func emit(_ payload:ToolEventPayload) { continuation.yield(ToolEvent(sessionID:id,sequence:sequence,occurredAt:Date(),correlation:AgentCorrelation(turnID:active,itemID:nil,approvalID:nil),payload:payload)); sequence += 1 }
}
