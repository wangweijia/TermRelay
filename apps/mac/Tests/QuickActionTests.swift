import Foundation
import Darwin
import XCTest
@testable import TermRelay

final class QuickActionTests: XCTestCase {
    func testStorePersistsOnlyOnMacAndSupportsDeletion() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("termrelay-quick-tests-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = QuickActionStore(directory: directory)
        var action = QuickAction.draft(directory: directory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        action.name = "部署"
        action.command = "printf 'ok'"
        action.revision = 1
        action.proxy.mode = .disabled
        try store.save([action])
        XCTAssertEqual(try store.load(), [action])
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        try store.save([])
        XCTAssertTrue(try store.load().isEmpty)
    }

    func testPublishedMetadataDoesNotContainCommandsOrProxyAddresses() throws {
        let entry = QuickActionCatalogEntry(
            id: UUID().uuidString, revision: 1, name: "部署", description: "生产",
            workspaceId: "opaque-workspace", proxyMode: "custom",
            requiresConfirmation: true
        )
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(entry))
            as? [String: Any])
        XCTAssertEqual(payload["workspaceId"] as? String, "opaque-workspace")
        XCTAssertNil(payload["command"])
        XCTAssertNil(payload["directory"])
        XCTAssertNil(payload["httpsProxy"])
    }

    @MainActor
    func testAppModelEditsRevisionAndPersistsCatalog() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("termrelay-quick-model-\(UUID())")
        let suiteName = "QuickActionTests.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: directory)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = QuickActionStore(directory: directory)
        let model = AppModel(defaults: defaults, quickActionStore: store)
        var action = QuickAction.draft(directory: directory)
        action.name = "部署"
        action.command = "true"
        try model.saveQuickAction(action)
        XCTAssertEqual(model.quickActions.first?.revision, 1)
        action.description = "第二版"
        try model.saveQuickAction(action)
        XCTAssertEqual(model.quickActions.first?.revision, 2)
        XCTAssertEqual(try store.load().first?.description, "第二版")
        try model.deleteQuickAction(id: action.id)
        XCTAssertTrue(model.quickActions.isEmpty)
        XCTAssertTrue(try store.load().isEmpty)
    }

    @MainActor
    func testRunnerUsesPerRunProxyAndReportsExitCode() async throws {
        let directory = FileManager.default.temporaryDirectory
        let runner = QuickActionRunner { _ in }
        var action = QuickAction.draft(directory: directory)
        action.name = "检查"
        action.command = "printf '%s' \"${HTTPS_PROXY:-none}\"; exit 7"
        action.proxy.mode = .disabled
        let runID = UUID()
        try runner.start(action, runID: runID)
        do {
            try runner.start(action, runID: UUID())
            XCTFail("Concurrent run should be rejected")
        } catch {}
        for _ in 0..<100 where runner.runs[runID]?.status == "running" {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(runner.runs[runID]?.status, "failed")
        XCTAssertEqual(runner.runs[runID]?.exitCode, 7)
        XCTAssertEqual(runner.runs[runID]?.output, "none")

        action.proxy.mode = .custom
        action.proxy.httpsProxy = "http://127.0.0.1:7890"
        action.command = "printf '%s' \"$HTTPS_PROXY\""
        let secondID = UUID()
        try runner.start(action, runID: secondID)
        for _ in 0..<100 where runner.runs[secondID]?.status == "running" {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(runner.runs[secondID]?.status, "succeeded")
        XCTAssertEqual(runner.runs[secondID]?.output, action.proxy.httpsProxy)
    }

    @MainActor
    func testCancelTerminatesTheShortcutProcessGroup() async throws {
        let runner = QuickActionRunner { _ in }
        var action = QuickAction.draft(directory: FileManager.default.temporaryDirectory)
        action.name = "等待"
        action.command = "printf 'CHILD=%s\\n' $$; sleep 8"
        let runID = UUID()
        try runner.start(action, runID: runID)
        for _ in 0..<100 where runner.runs[runID]?.output.contains("CHILD=") != true {
            try await Task.sleep(for: .milliseconds(20))
        }
        let output = try XCTUnwrap(runner.runs[runID]?.output)
        let child = try XCTUnwrap(
            output.split(separator: "\n").first(where: { $0.contains("CHILD=") })?
                .split(separator: "=").last.flatMap { Int32($0) }
        )
        runner.cancel(runID)
        for _ in 0..<100 where runner.runs[runID]?.status == "running" {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(runner.runs[runID]?.status, "cancelled")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(kill(child, 0), -1, "Shortcut child must not survive cancellation")
    }

    @MainActor
    func testDetachedOutputDoesNotLeaveRunStuck() async throws {
        let runner = QuickActionRunner { _ in }
        var action = QuickAction.draft(directory: FileManager.default.temporaryDirectory)
        action.name = "后台进程"
        action.command = "sleep 8 &"
        let runID = UUID()
        try runner.start(action, runID: runID)
        for _ in 0..<100 where runner.runs[runID]?.status == "running" {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(runner.runs[runID]?.status, "succeeded")
    }

    @MainActor
    func testRunnerAcceptsManualConfirmationOnControllingTerminalOnce() async throws {
        let runner = QuickActionRunner { _ in }
        var action = QuickAction.draft(directory: FileManager.default.temporaryDirectory)
        action.name = "交互确认"
        action.command = """
            printf '\\033[31mPROMPT>\\033[0m'
            read answer </dev/tty
            printf 'first=%s\\n' "$answer"
            read -t 1 other </dev/tty
            printf 'second=%s\\n' "$other"
            """
        let runID = UUID()
        let request = QuickActionInputRequest(runID: runID, commandID: UUID(), answer: .y)
        XCTAssertThrowsError(try runner.sendInput(request))
        try runner.start(action, runID: runID)
        for _ in 0..<100 where runner.runs[runID]?.output.contains("PROMPT>") != true {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(runner.runs[runID]?.output.contains("PROMPT>") == true,
                      "\(String(describing: runner.runs[runID]))")
        XCTAssertEqual(runner.runs[runID]?.status, "running",
                       "\(String(describing: runner.runs[runID]))")
        try runner.sendInput(request)
        try runner.sendInput(request)
        for _ in 0..<150 where runner.runs[runID]?.status == "running" {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(runner.runs[runID]?.status, "succeeded")
        XCTAssertTrue(runner.runs[runID]?.output.contains("first=y") == true)
        XCTAssertTrue(runner.runs[runID]?.output.contains("second=") == true)
        XCTAssertFalse(runner.runs[runID]?.output.contains("second=y") == true)
        XCTAssertFalse(runner.runs[runID]?.output.contains("\u{001B}") == true)
        XCTAssertThrowsError(try runner.sendInput(request))
    }
}
