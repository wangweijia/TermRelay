import Foundation
import XCTest
@testable import TermRelay

final class ProjectHistoryTests: XCTestCase {
    func testStreamingCompletionReplacesDeltasAndKeepsTurnsSeparate() {
        func event(_ seq: Int, _ kind: String, _ text: String, turn: String = "first") -> RelayHistoryEvent {
            .init(seq: seq, type: "tool.event", payload: .object([
                "kind": .string(kind), "correlation": .object(["turnId": .string(turn), "itemId": .string("answer")]),
                "data": .object(["text": .string(text)]),
            ]), createdAt: "")
        }
        let events = [event(1, "user.message", "Hello"), event(2, "assistant.delta", "A"),
                      event(3, "assistant.delta", "B"), event(4, "assistant.completed", "AB"),
                      event(5, "reasoning.delta", "Think", turn: "second"),
                      event(6, "reasoning.delta", " more", turn: "second"),
                      event(7, "assistant.delta", "Next", turn: "second")]
        XCTAssertEqual(ProjectHistory.messages(from: events, provider: "codex"), [
            .init(role: "用户", text: "Hello"), .init(role: "codex", text: "AB"),
            .init(role: "思考", text: "Think more"), .init(role: "codex", text: "Next"),
        ])
    }

    func testRemoteProjectSelectionStaysInProjectTab() {
        let archived = ManagedSession(directory: URL(fileURLWithPath: "/tmp"), toolID: "dsh",
                                      state: .finished, projectID: "api")
        let manual = ManagedSession(directory: URL(fileURLWithPath: "/tmp"), toolID: "shell")
        XCTAssertEqual(SessionSidebarTab.projects.selection(current: manual.id, sessions: [manual, archived], historyIDs: []), archived.id)
        XCTAssertEqual(SessionSidebarTab.containing(selection: archived.id, sessions: [manual, archived], historyIDs: []), .projects)
    }
}
