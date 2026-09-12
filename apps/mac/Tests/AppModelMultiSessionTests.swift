import XCTest
@testable import TermRelay

final class AppModelMultiSessionTests: XCTestCase {
    @MainActor
    func testStartingSecondSessionKeepsFirstSessionRunning() throws {
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

        model.terminateAllSessions()
    }
}
