import XCTest
@testable import TermRelay

final class AppModelMultiSessionTests: XCTestCase {
    @MainActor
    func testStartingSecondSessionKeepsFirstSessionRunning() throws {
        let suiteName = "AppModelMultiSessionTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let model = AppModel(defaults: defaults)
        let firstID = try XCTUnwrap(model.startLocalTerminal())
        let first = try XCTUnwrap(model.terminalSession(id: firstID))
        first.startIfNeeded()
        XCTAssertEqual(first.state, .running)

        let secondID = try XCTUnwrap(model.startLocalTerminal())

        XCTAssertNotEqual(firstID, secondID)
        XCTAssertEqual(model.terminalSessions.count, 2)
        XCTAssertEqual(first.state, .running)
        XCTAssertNotNil(model.terminalSession(id: secondID))

        model.terminateAllSessions()
    }
}
