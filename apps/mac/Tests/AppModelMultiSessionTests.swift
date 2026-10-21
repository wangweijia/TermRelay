import XCTest
@testable import TermRelay

final class AppModelMultiSessionTests: XCTestCase {
    @MainActor
    func testRemoteShellRequiresLocalWorkspaceOptInAndRunsWithoutATerminalView() async throws {
        let suite = "AppModelRemoteStart-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = AppModel(defaults: defaults)
        model.sessionName = "Unchanged local draft"
        model.selectedTool = .copilot
        let id = UUID()
        let request = RemoteSessionStart(commandID: id, sessionID: id, workspaceID: "untrusted",
            toolKey: "shell", runtimeMode: "pty", displayName: "Remote", rows: 24, columns: 80)
        let rejected = await model.startRemoteSession(request)
        XCTAssertFalse(rejected.succeeded)
        XCTAssertTrue(model.sessions.isEmpty)
        XCTAssertFalse(model.currentWorkspaceAllowsRemoteStart)
        model.setCurrentWorkspaceRemoteStart(true)
        XCTAssertTrue(model.currentWorkspaceAllowsRemoteStart)
        let workspace = try XCTUnwrap(model.remoteWorkspaceIDs.first)
        let authorized = RemoteSessionStart(commandID: id, sessionID: id, workspaceID: workspace,
            toolKey: "shell", runtimeMode: "pty", displayName: "Remote", rows: 24, columns: 80)
        let created = await model.startRemoteSession(authorized)
        XCTAssertTrue(created.succeeded, created.message ?? "")
        XCTAssertEqual(model.sessions.count, 1)
        XCTAssertEqual(model.sessions.first?.id, id)
        XCTAssertEqual(model.sessions.first?.displayName, "Remote")
        XCTAssertEqual(model.terminalSession(id: id)?.state, .running)
        XCTAssertEqual(model.selectedTool, .copilot)
        XCTAssertEqual(model.sessionName, "Unchanged local draft")
        model.setCurrentWorkspaceRemoteStart(false)
        XCTAssertFalse(model.currentWorkspaceAllowsRemoteStart)
        XCTAssertEqual(model.terminalSession(id: id)?.state, .running)
        let duplicate = await model.startRemoteSession(authorized)
        XCTAssertFalse(duplicate.succeeded)
        XCTAssertEqual(model.sessions.count, 1)
        await model.terminateAllSessions()
    }

    @MainActor
    func testStartingSecondSessionKeepsFirstSessionRunning() async throws {
        let suiteName = "AppModelMultiSessionTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let model = AppModel(defaults: defaults)
        model.sessionName = "后端服务"
        let firstID = try XCTUnwrap(model.startLocalTerminal())
        let first = try XCTUnwrap(model.terminalSession(id: firstID))
        XCTAssertEqual(model.sessions.first?.displayName, "后端服务")
        XCTAssertEqual(model.sessionName, "")
        first.startIfNeeded()
        XCTAssertEqual(first.state, .running)

        model.sessionName = "测试窗口"
        let secondID = try XCTUnwrap(model.startLocalTerminal())

        XCTAssertNotEqual(firstID, secondID)
        XCTAssertEqual(model.terminalSessions.count, 2)
        XCTAssertEqual(first.state, .running)
        XCTAssertNotNil(model.terminalSession(id: secondID))
        XCTAssertEqual(model.sessions.last?.displayName, "测试窗口")

        await model.terminateAllSessions()
    }
}
