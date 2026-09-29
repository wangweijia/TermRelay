import Darwin
import Foundation

@MainActor
final class QuickActionRunner {
    private final class Running {
        let actionID: UUID
        let pid: pid_t
        let pipe: Pipe
        var bytes = Data()
        var exitCode: Int?
        var reachedEOF = false
        var wasCancelled = false
        var timedOut = false
        var escalation: Task<Void, Never>?
        var deadline: Task<Void, Never>?

        init(actionID: UUID, pid: pid_t, pipe: Pipe) {
            self.actionID = actionID
            self.pid = pid
            self.pipe = pipe
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
        let pipe = Pipe()
        let pid = try spawn(
            command: action.command,
            directory: action.directory,
            environment: TerminalEnvironment.make(proxy: action.proxy),
            pipe: pipe
        )
        let running = Running(actionID: action.id, pid: pid, pipe: pipe)
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
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
        pipe.fileHandleForWriting.closeFile()
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
            run.output = String(decoding: running.bytes, as: UTF8.self)
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
        running.pipe.fileHandleForReading.readabilityHandler = nil
        processes[runID] = nil
        update(run)
    }

    private func update(_ run: QuickActionRun) {
        runs[run.id] = run
        didUpdate(run)
    }

    private func spawn(
        command: String,
        directory: URL,
        environment: [String: String],
        pipe: Pipe
    ) throws -> pid_t {
        var actions: posix_spawn_file_actions_t? = nil
        var attributes: posix_spawnattr_t? = nil
        var errorCode = posix_spawn_file_actions_init(&actions)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        defer { posix_spawn_file_actions_destroy(&actions) }
        errorCode = posix_spawnattr_init(&attributes)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        defer { posix_spawnattr_destroy(&attributes) }
        errorCode = posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP))
        if errorCode == 0 { errorCode = posix_spawnattr_setpgroup(&attributes, 0) }
        let inputFD = open("/dev/null", O_RDONLY)
        guard inputFD >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(inputFD) }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_adddup2(
                &actions, pipe.fileHandleForWriting.fileDescriptor, STDOUT_FILENO
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_adddup2(
                &actions, pipe.fileHandleForWriting.fileDescriptor, STDERR_FILENO
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_adddup2(
                &actions, inputFD, STDIN_FILENO
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_addclose(
                &actions, pipe.fileHandleForReading.fileDescriptor
            )
        }
        if errorCode == 0 {
            errorCode = posix_spawn_file_actions_addclose(
                &actions, pipe.fileHandleForWriting.fileDescriptor
            )
        }
        if errorCode == 0 {
            errorCode = directory.path.withCString {
                posix_spawn_file_actions_addchdir_np(&actions, $0)
            }
        }
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }

        var arguments: [UnsafeMutablePointer<CChar>?] = ["/bin/zsh", "-f", "-c", command]
            .map { strdup($0) } + [nil]
        var variables: [UnsafeMutablePointer<CChar>?] = environment
            .map { strdup("\($0.key)=\($0.value)") } + [nil]
        defer {
            for pointer in arguments + variables {
                if let pointer { free(pointer) }
            }
        }
        var pid: pid_t = 0
        errorCode = posix_spawn(&pid, "/bin/zsh", &actions, &attributes, &arguments, &variables)
        guard errorCode == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errorCode) ?? .EIO) }
        return pid
    }
}
