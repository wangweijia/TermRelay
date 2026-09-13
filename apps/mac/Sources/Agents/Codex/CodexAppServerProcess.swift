import CryptoKit
import Foundation

protocol CodexAppServerTransport: Sendable {
    var lines: AsyncThrowingStream<Data, Error> { get }
    func start() throws
    func send(_ line: Data) throws
    func stop()
}

final class CodexAppServerProcess: @unchecked Sendable, CodexAppServerTransport {
    let lines: AsyncThrowingStream<Data, Error>

    private let executableURL: URL
    private let directory: URL
    private let environment: [String: String]
    private let socketPath: String?
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let stateLock = NSLock()
    private let lineBuffer: JSONLineBuffer
    private let webSocketCodec: WebSocketPipeCodec?
    private var process: Process?
    private var inputHandle: FileHandle?
    private var stderrTail = Data()

    init(
        executableURL: URL,
        directory: URL,
        environment: [String: String] = TerminalEnvironment.make(),
        socketPath: String? = nil
    ) {
        self.executableURL = executableURL
        self.directory = directory
        self.environment = environment
        self.socketPath = socketPath
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        lines = stream.stream
        continuation = stream.continuation
        lineBuffer = JSONLineBuffer(continuation: stream.continuation)
        webSocketCodec = socketPath.map { _ in
            WebSocketPipeCodec(continuation: stream.continuation)
        }
    }

    func start() throws {
        try stateLock.withLock {
            guard process == nil else { return }
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            let error = Pipe()
            process.executableURL = executableURL
            if let socketPath {
                process.arguments = ["app-server", "proxy", "--sock", socketPath]
            } else {
                process.arguments = ["app-server", "--listen", "stdio://"]
            }
            process.currentDirectoryURL = directory
            process.environment = sanitizedEnvironment()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = error

            output.fileHandleForReading.readabilityHandler = { [weak self, lineBuffer] handle in
                let data = handle.availableData
                guard let self else { return }
                if data.isEmpty {
                    self.webSocketCodec?.finish()
                    if self.webSocketCodec == nil { lineBuffer.finish() }
                } else if let webSocketCodec = self.webSocketCodec {
                    for response in webSocketCodec.receive(data) {
                        try? self.write(response)
                    }
                } else {
                    lineBuffer.receive(data)
                }
            }
            error.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                self?.appendStderr(data)
            }
            process.terminationHandler = { [weak self, lineBuffer] process in
                output.fileHandleForReading.readabilityHandler = nil
                error.fileHandleForReading.readabilityHandler = nil
                self?.webSocketCodec?.finish()
                if self?.webSocketCodec == nil { lineBuffer.finish() }
                self?.clearProcess(process)
            }

            try process.run()
            self.process = process
            inputHandle = input.fileHandleForWriting
            if let webSocketCodec {
                try input.fileHandleForWriting.write(contentsOf: webSocketCodec.handshakeRequest)
            }
        }
        if let webSocketCodec {
            do {
                try webSocketCodec.waitForHandshake(timeout: .now() + 5)
            } catch {
                let detail = diagnosticTail().trimmingCharacters(in: .whitespacesAndNewlines)
                stop()
                throw AgentError.providerUnavailable(
                    detail.isEmpty ? error.localizedDescription : "\(error.localizedDescription)：\(detail)"
                )
            }
        }
    }

    func send(_ line: Data) throws {
        try stateLock.withLock {
            guard let inputHandle, process?.isRunning == true else {
                throw AgentError.providerUnavailable("Codex App Server 未运行")
            }
            let framed = webSocketCodec?.clientTextFrame(line) ?? line + Data([0x0A])
            try inputHandle.write(contentsOf: framed)
        }
    }

    func stop() {
        let running: Process? = stateLock.withLock {
            try? inputHandle?.close()
            inputHandle = nil
            return process
        }
        guard let running else {
            continuation.finish()
            return
        }
        if running.isRunning { running.terminate() }
    }

    func diagnosticTail() -> String {
        stateLock.withLock {
            String(decoding: stderrTail, as: UTF8.self)
                .replacingOccurrences(
                    of: #"(?i)(api[_-]?key|token|authorization)\s*[:=]\s*\S+"#,
                    with: "$1=[REDACTED]",
                    options: .regularExpression
                )
        }
    }

    private func appendStderr(_ data: Data) {
        stateLock.withLock {
            stderrTail.append(data)
            if stderrTail.count > 64 * 1_024 {
                stderrTail.removeFirst(stderrTail.count - 64 * 1_024)
            }
        }
    }

    private func clearProcess(_ terminated: Process) {
        stateLock.withLock {
            if process === terminated {
                process = nil
                inputHandle = nil
            }
        }
    }

    private func write(_ data: Data) throws {
        try stateLock.withLock {
            guard let inputHandle, process?.isRunning == true else { return }
            try inputHandle.write(contentsOf: data)
        }
    }

    private func sanitizedEnvironment() -> [String: String] {
        var environment = self.environment
        environment.removeValue(forKey: "TERM")
        environment.removeValue(forKey: "COLORTERM")
        return environment
    }
}

final class WebSocketPipeCodec: @unchecked Sendable {
    let handshakeRequest: Data

    private let maximumMessageBytes = 8 * 1_024 * 1_024
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let expectedAccept: String
    private let lock = NSLock()
    private let handshakeSemaphore = DispatchSemaphore(value: 0)
    private var buffer = Data()
    private var handshakeResult: Result<Void, Error>?
    private var handshakeComplete = false
    private var fragmentOpcode: UInt8?
    private var fragment = Data()
    private var finished = false

    init(continuation: AsyncThrowingStream<Data, Error>.Continuation) {
        self.continuation = continuation
        let keyData = withUnsafeBytes(of: UUID().uuid) { Data($0) }
        let key = keyData.base64EncodedString()
        let digest = Insecure.SHA1.hash(
            data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8)
        )
        expectedAccept = Data(digest).base64EncodedString()
        let request =
            "GET / HTTP/1.1\r\n" +
            "Host: localhost\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Key: \(key)\r\n" +
            "Sec-WebSocket-Version: 13\r\n" +
            "\r\n"
        handshakeRequest = Data(request.utf8)
    }

    func waitForHandshake(timeout: DispatchTime) throws {
        guard handshakeSemaphore.wait(timeout: timeout) == .success else {
            throw AgentError.protocolFailure("App Server Unix WebSocket 握手超时")
        }
        try lock.withLock {
            guard let handshakeResult else {
                throw AgentError.protocolFailure("App Server Unix WebSocket 握手没有结果")
            }
            try handshakeResult.get()
        }
    }

    func receive(_ data: Data) -> [Data] {
        lock.withLock {
            guard !finished else { return [] }
            buffer.append(data)
            do {
                if !handshakeComplete { try consumeHandshake() }
                return handshakeComplete ? try consumeFrames() : []
            } catch {
                fail(error)
                return []
            }
        }
    }

    func clientTextFrame(_ payload: Data) -> Data {
        Self.clientFrame(opcode: 0x1, payload: payload)
    }

    func finish() {
        lock.withLock {
            guard !finished else { return }
            fail(AgentError.providerUnavailable("Codex App Server Unix WebSocket 已退出"))
        }
    }

    private func consumeHandshake() throws {
        let marker = Data("\r\n\r\n".utf8)
        guard let range = buffer.range(of: marker) else {
            if buffer.count > 16 * 1_024 {
                throw AgentError.protocolFailure("App Server WebSocket 握手响应过大")
            }
            return
        }
        let headerData = buffer[..<range.upperBound]
        buffer.removeSubrange(..<range.upperBound)
        guard let header = String(data: headerData, encoding: .utf8) else {
            throw AgentError.protocolFailure("App Server WebSocket 握手不是 UTF-8")
        }
        let lines = header.components(separatedBy: "\r\n")
        guard lines.first?.contains(" 101 ") == true else {
            throw AgentError.protocolFailure("App Server 拒绝 WebSocket 握手：\(lines.first ?? "未知响应")")
        }
        let accept = lines.dropFirst().first { line in
            line.lowercased().hasPrefix("sec-websocket-accept:")
        }?.split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard accept == expectedAccept else {
            throw AgentError.protocolFailure("App Server WebSocket 握手校验失败")
        }
        handshakeComplete = true
        handshakeResult = .success(())
        handshakeSemaphore.signal()
    }

    private func consumeFrames() throws -> [Data] {
        var controlResponses: [Data] = []
        while buffer.count >= 2 {
            let first = buffer[buffer.startIndex]
            let second = buffer[buffer.index(after: buffer.startIndex)]
            let isFinal = first & 0x80 != 0
            let opcode = first & 0x0F
            let isMasked = second & 0x80 != 0
            var length = UInt64(second & 0x7F)
            var offset = 2
            if length == 126 {
                guard buffer.count >= 4 else { break }
                length = UInt64(buffer[offset]) << 8 | UInt64(buffer[offset + 1])
                offset += 2
            } else if length == 127 {
                guard buffer.count >= 10 else { break }
                length = 0
                for byte in buffer[offset..<(offset + 8)] { length = length << 8 | UInt64(byte) }
                offset += 8
            }
            guard length <= UInt64(maximumMessageBytes) else {
                throw AgentError.protocolFailure("App Server WebSocket 消息超过 8 MiB")
            }
            let maskSize = isMasked ? 4 : 0
            guard length <= UInt64(Int.max - offset - maskSize) else {
                throw AgentError.protocolFailure("App Server WebSocket 消息长度无效")
            }
            let frameSize = offset + maskSize + Int(length)
            guard buffer.count >= frameSize else { break }
            let mask = isMasked ? Array(buffer[offset..<(offset + 4)]) : []
            offset += maskSize
            var payload = Data(buffer[offset..<(offset + Int(length))])
            if isMasked {
                for index in payload.indices {
                    payload[index] ^= mask[payload.distance(from: payload.startIndex, to: index) % 4]
                }
            }
            buffer.removeSubrange(..<buffer.index(buffer.startIndex, offsetBy: frameSize))

            switch opcode {
            case 0x0:
                guard fragmentOpcode != nil else {
                    throw AgentError.protocolFailure("App Server 返回了无起始帧的 continuation")
                }
                fragment.append(payload)
                if isFinal {
                    continuation.yield(fragment)
                    fragment.removeAll(keepingCapacity: true)
                    fragmentOpcode = nil
                }
            case 0x1:
                guard fragmentOpcode == nil else {
                    throw AgentError.protocolFailure("App Server 返回了交错的 WebSocket 消息")
                }
                if isFinal { continuation.yield(payload) }
                else {
                    fragmentOpcode = opcode
                    fragment = payload
                }
            case 0x8:
                finishSuccessfully()
                return controlResponses
            case 0x9:
                controlResponses.append(Self.clientFrame(opcode: 0xA, payload: payload))
            case 0xA:
                break
            default:
                throw AgentError.protocolFailure("App Server 返回了不支持的 WebSocket opcode \(opcode)")
            }
        }
        return controlResponses
    }

    private func finishSuccessfully() {
        guard !finished else { return }
        finished = true
        continuation.finish()
    }

    private func fail(_ error: Error) {
        guard !finished else { return }
        finished = true
        if handshakeResult == nil {
            handshakeResult = .failure(error)
            handshakeSemaphore.signal()
        }
        continuation.finish(throwing: error)
    }

    private static func clientFrame(opcode: UInt8, payload: Data) -> Data {
        var frame = Data([0x80 | opcode])
        let count = payload.count
        if count < 126 {
            frame.append(0x80 | UInt8(count))
        } else if count <= Int(UInt16.max) {
            frame.append(0x80 | 126)
            frame.append(UInt8((count >> 8) & 0xFF))
            frame.append(UInt8(count & 0xFF))
        } else {
            frame.append(0x80 | 127)
            let length = UInt64(count)
            for shift in stride(from: 56, through: 0, by: -8) {
                frame.append(UInt8((length >> UInt64(shift)) & 0xFF))
            }
        }
        let mask = withUnsafeBytes(of: UUID().uuid) { Array($0.prefix(4)) }
        frame.append(contentsOf: mask)
        for (index, byte) in payload.enumerated() {
            frame.append(byte ^ mask[index % 4])
        }
        return frame
    }
}

final class JSONLineBuffer: @unchecked Sendable {
    private let maximumLineBytes = 8 * 1_024 * 1_024
    private let lock = NSLock()
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private var buffer = Data()
    private var finished = false

    init(continuation: AsyncThrowingStream<Data, Error>.Continuation) {
        self.continuation = continuation
    }

    func receive(_ data: Data) {
        lock.withLock {
            guard !finished else { return }
            buffer.append(data)
            while let newline = buffer.firstIndex(of: 0x0A) {
                guard newline <= maximumLineBytes else {
                    finished = true
                    continuation.finish(throwing: AgentError.protocolFailure(
                        "Codex App Server 单行消息超过 8 MiB"
                    ))
                    return
                }
                var line = buffer[..<newline]
                if line.last == 0x0D { line = line.dropLast() }
                if !line.isEmpty { continuation.yield(Data(line)) }
                buffer.removeSubrange(...newline)
            }
            guard buffer.count <= maximumLineBytes else {
                finished = true
                continuation.finish(throwing: AgentError.protocolFailure(
                    "Codex App Server 单行消息超过 8 MiB"
                ))
                return
            }
        }
    }

    func finish() {
        lock.withLock {
            guard !finished else { return }
            finished = true
            if !buffer.isEmpty {
                continuation.finish(throwing: AgentError.protocolFailure(
                    "Codex App Server 在不完整 JSONL 消息中退出"
                ))
            } else {
                continuation.finish()
            }
        }
    }
}
