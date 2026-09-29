import Darwin
import Foundation

struct FilePreviewResult: Encodable, Sendable {
    enum Status: String, Encodable, Sendable {
        case ok, not_found, forbidden, too_large, unsupported, error
    }

    let requestId: UUID
    let status: Status
    let name: String?
    let content: String?

    init(requestId: UUID, status: Status, name: String? = nil, content: String? = nil) {
        self.requestId = requestId
        self.status = status
        self.name = name
        self.content = content
    }
}

enum FilePreviewReader {
    static let maxBytes = 512 * 1024

    static func read(requestId: UUID, path: String, workspace: URL) -> FilePreviewResult {
        func failure(_ status: FilePreviewResult.Status) -> FilePreviewResult {
            FilePreviewResult(requestId: requestId, status: status)
        }

        guard path.hasPrefix("/"), !path.utf8.contains(0),
              markdownExtension(URL(fileURLWithPath: path).pathExtension) else {
            return failure(.unsupported)
        }
        guard let root = canonicalPath(workspace.path) else { return failure(.error) }
        guard let file = canonicalPath(path) else {
            switch errno {
            case EACCES, EPERM, ELOOP: return failure(.forbidden)
            case ENOENT, ENOTDIR: return failure(.not_found)
            default: return failure(.error)
            }
        }
        let prefix = root == "/" ? root : root + "/"
        guard file.hasPrefix(prefix) else { return failure(.forbidden) }
        guard markdownExtension(URL(fileURLWithPath: file).pathExtension) else {
            return failure(.unsupported)
        }

        let relative = String(file.dropFirst(prefix.count))
        let components = relative.split(separator: "/").map(String.init)
        guard !components.isEmpty else { return failure(.unsupported) }
        var descriptor = open(root, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { return failure(.error) }
        defer { close(descriptor) }
        for (index, component) in components.enumerated() {
            let flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC
                | (index < components.count - 1 ? O_DIRECTORY : O_NONBLOCK)
            let next = openat(descriptor, component, flags)
            guard next >= 0 else {
                switch errno {
                case ENOENT, ENOTDIR: return failure(.not_found)
                case EACCES, EPERM, ELOOP: return failure(.forbidden)
                default: return failure(.error)
                }
            }
            close(descriptor)
            descriptor = next
        }

        var statInfo = stat()
        guard fstat(descriptor, &statInfo) == 0 else { return failure(.error) }
        guard (statInfo.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG) else {
            return failure(.unsupported)
        }
        guard statInfo.st_size <= maxBytes else { return failure(.too_large) }
        var bytes = [UInt8](repeating: 0, count: maxBytes + 1)
        let capacity = bytes.count
        var count = 0
        while count < capacity {
            let amount = bytes.withUnsafeMutableBytes { buffer in
                Darwin.read(descriptor, buffer.baseAddress!.advanced(by: count), capacity - count)
            }
            if amount < 0 {
                if errno == EINTR { continue }
                return failure(.error)
            }
            if amount == 0 { break }
            count += amount
        }
        guard count <= maxBytes else { return failure(.too_large) }
        guard let content = String(bytes: bytes.prefix(count), encoding: .utf8) else {
            return failure(.unsupported)
        }
        return FilePreviewResult(requestId: requestId, status: .ok,
                                 name: URL(fileURLWithPath: path).lastPathComponent, content: content)
    }

    private static func markdownExtension(_ value: String) -> Bool {
        ["md", "markdown"].contains(value.lowercased())
    }

    private static func canonicalPath(_ path: String) -> String? {
        path.withCString { input in
            guard let resolved = realpath(input, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        }
    }
}
