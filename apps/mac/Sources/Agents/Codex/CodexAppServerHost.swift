import Foundation

final class CodexAppServerHost: @unchecked Sendable {
    let socketPath: String
    var endpoint: String { "unix://\(socketPath)" }

    private let executableURL: URL
    private let directory: URL
    private let environment: [String: String]
    private let lock = NSLock()
    private var process: Process?
    private var stderrTail = Data()

    init(
        executableURL: URL,
        directory: URL,
        environment: [String: String],
        temporaryDirectory: URL = FileManager.default.temporaryDirectory
    ) {
        self.executableURL = executableURL
        self.directory = directory
        self.environment = environment
        let suffix = UUID().uuidString.lowercased().prefix(12)
        let candidate = temporaryDirectory.appendingPathComponent("tr-\(suffix).sock").path
        socketPath = candidate.utf8.count < 100
            ? candidate
            : "/private/tmp/tr-\(suffix).sock"
    }

    func start() async throws {
        try lock.withLock {
            guard process == nil else { return }
            try? FileManager.default.removeItem(atPath: socketPath)

            let process = Process()
            let error = Pipe()
            process.executableURL = executableURL
            process.arguments = ["app-server", "--listen", endpoint]
            process.currentDirectoryURL = directory
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = error
            error.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                self?.appendStderr(data)
            }
            process.terminationHandler = { [weak self] terminated in
                error.fileHandleForReading.readabilityHandler = nil
                let remaining = error.fileHandleForReading.readDataToEndOfFile()
                if !remaining.isEmpty { self?.appendStderr(remaining) }
                self?.clearProcess(terminated)
            }
            try process.run()
            self.process = process
        }

        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: socketPath) { return }
            if lock.withLock({ process?.isRunning != true }) {
                try? await Task.sleep(for: .milliseconds(20))
                let detail = diagnosticTail()
                throw AgentError.providerUnavailable(
                    detail.isEmpty
                        ? "Codex App Server 启动后立即退出"
                        : "Codex App Server 启动失败：\(detail)"
                )
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        stop()
        throw AgentError.providerUnavailable("等待 Codex App Server Unix Socket 超时")
    }

    func stop() {
        let running = lock.withLock { process }
        if running?.isRunning == true { running?.terminate() }
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    private func clearProcess(_ terminated: Process) {
        lock.withLock {
            if process === terminated { process = nil }
        }
        try? FileManager.default.removeItem(atPath: socketPath)
    }

    private func appendStderr(_ data: Data) {
        lock.withLock {
            stderrTail.append(data)
            if stderrTail.count > 32 * 1_024 {
                stderrTail.removeFirst(stderrTail.count - 32 * 1_024)
            }
        }
    }

    private func diagnosticTail() -> String {
        lock.withLock {
            String(decoding: stderrTail, as: UTF8.self)
                .replacingOccurrences(
                    of: #"(?i)(api[_-]?key|token|authorization)\s*[:=]\s*\S+"#,
                    with: "$1=[REDACTED]",
                    options: .regularExpression
                )
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}
