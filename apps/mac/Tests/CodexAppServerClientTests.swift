import CryptoKit
import Foundation
import XCTest
@testable import TermRelay

final class CodexAppServerClientTests: XCTestCase {
    func testUnixProxyCodecPerformsWebSocketUpgradeAndReadsTextFrame() async throws {
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        let codec = WebSocketPipeCodec(continuation: stream.continuation)
        let request = try XCTUnwrap(String(data: codec.handshakeRequest, encoding: .utf8))
        let keyLine = try XCTUnwrap(
            request.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("sec-websocket-key:") }
        )
        let key = keyLine.split(separator: ":", maxSplits: 1)[1]
            .trimmingCharacters(in: .whitespaces)
        let digest = Insecure.SHA1.hash(
            data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)
        )
        let accept = Data(digest).base64EncodedString()
        let message = Data(#"{"id":1,"result":{}}"#.utf8)
        var response = Data(
            ("HTTP/1.1 101 Switching Protocols\r\n" +
             "Upgrade: websocket\r\n" +
             "Connection: Upgrade\r\n" +
             "Sec-WebSocket-Accept: \(accept)\r\n\r\n").utf8
        )
        response.append(0x81)
        response.append(UInt8(message.count))
        response.append(message)

        XCTAssertTrue(codec.receive(response).isEmpty)
        XCTAssertNoThrow(try codec.waitForHandshake(timeout: .now() + 1))
        var iterator = stream.stream.makeAsyncIterator()
        let received = try await iterator.next()
        XCTAssertEqual(received, message)

        let clientFrame = codec.clientTextFrame(message)
        XCTAssertEqual(clientFrame.first, 0x81)
        XCTAssertEqual(clientFrame[1] & 0x80, 0x80, "Client WebSocket frames must be masked")
    }

    func testInitializeHandshakeAndServerMessages() async throws {
        let transport = FakeCodexTransport()
        let client = CodexAppServerClient(transport: transport, timeout: .seconds(1))
        let starting = Task { try await client.start() }

        let initialize = try await transport.waitForSentMessage(at: 0)
        XCTAssertEqual(initialize["method"] as? String, "initialize")
        let initializeID = try XCTUnwrap(initialize["id"] as? Int)
        transport.receive([
            "id": initializeID,
            "result": ["userAgent": "codex-cli 0.153.4"],
        ])
        _ = try await starting.value

        let initialized = try await transport.waitForSentMessage(at: 1)
        XCTAssertEqual(initialized["method"] as? String, "initialized")
        XCTAssertNil(initialized["id"])

        transport.receive([
            "method": "item/agentMessage/delta",
            "params": ["delta": "hello"],
        ])
        transport.receive([
            "id": 91,
            "method": "item/commandExecution/requestApproval",
            "params": ["turnId": "turn-a"],
        ])

        var iterator = client.messages.makeAsyncIterator()
        guard case .notification(let method, _)? = await iterator.next() else {
            return XCTFail("Expected a notification")
        }
        XCTAssertEqual(method, "item/agentMessage/delta")
        guard case .request(let id, let requestMethod, _)? = await iterator.next() else {
            return XCTFail("Expected a reverse request")
        }
        XCTAssertEqual(id.integer, 91)
        XCTAssertEqual(requestMethod, "item/commandExecution/requestApproval")

        await client.stop()
        XCTAssertEqual(transport.stopCount, 1)
    }

    func testRequestTimeoutDoesNotLeavePendingContinuation() async throws {
        let transport = FakeCodexTransport()
        let client = CodexAppServerClient(transport: transport, timeout: .milliseconds(20))
        let starting = Task { try await client.start() }
        let initialize = try await transport.waitForSentMessage(at: 0)
        transport.receive([
            "id": try XCTUnwrap(initialize["id"] as? Int),
            "result": [:],
        ])
        _ = try await starting.value

        do {
            _ = try await client.request(method: "thread/start", params: .object([:]))
            XCTFail("Expected timeout")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("超时"))
        }
        await client.stop()
    }

    func testCodexRuntimeMapsTurnAndApprovalOnDirectConnection() async throws {
        let sessionID = UUID()
        let workspace = URL(fileURLWithPath: "/tmp")
        let transport = FakeCodexTransport()
        let client = CodexAppServerClient(transport: transport, timeout: .seconds(1))
        let runtime = CodexStructuredRuntime(
            sessionID: sessionID,
            workspaceURL: workspace,
            providerVersion: "codex-cli 0.153.4",
            client: client
        )
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID,
                workspaceURL: workspace
            ))
        }

        try await transport.respondToRequest(at: 0, result: [:])
        let threadStart = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(threadStart["method"] as? String, "thread/start")
        try await transport.respondToRequest(at: 2, result: [
            "thread": ["id": "thread-a"],
        ])
        try await starting.value

        let turnStarting = Task {
            try await coordinator.send(.startTurn(
                TurnInput(text: "检查项目"),
                idempotencyKey: UUID()
            ))
        }
        let turnStart = try await transport.waitForSentMessage(at: 3)
        XCTAssertEqual(turnStart["method"] as? String, "turn/start")
        try await transport.respondToRequest(at: 3, result: [
            "turn": ["id": "turn-a"],
        ])
        try await turnStarting.value

        transport.receive([
            "id": 900,
            "method": "item/commandExecution/requestApproval",
            "params": [
                "threadId": "thread-a",
                "turnId": "turn-a",
                "itemId": "item-a",
                "command": "git status",
                "startedAtMs": 1_000,
            ],
        ])
        try await Task.sleep(for: .milliseconds(20))
        let snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .awaitingApproval)
        XCTAssertEqual(snapshot.pendingApprovalIDs, ["command:item-a"])

        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: "command:item-a",
            turnID: "turn-a",
            decision: .allowOnce
        )))
        let approvalResponse = try await transport.waitForSentMessage(at: 4)
        XCTAssertEqual(approvalResponse["id"] as? Int, 900)
        XCTAssertEqual(
            (approvalResponse["result"] as? [String: Any])?["decision"] as? String,
            "accept"
        )

        transport.receive([
            "id": 901,
            "method": "item/tool/requestUserInput",
            "params": [
                "threadId": "thread-a", "turnId": "turn-a", "itemId": "item-q",
                "isBlocking": true,
                "questions": [[
                    "id": "strategy", "header": "方案", "question": "选择处理方式",
                    "options": [["label": "修复", "description": "直接修复问题"]],
                    "isOther": true, "isSecret": false,
                ]],
            ],
        ])
        try await Task.sleep(for: .milliseconds(20))
        let inputState = await coordinator.state
        XCTAssertEqual(inputState, .awaitingUserInput)
        try await coordinator.send(.resolveUserInput(UserInputResolution(
            requestID: "input:901", turnID: "turn-a", answers: ["strategy": ["修复"]]
        )))
        let inputResponse = try await transport.waitForSentMessage(at: 5)
        XCTAssertEqual(inputResponse["id"] as? Int, 901)
        let inputResult = try XCTUnwrap(inputResponse["result"] as? [String: Any])
        let responseAnswers = try XCTUnwrap(inputResult["answers"] as? [String: Any])
        let strategy = try XCTUnwrap(responseAnswers["strategy"] as? [String: Any])
        XCTAssertEqual(strategy["answers"] as? [String], ["修复"])

        transport.receive([
            "method": "turn/completed",
            "params": [
                "threadId": "thread-a",
                "turn": ["id": "turn-a", "status": "completed", "items": []],
            ],
        ])
        try await Task.sleep(for: .milliseconds(20))
        let finalState = await coordinator.state
        XCTAssertEqual(finalState, .ready)
        let stopping = Task { await coordinator.stop() }
        let deleteThread = try await transport.waitForSentMessage(at: 6)
        XCTAssertEqual(deleteThread["method"] as? String, "thread/delete")
        try await transport.respondToRequest(at: 6, result: [:])
        await stopping.value
    }

    func testFreshACPThreadStartsOnceAndNeverResumes() async throws {
        let sessionID = UUID()
        let workspace = URL(fileURLWithPath: "/tmp")
        let transport = FakeCodexTransport()
        let client = CodexAppServerClient(transport: transport, timeout: .seconds(1))
        let runtime = CodexStructuredRuntime(
            sessionID: sessionID,
            workspaceURL: workspace,
            providerVersion: "codex-cli 0.154.0",
            client: client
        )
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID,
                workspaceURL: workspace
            ))
        }

        try await transport.respondToRequest(at: 0, result: [:])
        let threadStart = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(threadStart["method"] as? String, "thread/start")
        XCTAssertEqual(
            (threadStart["params"] as? [String: Any])?["sandbox"] as? String,
            "workspace-write"
        )
        XCTAssertFalse(transport.sentMethods.contains("thread/resume"))
        try await transport.respondToRequest(at: 2, result: ["thread": ["id": "thread-new"]])
        try await starting.value

        let stopping = Task { await coordinator.stop() }
        let deleteThread = try await transport.waitForSentMessage(at: 3)
        XCTAssertEqual(deleteThread["method"] as? String, "thread/delete")
        try await transport.respondToRequest(at: 3, result: [:])
        await stopping.value
    }

    func testStoppingWindowInterruptsTurnBeforeDeletingThread() async throws {
        let sessionID = UUID()
        let workspace = URL(fileURLWithPath: "/tmp")
        let transport = FakeCodexTransport()
        let runtime = CodexStructuredRuntime(
            sessionID: sessionID,
            workspaceURL: workspace,
            providerVersion: "codex-cli 0.154.0",
            client: CodexAppServerClient(transport: transport, timeout: .seconds(1))
        )
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID,
                workspaceURL: workspace
            ))
        }
        try await transport.respondToRequest(at: 0, result: [:])
        try await transport.respondToRequest(at: 2, result: ["thread": ["id": "thread-live"]])
        try await starting.value

        let turnStarting = Task {
            try await coordinator.send(.startTurn(
                TurnInput(text: "长任务"),
                idempotencyKey: UUID()
            ))
        }
        try await transport.respondToRequest(at: 3, result: [
            "turn": ["id": "turn-live"],
        ])
        try await turnStarting.value

        let stopping = Task { await coordinator.stop() }
        let interrupt = try await transport.waitForSentMessage(at: 4)
        XCTAssertEqual(interrupt["method"] as? String, "turn/interrupt")
        try await transport.respondToRequest(at: 4, result: [:])
        let deleteThread = try await transport.waitForSentMessage(at: 5)
        XCTAssertEqual(deleteThread["method"] as? String, "thread/delete")
        try await transport.respondToRequest(at: 5, result: [:])
        await stopping.value
    }

    func testRealCodexInitializeWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_CODEX_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TERMRELAY_RUN_CODEX_INTEGRATION=1 for the real local probe")
        }
        let installation = try await CodexStructuredAdapter().detect()
        XCTAssertTrue(installation.supported, installation.unsupportedReason ?? "unsupported")
        let codexHome = URL(fileURLWithPath: "/private/tmp/termrelay-codex-home-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: codexHome, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: codexHome) }
        var environment = TerminalEnvironment.make(executableURL: installation.executableURL)
        environment["CODEX_HOME"] = codexHome.path
        let transport = CodexAppServerProcess(
            executableURL: installation.executableURL,
            directory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            environment: environment
        )
        let client = CodexAppServerClient(transport: transport, timeout: .seconds(5))
        let response = try await client.start()
        XCTAssertNotNil(response.object?["userAgent"]?.string)
        await client.stop()
    }

    func testRealFreshACPThroughUnixSocketWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_CODEX_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TERMRELAY_RUN_CODEX_INTEGRATION=1 for the real local probe")
        }
        let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let installation = try await CodexStructuredAdapter().detect()
        let codexHome = URL(fileURLWithPath: "/private/tmp/termrelay-codex-home-\(UUID().uuidString)")
        let runtimeRoot = URL(fileURLWithPath: "/private/tmp/termrelay-runtime-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: codexHome, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: codexHome)
            try? FileManager.default.removeItem(at: runtimeRoot)
        }
        var environment = TerminalEnvironment.make(executableURL: installation.executableURL)
        environment["CODEX_HOME"] = codexHome.path
        let host = CodexAppServerHost(
            executableURL: installation.executableURL,
            directory: workspace,
            environment: environment,
            runtimeRootDirectory: runtimeRoot
        )
        let sessionID = UUID()
        let runtime = try await CodexStructuredAdapter(
            configuredExecutableURL: installation.executableURL,
            host: host
        ).makeRuntime(configuration: AgentLaunchConfiguration(
            sessionID: sessionID,
            workspaceURL: workspace,
            environment: environment
        ))
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(
            request: AgentSessionRequest(sessionID: sessionID, workspaceURL: workspace)
        )
        let state = await coordinator.state
        XCTAssertEqual(state, .ready)
        await coordinator.stop()
    }

}

private final class FakeCodexTransport: @unchecked Sendable, CodexAppServerTransport {
    let lines: AsyncThrowingStream<Data, Error>

    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var sent: [Data] = []
    private(set) var stopCount = 0
    var sentCount: Int { lock.withLock { sent.count } }
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

    func send(_ line: Data) throws {
        lock.withLock { sent.append(line) }
    }

    func stop() {
        lock.withLock { stopCount += 1 }
        continuation.finish()
    }

    func receive(_ object: [String: Any]) {
        continuation.yield(try! JSONSerialization.data(withJSONObject: object))
    }

    func waitForSentMessage(at index: Int) async throws -> [String: Any] {
        for _ in 0..<100 {
            if let data = lock.withLock({ sent.indices.contains(index) ? sent[index] : nil }) {
                return try XCTUnwrap(
                    JSONSerialization.jsonObject(with: data) as? [String: Any]
                )
            }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw AgentError.protocolFailure("Timed out waiting for client message")
    }

    func respondToRequest(at index: Int, result: [String: Any]) async throws {
        let request = try await waitForSentMessage(at: index)
        receive([
            "id": try XCTUnwrap(request["id"] as? Int),
            "result": result,
        ])
    }
}
