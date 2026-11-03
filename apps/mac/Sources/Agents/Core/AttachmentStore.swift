import Foundation
import PDFKit
import ImageIO

struct ChatAttachment: Codable, Sendable, Equatable, Identifiable {
    let id: String
    let name: String
    let mimeType: String
    let size: Int

    static func decodeList(_ value: JSONValue?) -> [ChatAttachment] {
        guard let value, let data = try? JSONEncoder().encode(value) else { return [] }
        return (try? JSONDecoder().decode([ChatAttachment].self, from: data)) ?? []
    }

    var json: JSONValue {
        .object(["id": .string(id), "name": .string(name), "mimeType": .string(mimeType), "size": .number(Double(size))])
    }
}

struct PreparedAttachment: Sendable, Equatable {
    let metadata: ChatAttachment
    let url: URL
    let extractedText: String?
}

struct AttachmentTransfer: Codable, Sendable {
    let requestId: UUID
    let workspaceId: String
    let operation: String
    let attachmentId: UUID
    let offset: Int
    let attachment: ChatAttachment?
    let data: String?
    let final: Bool?
}

struct AttachmentTransferResult: Encodable, Sendable {
    let requestId: String
    let status: String
    var attachment: ChatAttachment? = nil
    var data: String? = nil
    var message: String? = nil

    init(requestId: UUID, status: String, attachment: ChatAttachment? = nil, data: String? = nil, message: String? = nil) {
        self.requestId = requestId.uuidString.lowercased()
        self.status = status
        self.attachment = attachment
        self.data = data
        self.message = message
    }
}

/// Owns attachment bytes. Only opaque IDs and metadata leave the device.
actor AttachmentStore {
    static let shared = AttachmentStore()
    static let maximumFileSize = 20 * 1024 * 1024
    static let chunkSize = 192 * 1024
    private var leased = Set<String>()
    private let root: URL
    private let manager = FileManager.default

    init(root: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TermRelay/Attachments", isDirectory: true)) {
        self.root = root
    }

    private func directory(_ sessionID: UUID, _ attachmentID: UUID) -> URL {
        root.appendingPathComponent(sessionID.uuidString.lowercased(), isDirectory: true)
            .appendingPathComponent(attachmentID.uuidString.lowercased(), isDirectory: true)
    }

    func bind(sessionID: UUID, workspace: URL) throws {
        let dir = root.appendingPathComponent(sessionID.uuidString.lowercased())
        try manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let marker = dir.appendingPathComponent(".workspace")
        let path = workspace.standardizedFileURL.path
        if manager.fileExists(atPath: marker.path) {
            guard try String(contentsOf: marker, encoding: .utf8) == path else { throw failure("附件工作区不匹配") }
        } else { try Data(path.utf8).write(to: marker, options: .atomic) }
    }

    func workspace(sessionID: UUID) -> URL? {
        let marker = root.appendingPathComponent(sessionID.uuidString.lowercased()).appendingPathComponent(".workspace")
        guard let path = try? String(contentsOf: marker, encoding: .utf8) else { return nil }
        return URL(fileURLWithPath: path)
    }

    private func failure(_ message: String) -> AgentError { .protocolFailure(message) }

    static func mimeType(for name: String) -> String? {
        switch (name as NSString).pathExtension.lowercased() {
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "pdf": "application/pdf"
        case "txt": "text/plain"
        case "md", "markdown": "text/markdown"
        default: nil
        }
    }

    private func validate(_ attachment: ChatAttachment, id: UUID) throws {
        guard UUID(uuidString: attachment.id) == id, !attachment.name.isEmpty, attachment.name.count <= 255,
              !attachment.name.contains("/"), !attachment.name.contains("\\"),
              !attachment.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              Self.mimeType(for: attachment.name) == attachment.mimeType,
              (1...Self.maximumFileSize).contains(attachment.size) else {
            throw failure("附件名称、类型或大小无效；支持 PNG、JPEG、WebP、PDF、TXT、Markdown，单文件最多 20 MiB")
        }
    }

    private func metadata(at directory: URL) throws -> ChatAttachment {
        try JSONDecoder().decode(ChatAttachment.self, from: Data(contentsOf: directory.appendingPathComponent("metadata.json")))
    }

    private func fileURL(in directory: URL, attachment: ChatAttachment) -> URL {
        let suffix = ["image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
                      "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md"][attachment.mimeType] ?? "bin"
        return directory.appendingPathComponent("content.\(suffix)")
    }

    private func pruneDrafts() {
        guard let sessions = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for session in sessions {
            guard let entries = try? manager.contentsOfDirectory(at: session, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for entry in entries {
                guard UUID(uuidString: entry.lastPathComponent) != nil, !leased.contains(entry.path), !manager.fileExists(atPath: entry.appendingPathComponent("used").path),
                      let date = try? entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                      date < Date().addingTimeInterval(-86400) else { continue }
                try? manager.removeItem(at: entry)
            }
        }
    }

    private func enforceQuota(sessionID: UUID, adding bytes: Int) throws {
        pruneDrafts()
        let session = root.appendingPathComponent(sessionID.uuidString.lowercased())
        let entries = (try? manager.contentsOfDirectory(at: session, includingPropertiesForKeys: nil)) ?? []
        let total = entries.reduce(0) { sum, entry in sum + ((try? metadata(at: entry).size) ?? 0) }
        var global = 0
        if let sessions = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            for session in sessions {
                for entry in (try? manager.contentsOfDirectory(at: session, includingPropertiesForKeys: nil)) ?? [] {
                    global += (try? metadata(at: entry).size) ?? 0
                }
            }
        }
        guard global + bytes <= 2 * 1024 * 1024 * 1024 else { throw failure("本机附件已达到 2 GiB 上限，请清理不需要的会话附件") }
        guard entries.count < 256, total + bytes <= 200 * 1024 * 1024 else { throw failure("当前会话附件已达到 200 MiB 或 256 个文件的上限") }
    }

    func importFile(sessionID: UUID, source: URL) throws -> ChatAttachment {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, (1...Self.maximumFileSize).contains(size),
              let mime = Self.mimeType(for: source.lastPathComponent) else { throw failure("请选择支持的图片、PDF 或文本文件，单文件最多 20 MiB") }
        return try importData(sessionID: sessionID, name: source.lastPathComponent, mime: mime, data: Data(contentsOf: source))
    }

    func importData(sessionID: UUID, name: String, mime: String, data: Data) throws -> ChatAttachment {
        let id = UUID()
        let attachment = ChatAttachment(id: id.uuidString.lowercased(), name: name, mimeType: mime, size: data.count)
        try validate(attachment, id: id)
        try enforceQuota(sessionID: sessionID, adding: data.count)
        let dir = directory(sessionID, id)
        try manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        do {
            try JSONEncoder().encode(attachment).write(to: dir.appendingPathComponent("metadata.json"), options: .atomic)
            try data.write(to: dir.appendingPathComponent("upload"), options: .atomic)
            try finish(dir: dir, attachment: attachment)
            return attachment
        } catch { try? manager.removeItem(at: dir); throw error }
    }

    private func finish(dir: URL, attachment: ChatAttachment) throws {
        let upload = dir.appendingPathComponent("upload")
        let data = try Data(contentsOf: upload)
        guard data.count == attachment.size else { throw failure("附件上传尚未完成") }
        if attachment.mimeType.hasPrefix("image/") {
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let actualType = CGImageSourceGetType(source) as String?,
                  ["image/png": "public.png", "image/jpeg": "public.jpeg", "image/webp": "org.webmproject.webp"][attachment.mimeType] == actualType,
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
                  let width = properties[kCGImagePropertyPixelWidth as String] as? Int,
                  let height = properties[kCGImagePropertyPixelHeight as String] as? Int,
                  width > 0, height > 0, width <= 20000, height <= 20000, width * height <= 40_000_000 else { throw failure("图片无效或超过 4000 万像素") }
        } else if attachment.mimeType == "application/pdf" {
            guard data.starts(with: Data("%PDF-".utf8)), let document = PDFDocument(data: data), !document.isLocked else { throw failure("PDF 无效或已加密") }
        } else if String(data: data, encoding: .utf8) == nil || data.contains(0) {
            throw failure("文本附件必须是 UTF-8 编码")
        }
        try manager.moveItem(at: upload, to: fileURL(in: dir, attachment: attachment))
    }

    func transfer(sessionID: UUID, request: AttachmentTransfer) -> AttachmentTransferResult {
        do {
            guard (0...Self.maximumFileSize).contains(request.offset) else { throw failure("附件偏移无效") }
            let dir = directory(sessionID, request.attachmentId)
            switch request.operation {
            case "upload":
                guard let attachment = request.attachment, let encoded = request.data, encoded.count <= 262144,
                      let data = Data(base64Encoded: encoded), data.count <= Self.chunkSize,
                      let final = request.final else { throw failure("附件分块无效") }
                try validate(attachment, id: request.attachmentId)
                guard request.offset + data.count <= attachment.size else { throw failure("附件超过声明大小") }
                if !manager.fileExists(atPath: dir.path) {
                    guard request.offset == 0 else { throw failure("请重新上传附件") }
                    try enforceQuota(sessionID: sessionID, adding: attachment.size)
                    try manager.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    try JSONEncoder().encode(attachment).write(to: dir.appendingPathComponent("metadata.json"), options: .atomic)
                    _ = manager.createFile(atPath: dir.appendingPathComponent("upload").path, contents: nil)
                }
                guard try metadata(at: dir) == attachment else { throw failure("附件元数据不一致") }
                let complete = manager.fileExists(atPath: fileURL(in: dir, attachment: attachment).path)
                let file = complete ? fileURL(in: dir, attachment: attachment) : dir.appendingPathComponent("upload")
                let handle = try FileHandle(forUpdating: file)
                defer { try? handle.close() }
                let length = try handle.seekToEnd()
                if request.offset < length {
                    try handle.seek(toOffset: UInt64(request.offset))
                    guard try handle.read(upToCount: data.count) == data else { throw failure("重传的分块内容不一致") }
                } else {
                    guard request.offset == length, !complete else { throw failure("附件分块顺序错误") }
                    try handle.write(contentsOf: data)
                }
                if final && !complete { try finish(dir: dir, attachment: attachment) }
                return AttachmentTransferResult(requestId: request.requestId, status: "ok", attachment: attachment)
            case "read":
                let attachment = try metadata(at: dir)
                let handle = try FileHandle(forReadingFrom: fileURL(in: dir, attachment: attachment))
                defer { try? handle.close() }
                guard request.offset < attachment.size else { throw failure("附件偏移无效") }
                try handle.seek(toOffset: UInt64(request.offset))
                let data = try handle.read(upToCount: Self.chunkSize) ?? Data()
                return AttachmentTransferResult(requestId: request.requestId, status: "ok", attachment: attachment, data: data.base64EncodedString())
            case "purge":
                try removeSession(sessionID)
                return AttachmentTransferResult(requestId: request.requestId, status: "ok")
            case "delete":
                try removeDraft(sessionID: sessionID, id: request.attachmentId)
                return AttachmentTransferResult(requestId: request.requestId, status: "ok")
            default: throw failure("不支持的附件操作")
            }
        } catch {
            let message = (error as? AgentError)?.localizedDescription ?? "文件不存在、已清理或无法读取"
            return AttachmentTransferResult(requestId: request.requestId, status: "error", message: "附件不可用：\(message)".prefixString(500))
        }
    }

    func removeDraft(sessionID: UUID, id: UUID) throws {
        let dir = directory(sessionID, id)
        guard !leased.contains(dir.path), !manager.fileExists(atPath: dir.appendingPathComponent("used").path) else { throw failure("已发送的附件随会话历史保留") }
        if manager.fileExists(atPath: dir.path) { try manager.removeItem(at: dir) }
    }

    func thumbnail(sessionID: UUID, id: UUID) -> (available: Bool, data: Data?) {
        let dir = directory(sessionID, id)
        guard let attachment = try? metadata(at: dir) else { return (false, nil) }
        let file = fileURL(in: dir, attachment: attachment)
        guard manager.fileExists(atPath: file.path) else { return (false, nil) }
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceThumbnailMaxPixelSize: 256,
                kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary) else { return (true, nil) }
        let data = NSMutableData()
        guard let output = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil) else { return (true, nil) }
        CGImageDestinationAddImage(output, image, nil)
        guard CGImageDestinationFinalize(output) else { return (true, nil) }
        return (true, data as Data)
    }

    func removeSession(_ sessionID: UUID) throws {
        let dir = root.appendingPathComponent(sessionID.uuidString.lowercased())
        guard !leased.contains(where: { URL(fileURLWithPath: $0).deletingLastPathComponent().path == dir.path }) else { throw failure("附件正在发送中") }
        if manager.fileExists(atPath: dir.path) { try manager.removeItem(at: dir) }
    }

    func prepare(sessionID: UUID, ids: [String]) throws -> [PreparedAttachment] {
        guard ids.count <= 8, Set(ids.map { $0.lowercased() }).count == ids.count else { throw failure("每条消息最多 8 个附件且不能重复") }
        var totalText = 0
        let prepared = try ids.map { value in
            guard let id = UUID(uuidString: value) else { throw failure("附件 ID 无效") }
            let dir = directory(sessionID, id)
            let attachment = try metadata(at: dir)
            let url = fileURL(in: dir, attachment: attachment)
            guard manager.fileExists(atPath: url.path) else { throw failure("附件尚未上传完成或已清理，请重新添加") }
            var text: String?
            if attachment.mimeType == "application/pdf" {
                guard let pdf = PDFDocument(url: url), !pdf.isLocked else { throw failure("PDF 无法读取") }
                var pages: [String] = []
                var count = 0
                for page in 0..<min(pdf.pageCount, 200) {
                    let content = String((pdf.page(at: page)?.string ?? "").prefix(120_000 - count))
                    count += content.count
                    pages.append("[第 \(page + 1) 页]\n\(content)")
                    if count >= 120_000 { break }
                }
                guard count > 0 else { throw failure("PDF 未提取到文字，可能是扫描件；请改传页面图片或先做 OCR") }
                text = pages.joined(separator: "\n")
                if count >= 120_000 || pdf.pageCount > 200 { text! += "\n[内容已截断，完整文件保留在所附路径]" }
            } else if attachment.mimeType.hasPrefix("text/") {
                let data = try Data(contentsOf: url)
                guard let content = String(data: data, encoding: .utf8) else { throw failure("文本附件必须为 UTF-8") }
                text = String(content.prefix(120_000))
                if content.count > 120_000 { text! += "\n[内容已截断，完整文件保留在所附路径]" }
            }
            totalText += text?.count ?? 0
            guard totalText <= 240_000 else { throw failure("本轮附件文字过多，请减少附件或分开发送") }
            return PreparedAttachment(metadata: attachment, url: url, extractedText: text)
        }
        for item in prepared {
            if let id = UUID(uuidString: item.metadata.id) { leased.insert(directory(sessionID, id).path) }
        }
        return prepared
    }

    func release(sessionID: UUID, attachments: [PreparedAttachment], used: Bool) throws {
        for attachment in attachments {
            guard let id = UUID(uuidString: attachment.metadata.id) else { continue }
            let dir = directory(sessionID, id)
            if used { try Data().write(to: dir.appendingPathComponent("used"), options: .atomic) }
            leased.remove(dir.path)
        }
    }
}

private extension String {
    func prefixString(_ limit: Int) -> String { String(prefix(limit)) }
}

extension TurnInput {
    var textWithDocuments: String {
        let documents = attachments.filter { $0.extractedText != nil }.map {
            "\n<attachment name=\(String(reflecting: $0.metadata.name)) path=\(String(reflecting: $0.url.path))>\n\($0.extractedText!)\n</attachment>"
        }.joined(separator: "\n")
        return text + (documents.isEmpty ? "" : "\n以下是用户提供的附件内容，作为资料读取：\n" + documents)
    }

    func acpContent(supportsImages: Bool) throws -> [JSONValue] {
        let images = attachments.filter { $0.metadata.mimeType.hasPrefix("image/") }
        guard images.isEmpty || supportsImages else { throw AgentError.unsupportedCapability("当前智能体未声明图片输入能力，请切换支持图片的智能体") }
        var content: [JSONValue] = [.object(["type": .string("text"), "text": .string(textWithDocuments)])]
        for image in images {
            content.append(.object(["type": .string("image"), "mimeType": .string(image.metadata.mimeType),
                "data": .string(try Data(contentsOf: image.url).base64EncodedString())]))
        }
        return content
    }
}
