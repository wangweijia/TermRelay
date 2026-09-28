import Foundation
import XCTest
@testable import TermRelay

final class PendingApprovalInboxTests: XCTestCase {
    func testApprovalsAreScopedToSessionsAndRemovedWhenResolvedOrTurnEnds() {
        let first = UUID()
        let second = UUID()
        var inbox = PendingApprovalInbox()
        inbox.apply(event(first, .approvalRequested(request("one"))))
        inbox.apply(event(first, .approvalRequested(request("two"))))
        inbox.apply(event(second, .approvalRequested(request("one"))))
        XCTAssertEqual(inbox.bySession[first]?.count, 2)
        XCTAssertEqual(inbox.bySession[second]?.count, 1)

        inbox.apply(event(first, .approvalResolved(
            approvalID: "one", turnID: "turn", decision: .allowOnce
        )))
        XCTAssertEqual(inbox.bySession[first]?.count, 1)
        XCTAssertNotNil(inbox.bySession[first]?["two"])
        XCTAssertEqual(inbox.bySession[second]?.count, 1)

        inbox.apply(event(first, .turnCompleted(turnID: "turn", status: .failed)))
        XCTAssertNil(inbox.bySession[first])
        XCTAssertEqual(inbox.bySession[second]?.count, 1)

        inbox.clear(sessionID: second)
        XCTAssertTrue(inbox.bySession.isEmpty)
    }

    func testFailedSessionClearsStaleApprovals() {
        let sessionID = UUID()
        var inbox = PendingApprovalInbox()
        inbox.apply(event(sessionID, .approvalRequested(request("pending"))))
        inbox.apply(event(sessionID, .failed(code: "agent", message: "Disconnected")))
        XCTAssertTrue(inbox.bySession.isEmpty)
    }

    private func event(_ sessionID: UUID, _ payload: ToolEventPayload) -> ToolEvent {
        ToolEvent(
            sessionID: sessionID, sequence: 1, occurredAt: Date(),
            correlation: AgentCorrelation(turnID: "turn", itemID: nil, approvalID: nil),
            payload: payload
        )
    }

    private func request(_ id: String) -> ApprovalRequest {
        ApprovalRequest(
            approvalID: id, turnID: "turn", itemID: nil, kind: "command",
            risk: .medium, title: "执行命令", detail: "echo test",
            availableDecisions: [.allowOnce, .deny], expiresAt: Date().addingTimeInterval(60)
        )
    }
}
