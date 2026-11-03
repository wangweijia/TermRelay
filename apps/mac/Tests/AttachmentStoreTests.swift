import CoreGraphics
import CoreText
import Foundation
import XCTest
@testable import TermRelay

final class AttachmentStoreTests: XCTestCase {
    func testChunkRetriesAreIdempotentAndSessionScoped() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AttachmentStore(root: root)
        let session = UUID(), id = UUID()
        let metadata = ChatAttachment(id: id.uuidString.lowercased(), name: "notes.txt", mimeType: "text/plain", size: 11)
        func upload(_ offset: Int, _ value: String, final: Bool) -> AttachmentTransfer {
            AttachmentTransfer(requestId: UUID(), workspaceId: "workspace", operation: "upload", attachmentId: id,
                offset: offset, attachment: metadata, data: Data(value.utf8).base64EncodedString(), final: final)
        }
        var result = await store.transfer(sessionID: session, request: upload(0, "hello ", final: false))
        XCTAssertEqual(result.status, "ok")
        result = await store.transfer(sessionID: session, request: upload(0, "hello ", final: false))
        XCTAssertEqual(result.status, "ok")
        result = await store.transfer(sessionID: session, request: upload(0, "other!", final: false))
        XCTAssertEqual(result.status, "error")
        result = await store.transfer(sessionID: session, request: upload(6, "world", final: true))
        XCTAssertEqual(result.status, "ok")
        result = await store.transfer(sessionID: session, request: upload(6, "world", final: true))
        XCTAssertEqual(result.status, "ok")
        let read = AttachmentTransfer(requestId: UUID(), workspaceId: "workspace", operation: "read", attachmentId: id,
            offset: 0, attachment: nil, data: nil, final: nil)
        result = await store.transfer(sessionID: UUID(), request: read)
        XCTAssertEqual(result.status, "error")
        result = await store.transfer(sessionID: session, request: read)
        XCTAssertEqual(result.data, Data("hello world".utf8).base64EncodedString())
        let prepared = try await store.prepare(sessionID: session, ids: [metadata.id])
        XCTAssertEqual(prepared.first?.extractedText, "hello world")
        let input = TurnInput(text: "summarize", attachments: prepared)
        XCTAssertTrue(input.textWithDocuments.contains("hello world"))
        try await store.release(sessionID: session, attachments: prepared, used: true)
        do { try await store.removeDraft(sessionID: session, id: id); XCTFail("Sent files must be retained") } catch {}
        try await store.removeSession(session)
        result = await store.transfer(sessionID: session, request: read)
        XCTAssertEqual(result.status, "error")
    }

    func testRejectsTraversalInvalidFilesAndIncompleteUploads() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AttachmentStore(root: root), session = UUID()
        for (name, mime, data) in [("../escape.txt", "text/plain", Data("x".utf8)),
                                   ("fake.png", "image/png", Data("not an image".utf8)),
                                   ("fake.pdf", "application/pdf", Data("not a pdf".utf8)),
                                   ("binary.txt", "text/plain", Data([0xff, 0]))] {
            do { _ = try await store.importData(sessionID: session, name: name, mime: mime, data: data); XCTFail("Must reject \(name)") } catch {}
        }
        let id = UUID()
        let metadata = ChatAttachment(id: id.uuidString.lowercased(), name: "notes.txt", mimeType: "text/plain", size: 10)
        let request = AttachmentTransfer(requestId: UUID(), workspaceId: "workspace", operation: "upload", attachmentId: id,
            offset: 0, attachment: metadata, data: Data("half".utf8).base64EncodedString(), final: false)
        let result = await store.transfer(sessionID: session, request: request)
        XCTAssertEqual(result.status, "ok")
        do { _ = try await store.prepare(sessionID: session, ids: [metadata.id]); XCTFail("Partial upload must not be sent") } catch {}
    }

    func testExtractsPDFTextAndPreservesAttachmentOnlyHistory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AttachmentStore(root: root), session = UUID()
        let pdf = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: pdf))
        var box = CGRect(x: 0, y: 0, width: 400, height: 300)
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &box, nil))
        context.beginPDFPage(nil)
        let font = CTFontCreateWithName("Helvetica" as CFString, 14, nil)
        let line = CTLineCreateWithAttributedString(NSAttributedString(string: "Attachment PDF test", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font]))
        context.textPosition = CGPoint(x: 20, y: 200)
        CTLineDraw(line, context)
        context.endPDFPage(); context.closePDF()
        let attachment = try await store.importData(sessionID: session, name: "document.pdf", mime: "application/pdf", data: pdf as Data)
        let prepared = try await store.prepare(sessionID: session, ids: [attachment.id])
        XCTAssertTrue(prepared.first?.extractedText?.contains("Attachment PDF test") == true)
        let history = RelayHistoryEvent(seq: 1, type: "tool.event", payload: .object([
            "kind": .string("user.message"), "data": .object(["text": .string(""), "attachments": .array([attachment.json])]),
        ]), createdAt: RelayDate.now())
        XCTAssertEqual(CopilotHistory.messages(from: [history]).first?.attachments, [attachment])
        try await store.release(sessionID: session, attachments: prepared, used: false)
    }

    func testImageInputAndWireIdentifiers() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = AttachmentStore(root: root), session = UUID()
        let data = try XCTUnwrap(Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr9sAAAAASUVORK5CYII="))
        let attachment = try await store.importData(sessionID: session, name: "image.png", mime: "image/png", data: data)
        let prepared = try await store.prepare(sessionID: session, ids: [attachment.id])
        let blocks = try TurnInput(text: "", attachments: prepared).acpContent(supportsImages: true)
        XCTAssertEqual(blocks.last?.object?["type"]?.string, "image")
        XCTAssertEqual(blocks.last?.object?["data"]?.string, data.base64EncodedString())
        let screenshot = AgentImage(data: data.base64EncodedString(), mimeType: "image/png")
        let combined = try TurnInput(text: "", images: [screenshot], attachments: prepared).acpContent(supportsImages: true)
        XCTAssertEqual(combined.count, 3)
        for block in combined.dropFirst() {
            XCTAssertEqual(block.object?["type"]?.string, "image")
            XCTAssertEqual(block.object?["mimeType"]?.string, "image/png")
            XCTAssertEqual(block.object?["data"]?.string, data.base64EncodedString())
        }
        XCTAssertThrowsError(try TurnInput(text: "", images: [screenshot], attachments: prepared).acpContent(supportsImages: false))
        XCTAssertThrowsError(try TurnInput(text: "", images: [screenshot]).acpContent(supportsImages: false))
        let requestID = UUID()
        let result = AttachmentTransferResult(requestId: requestID, status: "ok")
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as? [String: Any]
        XCTAssertEqual(json?["requestId"] as? String, requestID.uuidString.lowercased())
        try await store.release(sessionID: session, attachments: prepared, used: false)
    }

    func testACPImageCapabilityIsRequiredAndNoBytesEnterHistory() throws {
        let metadata = ChatAttachment(id: UUID().uuidString.lowercased(), name: "image.png", mimeType: "image/png", size: 1)
        let input = TurnInput(text: "", attachments: [.init(metadata: metadata, url: URL(fileURLWithPath: "/unused"), extractedText: nil)])
        XCTAssertThrowsError(try input.acpContent(supportsImages: false))
        let encoded = try JSONEncoder().encode(metadata)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("/unused"))
    }
}
