import Foundation
import XCTest
@testable import TermRelay

final class CodexAppServerClientTests: XCTestCase {
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

    func testCodexRuntimeMapsTurnAndApprovalWithoutLeakingRPC() async throws {
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
            "method": "turn/completed",
            "params": [
                "threadId": "thread-a",
                "turn": ["id": "turn-a", "status": "completed", "items": []],
            ],
        ])
        try await Task.sleep(for: .milliseconds(20))
        let finalState = await coordinator.state
        XCTAssertEqual(finalState, .ready)
        await coordinator.stop()
    }

    func testVersionSupportIsExplicit() {
        XCTAssertTrue(CodexVersionSupport.evaluate("codex-cli 0.153.4").supported)
        XCTAssertTrue(CodexVersionSupport.evaluate("codex-cli 0.153.9").supported)
        XCTAssertFalse(CodexVersionSupport.evaluate("codex-cli 0.154.0").supported)
    }

    func testRealCodexInitializeWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_CODEX_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TERMRELAY_RUN_CODEX_INTEGRATION=1 for the real local probe")
        }
        let installation = try await CodexStructuredAdapter().detect()
        XCTAssertTrue(installation.supported, installation.unsupportedReason ?? "unsupported")
        let transport = CodexAppServerProcess(
            executableURL: installation.executableURL,
            directory: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        )
        let client = CodexAppServerClient(transport: transport, timeout: .seconds(5))
        let response = try await client.start()
        XCTAssertNotNil(response.object?["userAgent"]?.string)
        await client.stop()
    }

    func testRealCodexEphemeralThreadWhenExplicitlyEnabled() async throws {
        guard ProcessInfo.processInfo.environment["TERMRELAY_RUN_CODEX_INTEGRATION"] == "1" else {
            throw XCTSkip("Set TERMRELAY_RUN_CODEX_INTEGRATION=1 for the real local probe")
        }
        let sessionID = UUID()
        let workspace = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let adapter = CodexStructuredAdapter()
        let runtime = try await adapter.makeRuntime(configuration: AgentLaunchConfiguration(
            sessionID: sessionID,
            workspaceURL: workspace,
            ephemeral: true
        ))
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(request: AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: workspace,
            ephemeral: true
        ))
        let snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .ready)
        XCTAssertEqual(snapshot.reference?.providerID, .codex)
        XCTAssertFalse(snapshot.reference?.opaqueID.isEmpty ?? true)
        await coordinator.stop()
    }
}

private final class FakeCodexTransport: @unchecked Sendable, CodexAppServerTransport {
    let lines: AsyncThrowingStream<Data, Error>

    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var sent: [Data] = []
    private(set) var stopCount = 0

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
