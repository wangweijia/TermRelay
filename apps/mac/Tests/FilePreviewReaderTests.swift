import Foundation
import XCTest
@testable import TermRelay

final class FilePreviewReaderTests: XCTestCase {
    func testWorkspaceBoundaryAndSymlinks() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let workspace = root.appendingPathComponent("work")
        let sibling = root.appendingPathComponent("work-other")
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        let inside = workspace.appendingPathComponent("file.md")
        let outside = sibling.appendingPathComponent("secret.md")
        try "inside".write(to: inside, atomically: true, encoding: .utf8)
        try "outside".write(to: outside, atomically: true, encoding: .utf8)
        let linkedInside = workspace.appendingPathComponent("linked.markdown")
        let linkedOutside = workspace.appendingPathComponent("external.md")
        let linkedDirectory = workspace.appendingPathComponent("linked-directory")
        try FileManager.default.createSymbolicLink(at: linkedInside, withDestinationURL: inside)
        try FileManager.default.createSymbolicLink(at: linkedOutside, withDestinationURL: outside)
        try FileManager.default.createSymbolicLink(at: linkedDirectory, withDestinationURL: sibling)

        XCTAssertEqual(preview(inside.path, workspace: workspace).status, .ok)
        XCTAssertEqual(preview(inside.path, workspace: workspace).content, "inside")
        XCTAssertEqual(preview(linkedInside.path, workspace: workspace).status, .ok)
        XCTAssertEqual(preview(linkedOutside.path, workspace: workspace).status, .forbidden)
        XCTAssertEqual(preview(linkedDirectory.appendingPathComponent("secret.md").path,
                               workspace: workspace).status, .forbidden)
        XCTAssertEqual(preview(outside.path, workspace: workspace).status, .forbidden)
        XCTAssertEqual(preview(workspace.path + "/../work-other/secret.md", workspace: workspace).status, .forbidden)
        XCTAssertEqual(preview("file.md", workspace: workspace).status, .unsupported)
        XCTAssertNil(preview(outside.path, workspace: workspace).content)
    }

    func testSizeFormatAndMissingFiles() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let exact = root.appendingPathComponent("exact.markdown")
        let oversized = root.appendingPathComponent("large.md")
        let invalid = root.appendingPathComponent("invalid.md")
        let other = root.appendingPathComponent("other.txt")
        try Data(repeating: 65, count: FilePreviewReader.maxBytes).write(to: exact)
        try Data(repeating: 65, count: FilePreviewReader.maxBytes + 1).write(to: oversized)
        try Data([0xff, 0xfe]).write(to: invalid)
        try Data("text".utf8).write(to: other)

        let accepted = preview(exact.path, workspace: root)
        XCTAssertEqual(accepted.status, .ok)
        XCTAssertEqual(accepted.name, "exact.markdown")
        XCTAssertEqual(accepted.content?.utf8.count, FilePreviewReader.maxBytes)
        XCTAssertEqual(preview(oversized.path, workspace: root).status, .too_large)
        XCTAssertEqual(preview(invalid.path, workspace: root).status, .unsupported)
        XCTAssertEqual(preview(other.path, workspace: root).status, .unsupported)
        XCTAssertEqual(preview(root.appendingPathComponent("missing.md").path, workspace: root).status, .not_found)
        XCTAssertNil(preview(oversized.path, workspace: root).content)
    }

    private func preview(_ path: String, workspace: URL) -> FilePreviewResult {
        FilePreviewReader.read(requestId: UUID(), path: path, workspace: workspace)
    }

    private func makeDirectory() throws -> URL {
        let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".build/file-preview-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
