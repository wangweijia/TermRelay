import Foundation
import XCTest
@testable import TermRelay

final class RemoteClientTests: XCTestCase {
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
            protocolVersion: "1",
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
            protocolVersion: "1",
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
            protocolVersion: "1",
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
                protocolVersion: "1",
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
    }
}
