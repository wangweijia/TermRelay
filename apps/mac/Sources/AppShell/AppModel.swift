import AppKit
import Foundation

enum ClientAuthorizationState: Equatable {
    case notRequired
    case unauthorized
    case requesting
    case awaitingApproval(userCode: String)
    case authorized
    case failed(String)
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var connectionState: ConnectionState = .offline
    @Published private(set) var sessions: [ManagedSession] = []
    @Published private(set) var terminalSessions: [UUID: LocalTerminalSession] = [:]
    @Published private(set) var structuredSessions: [UUID: LocalStructuredAgentSession] = [:]
    @Published private(set) var workingDirectory: URL
    @Published private(set) var errorMessage: String?
    @Published private(set) var dshAPIKeyConfigured = false
    @Published private(set) var clientAuthorizationState: ClientAuthorizationState = .notRequired
    @Published var selectedTool: BuiltInTool = .shell
    @Published var codexInteractionMode: CodexInteractionMode {
        didSet { defaults.set(codexInteractionMode.rawValue, forKey: Keys.codexInteractionMode) }
    }
    @Published var acpSendShortcut: ACPSendShortcut {
        didSet { defaults.set(acpSendShortcut.rawValue, forKey: Keys.acpSendShortcut) }
    }
    @Published var sessionName = ""
    @Published var proxyConfigurations: [String: ToolProxyConfiguration] {
        didSet { persistProxyConfigurations() }
    }
    @Published var toolExecutablePaths: [String: String] {
        didSet { defaults.set(toolExecutablePaths, forKey: Keys.toolExecutablePaths) }
    }
    @Published var serverURL: String {
        didSet {
            defaults.set(serverURL, forKey: Keys.serverURL)
            pairingTask?.cancel()
            refreshClientAuthorizationState()
        }
    }

    let deviceID: UUID
    private let defaults: UserDefaults
    private let credentialStore: any CredentialStoring
    private let pairingClient: ClientPairingClient
    private var remoteClient: RemoteClient?
    private var connectionStarted = false
    private var pairingTask: Task<Void, Never>?

    init(
        defaults: UserDefaults = .standard,
        credentialStore: any CredentialStoring = KeychainCredentialStore(),
        pairingClient: ClientPairingClient = ClientPairingClient()
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStore
        self.pairingClient = pairingClient
        proxyConfigurations = Self.loadProxyConfigurations(from: defaults)
        toolExecutablePaths = defaults.dictionary(forKey: Keys.toolExecutablePaths) as? [String: String] ?? [:]
        codexInteractionMode = defaults.string(forKey: Keys.codexInteractionMode)
            .flatMap(CodexInteractionMode.init(rawValue:)) ?? .pty
        acpSendShortcut = defaults.string(forKey: Keys.acpSendShortcut)
            .flatMap(ACPSendShortcut.init(rawValue:)) ?? .commandEnter
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
        dshAPIKeyConfigured = ((try? credentialStore.read(account: Keys.dshAPIKeyAccount)) ?? nil)?
            .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        refreshClientAuthorizationState()
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
            },
            authorizationInvalidatedHandler: { [weak self] in
                Task { @MainActor [weak self] in self?.removeInvalidCredential() }
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
        guard let remoteClient else { return }
        let url = serverURL
        let credential: String?
        do {
            credential = try clientCredential(for: url)
        } catch {
            connectionState = .offline
            errorMessage = error.localizedDescription
            return
        }
        if isPublicClientURL(url), credential == nil {
            connectionState = .offline
            errorMessage = "公网连接需要先授权此 Mac。"
            Task { await remoteClient.disconnect() }
            return
        }
        connectionState = .connecting
        Task { await remoteClient.connect(to: url, credential: credential) }
    }

    func useDefaultPublicServer() {
        serverURL = "wss://termrelay.wqyhomes.com/ws/client-public"
    }

    func authorizeClient() {
        pairingTask?.cancel()
        guard let serverWebSocketURL = URL(string: serverURL),
              isPublicClientURL(serverURL),
              let credentialAccount = clientCredentialAccount(for: serverURL) else {
            clientAuthorizationState = .failed("请先将 Server URL 设置为 /ws/client-public 公网入口。")
            return
        }
        clientAuthorizationState = .requesting
        pairingTask = Task { [weak self] in
            guard let self else { return }
            do {
                let pairing = try await pairingClient.create(
                    serverWebSocketURL: serverWebSocketURL,
                    deviceID: deviceID,
                    deviceName: Host.current().localizedName ?? "Mac",
                    appVersion: Self.appVersion
                )
                try Task.checkCancellation()
                clientAuthorizationState = .awaitingApproval(userCode: pairing.userCode)
                NSWorkspace.shared.open(pairing.verificationURL)
                let deadline = Date().addingTimeInterval(TimeInterval(pairing.expiresIn))
                while Date() < deadline {
                    try await Task.sleep(for: .seconds(max(1, pairing.pollInterval)))
                    switch try await pairingClient.exchange(
                        serverWebSocketURL: serverWebSocketURL,
                        pairingID: pairing.pairingID,
                        deviceCode: pairing.deviceCode
                    ) {
                    case .pending:
                        continue
                    case .issued(let credential, _):
                        try Task.checkCancellation()
                        try credentialStore.write(credential, account: credentialAccount)
                        clientAuthorizationState = .authorized
                        pairingTask = nil
                        reconnectToServer()
                        return
                    case .denied:
                        throw ClientAuthorizationError.denied
                    case .expired:
                        throw ClientAuthorizationError.expired
                    case .invalid:
                        throw ClientPairingError.invalidResponse
                    }
                }
                throw ClientAuthorizationError.expired
            } catch is CancellationError {
                return
            } catch {
                clientAuthorizationState = .failed(error.localizedDescription)
                pairingTask = nil
            }
        }
    }

    func cancelClientAuthorization() {
        pairingTask?.cancel()
        pairingTask = nil
        refreshClientAuthorizationState()
    }

    func removeClientCredential() {
        guard let account = clientCredentialAccount(for: serverURL) else { return }
        do {
            try credentialStore.delete(account: account)
            clientAuthorizationState = .unauthorized
            connectionState = .offline
            Task { await remoteClient?.disconnect() }
        } catch {
            errorMessage = error.localizedDescription
        }
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

    func saveDSHAPIKey(_ value: String) throws {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw AgentError.providerUnavailable("DeepSeek API Key 不能为空")
        }
        try credentialStore.write(trimmed, account: Keys.dshAPIKeyAccount)
        dshAPIKeyConfigured = true
    }

    func removeDSHAPIKey() throws {
        try credentialStore.delete(account: Keys.dshAPIKeyAccount)
        dshAPIKeyConfigured = false
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
            guard selectedTool != .dsh, selectedTool != .copilot else {
                throw ToolLaunchError.unsupportedMode("\(selectedTool.displayName) 当前仅支持 ACP 模式")
            }
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
        (selectedTool == .codex && codexInteractionMode == .acp)
            || selectedTool == .copilot
            || selectedTool == .dsh
            ? startStructuredSession()
            : startLocalTerminal()
    }

    @discardableResult
    private func startStructuredSession() -> UUID? {
          guard selectedTool == .codex || selectedTool == .copilot || selectedTool == .dsh,
              let remoteClient else {
            errorMessage = "该工具不支持结构化模式。"
            return nil
        }
        let proxy = proxyConfiguration(for: selectedTool)
        if let validationMessage = proxy.validationMessage {
            errorMessage = validationMessage
            return nil
        }
        let displayName = normalizedSessionName
        let executableName = switch selectedTool {
        case .copilot: "copilot"
        case .dsh: "dsh"
        default: "codex"
        }
        guard let executableURL = configuredExecutableURL(for: selectedTool)
            ?? ExecutableLocator.find(named: executableName) else {
            errorMessage = "找不到 \(executableName) 可执行程序"
            return nil
        }
        let sessionID = UUID()
        let sessionDirectory = workingDirectory
        var environment = TerminalEnvironment.make(proxy: proxy, executableURL: executableURL)
        let adapter: any StructuredAgentAdapter
        if selectedTool == .dsh {
            guard let key = (try? credentialStore.read(account: Keys.dshAPIKeyAccount)) ?? nil,
                  !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                errorMessage = "请先在设置中配置 DeepSeek API Key"
                return nil
            }
            environment["DEEPSEEK_API_KEY"] = key
            adapter = DSHStructuredAdapter(configuredExecutableURL: executableURL)
        } else if selectedTool == .copilot {
            adapter = CopilotStructuredAdapter(configuredExecutableURL: executableURL)
        } else {
            let host = CodexAppServerHost(
                executableURL: executableURL,
                directory: sessionDirectory,
                environment: environment
            )
            adapter = CodexStructuredAdapter(
                configuredExecutableURL: executableURL,
                host: host
            )
        }
        let session = LocalStructuredAgentSession(
            id: sessionID,
            directory: sessionDirectory,
            adapter: adapter,
            environment: environment,
            eventHandler: { event in
                Task { await remoteClient.publishToolEvent(event) }
            },
            stateHandler: { [weak self] id, state in
                self?.handleStructuredSessionState(id: id, state: state)
            }
        )
        structuredSessions[session.id] = session
        sessions.append(ManagedSession(
            id: session.id,
            directory: workingDirectory,
            toolID: selectedTool.rawValue,
            displayName: displayName,
            runtimeMode: .acp
        ))
        let workspaceID = workspaceID(for: workingDirectory)
        let tool = selectedTool
        Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
            await session.start()
            guard session.state == .ready else { return }
            await remoteClient.publishSession(
                id: session.id,
                workspaceId: workspaceID,
                toolKey: tool.rawValue,
                displayName: displayName,
                runtimeMode: .acp,
                startedAt: session.startedAt
            )
        }
        errorMessage = nil
        sessionName = ""
        return session.id
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

    func terminateAllSessions() async {
        for session in terminalSessions.values { session.terminate() }
        for session in structuredSessions.values { await session.stop() }
        if let remoteClient { await remoteClient.disconnect() }
    }

    private func syncRemoteState() {
        guard let remoteClient else { return }
        let activeSessions = terminalSessions.values.filter {
            $0.state.isActive && structuredSessions[$0.id] == nil
        }
        let activeStructured = structuredSessions.values.filter { $0.state.isActive }
        let managedSessions = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            for session in activeSessions {
                let workspaceID = workspaceID(for: session.directory)
                await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
                await remoteClient.publishSession(
                    id: session.id,
                    workspaceId: workspaceID,
                    toolKey: session.tool.rawValue,
                    displayName: managedSessions[session.id]?.displayName
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
                    toolKey: managedSessions[session.id]?.toolID ?? BuiltInTool.codex.rawValue,
                    displayName: managedSessions[session.id]?.displayName
                        ?? "Agent — \(session.directory.lastPathComponent)",
                    runtimeMode: .acp,
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
        case .resolveUserInput(_, let sessionID, let requestID, let turnID, let answers):
            guard let session = structuredSessions[sessionID] else {
                return .rejected("unknown_session", "The requested ACP session is not active.")
            }
            return await session.resolveUserInput(
                requestID: requestID,
                turnID: turnID,
                answers: answers
            )
        case .stop(_, let sessionID) where structuredSessions[sessionID] != nil:
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
        case .startTurn, .interruptTurn, .resolveApproval, .resolveUserInput:
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
        if state == .failed {
            errorMessage = structuredSessions[id]?.failureMessage ?? "ACP 会话启动失败"
        }
        terminalSessions[id]?.terminate()
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
        static let codexInteractionMode = "codexInteractionMode"
        static let acpSendShortcut = "acpSendShortcut"
        static let dshAPIKeyAccount = "deepseek.dsh.api-key"
        static let clientCredentialPrefix = "termrelay.client-credential."
        static let legacyServerURLs = [
            "ws://localhost:3000/ws/client",
            "ws://127.0.0.1:3000/ws/client",
        ]
    }

    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    private func isPublicClientURL(_ value: String) -> Bool {
        URL(string: value)?.path == "/ws/client-public"
    }

    private func clientCredentialAccount(for value: String) -> String? {
        guard let url = URL(string: value), isPublicClientURL(value), let host = url.host else {
            return nil
        }
        let authority = url.port.map { "\(host):\($0)" } ?? host
        return Keys.clientCredentialPrefix + authority.lowercased()
    }

    private func clientCredential(for value: String) throws -> String? {
        guard let account = clientCredentialAccount(for: value) else { return nil }
        return try credentialStore.read(account: account)
    }

    private func refreshClientAuthorizationState() {
        guard isPublicClientURL(serverURL) else {
            clientAuthorizationState = .notRequired
            return
        }
        do {
            clientAuthorizationState = try clientCredential(for: serverURL) == nil
                ? .unauthorized : .authorized
        } catch {
            clientAuthorizationState = .failed(error.localizedDescription)
        }
    }

    private func removeInvalidCredential() {
        guard let account = clientCredentialAccount(for: serverURL) else { return }
        try? credentialStore.delete(account: account)
        clientAuthorizationState = .unauthorized
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

private enum ClientAuthorizationError: LocalizedError {
    case denied
    case expired

    var errorDescription: String? {
        switch self {
        case .denied: "此 Mac 的授权请求已被拒绝。"
        case .expired: "授权请求已过期，请重新发起。"
        }
    }
}

private extension SessionState {
    var isActive: Bool { self == .starting || self == .running || self == .stopping }
}

private extension StructuredSessionState {
    var isActive: Bool {
        switch self {
        case .created, .starting, .ready, .running, .awaitingApproval, .awaitingUserInput, .interrupting, .degraded: true
        case .finished, .failed: false
        }
    }
}
