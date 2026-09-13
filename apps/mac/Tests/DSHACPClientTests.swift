import Foundation
import XCTest
@testable import TermRelay

final class DSHACPClientTests: XCTestCase {
    func testACPHandshakeFreshSessionTurnAndPermission() async throws {
        let transport = FakeACPTransport()
        let client = DSHACPClient(transport: transport)
        let sessionID = UUID()
        let runtimeHome = URL(fileURLWithPath: "/private/tmp/termrelay-dsh-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: runtimeHome, withIntermediateDirectories: true)
        let runtime = DSHStructuredRuntime(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "0.1.2-alpha.5",
            client: client,
            runtimeHome: runtimeHome
        )
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID,
                workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }

        let initialize = try await transport.waitForSentMessage(at: 0)
        XCTAssertEqual(initialize["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(initialize["method"] as? String, "initialize")
        XCTAssertEqual((initialize["params"] as? [String: Any])?["protocolVersion"] as? Int, 1)
        transport.respond(to: initialize, result: [
            "protocolVersion": 1,
            "agentInfo": ["name": "deepseek-harness-acp", "version": "0.1.2-alpha.5"],
            "agentCapabilities": [:],
        ])

        let sessionNew = try await transport.waitForSentMessage(at: 1)
        XCTAssertEqual(sessionNew["method"] as? String, "session/new")
        XCTAssertEqual((sessionNew["params"] as? [String: Any])?["cwd"] as? String, "/tmp")
        XCTAssertFalse(transport.sentMethods.contains("session/resume"))
        transport.respond(to: sessionNew, result: ["sessionId": "dsh-session-a", "configOptions": []])
        try await starting.value
        let readyState = await coordinator.state
        XCTAssertEqual(readyState, .ready)

        try await coordinator.send(.startTurn(TurnInput(text: "检查项目"), idempotencyKey: UUID()))
        let prompt = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(prompt["method"] as? String, "session/prompt")

        transport.receive([
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": [
                "sessionId": "dsh-session-a",
                "update": [
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": "message-a",
                    "content": ["type": "text", "text": "完成"],
                ],
            ],
        ])
        transport.receive([
            "jsonrpc": "2.0",
            "id": 91,
            "method": "session/request_permission",
            "params": [
                "sessionId": "dsh-session-a",
                "toolCall": [
                    "toolCallId": "tool-a", "title": "bash", "kind": "execute",
                    "rawInput": ["command": "touch result.txt"],
                ],
                "options": [
                    ["optionId": "allow-once", "name": "Allow once", "kind": "allow_once"],
                    ["optionId": "reject-once", "name": "Reject once", "kind": "reject_once"],
                ],
            ],
        ])
        try await Task.sleep(for: .milliseconds(30))
        let approvalSnapshot = await coordinator.snapshot()
        XCTAssertEqual(approvalSnapshot.state, .awaitingApproval)
        let approvalID = try XCTUnwrap(approvalSnapshot.pendingApprovalIDs.first)
        let turnID = try XCTUnwrap(approvalSnapshot.activeTurnID)
        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: approvalID,
            turnID: turnID,
            decision: .allowOnce
        )))
        let permissionResponse = try await transport.waitForSentMessage(at: 3)
        XCTAssertEqual(permissionResponse["id"] as? Int, 91)
        let result = try XCTUnwrap(permissionResponse["result"] as? [String: Any])
        let outcome = try XCTUnwrap(result["outcome"] as? [String: Any])
        XCTAssertEqual(outcome["optionId"] as? String, "allow-once")

        transport.respond(to: prompt, result: ["stopReason": "end_turn"])
        try await Task.sleep(for: .milliseconds(30))
        let completedState = await coordinator.state
        XCTAssertEqual(completedState, .ready)

        let stopping = Task { await coordinator.stop() }
        let close = try await transport.waitForSentMessage(at: 4)
        XCTAssertEqual(close["method"] as? String, "session/close")
        XCTAssertFalse(transport.sentMethods.contains("session/resume"))
        transport.respond(to: close, result: [:])
        await stopping.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: runtimeHome.path))
    }

    func testRealDSHFreshSessionWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_DSH_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TERMRELAY_RUN_DSH_INTEGRATION=1 for the real local probe")
        }
        let installation = try await DSHStructuredAdapter().detect()
        var environment = TerminalEnvironment.make(executableURL: installation.executableURL)
        environment["DEEPSEEK_API_KEY"] = "termrelay-keyless-startup-probe"
        let sessionID = UUID()
        let runtime = try await DSHStructuredAdapter(
            configuredExecutableURL: installation.executableURL
        ).makeRuntime(configuration: AgentLaunchConfiguration(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            environment: environment
        ))
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(request: AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        ))
        let state = await coordinator.state
        XCTAssertEqual(state, .ready)
        await coordinator.stop()
    }
}

private final class FakeACPTransport: @unchecked Sendable, ACPTransport {
    let lines: AsyncThrowingStream<Data, Error>
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var sent: [Data] = []

    var sentMethods: [String] {
        lock.withLock {
            sent.compactMap { data in
                (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["method"] as? String
            }
        }
    }

    init() {
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        lines = stream.stream
        continuation = stream.continuation
    }

    func start() throws {}
    func stop() { continuation.finish() }
    func diagnosticTail() -> String { "" }
    func send(_ line: Data) throws { lock.withLock { sent.append(line) } }

    func receive(_ object: [String: Any]) {
        continuation.yield(try! JSONSerialization.data(withJSONObject: object))
    }

    func respond(to request: [String: Any], result: [String: Any]) {
        receive(["jsonrpc": "2.0", "id": request["id"]!, "result": result])
    }

    func waitForSentMessage(at index: Int) async throws -> [String: Any] {
        for _ in 0..<200 {
            if let data = lock.withLock({ sent.indices.contains(index) ? sent[index] : nil }) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw AgentError.protocolFailure("Timed out waiting for ACP message")
    }
}
