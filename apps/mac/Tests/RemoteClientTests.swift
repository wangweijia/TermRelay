import Foundation
import XCTest
@testable import TermRelay

final class RemoteClientTests: XCTestCase {
    func testRemoteStartCachesConcurrentRequestsAndFailuresWithoutRelaunching() async {
        actor Counter {
            var count = 0
            func start() async -> RemoteCommandResult {
                count += 1
                try? await Task.sleep(for: .milliseconds(20))
                return .rejected("startup_failed", "Synthetic startup failure")
            }
        }
        let counter = Counter()
        let client = RemoteClient(deviceID: UUID(), stateHandler: { _, _ in }, commandHandler: { _ in .completed },
            sessionStartHandler: { _ in await counter.start() })
        let id = UUID()
        let request = RemoteSessionStart(commandID: id, sessionID: id, workspaceID: "authorized",
            toolKey: "codex", runtimeMode: "acp", displayName: nil, rows: 24, columns: 80)
        async let first = client.executeSessionStart(request)
        async let second = client.executeSessionStart(request)
        let results = await [first, second]
        XCTAssertTrue(results.allSatisfy { !$0.succeeded && $0.errorCode == "startup_failed" })
        let replay = await client.executeSessionStart(request)
        XCTAssertEqual(replay.errorCode, "startup_failed")
        let count = await counter.count
        XCTAssertEqual(count, 1)
        let changed = RemoteSessionStart(commandID: id, sessionID: id, workspaceID: "other",
            toolKey: "codex", runtimeMode: "acp", displayName: nil, rows: 24, columns: 80)
        let conflict = await client.executeSessionStart(changed)
        XCTAssertEqual(conflict.errorCode, "conflict")
    }

    func testDecodesRemoteStartWithoutAnExistingSessionAndRejectsUnsafeFields() async {
        let client = RemoteClient(deviceID: UUID(), stateHandler: { _, _ in }, commandHandler: { _ in .completed })
        let id = UUID()
        let payload: [String: JSONValue] = [
            "workspaceId": .string("workspace-1"), "toolKey": .string("codex"), "runtimeMode": .string("acp"),
        ]
        func envelope(_ input: [String: JSONValue], commandID: UUID? = nil) -> IncomingRelayEnvelope {
            IncomingRelayEnvelope(type: "session.start", protocolVersion: "2", messageId: UUID(),
                deviceId: "device", sessionId: id.uuidString, commandId: commandID ?? id, payload: .object(input))
        }
        let decoded = await client.decodeSessionStart(envelope(payload))
        XCTAssertEqual(decoded?.sessionID, id)
        XCTAssertEqual(decoded?.runtimeMode, "acp")
        var pty = payload
        pty["toolKey"] = .string("shell")
        pty["runtimeMode"] = .string("pty")
        pty["rows"] = .number(40)
        pty["columns"] = .number(120)
        let terminal = await client.decodeSessionStart(envelope(pty))
        XCTAssertEqual(terminal?.rows, 40)
        XCTAssertEqual(terminal?.columns, 120)
        pty.removeValue(forKey: "rows")
        let missingSize = await client.decodeSessionStart(envelope(pty))
        XCTAssertNil(missingSize)
        for (key, value) in [("path", JSONValue.string("/tmp")), ("initialPrompt", .string("run")),
                             ("rows", .number(0)), ("runtimeMode", .string("invalid"))] {
            var changed = payload
            changed[key] = value
            let rejected = await client.decodeSessionStart(envelope(changed))
            XCTAssertNil(rejected)
        }
        let mismatched = await client.decodeSessionStart(envelope(payload, commandID: UUID()))
        XCTAssertNil(mismatched)
    }

    func testDecodesFilePreviewWithoutCommandOrSequence() async {
        let client = RemoteClient(deviceID: UUID(), stateHandler: { _, _ in },
                                  commandHandler: { _ in .completed })
        let sessionID = UUID()
        let requestID = UUID()
        func envelope(commandID: UUID? = nil, session: String? = nil) -> IncomingRelayEnvelope {
            IncomingRelayEnvelope(
                type: "file.preview.request", protocolVersion: "2", messageId: UUID(),
                deviceId: "device", sessionId: session ?? sessionID.uuidString, commandId: commandID,
                payload: .object([
                    "requestId": .string(requestID.uuidString),
                    "workspaceId": .string("workspace-1"),
                    "path": .string("/project/readme.md"),
                ])
            )
        }
        let decoded = await client.decodeFilePreviewRequest(envelope())
        XCTAssertEqual(decoded?.sessionID, sessionID)
        XCTAssertEqual(decoded?.requestID, requestID)
        XCTAssertEqual(decoded?.workspaceID, "workspace-1")
        XCTAssertEqual(decoded?.path, "/project/readme.md")
        let withCommand = await client.decodeFilePreviewRequest(envelope(commandID: UUID()))
        let withoutSession = await client.decodeFilePreviewRequest(envelope(session: "invalid"))
        XCTAssertNil(withCommand)
        XCTAssertNil(withoutSession)
    }

    func testDecodesOnlyValidShortcutCommands() async {
        let client = RemoteClient(deviceID: UUID(), stateHandler: { _, _ in },
                                  commandHandler: { _ in .completed })
        let runID = UUID()
        let shortcutID = UUID()
        let start = IncomingRelayEnvelope(
            type: "shortcut.run.start", protocolVersion: "2", messageId: UUID(),
            deviceId: "device", sessionId: nil, commandId: nil, payload: .object([
                "runId": .string(runID.uuidString), "shortcutId": .string(shortcutID.uuidString),
                "revision": .number(2),
            ])
        )
        guard case .start(let run, let shortcut, let revision) = await client.decodeQuickActionCommand(start) else {
            return XCTFail("Expected shortcut start")
        }
        XCTAssertEqual(run, runID)
        XCTAssertEqual(shortcut, shortcutID)
        XCTAssertEqual(revision, 2)
        let invalid = IncomingRelayEnvelope(
            type: "shortcut.run.start", protocolVersion: "2", messageId: UUID(),
            deviceId: "device", sessionId: nil, commandId: nil, payload: .object([
                "runId": .string(runID.uuidString), "shortcutId": .string(shortcutID.uuidString),
                "revision": .number(0),
            ])
        )
        let rejected = await client.decodeQuickActionCommand(invalid)
        XCTAssertNil(rejected)
    }

    func testDecodesOnlyLimitedShortcutConfirmationInput() async {
        let client = RemoteClient(deviceID: UUID(), stateHandler: { _, _ in },
                                  commandHandler: { _ in .completed })
        let runID = UUID()
        let commandID = UUID()
        func envelope(_ answer: String, commandId: UUID? = nil) -> IncomingRelayEnvelope {
            IncomingRelayEnvelope(
                type: "shortcut.run.input", protocolVersion: "2", messageId: UUID(),
                deviceId: "device", sessionId: nil, commandId: commandId,
                payload: .object([
                    "runId": .string(runID.uuidString),
                    "commandId": .string(commandID.uuidString),
                    "answer": .string(answer),
                ])
            )
        }
        let accepted = await client.decodeQuickActionInput(envelope("yes"))
        XCTAssertEqual(accepted?.runID, runID)
        XCTAssertEqual(accepted?.commandID, commandID)
        XCTAssertEqual(accepted?.answer, .yes)
        let rejected = await client.decodeQuickActionInput(envelope("password"))
        XCTAssertNil(rejected)
        let wrongChannel = await client.decodeQuickActionInput(envelope("y", commandId: commandID))
        XCTAssertNil(wrongChannel)
    }

    func testPairingAPIURLUsesTheWebSocketOrigin() throws {
        let websocketURL = try XCTUnwrap(URL(string: "wss://relay.example.com/ws/client-public?ignored=1"))
        let apiURL = try ClientPairingClient.apiURL(
            serverWebSocketURL: websocketURL,
            path: "/api/client-pairings"
        )

        XCTAssertEqual(apiURL.absoluteString, "https://relay.example.com/api/client-pairings")
    }

    func testRelayOutboxPersistsAndPrunesOnlyConfirmedEvents() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("termrelay-outbox-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let sessionID = UUID()
        let store = RelayOutboxStore(deviceID: UUID(), directory: root)
        let first = RelayPendingEvent.terminal(TerminalOutputBatch(
            sessionID: sessionID,
            sequence: 1,
            capturedAt: Date(timeIntervalSince1970: 1),
            bytes: Data("first".utf8)
        ))
        let second = RelayPendingEvent.terminal(TerminalOutputBatch(
            sessionID: sessionID,
            sequence: 2,
            capturedAt: Date(timeIntervalSince1970: 2),
            bytes: Data("second".utf8)
        ))

        try store.save(second)
        try store.save(first)
        XCTAssertEqual(try store.load().map(\.sequence), [1, 2])

        try store.remove(sessionID: sessionID, through: 1)
        let remaining = try store.load()
        XCTAssertEqual(remaining.map(\.sequence), [2])
        XCTAssertEqual(remaining.first?.terminalData, Data("second".utf8))
    }

    func testDecodesInputAndResizeCommands() async throws {
        let client = RemoteClient(
            deviceID: UUID(),
            stateHandler: { _, _ in },
            commandHandler: { _ in .completed }
        )
        let commandID = UUID()
        let sessionID = UUID()
        let input = IncomingRelayEnvelope(
            type: "terminal.input",
            protocolVersion: "2",
            messageId: UUID(),
            deviceId: "device",
            sessionId: sessionID.uuidString,
            commandId: commandID,
            payload: .object([
                "encoding": .string("base64"),
                "data": .string(Data("hello".utf8).base64EncodedString()),
            ])
        )

        guard case .input(let decodedCommandID, let decodedSessionID, let data) =
            await client.decodeCommand(input)
        else { return XCTFail("Expected terminal input") }
        XCTAssertEqual(decodedCommandID, commandID)
        XCTAssertEqual(decodedSessionID, sessionID)
        XCTAssertEqual(data, Data("hello".utf8))

        let resize = IncomingRelayEnvelope(
            type: "terminal.resize",
            protocolVersion: "2",
            messageId: UUID(),
            deviceId: "device",
            sessionId: sessionID.uuidString,
            commandId: commandID,
            payload: .object(["columns": .number(120), "rows": .number(36)])
        )
        guard case .resize(_, _, let columns, let rows) = await client.decodeCommand(resize)
        else { return XCTFail("Expected terminal resize") }
        XCTAssertEqual(columns, 120)
        XCTAssertEqual(rows, 36)
    }

    func testRejectsMalformedRemoteCommand() async {
        let client = RemoteClient(
            deviceID: UUID(),
            stateHandler: { _, _ in },
            commandHandler: { _ in .completed }
        )
        let malformed = IncomingRelayEnvelope(
            type: "terminal.input",
            protocolVersion: "2",
            messageId: UUID(),
            deviceId: "device",
            sessionId: UUID().uuidString,
            commandId: UUID(),
            payload: .object(["encoding": .string("base64"), "data": .string("not base64")])
        )
        let result = await client.decodeCommand(malformed)
        XCTAssertNil(result)
    }

    func testDecodesStructuredTurnAndApprovalCommands() async {
        let client = RemoteClient(
            deviceID: UUID(),
            stateHandler: { _, _ in },
            commandHandler: { _ in .completed }
        )
        let sessionID = UUID()
        func envelope(type: String, payload: JSONValue) -> IncomingRelayEnvelope {
            IncomingRelayEnvelope(
                type: type,
                protocolVersion: "2",
                messageId: UUID(),
                deviceId: "device",
                sessionId: sessionID.uuidString,
                commandId: UUID(),
                payload: payload
            )
        }
        let turn = await client.decodeCommand(envelope(
            type: "tool.turn.start",
            payload: .object(["text": .string("fix the tests")])
        ))
        guard case .startTurn(_, _, let text) = turn else {
            return XCTFail("Expected structured turn command")
        }
        XCTAssertEqual(text, "fix the tests")

        let approval = await client.decodeCommand(envelope(
            type: "tool.approval.resolve",
            payload: .object([
                "approvalId": .string("approval-1"),
                "turnId": .string("turn-1"),
                "decision": .string("allowOnce"),
            ])
        ))
        guard case .resolveApproval(_, _, let approvalID, let turnID, let decision) = approval else {
            return XCTFail("Expected approval command")
        }
        XCTAssertEqual(approvalID, "approval-1")
        XCTAssertEqual(turnID, "turn-1")
        XCTAssertEqual(decision, .allowOnce)

        let userInput = await client.decodeCommand(envelope(
            type: "tool.user-input.resolve",
            payload: .object([
                "requestId": .string("input-1"), "turnId": .string("turn-1"),
                "answers": .object(["strategy": .array([.string("修复")])]),
            ])
        ))
        guard case .resolveUserInput(_, _, let requestID, let inputTurnID, let answers) = userInput else {
            return XCTFail("Expected requestUserInput resolution")
        }
        XCTAssertEqual(requestID, "input-1")
        XCTAssertEqual(inputTurnID, "turn-1")
        XCTAssertEqual(answers, ["strategy": ["修复"]])
    }
}
