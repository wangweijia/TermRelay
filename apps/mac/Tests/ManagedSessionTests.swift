import XCTest
@testable import TermRelay

final class ManagedSessionTests: XCTestCase {
    func testHappyPathTransitions() throws {
        var session = ManagedSession(directory: URL(fileURLWithPath: "/tmp/project"), toolID: "codex")
        try session.transition(to: .running)
        try session.transition(to: .stopping)
        try session.transition(to: .finished)
        XCTAssertEqual(session.state, .finished)
    }

    func testFinishedSessionCannotRestart() throws {
        var session = ManagedSession(
            directory: URL(fileURLWithPath: "/tmp/project"),
            toolID: "codex",
            state: .finished
        )
        XCTAssertThrowsError(try session.transition(to: .running))
    }

    func testUsesCustomNameAndFallsBackToDirectoryName() {
        let directory = URL(fileURLWithPath: "/tmp/project")
        XCTAssertEqual(
            ManagedSession(directory: directory, toolID: "codex", displayName: "  API 调试  ")
                .displayName,
            "API 调试"
        )
        XCTAssertEqual(
            ManagedSession(directory: directory, toolID: "shell", displayName: "  ").displayName,
            "project"
        )
    }
}
