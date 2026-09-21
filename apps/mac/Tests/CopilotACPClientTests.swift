import Foundation
import XCTest
@testable import TermRelay

final class CopilotACPClientTests: XCTestCase {
    func testCopilotACPHandshakeTurnPermissionAndShutdown() async throws {
        let transport = FakeCopilotACPTransport()
        let client = CopilotACPClient(transport: transport)
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.0",
            client: client
        )
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID,
                workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }

        let initialize = try await transport.waitForSentMessage(at: 0)
        XCTAssertEqual(initialize["method"] as? String, "initialize")
        XCTAssertEqual((initialize["params"] as? [String: Any])?["protocolVersion"] as? Int, 1)
        transport.respond(to: initialize, result: [
            "protocolVersion": 1,
            "agentInfo": ["name": "github-copilot", "version": "1.0.0"],
            "agentCapabilities": [:],
        ])

        let sessionNew = try await transport.waitForSentMessage(at: 1)
        XCTAssertEqual(sessionNew["method"] as? String, "session/new")
        XCTAssertEqual((sessionNew["params"] as? [String: Any])?["cwd"] as? String, "/tmp")
        transport.respond(to: sessionNew, result: ["sessionId": "copilot-session-a"])
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
                "sessionId": "copilot-session-a",
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
                "sessionId": "copilot-session-a",
                "toolCall": [
                    "toolCallId": "tool-a",
                    "title": "shell",
                    "kind": "execute",
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
        let approvalID = try XCTUnwrap(approvalSnapshot.pendingApprovalIDs.first)
        let turnID = try XCTUnwrap(approvalSnapshot.activeTurnID)
        XCTAssertTrue(approvalID.hasPrefix("copilot:"))
        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: approvalID,
            turnID: turnID,
            decision: .allowOnce
        )))
        let permissionResponse = try await transport.waitForSentMessage(at: 3)
        let result = try XCTUnwrap(permissionResponse["result"] as? [String: Any])
        let outcome = try XCTUnwrap(result["outcome"] as? [String: Any])
        XCTAssertEqual(outcome["optionId"] as? String, "allow-once")

        transport.respond(to: prompt, result: ["stopReason": "end_turn"])
        try await Task.sleep(for: .milliseconds(30))
        let completedState = await coordinator.state
        XCTAssertEqual(completedState, .ready)

        await coordinator.stop()
        XCTAssertFalse(transport.sentMethods.contains("session/close"))
        XCTAssertTrue(transport.didStop)
    }
}

private final class FakeCopilotACPTransport: @unchecked Sendable, CopilotACPTransport {
    let lines: AsyncThrowingStream<Data, Error>
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let lock = NSLock()
    private var sent: [Data] = []
    private var stopped = false

    var sentMethods: [String] {
        lock.withLock {
            sent.compactMap { data in
                (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["method"] as? String
            }
        }
    }

    var didStop: Bool { lock.withLock { stopped } }

    init() {
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        lines = stream.stream
        continuation = stream.continuation
    }

    func start() throws {}

    func stop() {
        lock.withLock { stopped = true }
        continuation.finish()
    }

    func diagnosticTail() -> String { "" }

    func send(_ line: Data) throws {
        lock.withLock { sent.append(line) }
    }

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
        throw AgentError.protocolFailure("Timed out waiting for Copilot ACP message")
    }
}