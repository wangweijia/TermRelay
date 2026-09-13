import Darwin
import Foundation

final class DSHACPProcess: @unchecked Sendable, ACPTransport {
    let lines: AsyncThrowingStream<Data, Error>

    private let executableURL: URL
    private let directory: URL
    private let environment: [String: String]
    private let continuation: AsyncThrowingStream<Data, Error>.Continuation
    private let stateLock = NSLock()
    private let lineBuffer: JSONLineBuffer
    private let exitSemaphore = DispatchSemaphore(value: 0)
    private var process: Process?
    private var inputHandle: FileHandle?
    private var stderrTail = Data()

    init(executableURL: URL, directory: URL, environment: [String: String]) {
        self.executableURL = executableURL
        self.directory = directory
        self.environment = environment
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
            process.arguments = ["--profile", "acp"]
            process.currentDirectoryURL = directory
            process.environment = environment
            process.standardInput = input
            process.standardOutput = output
            process.standardError = error
            output.fileHandleForReading.readabilityHandler = { [weak self, lineBuffer] handle in
                let data = handle.availableData
                guard self != nil else { return }
                if data.isEmpty { lineBuffer.finish() } else { lineBuffer.receive(data) }
            }
            error.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if !data.isEmpty { self?.appendStderr(data) }
            }
            process.terminationHandler = { [weak self, lineBuffer] process in
                output.fileHandleForReading.readabilityHandler = nil
                error.fileHandleForReading.readabilityHandler = nil
                lineBuffer.finish()
                self?.clearProcess(process)
                self?.exitSemaphore.signal()
            }
            try process.run()
            self.process = process
            inputHandle = input.fileHandleForWriting
        }
    }

    func send(_ line: Data) throws {
        try stateLock.withLock {
            guard let inputHandle, process?.isRunning == true else {
                throw AgentError.providerUnavailable("DSH ACP 进程未运行")
            }
            try inputHandle.write(contentsOf: line + Data([0x0A]))
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
        guard running.isRunning else { return }
        if exitSemaphore.wait(timeout: .now() + 1) == .success { return }
        running.terminate()
        if exitSemaphore.wait(timeout: .now() + 2) == .success { return }
        Darwin.kill(running.processIdentifier, SIGKILL)
        _ = exitSemaphore.wait(timeout: .now() + 2)
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
}
