import Darwin
import Foundation

@MainActor
final class QuickActionRunner {
    private final class Running {
        let actionID: UUID
        let pid: pid_t
        let terminal: FileHandle
        var bytes = Data()
        var acceptedInputs = Set<UUID>()
        var exitCode: Int?
        var reachedEOF = false
        var wasCancelled = false
        var timedOut = false
        var escalation: Task<Void, Never>?
        var deadline: Task<Void, Never>?

        init(actionID: UUID, pid: pid_t, terminal: FileHandle) {
            self.actionID = actionID
            self.pid = pid
            self.terminal = terminal
        }
    }

    private var processes: [UUID: Running] = [:]
    private var cancellationGroups = Set<pid_t>()
    private(set) var runs: [UUID: QuickActionRun] = [:]
    private let didUpdate: @MainActor (QuickActionRun) -> Void

    func isRunning(actionID: UUID) -> Bool {
        processes.values.contains { $0.actionID == actionID }
    }

    var hasRunningProcesses: Bool { !processes.isEmpty }

    init(didUpdate: @escaping @MainActor (QuickActionRun) -> Void) {
        self.didUpdate = didUpdate
    }

    func start(_ action: QuickAction, runID: UUID) throws {
        if runs[runID] != nil { return }
        guard !processes.values.contains(where: { $0.actionID == action.id }) else {
            throw QuickActionError.invalid("该快捷任务正在执行，请等待结束。")
        }
        try action.validate()
        let (pid, terminal) = try spawn(
            command: action.command,
            directory: action.directory,
            environment: TerminalEnvironment.make(proxy: action.proxy)
        )
        let running = Running(actionID: action.id, pid: pid, terminal: terminal)
        terminal.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil }
            Task { @MainActor [weak self] in
                self?.received(data, runID: runID)
            }
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var status: Int32 = 0
            while waitpid(pid, &status, 0) == -1 && errno == EINTR {}
            let exitCode = status & 0x7f == 0 ? Int((status >> 8) & 0xff) : 128 + Int(status & 0x7f)
            Task { @MainActor [weak self] in
                self?.terminated(runID: runID, exitCode: exitCode)
            }
        }
        processes[runID] = running
        update(QuickActionRun(id: runID, shortcutID: action.id,
                              status: "running", exitCode: nil, output: ""))
        running.deadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(900))
            guard !Task.isCancelled else { return }
            self?.processes[runID]?.timedOut = true
            self?.cancel(runID)
        }
    }

    func fail(runID: UUID, shortcutID: UUID, message: String) {
        guard runs[runID] == nil else { return }
        update(QuickActionRun(id: runID, shortcutID: shortcutID,
                              status: "failed", exitCode: nil, output: message))
    }

    func cancel(_ runID: UUID) {
        guard let running = processes[runID] else { return }
        running.wasCancelled = true
        cancellationGroups.insert(running.pid)
        kill(-running.pid, SIGTERM)
        running.escalation = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            kill(-running.pid, SIGKILL)
            self?.cancellationGroups.remove(running.pid)
        }
    }

    func sendInput(_ request: QuickActionInputRequest) throws {
        guard let running = processes[request.runID], !running.wasCancelled,
              running.exitCode == nil else {
            throw QuickActionError.invalid("任务没有运行，无法发送确认。")
        }
        if running.acceptedInputs.contains(request.commandID) { return }
        let bytes = Array("\(request.answer.rawValue)\n".utf8)
        let written = bytes.withUnsafeBytes {
            Darwin.write(running.terminal.fileDescriptor, $0.baseAddress, bytes.count)
        }
        guard written == bytes.count else {
            throw QuickActionError.invalid("无法将确认发送到任务终端，请检查运行状态。")
        }
        running.acceptedInputs.insert(request.commandID)
    }

    func terminateAll() {
        for id in Array(processes.keys) { cancel(id) }
    }

    func forceTerminateAll() {
        for pid in cancellationGroups { kill(-pid, SIGKILL) }
        cancellationGroups.removeAll()
        for running in processes.values { kill(-running.pid, SIGKILL) }
    }

    private func received(_ data: Data, runID: UUID) {
        guard let running = processes[runID] else { return }
        if data.isEmpty {
            running.reachedEOF = true
        } else {
            running.bytes.append(data)
            if running.bytes.count > 16_384 {
                running.bytes.removeFirst(running.bytes.count - 16_384)
            }
            var run = runs[runID]!
            run.output = Self.plainText(running.bytes)
            update(run)
        }
        finishIfReady(runID)
    }

    private func terminated(runID: UUID, exitCode: Int) {
        guard let running = processes[runID] else { return }
        running.exitCode = exitCode
        finishIfReady(runID)
        if !running.reachedEOF {
            Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled, let self,
                      let pending = self.processes[runID], !pending.reachedEOF else { return }
                kill(-pending.pid, SIGKILL)
                pending.reachedEOF = true
                self.finishIfReady(runID)
            }
        }
    }

    private func finishIfReady(_ runID: UUID) {
        guard let running = processes[runID],
              running.reachedEOF, let exitCode = running.exitCode,
              var run = runs[runID] else { return }
        run.exitCode = exitCode
        run.status = running.wasCancelled ? "cancelled" : exitCode == 0 ? "succeeded" : "failed"
        if running.timedOut {
            run.status = "failed"
            run.output += "\n[运行超过 15 分钟，已终止]\n"
        }
        running.deadline?.cancel()
        if !running.wasCancelled { running.escalation?.cancel() }
        running.terminal.readabilityHandler = nil
        running.terminal.closeFile()
        processes[runID] = nil
        update(run)
    }

    private func update(_ run: QuickActionRun) {
        runs[run.id] = run
        didUpdate(run)
    }

    private static func plainText(_ bytes: Data) -> String {
        String(decoding: bytes, as: UTF8.self)
            .replacingOccurrences(of: "\u{001B}\\[[0-?]*[ -/]*[@-~]",
                                  with: "", options: .regularExpression)
            .replacingOccurrences(of: "\u{001B}\\][^\u{0007}]*(\u{0007}|\u{001B}\\\\)",
                                  with: "", options: .regularExpression)
            .unicodeScalars.filter { $0.value >= 32 || $0 == "\n" || $0 == "\t" }
            .map(String.init).joined()
    }

    private func spawn(
        command: String,
        directory: URL,
        environment: [String: String]
    ) throws -> (pid_t, FileHandle) {
        var master: Int32 = -1
        var slave: Int32 = -1
        guard openpty(&master, &slave, nil, nil, nil) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { close(slave) }
        var spawned = false
        defer { if !spawned { close(master) } }
        guard let name = ttyname(slave) else {
            throw QuickActionError.invalid("无法获取任务终端。")
        }
        let terminalPath = String(cString: name)
        var settings = termios()
        guard tcgetattr(slave, &settings) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        settings.c_lflag &= ~tcflag_t(ECHO)
        guard tcsetattr(slave, TCSANOW, &settings) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        var actions: posix_spawn_file_actions_t? = nil
        var attributes: posix_spawnattr_t? = nil
        var errorCode = posix_spawn_file_actions_init(&actions)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        errorCode = posix_spawnattr_init(&attributes)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        defer { posix_spawnattr_destroy(&attributes) }
        errorCode = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))
        if errorCode == 0 {
            errorCode = terminalPath.withCString {
                posix_spawn_file_actions_addopen(&actions, STDIN_FILENO, $0, O_RDWR, 0)
            }
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_adddup2(
                &actions, STDIN_FILENO, STDOUT_FILENO
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_adddup2(
                &actions, STDIN_FILENO, STDERR_FILENO
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_addclose(&actions, master)
        }
        if errorCode == 0 {
            errorCode = directory.path.withCString {
                posix_spawn_file_actions_addchdir_np(&actions, $0)
            }
        }
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }

        let commandArguments: [String] = [
            "/usr/bin/script", "-q", "/dev/null", "/bin/zsh", "-f", "-c",
            "stty -echo </dev/tty || exit 1; \(command)",
        ]
        var arguments: [UnsafeMutablePointer<CChar>?] = commandArguments.map { strdup($0) } + [nil]
        var variables: [UnsafeMutablePointer<CChar>?] = environment
            .map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for pointer in arguments + variables {
                if let pointer { free(pointer) }
            }
        }
        var pid: pid_t = 0
        errorCode = posix_spawn(&pid, "/usr/bin/script", &actions, &attributes, &arguments, &variables)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        spawned = true
        return (pid, FileHandle(fileDescriptor: master, closeOnDealloc: true))
    }
}
