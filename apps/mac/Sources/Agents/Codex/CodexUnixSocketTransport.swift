import Darwin
import Foundation

/// Direct App Server client transport. Codex's Unix listener speaks WebSocket
/// over AF_UNIX, so this owns both the socket and the HTTP/WebSocket framing.
final class CodexUnixSocketTransport: @unchecked Sendable, CodexAppServerTransport {
    let lines: AsyncThrowingStream<Data, Error>

    private let socketPath: String
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let codec: WebSocketPipeCodec
    private let lock = NSLock()
    private var descriptor: Int32 = -1
    private var stopped = false

    init(socketPath: String) {
        self.socketPath = socketPath
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        lines = stream.stream
        continuation = stream.continuation
        codec = WebSocketPipeCodec(continuation: stream.continuation)
    }

    func start() throws {
        let fd = try lock.withLock { () throws -> Int32 in
            guard descriptor == -1 else { return descriptor }
            let fd = socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw posixError("创建 Codex Unix Socket 失败") }
            do {
                try connect(fd)
                descriptor = fd
                stopped = false
                return fd
            } catch {
                Darwin.close(fd)
                throw error
            }
        }

        do {
            try writeAll(codec.handshakeRequest, to: fd)
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.readLoop(fd: fd)
            }
            try codec.waitForHandshake(timeout: .now() + 5)
        } catch {
            stop()
            throw error
        }
    }

    func send(_ line: Data) throws {
        let fd = lock.withLock { descriptor }
        guard fd >= 0, !lock.withLock({ stopped }) else {
            throw AgentError.providerUnavailable("Codex App Server Unix Socket 未连接")
        }
        try writeAll(codec.clientTextFrame(line), to: fd)
    }

    func stop() {
        let fd = lock.withLock { () -> Int32 in
            guard !stopped else { return -1 }
            stopped = true
            let fd = descriptor
            descriptor = -1
            return fd
        }
        if fd >= 0 {
            shutdown(fd, SHUT_RDWR)
            Darwin.close(fd)
        }
        codec.finish()
    }

    private func connect(_ fd: Int32) throws {
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < capacity else {
            throw AgentError.protocolFailure("Codex Unix Socket 路径过长")
        }
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { destination in
                socketPath.withCString { source in
                    _ = strncpy(destination, source, capacity - 1)
                }
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { throw posixError("连接 Codex App Server 失败") }
    }

    private func readLoop(fd: Int32) {
        var bytes = [UInt8](repeating: 0, count: 16 * 1_024)
        while true {
            let count = Darwin.read(fd, &bytes, bytes.count)
            guard count > 0 else {
                if !lock.withLock({ stopped }) { codec.finish() }
                return
            }
            let responses = codec.receive(Data(bytes.prefix(count)))
            for response in responses {
                do { try writeAll(response, to: fd) }
                catch {
                    if !lock.withLock({ stopped }) { codec.finish() }
                    return
                }
            }
        }
    }

    private func writeAll(_ data: Data, to fd: Int32) throws {
        try data.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                guard count > 0 else { throw posixError("写入 Codex Unix Socket 失败") }
                sent += count
            }
        }
    }

    private func posixError(_ prefix: String) -> Error {
        AgentError.providerUnavailable("\(prefix)：\(String(cString: strerror(errno)))")
    }
}
