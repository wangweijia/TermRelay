import Foundation
import XCTest
@testable import TermRelay

final class SessionSidebarSelectionTests: XCTestCase {
    private func session(projectID: String? = nil) -> ManagedSession {
        ManagedSession(directory: URL(fileURLWithPath: "/tmp"), toolID: "codex", projectID: projectID)
    }

    func testClickingProjectsSelectsProjectAndDoesNotBounceBackToActive() {
        let manual = session()
        let project = session(projectID: "api")
        let sessions = [project, manual]
        let selected = SessionSidebarTab.projects.selection(current: manual.id, sessions: sessions, historyIDs: [])
        XCTAssertEqual(selected, project.id)
        XCTAssertEqual(SessionSidebarTab.containing(selection: selected, sessions: sessions, historyIDs: []), .projects)
        XCTAssertEqual(SessionSidebarTab.projects.selection(current: selected, sessions: sessions, historyIDs: []), project.id)
    }

    func testSwitchingBackToActiveSelectsOnlyManualSessions() {
        let manual = session()
        let project = session(projectID: "api")
        let sessions = [manual, project]
        let selected = SessionSidebarTab.active.selection(current: project.id, sessions: sessions, historyIDs: [])
        XCTAssertEqual(selected, manual.id)
        XCTAssertEqual(SessionSidebarTab.containing(selection: selected, sessions: sessions, historyIDs: []), .active)
        XCTAssertTrue(SessionSidebarTab.active.contains(manual))
        XCTAssertFalse(SessionSidebarTab.active.contains(project))
        XCTAssertTrue(SessionSidebarTab.projects.contains(project))
        XCTAssertFalse(SessionSidebarTab.projects.contains(manual))
    }

    func testClosingProjectKeepsSelectionInProjectsInsteadOfChoosingManualSession() {
        let closed = session(projectID: "api")
        let remaining = session(projectID: "api")
        let manual = session()
        XCTAssertEqual(SessionSidebarTab.projects.selection(current: closed.id, sessions: [remaining, manual], historyIDs: []), remaining.id)
        XCTAssertNil(SessionSidebarTab.projects.selection(current: closed.id, sessions: [manual], historyIDs: []))
    }

    func testEmptyTabClearsSelectionWithoutChangingTab() {
        let manual = session()
        let history = UUID()
        let selected = SessionSidebarTab.projects.selection(current: manual.id, sessions: [manual], historyIDs: [history])
        XCTAssertNil(selected)
        XCTAssertNil(SessionSidebarTab.containing(selection: selected, sessions: [manual], historyIDs: [history]))
        XCTAssertNil(SessionSidebarTab.active.selection(current: history, sessions: [], historyIDs: [history]))
    }

    func testHistorySelectionIsPreservedAndUsesFirstHistoryAsFallback() {
        let manual = session()
        let history = [UUID(), UUID()]
        XCTAssertEqual(SessionSidebarTab.history.selection(current: manual.id, sessions: [manual], historyIDs: history), history.first)
        XCTAssertEqual(SessionSidebarTab.history.selection(current: history.last, sessions: [manual], historyIDs: history), history.last)
        XCTAssertEqual(SessionSidebarTab.containing(selection: history.last, sessions: [manual], historyIDs: history), .history)
        XCTAssertFalse(SessionSidebarTab.history.contains(manual))
    }

    func testApprovalsAndNewSessionsResolveTheirActualTab() {
        let manual = session()
        let project = session(projectID: "api")
        let sessions = [manual, project]
        XCTAssertEqual(SessionSidebarTab.containing(selection: project.id, sessions: sessions, historyIDs: []), .projects)
        XCTAssertEqual(SessionSidebarTab.containing(selection: manual.id, sessions: sessions, historyIDs: []), .active)
        XCTAssertNil(SessionSidebarTab.containing(selection: UUID(), sessions: sessions, historyIDs: []))
    }
}
