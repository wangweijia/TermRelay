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
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let stateLock = NSLock()
    private let lineBuffer: JSONLineBuffer
    private var process: Process?
    private var inputHandle: FileHandle?
    private var stderrTail = Data()

    init(executableURL: URL, directory: URL) {
        self.executableURL = executableURL
        self.directory = directory
        let stream = AsyncThrowingStream<Data, Error>.makeStream()
        lines = stream.stream
        continuation = stream.continuation
        lineBuffer = JSONLineBuffer(continuation: stream.continuation)
    }

    func start() throws {
        try stateLock.withLock {
            guard process == nil else { return }
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            let error = Pipe()
            process.executableURL = executableURL
            process.arguments = ["app-server", "--listen", "stdio://"]
            process.currentDirectoryURL = directory
            process.environment = sanitizedEnvironment()
            process.standardInput = input
            process.standardOutput = output
            process.standardError = error

            output.fileHandleForReading.readabilityHandler = { [lineBuffer] handle in
                let data = handle.availableData
                if data.isEmpty { lineBuffer.finish() }
                else { lineBuffer.receive(data) }
            }
            error.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                self?.appendStderr(data)
            }
            process.terminationHandler = { [weak self, lineBuffer] process in
                output.fileHandleForReading.readabilityHandler = nil
                error.fileHandleForReading.readabilityHandler = nil
                lineBuffer.finish()
                self?.clearProcess(process)
            }

            try process.run()
            self.process = process
            inputHandle = input.fileHandleForWriting
        }
    }

    func send(_ line: Data) throws {
        try stateLock.withLock {
            guard let inputHandle, process?.isRunning == true else {
                throw AgentError.providerUnavailable("Codex App Server 未运行")
            }
            var framed = line
            framed.append(0x0A)
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

    private func sanitizedEnvironment() -> [String: String] {
        var environment = TerminalEnvironment.make()
        environment.removeValue(forKey: "TERM")
        environment.removeValue(forKey: "COLORTERM")
        return environment
    }
}

private final class JSONLineBuffer: @unchecked Sendable {
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
