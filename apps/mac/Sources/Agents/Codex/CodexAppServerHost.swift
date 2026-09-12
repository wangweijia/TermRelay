import Foundation

final class CodexAppServerHost: @unchecked Sendable {
    let socketPath: String
    var endpoint: String { "unix://\(socketPath)" }

    private let executableURL: URL
    private let directory: URL
    private let environment: [String: String]
    private let lock = NSLock()
    private var process: Process?

    init(executableURL: URL, directory: URL, environment: [String: String]) {
        self.executableURL = executableURL
        self.directory = directory
        self.environment = environment
        let suffix = UUID().uuidString.lowercased().prefix(12)
        socketPath = "/private/tmp/termrelay-\(suffix).sock"
    }

    func start() async throws {
        try lock.withLock {
            guard process == nil else { return }
            try? FileManager.default.removeItem(atPath: socketPath)

            let process = Process()
            process.executableURL = executableURL
            process.arguments = ["app-server", "--listen", endpoint]
            process.currentDirectoryURL = directory
            process.environment = environment
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            process.terminationHandler = { [weak self] terminated in
                self?.clearProcess(terminated)
            }
            try process.run()
            self.process = process
        }

        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: socketPath) { return }
            if lock.withLock({ process?.isRunning != true }) {
                throw AgentError.providerUnavailable("Codex App Server 启动后立即退出")
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
}
