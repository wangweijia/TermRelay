import Foundation
import XCTest
@testable import TermRelay

final class CopilotACPClientTests: XCTestCase {
    func testServerHistoryImportsOnlyConversationAndRecentWork() {
        let events: [RelayHistoryEvent] = [
            .init(seq: 1, type: "tool.event", payload: .object([
                "kind": .string("user.message"), "data": .object(["text": .string("Fix the parser")]),
            ]), createdAt: ""),
            .init(seq: 2, type: "tool.event", payload: .object([
                "kind": .string("command.started"), "data": .object(["command": .string("pnpm test")]),
            ]), createdAt: ""),
            .init(seq: 3, type: "tool.event", payload: .object([
                "kind": .string("assistant.delta"), "data": .object(["text": .string("Fixed")]),
            ]), createdAt: ""),
            .init(seq: 4, type: "tool.event", payload: .object([
                "kind": .string("assistant.completed"), "data": .object(["text": .string("Fixed the parser")]),
            ]), createdAt: ""),
        ]
        XCTAssertEqual(CopilotHistory.messages(from: events), [
            .init(role: "用户", text: "Fix the parser"),
            .init(role: "Copilot", text: "Fixed the parser"),
        ])
        let context = CopilotHistory.context(from: events)
        XCTAssertTrue(context?.contains("用户：Fix the parser") == true)
        XCTAssertTrue(context?.contains("执行命令：pnpm test") == true)
        XCTAssertTrue(context?.contains("Copilot：Fixed the parser") == true)
        XCTAssertFalse(context?.contains("assistant.delta") == true)
        XCTAssertNil(CopilotHistory.context(from: []))
        let bounded = CopilotHistory.context(from: events, maximumCharacters: 15)
        XCTAssertFalse(bounded?.contains("Fix the parser") == true)
    }

    func testNewCopilotSessionReceivesImportedContextOnFirstPrompt() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.0", initialContext: "Previous work: fixed parser",
            client: CopilotACPClient(transport: transport)
        )
        let starting = Task {
            try await runtime.start()
            _ = try await runtime.createSession(AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: ["protocolVersion": 1])
        transport.respond(to: try await transport.waitForSentMessage(at: 1), result: ["sessionId": "new-session"])
        try await starting.value
        try await runtime.send(.startTurn(TurnInput(text: "Continue"), idempotencyKey: UUID()))
        let first = try await transport.waitForSentMessage(at: 2)
        let prompt = (first["params"] as? [String: Any])?["prompt"] as? [[String: Any]]
        XCTAssertTrue((prompt?.first?["text"] as? String)?.contains("Previous work: fixed parser") == true)
        XCTAssertTrue((prompt?.first?["text"] as? String)?.contains("Continue") == true)
        await runtime.stop()
    }

    func testCopilotListsSavedSessionsAcrossPagesForWorkspace() async throws {
        let transport = FakeCopilotACPTransport()
        let adapter = CopilotStructuredAdapter(
            configuredExecutableURL: URL(fileURLWithPath: "/bin/echo"),
            transportFactory: { _, _, _ in transport }
        )
        let listing = Task {
            try await adapter.listSessions(in: URL(fileURLWithPath: "/tmp"), environment: [:])
        }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: [
            "protocolVersion": 1,
            "agentCapabilities": ["sessionCapabilities": ["list": [:]]],
        ])
        let first = try await transport.waitForSentMessage(at: 1)
        XCTAssertEqual(first["method"] as? String, "session/list")
        XCTAssertEqual((first["params"] as? [String: Any])?["cwd"] as? String, "/tmp")
        transport.respond(to: first, result: [
            "sessions": [
                ["sessionId": "old-one", "cwd": "/tmp", "title": "Old conversation"],
                ["sessionId": "other", "cwd": "/elsewhere"],
            ],
            "nextCursor": "page-two",
        ])
        let second = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual((second["params"] as? [String: Any])?["cursor"] as? String, "page-two")
        transport.respond(to: second, result: [
            "sessions": [["sessionId": "old-two", "cwd": "/tmp", "title": "Later conversation"]],
        ])
        let result = try await listing.value
        XCTAssertEqual(result.map(\.id), ["old-one", "old-two"])
        XCTAssertEqual(result[0].title, "Old conversation")
    }

    func testCopilotLoadsPriorConversationBeforeNewPrompt() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let coordinator = StructuredSessionCoordinator(runtime: CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.88", client: CopilotACPClient(transport: transport)
        ))
        let replayed = Task {
            var events: [ToolEvent] = []
            for await event in coordinator.events {
                events.append(event)
                if case .turnCompleted = event.payload { return events }
            }
            return events
        }
        let starting = Task {
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
                providerSessionID: "saved-copilot-session"
            ))
        }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: [
            "protocolVersion": 1, "agentCapabilities": ["loadSession": true],
        ])
        let load = try await transport.waitForSentMessage(at: 1)
        XCTAssertEqual(load["method"] as? String, "session/load")
        XCTAssertEqual(
            (load["params"] as? [String: Any])?["sessionId"] as? String, "saved-copilot-session"
        )
        transport.receive([
            "jsonrpc": "2.0", "method": "session/update", "params": [
                "sessionId": "saved-copilot-session", "update": [
                    "sessionUpdate": "user_message_chunk", "messageId": "prior-user",
                    "content": ["type": "text", "text": "Original question"],
                ],
            ],
        ])
        transport.receive([
            "jsonrpc": "2.0", "method": "session/update", "params": [
                "sessionId": "saved-copilot-session", "update": [
                    "sessionUpdate": "agent_message_chunk", "messageId": "prior-answer",
                    "content": ["type": "text", "text": "Original answer"],
                ],
            ],
        ])
        transport.respond(to: load, result: [:])
        try await starting.value
        let reference = await coordinator.reference
        XCTAssertEqual(reference?.opaqueID, "saved-copilot-session")
        let events = await replayed.value
        XCTAssertEqual(events.compactMap { event -> String? in
            if case .userMessage(_, let text) = event.payload { return text }
            return nil
        }, ["Original question"])
        XCTAssertEqual(events.compactMap { event -> String? in
            if case .assistantMessageCompleted(let text) = event.payload { return text }
            return nil
        }, ["Original answer"])
        let state = await coordinator.snapshot().state
        XCTAssertEqual(state, .ready)
        try await coordinator.send(.startTurn(TurnInput(text: "Follow-up"), idempotencyKey: UUID()))
        let prompt = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(prompt["method"] as? String, "session/prompt")
        XCTAssertEqual(
            (prompt["params"] as? [String: Any])?["sessionId"] as? String, "saved-copilot-session"
        )
        await coordinator.stop()
    }

    func testCopilotRejectsLoadWithoutCapability() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.88", client: CopilotACPClient(transport: transport)
        )
        let starting = Task { try await runtime.start() }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: [
            "protocolVersion": 1, "agentCapabilities": ["loadSession": false],
        ])
        try await starting.value
        do {
            _ = try await runtime.createSession(AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
                providerSessionID: "old"
            ))
            XCTFail("Expected unsupported session/load")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("session/load"))
        }
        XCTAssertFalse(transport.sentMethods.contains("session/new"))
        XCTAssertFalse(transport.sentMethods.contains("session/load"))
        await runtime.stop()
    }

    func testCopilotACPReasoningEffortLaunchArguments() {
        XCTAssertEqual(CopilotReasoningEffort.automatic.launchArguments, ["--acp", "--stdio"])
        for effort in CopilotReasoningEffort.allCases where effort != .automatic {
            XCTAssertEqual(
                effort.launchArguments,
                ["--acp", "--stdio", "--effort=\(effort.rawValue)"]
            )
        }
    }

    func testCopilotAdvertisedModelCommandWithoutConfigOptions() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.88", client: CopilotACPClient(transport: transport)
        )
        let starting = Task {
            try await runtime.start()
            _ = try await runtime.createSession(AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: ["protocolVersion": 1])
        transport.respond(to: try await transport.waitForSentMessage(at: 1), result: ["sessionId": "copilot-command"])
        try await starting.value
        let initial = try await runtime.configurationOptions()
        XCTAssertTrue(initial.isEmpty)
        transport.receive([
            "jsonrpc": "2.0", "method": "session/update", "params": [
                "sessionId": "copilot-command", "update": [
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [["name": "model", "description": "Change model"]],
                ],
            ],
        ])
        for _ in 0..<50 {
            let options = try await runtime.configurationOptions()
            if !options.isEmpty { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let options = try await runtime.configurationOptions()
        XCTAssertEqual(options.map(\.id), ["model"])
        XCTAssertTrue(options[0].choices.isEmpty)
        await runtime.stop()
    }

    func testCopilotModelOptionsAndIdleUpdates() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.88", client: CopilotACPClient(transport: transport)
        )
        let starting = Task {
            try await runtime.start()
            _ = try await runtime.createSession(AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }
        let initialize = try await transport.waitForSentMessage(at: 0)
        transport.respond(to: initialize, result: ["protocolVersion": 1])
        let newSession = try await transport.waitForSentMessage(at: 1)
        let initial = [[
            "id": "provider-model", "name": "Model", "category": "model", "type": "select",
            "currentValue": "model-a", "options": [
                ["value": "model-a", "name": "Model A"], ["value": "model-b", "name": "Model B"],
            ],
        ] as [String: Any]]
        transport.respond(to: newSession, result: ["sessionId": "copilot-model", "configOptions": initial])
        try await starting.value
        let options = try await runtime.configurationOptions()
        XCTAssertEqual(options.first?.currentValue, "model-a")

        let changing = Task { try await runtime.setConfiguration(id: "model", value: "model-b") }
        let request = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(request["method"] as? String, "session/set_config_option")
        XCTAssertEqual((request["params"] as? [String: Any])?["configId"] as? String, "provider-model")
        let changed = initial.map { option -> [String: Any] in
            var copy = option
            copy["currentValue"] = "model-b"
            return copy
        }
        transport.respond(to: request, result: ["configOptions": changed])
        let confirmed = try await changing.value
        XCTAssertEqual(confirmed.first?.currentValue, "model-b")

        transport.receive([
            "jsonrpc": "2.0", "method": "session/update", "params": [
                "sessionId": "copilot-model", "update": [
                    "sessionUpdate": "config_option_update", "configOptions": initial,
                ],
            ],
        ])
        for _ in 0..<50 {
            let latest = try await runtime.configurationOptions()
            if latest.first?.currentValue == "model-a" { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        let refreshed = try await runtime.configurationOptions()
        XCTAssertEqual(refreshed.first?.currentValue, "model-a")
        await runtime.stop()
    }

    func testCopilotAdvertisedThoughtLevelOptionCanChange() async throws {
        let transport = FakeCopilotACPTransport()
        let sessionID = UUID()
        let runtime = CopilotStructuredRuntime(
            sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp"),
            providerVersion: "1.0.88", client: CopilotACPClient(transport: transport)
        )
        let starting = Task {
            try await runtime.start()
            _ = try await runtime.createSession(AgentSessionRequest(
                sessionID: sessionID, workspaceURL: URL(fileURLWithPath: "/tmp")
            ))
        }
        transport.respond(to: try await transport.waitForSentMessage(at: 0), result: ["protocolVersion": 1])
        let original: [[String: Any]] = [
            [
                "id": "provider-model", "name": "Model", "category": "model", "type": "select",
                "currentValue": "model-a", "options": [["value": "model-a", "name": "Model A"]],
            ],
            [
                "id": "reasoning-level", "name": "Reasoning", "category": "thought_level", "type": "select",
                "currentValue": "medium", "options": [
                    ["value": "medium", "name": "Medium"], ["value": "high", "name": "High"],
                ],
            ],
        ]
        transport.respond(
            to: try await transport.waitForSentMessage(at: 1),
            result: ["sessionId": "copilot-thought-level", "configOptions": original]
        )
        try await starting.value
        let initialOptions = try await runtime.configurationOptions()
        XCTAssertEqual(initialOptions.map(\.id), ["model", "effort"])

        let changing = Task { try await runtime.setConfiguration(id: "effort", value: "high") }
        let request = try await transport.waitForSentMessage(at: 2)
        XCTAssertEqual(request["method"] as? String, "session/set_config_option")
        XCTAssertEqual((request["params"] as? [String: Any])?["configId"] as? String, "reasoning-level")
        var updated = original
        updated[1]["currentValue"] = "high"
        transport.respond(to: request, result: ["configOptions": updated])
        let options = try await changing.value
        XCTAssertEqual(options.map(\.id), ["model", "effort"])
        XCTAssertEqual(options.last?.currentValue, "high")
        await runtime.stop()
    }

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