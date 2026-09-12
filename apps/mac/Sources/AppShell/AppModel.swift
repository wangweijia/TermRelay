import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var connectionState: ConnectionState = .offline
    @Published private(set) var sessions: [ManagedSession] = []
    @Published private(set) var terminalSessions: [UUID: LocalTerminalSession] = [:]
    @Published private(set) var structuredSessions: [UUID: LocalStructuredAgentSession] = [:]
    @Published private(set) var workingDirectory: URL
    @Published private(set) var errorMessage: String?
    @Published var selectedTool: BuiltInTool = .shell
    @Published var agentWebDisplayMode: AgentWebDisplayMode {
        didSet { defaults.set(agentWebDisplayMode.rawValue, forKey: Keys.agentWebDisplayMode) }
    }
    @Published var sessionName = ""
    @Published var proxyConfigurations: [String: ToolProxyConfiguration] {
        didSet { persistProxyConfigurations() }
    }
    @Published var toolExecutablePaths: [String: String] {
        didSet { defaults.set(toolExecutablePaths, forKey: Keys.toolExecutablePaths) }
    }
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Keys.serverURL) }
    }

    let deviceID: UUID
    private let defaults: UserDefaults
    private var remoteClient: RemoteClient?
    private var connectionStarted = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        proxyConfigurations = Self.loadProxyConfigurations(from: defaults)
        toolExecutablePaths = defaults.dictionary(forKey: Keys.toolExecutablePaths) as? [String: String] ?? [:]
        agentWebDisplayMode = defaults.string(forKey: Keys.agentWebDisplayMode)
            .flatMap(AgentWebDisplayMode.init(rawValue:)) ?? .full
        workingDirectory = FileManager.default.homeDirectoryForCurrentUser
        let storedServerURL = defaults.string(forKey: Keys.serverURL)
        if let storedServerURL, !Keys.legacyServerURLs.contains(storedServerURL) {
            serverURL = storedServerURL
        } else {
            let developmentServerURL = "ws://localhost:3007/ws/client"
            serverURL = developmentServerURL
            defaults.set(developmentServerURL, forKey: Keys.serverURL)
        }
        if let stored = defaults.string(forKey: Keys.deviceID), let id = UUID(uuidString: stored) {
            deviceID = id
        } else {
            let id = UUID()
            deviceID = id
            defaults.set(id.uuidString, forKey: Keys.deviceID)
        }
        remoteClient = RemoteClient(
            deviceID: deviceID,
            stateHandler: { [weak self] state, message in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.connectionState = state
                    if let message { self.errorMessage = message }
                    else if state == .connected { self.errorMessage = nil }
                    if state == .connected { self.syncRemoteState() }
                }
            },
            commandHandler: { [weak self] command in
                await self?.handleRemoteCommand(command)
                    ?? .rejected("app_unavailable", "Mac App is shutting down.")
            }
        )
    }

    func beginConnecting() { connectionState = .connecting }
    func markConnected() { connectionState = .connected }
    func markOffline() { connectionState = .offline }

    func connectToServer() {
        guard !connectionStarted else { return }
        connectionStarted = true
        reconnectToServer()
    }

    func reconnectToServer() {
        connectionStarted = true
        connectionState = .connecting
        guard let remoteClient else { return }
        let url = serverURL
        Task { await remoteClient.connect(to: url) }
    }

    func addSession(directory: URL, toolID: String, displayName: String? = nil) {
        sessions.append(
            ManagedSession(directory: directory, toolID: toolID, displayName: displayName)
        )
    }

    var selectedToolAvailability: ToolAvailability {
        selectedTool.makeAdapter(executableURL: configuredExecutableURL(for: selectedTool)).detect()
    }
    var suggestedSessionName: String {
        "\(selectedTool.displayName) — \(workingDirectory.lastPathComponent)"
    }

    func proxyConfiguration(for tool: BuiltInTool) -> ToolProxyConfiguration {
        proxyConfigurations[tool.rawValue] ?? .inherited
    }

    func setProxyConfiguration(_ configuration: ToolProxyConfiguration, for tool: BuiltInTool) {
        proxyConfigurations[tool.rawValue] = configuration
    }

    func executablePath(for tool: BuiltInTool) -> String {
        toolExecutablePaths[tool.rawValue] ?? ""
    }

    func setExecutablePath(_ path: String, for tool: BuiltInTool) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { toolExecutablePaths.removeValue(forKey: tool.rawValue) }
        else { toolExecutablePaths[tool.rawValue] = trimmed }
    }

    func chooseExecutable(for tool: BuiltInTool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.prompt = "选择"
        if panel.runModal() == .OK, let url = panel.url {
            setExecutablePath(url.path, for: tool)
        }
    }

    func chooseWorkingDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = workingDirectory
        panel.prompt = "选择目录"
        if panel.runModal() == .OK, let url = panel.url {
            workingDirectory = url
        }
    }

    @discardableResult
    func startLocalTerminal() -> UUID? {
        do {
            guard let remoteClient else { return nil }
            let proxy = proxyConfiguration(for: selectedTool)
            if let validationMessage = proxy.validationMessage {
                errorMessage = validationMessage
                return nil
            }
            let displayName = normalizedSessionName
            let terminalSession = try LocalTerminalSession(
                directory: workingDirectory,
                tool: selectedTool,
                executableURL: configuredExecutableURL(for: selectedTool),
                proxy: proxy,
                outputHandler: { batch in
                    Task { await remoteClient.publishTerminalOutput(batch) }
                },
                stateHandler: { [weak self] id, state in
                    self?.handleLocalSessionState(id: id, state: state)
                }
            )
            terminalSessions[terminalSession.id] = terminalSession
            sessions.append(
                ManagedSession(
                    id: terminalSession.id,
                    directory: workingDirectory,
                    toolID: selectedTool.rawValue,
                    displayName: displayName
                )
            )
            let workspaceID = workspaceID(for: workingDirectory)
            let directory = terminalSession.directory
            let toolKey = terminalSession.tool.rawValue
            Task {
                await remoteClient.setActiveSessionCount(activeSessionCount)
                await remoteClient.publishWorkspace(id: workspaceID, directory: directory)
                await remoteClient.publishSession(
                    id: terminalSession.id,
                    workspaceId: workspaceID,
                    toolKey: toolKey,
                    displayName: displayName,
                    startedAt: terminalSession.startedAt
                )
            }
            errorMessage = nil
            sessionName = ""
            return terminalSession.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func startLocalSession() -> UUID? {
        selectedTool == .codex ? startStructuredSession() : startLocalTerminal()
    }

    @discardableResult
    private func startStructuredSession() -> UUID? {
        guard selectedTool == .codex, let remoteClient else {
            errorMessage = "结构化模式目前仅支持 Codex。"
            return nil
        }
        let proxy = proxyConfiguration(for: selectedTool)
        if let validationMessage = proxy.validationMessage {
            errorMessage = validationMessage
            return nil
        }
        let displayName = normalizedSessionName
        guard let executableURL = configuredExecutableURL(for: selectedTool)
            ?? ExecutableLocator.find(named: "codex") else {
            errorMessage = "找不到 codex 可执行程序"
            return nil
        }
        let sessionID = UUID()
        let sessionDirectory = workingDirectory
        let environment = TerminalEnvironment.make(proxy: proxy)
        let host = CodexAppServerHost(
            executableURL: executableURL,
            directory: sessionDirectory,
            environment: environment
        )
        let session = LocalStructuredAgentSession(
            id: sessionID,
            directory: sessionDirectory,
            adapter: CodexStructuredAdapter(
                configuredExecutableURL: executableURL,
                host: host
            ),
            webDisplayMode: agentWebDisplayMode,
            environment: environment,
            eventHandler: { event in
                Task { await remoteClient.publishToolEvent(event) }
            },
            stateHandler: { [weak self] id, state in
                self?.handleStructuredSessionState(id: id, state: state)
            },
            referenceHandler: { [weak self] reference in
                self?.startCodexTUI(
                    sessionID: sessionID,
                    directory: sessionDirectory,
                    executableURL: executableURL,
                    proxy: proxy,
                    endpoint: host.endpoint,
                    threadID: reference.opaqueID,
                    remoteClient: remoteClient
                )
            }
        )
        structuredSessions[session.id] = session
        sessions.append(ManagedSession(
            id: session.id,
            directory: workingDirectory,
            toolID: selectedTool.rawValue,
            displayName: displayName,
            runtimeMode: .structured,
            webDisplayMode: agentWebDisplayMode
        ))
        let workspaceID = workspaceID(for: workingDirectory)
        Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
            await remoteClient.publishSession(
                id: session.id,
                workspaceId: workspaceID,
                toolKey: selectedTool.rawValue,
                displayName: displayName,
                runtimeMode: .structured,
                webDisplayMode: agentWebDisplayMode,
                startedAt: session.startedAt
            )
            await session.start()
        }
        errorMessage = nil
        sessionName = ""
        return session.id
    }

    private func startCodexTUI(
        sessionID: UUID,
        directory: URL,
        executableURL: URL,
        proxy: ToolProxyConfiguration,
        endpoint: String,
        threadID: String,
        remoteClient: RemoteClient
    ) {
        guard structuredSessions[sessionID] != nil, terminalSessions[sessionID] == nil else { return }
        do {
            let adapter = CodexAdapter(configuredExecutableURL: executableURL)
            let launch = try adapter.makeRemoteLaunchConfiguration(
                directory: directory,
                proxy: proxy,
                endpoint: endpoint,
                threadID: threadID
            )
            let terminal = try LocalTerminalSession(
                id: sessionID,
                directory: directory,
                tool: .codex,
                executableURL: executableURL,
                proxy: proxy,
                launchConfiguration: launch,
                outputHandler: { batch in
                    Task { await remoteClient.publishTerminalOutput(batch) }
                },
                stateHandler: { [weak self] id, state in
                    self?.handleLocalSessionState(id: id, state: state)
                }
            )
            terminalSessions[sessionID] = terminal
            terminal.startIfNeeded()
        } catch {
            errorMessage = error.localizedDescription
            Task { await structuredSessions[sessionID]?.stop() }
        }
    }

    func terminalSession(id: UUID) -> LocalTerminalSession? {
        terminalSessions[id]
    }

    func structuredSession(id: UUID) -> LocalStructuredAgentSession? {
        structuredSessions[id]
    }

    func stopLocalTerminal(id: UUID) {
        terminalSessions[id]?.terminate()
        if let structured = structuredSessions[id] {
            Task { await structured.stop() }
        }
        updateActiveSessionCount()
    }

    func closeLocalTerminal(id: UUID) {
        terminalSessions[id]?.terminate()
        terminalSessions[id] = nil
        if let structured = structuredSessions.removeValue(forKey: id) {
            Task { await structured.stop() }
        }
        sessions.removeAll { $0.id == id }
        updateActiveSessionCount()
    }

    func terminateAllSessions() {
        for session in terminalSessions.values { session.terminate() }
        for session in structuredSessions.values { Task { await session.stop() } }
        if let remoteClient { Task { await remoteClient.disconnect() } }
    }

    private func syncRemoteState() {
        guard let remoteClient else { return }
        let activeSessions = terminalSessions.values.filter {
            $0.state.isActive && structuredSessions[$0.id] == nil
        }
        let activeStructured = structuredSessions.values.filter { $0.state.isActive }
        let displayNames = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0.displayName) })
        Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            for session in activeSessions {
                let workspaceID = workspaceID(for: session.directory)
                await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
                await remoteClient.publishSession(
                    id: session.id,
                    workspaceId: workspaceID,
                    toolKey: session.tool.rawValue,
                    displayName: displayNames[session.id]
                        ?? "\(session.tool.displayName) — \(session.directory.lastPathComponent)",
                    startedAt: session.startedAt
                )
            }
            for session in activeStructured {
                let workspaceID = workspaceID(for: session.directory)
                await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
                await remoteClient.publishSession(
                    id: session.id,
                    workspaceId: workspaceID,
                    toolKey: BuiltInTool.codex.rawValue,
                    displayName: displayNames[session.id] ?? "Codex Agent — \(session.directory.lastPathComponent)",
                    runtimeMode: .structured,
                    webDisplayMode: session.webDisplayMode,
                    startedAt: session.startedAt
                )
                for event in session.events { await remoteClient.publishToolEvent(event) }
            }
        }
    }

    private func handleRemoteCommand(_ command: RemoteTerminalCommand) async -> RemoteCommandResult {
        switch command {
        case .startTurn(let commandID, let sessionID, let text):
            guard let session = structuredSessions[sessionID] else {
                return .rejected("unknown_session", "The requested structured session is not active.")
            }
            return await session.startTurn(text, idempotencyKey: commandID)
        case .interruptTurn(_, let sessionID):
            guard let session = structuredSessions[sessionID] else {
                return .rejected("unknown_session", "The requested structured session is not active.")
            }
            return await session.interrupt()
        case .resolveApproval(_, let sessionID, let approvalID, let turnID, let decision):
            guard let session = structuredSessions[sessionID] else {
                return .rejected("unknown_session", "The requested structured session is not active.")
            }
            return await session.resolveApproval(approvalID: approvalID, turnID: turnID, decision: decision)
        case .stop(_, let sessionID) where structuredSessions[sessionID] != nil:
            terminalSessions[sessionID]?.terminate()
            await structuredSessions[sessionID]?.stop()
            updateActiveSessionCount()
            return .completed
        default: break
        }
        guard let session = terminalSessions[command.sessionId] else {
            return .rejected("unknown_session", "The requested local session is not active.")
        }
        guard session.state == .running else {
            return .rejected("session_not_running", "The local session is not running.")
        }
        switch command {
        case .input(_, _, let data): session.sendRemoteInput(data)
        case .resize(_, _, let columns, let rows): session.resize(columns: columns, rows: rows)
        case .interrupt: session.sendInterrupt()
        case .stop:
            session.terminate()
            updateActiveSessionCount()
        case .startTurn, .interruptTurn, .resolveApproval:
            break
        }
        return .completed
    }

    private var activeSessionCount: Int {
        let terminalIDs = Set(terminalSessions.values.filter { $0.state.isActive }.map(\.id))
        let structuredIDs = Set(structuredSessions.values.filter { $0.state.isActive }.map(\.id))
        return terminalIDs.union(structuredIDs).count
    }

    private var normalizedSessionName: String {
        let trimmed = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? suggestedSessionName : trimmed).prefix(128))
    }

    private func updateActiveSessionCount() {
        guard let remoteClient else { return }
        let count = activeSessionCount
        Task { await remoteClient.setActiveSessionCount(count) }
    }

    private func handleLocalSessionState(id: UUID, state: SessionState) {
        updateActiveSessionCount()
        guard state == .finished || state == .failed, let remoteClient else { return }
        if let structured = structuredSessions[id], structured.state != .finished {
            Task { await structured.stop() }
        }
        Task {
            await remoteClient.publishSessionEnded(
                id: id,
                status: state,
                finishedAt: RelayDate.now()
            )
        }
    }

    private func handleStructuredSessionState(id: UUID, state: StructuredSessionState) {
        updateActiveSessionCount()
        guard state == .finished || state == .failed, let remoteClient else { return }
        if terminalSessions[id]?.state.isActive == true {
            terminalSessions[id]?.terminate()
        }
        Task {
            await remoteClient.publishSessionEnded(
                id: id,
                status: state == .failed ? .failed : .finished,
                finishedAt: RelayDate.now()
            )
        }
    }

    private func workspaceID(for directory: URL) -> String {
        var identifiers = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String] ?? [:]
        if let existing = identifiers[directory.path] { return existing }
        let identifier = "workspace-\(UUID().uuidString.lowercased())"
        identifiers[directory.path] = identifier
        defaults.set(identifiers, forKey: Keys.workspaceIDs)
        return identifier
    }

    private enum Keys {
        static let serverURL = "serverURL"
        static let deviceID = "deviceID"
        static let workspaceIDs = "workspaceIDs"
        static let proxyConfigurations = "toolProxyConfigurations"
        static let toolExecutablePaths = "toolExecutablePaths"
        static let agentWebDisplayMode = "agentWebDisplayMode"
        static let legacyServerURLs = [
            "ws://localhost:3000/ws/client",
            "ws://127.0.0.1:3000/ws/client",
        ]
    }

    private func persistProxyConfigurations() {
        guard let data = try? JSONEncoder().encode(proxyConfigurations) else { return }
        defaults.set(data, forKey: Keys.proxyConfigurations)
    }

    private static func loadProxyConfigurations(
        from defaults: UserDefaults
    ) -> [String: ToolProxyConfiguration] {
        guard let data = defaults.data(forKey: Keys.proxyConfigurations),
              let value = try? JSONDecoder().decode(
                [String: ToolProxyConfiguration].self,
                from: data
              ) else { return [:] }
        return value
    }

    private func configuredExecutableURL(for tool: BuiltInTool) -> URL? {
        let path = executablePath(for: tool).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return nil }
        return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
    }
}

private extension SessionState {
    var isActive: Bool { self == .starting || self == .running || self == .stopping }
}

private extension StructuredSessionState {
    var isActive: Bool {
        switch self {
        case .created, .starting, .ready, .running, .awaitingApproval, .interrupting, .degraded: true
        case .finished, .failed: false
        }
    }
}
