import XCTest
@testable import TermRelay

final class ManagedSessionTests: XCTestCase {
    func testLocalSessionMetadataDefaultsToStartingPTY() {
        let session = ManagedSession(directory: URL(fileURLWithPath: "/tmp/project"), toolID: "shell")
        XCTAssertEqual(session.state, .starting)
        XCTAssertEqual(session.runtimeMode, .pty)
        XCTAssertNil(session.projectID)
    }

    func testArchivePreservesServerStateAndRuntimeMode() {
        let session = ManagedSession(
            directory: URL(fileURLWithPath: "/tmp/project"),
            toolID: "codex",
            runtimeMode: .acp,
            state: .finished,
            projectID: "project"
        )
        XCTAssertEqual(session.state, .finished)
        XCTAssertEqual(session.runtimeMode, .acp)
        XCTAssertEqual(session.projectID, "project")
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
