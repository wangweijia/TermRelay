import Darwin
import Foundation

final class CodexAppServerHost: @unchecked Sendable {
    struct RuntimeMetadata: Codable, Sendable {
        let id: UUID
        let pid: Int32
        let executablePath: String
        let workingDirectory: String
        let socketPath: String
        let createdAt: Date
    }

    let runtimeID: UUID
    let runtimeDirectory: URL
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
        temporaryDirectory: URL = FileManager.default.temporaryDirectory,
        runtimeRootDirectory: URL? = nil,
        runtimeID: UUID = UUID()
    ) {
        self.executableURL = executableURL
        self.directory = directory
        self.environment = environment
        self.runtimeID = runtimeID
        let root = runtimeRootDirectory ?? Self.defaultRuntimeRoot
        runtimeDirectory = root.appendingPathComponent(runtimeID.uuidString.lowercased(), isDirectory: true)
        let suffix = runtimeID.uuidString.lowercased().prefix(12)
        let candidate = temporaryDirectory.appendingPathComponent("tr-\(suffix).sock").path
        socketPath = candidate.utf8.count < 100
            ? candidate
            : "/private/tmp/tr-\(suffix).sock"
    }

    func start() async throws {
        do {
            try lock.withLock {
                guard process == nil else { return }
                try FileManager.default.createDirectory(
                    at: runtimeDirectory,
                    withIntermediateDirectories: true
                )
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
                try writeMetadata(pid: process.processIdentifier)
            }
        } catch {
            stop()
            throw error
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
        if let running, running.isRunning {
            running.terminate()
            for _ in 0..<40 where running.isRunning { usleep(50_000) }
            if running.isRunning {
                kill(running.processIdentifier, SIGKILL)
                for _ in 0..<20 where running.isRunning { usleep(50_000) }
            }
        }
        cleanupOwnedFiles()
        lock.withLock {
            if process === running { process = nil }
        }
    }

    func diagnosticTail() -> String {
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

    /// Removes only processes and paths whose command line or metadata proves
    /// they were created by TermRelay. Other Codex app-server instances are untouched.
    static func cleanupAbandonedRuntimes(
        runtimeRoot: URL = defaultRuntimeRoot,
        temporaryDirectory: URL = FileManager.default.temporaryDirectory
    ) {
        cleanupLegacyProcesses(temporaryDirectory: temporaryDirectory)
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: runtimeRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            cleanupLegacySockets(temporaryDirectory: temporaryDirectory)
            return
        }
        for entry in entries {
            let metadataURL = entry.appendingPathComponent("runtime.json")
            guard let data = try? Data(contentsOf: metadataURL),
                  let metadata = try? JSONDecoder.iso8601.decode(RuntimeMetadata.self, from: data) else {
                try? FileManager.default.removeItem(at: entry)
                continue
            }
            if processCommand(pid: metadata.pid).map({ command in
                command.contains("codex") && command.contains("app-server")
                    && command.contains("unix://\(metadata.socketPath)")
            }) == true {
                terminate(pid: metadata.pid)
            }
            removeOwnedSocket(metadata.socketPath, runtimeRoot: runtimeRoot, temporaryDirectory: temporaryDirectory)
            try? FileManager.default.removeItem(at: entry)
        }
        cleanupLegacySockets(temporaryDirectory: temporaryDirectory)
    }

    static var defaultRuntimeRoot: URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return caches
            .appendingPathComponent("TermRelay", isDirectory: true)
            .appendingPathComponent("runtime", isDirectory: true)
    }

    private func writeMetadata(pid: Int32) throws {
        let metadata = RuntimeMetadata(
            id: runtimeID,
            pid: pid,
            executablePath: executableURL.path,
            workingDirectory: directory.path,
            socketPath: socketPath,
            createdAt: Date()
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(metadata).write(
            to: runtimeDirectory.appendingPathComponent("runtime.json"),
            options: .atomic
        )
    }

    private func clearProcess(_ terminated: Process) {
        lock.withLock {
            if process === terminated { process = nil }
        }
        cleanupOwnedFiles()
    }

    private func cleanupOwnedFiles() {
        try? FileManager.default.removeItem(atPath: socketPath)
        try? FileManager.default.removeItem(at: runtimeDirectory)
    }

    private func appendStderr(_ data: Data) {
        lock.withLock {
            stderrTail.append(data)
            if stderrTail.count > 32 * 1_024 {
                stderrTail.removeFirst(stderrTail.count - 32 * 1_024)
            }
        }
    }

    private static func cleanupLegacyProcesses(temporaryDirectory: URL) {
        guard let output = processList() else { return }
        for line in output.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let parts = trimmed.split(maxSplits: 1, whereSeparator: \Character.isWhitespace)
            guard parts.count == 2, let pid = Int32(parts[0]) else { continue }
            let command = String(parts[1])
            guard command.contains("codex"),
                  (command.contains("app-server") || command.contains("--remote")),
                  let socket = unixSocketArgument(in: command),
                  isTermRelaySocket(socket, runtimeRoot: defaultRuntimeRoot, temporaryDirectory: temporaryDirectory)
            else { continue }
            terminate(pid: pid)
        }
    }

    private static func cleanupLegacySockets(temporaryDirectory: URL) {
        for directory in [temporaryDirectory, URL(fileURLWithPath: "/private/tmp", isDirectory: true)] {
            guard let entries = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil
            ) else { continue }
            for entry in entries where isLegacySocketName(entry.lastPathComponent) {
                try? FileManager.default.removeItem(at: entry)
            }
        }
    }

    private static func removeOwnedSocket(
        _ path: String,
        runtimeRoot: URL,
        temporaryDirectory: URL
    ) {
        guard isTermRelaySocket(path, runtimeRoot: runtimeRoot, temporaryDirectory: temporaryDirectory) else { return }
        try? FileManager.default.removeItem(atPath: path)
    }

    private static func isTermRelaySocket(
        _ path: String,
        runtimeRoot: URL,
        temporaryDirectory: URL
    ) -> Bool {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let parent = url.deletingLastPathComponent()
        return (parent == temporaryDirectory.standardizedFileURL && isLegacySocketName(url.lastPathComponent))
            || (parent.path == "/private/tmp" && isLegacySocketName(url.lastPathComponent))
            || url.path.hasPrefix(runtimeRoot.standardizedFileURL.path + "/")
    }

    private static func isLegacySocketName(_ name: String) -> Bool {
        guard name.hasSuffix(".sock") else { return false }
        let stem = String(name.dropLast(5))
        for prefix in ["tr-", "trp-", "termrelay-"] where stem.hasPrefix(prefix) {
            let identifier = String(stem.dropFirst(prefix.count))
            if UUID(uuidString: identifier) != nil { return true }
            return identifier.count == 12 && identifier.allSatisfy {
                $0 == "-" || $0.isHexDigit
            }
        }
        return false
    }

    private static func unixSocketArgument(in command: String) -> String? {
        guard let range = command.range(of: "unix://") else { return nil }
        let suffix = command[range.upperBound...]
        return suffix.split(whereSeparator: \Character.isWhitespace).first.map(String.init)
    }

    private static func processList() -> String? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,command="]
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return nil }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }

    private static func processCommand(pid: Int32) -> String? {
        processList()?.split(separator: "\n").compactMap { line -> String? in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            let parts = trimmed.split(maxSplits: 1, whereSeparator: \Character.isWhitespace)
            guard parts.count == 2, Int32(parts[0]) == pid else { return nil }
            return String(parts[1])
        }.first
    }

    private static func terminate(pid: Int32) {
        guard pid > 1 else { return }
        kill(pid, SIGTERM)
        for _ in 0..<20 {
            if kill(pid, 0) != 0 { return }
            usleep(50_000)
        }
        kill(pid, SIGKILL)
    }
}

private extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
