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
    @Published private(set) var pendingApprovals = PendingApprovalInbox()
    @Published private(set) var projectHistory: [RelayHistorySession] = []
    @Published private(set) var copilotHistory: [CopilotHistorySession] = []
    @Published private(set) var historyMessages: [UUID: [CopilotHistoryMessage]] = [:]
    @Published private(set) var historyLoadingID: UUID?
    @Published private(set) var quickActions: [QuickAction] = []
    @Published private(set) var quickRuns: [UUID: QuickActionRun] = [:]
    @Published private(set) var workingDirectory: URL
    @Published private(set) var errorMessage: String?
    @Published private(set) var dshAPIKeyConfigured = false
    @Published private(set) var clientAuthorizationState: ClientAuthorizationState = .notRequired
    @Published var selectedTool: BuiltInTool = .shell
    @Published var copilotReasoningEffort: CopilotReasoningEffort = .automatic
    @Published var codexInteractionMode: CodexInteractionMode {
        didSet { defaults.set(codexInteractionMode.rawValue, forKey: Keys.codexInteractionMode) }
    }
    @Published var acpSendShortcut: ACPSendShortcut {
        didSet { defaults.set(acpSendShortcut.rawValue, forKey: Keys.acpSendShortcut) }
    }
    @Published var sessionName = ""
    @Published private(set) var remoteWorkspaceIDs: Set<String> = []
    @Published var aiServiceEnabled: Bool {
        didSet {
            defaults.set(aiServiceEnabled,forKey:"aiServiceEnabled")
            Task { await publishAICapabilities() }
        }
    }
    @Published var aiWorkingDirectory: String {
        didSet {
            defaults.set(aiWorkingDirectory,forKey:"aiWorkingDirectory")
            Task { await publishAICapabilities() }
        }
    }
    private lazy var aiRuntime = AIRuntimeManager(
        factory: { [weak self] configuration, root, directory in
            guard let self else { throw AgentError.providerUnavailable("Mac App 已关闭") }
            return try await self.aiLaunch(configuration:configuration,root:root,directory:directory)
        },
        announce: { [weak self] create,directory,adapter in await self?.announceAI(create,directory:directory,adapter:adapter) },
        eventHandler: { [weak self] event in await self?.observeAI(event) },
        updateHandler: { [weak self] update in await self?.publishAIUpdate(update) }
    )
    @Published var proxyConfigurations: [String: ToolProxyConfiguration] {
        didSet { persistProxyConfigurations() }
    }
    @Published var toolExecutablePaths: [String: String] {
        didSet {
            defaults.set(toolExecutablePaths, forKey: Keys.toolExecutablePaths)
            Task { await publishAICapabilities(); await publishRemoteWorkspaces() }
        }
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
    private var pendingAutoApproveSync: [UUID: Bool] = [:]
    private var connectionStarted = false
    private var pairingTask: Task<Void, Never>?
    private let quickActionStore: QuickActionStore
    private var quickActionLoadError: String?
    private var quickRunPublishTasks: [UUID: Task<Void, Never>] = [:]
    private var remoteQuickRunIDs = Set<UUID>()
    private lazy var quickActionRunner = QuickActionRunner { [weak self] run in
        self?.quickRuns[run.id] = run
        self?.publishQuickActionRun(run)
    }

    init(
        defaults: UserDefaults = DeviceIdentity.preferences,
        credentialStore: any CredentialStoring = KeychainCredentialStore(),
        pairingClient: ClientPairingClient = ClientPairingClient(),
        quickActionStore: QuickActionStore = QuickActionStore()
    ) {
        self.defaults = defaults
        self.credentialStore = credentialStore
        self.pairingClient = pairingClient
        self.quickActionStore = quickActionStore
        remoteWorkspaceIDs = Set(defaults.stringArray(forKey: "remoteWorkspaceIDs") ?? [])
        aiServiceEnabled = defaults.bool(forKey:"aiServiceEnabled")
        aiWorkingDirectory = defaults.string(forKey:"aiWorkingDirectory") ?? ""
        do {
            quickActions = try quickActionStore.load()
        } catch {
            quickActionLoadError = "无法读取快捷任务：\(error.localizedDescription)"
            errorMessage = quickActionLoadError
        }
        proxyConfigurations = Self.loadProxyConfigurations(from: defaults)
        toolExecutablePaths = defaults.dictionary(forKey: Keys.toolExecutablePaths) as? [String: String] ?? [:]
        codexInteractionMode = .acp
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
        deviceID = DeviceIdentity.load(defaults:defaults)
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
                    if state == .connected {
                        Task { await self.aiRuntime.connected(); await self.publishAICapabilities() }
                        self.syncRemoteState()
                        self.publishQuickActions()
                        Task { await self.refreshCopilotHistory() }
                    } else if state == .offline || state == .connecting {
                        Task {
                            let externalIDs = self.sessions.filter({$0.projectID != nil}).map(\.id)
                            await self.aiRuntime.disconnected()
                            for id in externalIDs { self.closeLocalTerminal(id:id) }
                        }
                    }
                }
            },
            commandHandler: { [weak self] command in
                await self?.handleRemoteCommand(command)
                    ?? .rejected("app_unavailable", "Mac App is shutting down.")
            },
            autoApproveStateHandler: { [weak self] sessionID, enabled in
                Task { @MainActor [weak self] in
                    guard let self, let session = self.structuredSessions[sessionID] else { return }
                    if let pending = self.pendingAutoApproveSync[sessionID] {
                        guard pending == enabled else { return }
                        self.pendingAutoApproveSync[sessionID] = nil
                    }
                    session.setAutoApproveEnabled(enabled)
                    if enabled { self.pendingApprovals.clear(sessionID: sessionID) }
                }
            },
            authorizationInvalidatedHandler: { [weak self] in
                Task { @MainActor [weak self] in self?.removeInvalidCredential() }
            },
            quickActionHandler: { [weak self] command in
                await self?.handleQuickActionCommand(command)
            },
            quickActionInputHandler: { [weak self] request in
                await self?.handleQuickActionInput(request) ?? .rejected("Mac App 不可用")
            },
            filePreviewWorkspaceHandler: { [weak self] sessionID, workspaceID in
                await self?.filePreviewWorkspace(sessionID: sessionID, workspaceID: workspaceID)
            },
            aiHandler: { [weak self] type,payload in
                guard let self else { return }
                await self.aiRuntime.handle(type:type,payload:payload)
            },
            sessionStartHandler: { [weak self] request in
                await self?.startRemoteSession(request) ?? .rejected("app_unavailable", "Mac App is shutting down.")
            }
        )
    }

    func beginConnecting() { connectionState = .connecting }

    private func aiLaunch(configuration: AIExecutionConfiguration, root: URL, directory: URL) throws -> AILaunchContext {
        guard serverURL.hasSuffix("/ws/client"), let tool = BuiltInTool(rawValue:configuration.provider),
              let executable = configuredExecutableURL(for:tool) ?? ExecutableLocator.find(named:configuration.provider) else {
            throw AgentError.providerUnavailable("AI Provider 不可用或不是局域网连接")
        }
        var environment = TerminalEnvironment.make(proxy:proxyConfiguration(for:tool),executableURL:executable)
        if configuration.provider == "dsh" {
            guard let key = try credentialStore.read(account:Keys.dshAPIKeyAccount), !key.isEmpty, configuration.directory == nil else {
                throw AgentError.unsupportedCapability("DSH key/workspace")
            }
            environment["DEEPSEEK_API_KEY"] = key
            let adapter = DSHStructuredAdapter(configuredExecutableURL:executable,transportFactory:{ executable,directory,env in
                DSHACPProcess(executableURL:executable,directory:directory,environment:env,
                    aiSandbox:AIRuntimeSandbox(stateDirectory:URL(fileURLWithPath:env["DSH_HOME"]!)))
            })
            return AILaunchContext(adapter:adapter,environment:environment)
        }
        let sandbox: AIRuntimeSandbox?
        let binary: URL
        if configuration.directory == nil {
            guard let native = AIRuntimeSandbox.nativeCodex(executable) else { throw AgentError.unsupportedCapability("Codex native executable") }
            binary = native
            let state = root.appendingPathComponent("provider-state",isDirectory:true)
            try FileManager.default.createDirectory(at:state,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
            let original = environment["CODEX_HOME"].map {URL(fileURLWithPath:$0)} ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex")
            let auth = original.appendingPathComponent("auth.json")
            if FileManager.default.fileExists(atPath:auth.path) { try FileManager.default.copyItem(at:auth,to:state.appendingPathComponent("auth.json")) }
            // Do not inherit MCP/plugin/tool configuration into facts-only execution.
            environment["CODEX_HOME"] = state.path
            environment["TMPDIR"] = state.path
            sandbox = AIRuntimeSandbox(stateDirectory:state)
        } else { binary = executable; sandbox = nil }
        return AILaunchContext(adapter:CodexStructuredAdapter(configuredExecutableURL:binary,aiSandbox:sandbox),environment:environment)
    }

    private func publishAICapabilities() async {
        guard serverURL.hasSuffix("/ws/client"), let remoteClient else { return }
        do {
            let configurations: [AIExecutionConfiguration] = aiServiceEnabled ? [
                AIExecutionConfiguration(provider:"codex",capacity:4,directory:aiWorkingDirectory.isEmpty ? nil:aiWorkingDirectory),
                AIExecutionConfiguration(provider:"dsh",capacity:4,directory:nil),
            ] : []
            try await aiRuntime.configure(configurations)
            var available = Set<String>()
            if let codex = configuredExecutableURL(for:.codex) ?? ExecutableLocator.find(named:"codex"), AIRuntimeSandbox.nativeCodex(codex) != nil { available.insert("codex") }
            if dshAPIKeyConfigured, (configuredExecutableURL(for:.dsh) ?? ExecutableLocator.find(named:"dsh")) != nil { available.insert("dsh") }
            await remoteClient.publishAI(type:"ai.capabilities",payload:await aiRuntime.capabilities(availableProviders:available))
        } catch {
            errorMessage = "AI 服务：\(error.localizedDescription)"
            await remoteClient.publishAI(type:"ai.capabilities",payload:AiCapabilities(providers:[]))
        }
    }

    func chooseAIWorkingDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.allowsMultipleSelection = false
        panel.message = "选择允许外部 Codex 会话操作的工作目录。目录只保存在这台 Mac。"
        if panel.runModal() == .OK, let url = panel.url { aiWorkingDirectory = url.resolvingSymlinksInPath().path }
    }

    private func announceAI(_ create: AiCreate, directory: URL, adapter: any StructuredAgentAdapter) async {
        guard let id = UUID(uuidString:create.id), let remoteClient else { return }
        let manager = aiRuntime
        let session = LocalStructuredAgentSession(id:id,directory:directory,adapter:adapter,eventHandler:{_ in},
            approvalHandler:{ [weak self] event in self?.recordApprovalEvent(event) },
            stateHandler:{ [weak self] id,state in self?.handleStructuredSessionState(id:id,state:state) },
            externalActionHandler:{ action in await manager.action(sessionID:id,action:action) })
        structuredSessions[id] = session
        sessions.append(ManagedSession(id:id,directory:directory,toolID:create.provider,displayName:create.displayName,runtimeMode:.acp,projectID:create.projectId))
        let workspace = workspaceID(for:directory)
        await publishWorkspace(directory)
        await remoteClient.publishSession(id:id,workspaceId:workspace,toolKey:create.provider,displayName:create.displayName,runtimeMode:.acp,startedAt:session.startedAt,projectID:create.projectId)
    }
    private func observeAI(_ event: ToolEvent) async {
        structuredSessions[event.sessionID]?.observeExternal(event)
        await remoteClient?.publishToolEvent(event)
    }
    private func publishAIUpdate(_ update: AiUpdate) async {
        await remoteClient?.publishAI(type:"ai.update",payload:update)
        guard let id = UUID(uuidString:update.id) else { return }
        if update.status == "closed" {
            pendingApprovals.clear(sessionID:id)
            await structuredSessions[id]?.stop()
            structuredSessions[id] = nil
            sessions.removeAll(where:{$0.id == id})
            await remoteClient?.publishSessionEnded(id:id,status:.finished,finishedAt:RelayDate.now())
        }
    }
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
        serverURL = "wss://termrelay.example.com/ws/client-public"
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
        Task { await publishAICapabilities(); await publishRemoteWorkspaces() }
    }

    func removeDSHAPIKey() throws {
        try credentialStore.delete(account: Keys.dshAPIKeyAccount)
        dshAPIKeyConfigured = false
        Task { await publishAICapabilities(); await publishRemoteWorkspaces() }
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
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        panel.prompt = "选择目录"
        if panel.runModal() == .OK, let url = panel.url {
            workingDirectory = url
        }
    }

    @discardableResult
    func startLocalTerminal(
        id: UUID = UUID(), directory: URL? = nil, tool: BuiltInTool? = nil,
        name: String? = nil, publish: Bool = true
    ) -> UUID? {
        let selectedTool = tool ?? self.selectedTool
        let workingDirectory = directory ?? self.workingDirectory
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
            let displayName = name ?? normalizedSessionName
            let terminalSession = try LocalTerminalSession(
                id: id,
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
            if publish { Task {
                await remoteClient.setActiveSessionCount(activeSessionCount)
                await publishWorkspace(directory)
                await remoteClient.publishSession(
                    id: terminalSession.id,
                    workspaceId: workspaceID,
                    toolKey: toolKey,
                    displayName: displayName,
                    startedAt: terminalSession.startedAt
                )
            } }
            errorMessage = nil
            if publish { sessionName = "" }
            return terminalSession.id
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func startLocalSession(resuming savedSession: CopilotSavedSession? = nil) -> UUID? {
        // TODO: Remove CodexInteractionMode and Codex PTY launch support after the ACP-only UI migration settles.
        if savedSession != nil && selectedTool != .copilot {
            errorMessage = "只能使用 Copilot 继续 Copilot 会话。"
            return nil
        }
        return selectedTool == .codex
            || selectedTool == .copilot
            || selectedTool == .dsh
            ? startStructuredSession(resuming: savedSession)
            : startLocalTerminal()
    }

    func listCopilotSessions() async throws -> [CopilotSavedSession] {
        let proxy = proxyConfiguration(for: .copilot)
        if let message = proxy.validationMessage {
            throw AgentError.providerUnavailable(message)
        }
        let executable = configuredExecutableURL(for: .copilot)
            ?? ExecutableLocator.find(named: "copilot")
        guard let executable else {
            throw AgentError.providerUnavailable("找不到 copilot 可执行程序")
        }
        let adapter = CopilotStructuredAdapter(
            configuredExecutableURL: executable, reasoningEffort: copilotReasoningEffort
        )
        return try await adapter.listSessions(
            in: workingDirectory,
            environment: TerminalEnvironment.make(proxy: proxy, executableURL: executable)
        )
    }

    var visibleProjectSessions: [ManagedSession] {
        let localIDs = Set(sessions.map(\.id))
        return projectHistory.compactMap { record in
            guard let id = UUID(uuidString: record.id), !localIDs.contains(id) else { return nil }
            return ManagedSession(id: id, directory: workingDirectory, toolID: record.toolKey,
                displayName: record.displayName ?? record.toolKey, runtimeMode: .acp,
                state: SessionState(rawValue: record.status) ?? .failed,
                projectID: record.projectId ?? "API")
        }
    }

    func projectArchive(id: UUID) -> CopilotHistorySession? {
        guard let record = projectHistory.first(where: { UUID(uuidString: $0.id) == id }) else { return nil }
        return CopilotHistorySession(id: id, workspaceId: record.workspaceId,
            displayName: record.displayName ?? record.toolKey, status: record.status,
            directory: nil, updatedAt: record.updatedAt, toolKey: record.toolKey)
    }

    func refreshProjectHistory() async {
        guard connectionState == .connected, let remoteClient else { return }
        do { projectHistory = try await remoteClient.listCopilotHistory(scope: "external") }
        catch { errorMessage = "无法读取项目对话：\(error.localizedDescription)" }
    }

    func refreshCopilotHistory() async {
        guard let remoteClient else { return }
        do {
            let records = try await remoteClient.listCopilotHistory()
            let directories = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String] ?? [:]
            let pathsByID = Dictionary(uniqueKeysWithValues: directories.map { ($0.value, $0.key) })
            copilotHistory = records.compactMap { record in
                guard record.toolKey == BuiltInTool.copilot.rawValue,
                      record.runtimeMode == SessionRuntimeMode.acp.rawValue,
                      record.status == "finished" || record.status == "failed",
                      let id = UUID(uuidString: record.id),
                      structuredSessions[id] == nil else { return nil }
                return CopilotHistorySession(
                    id: id, workspaceId: record.workspaceId,
                    displayName: record.displayName ?? "GitHub Copilot",
                    status: record.status,
                    directory: pathsByID[record.workspaceId].map { URL(fileURLWithPath: $0) },
                    updatedAt: record.updatedAt
                )
            }
        } catch {
            errorMessage = "无法读取 Copilot 历史：\(error.localizedDescription)"
        }
    }

    func loadCopilotHistory(_ archive: CopilotHistorySession) async throws -> [RelayHistoryEvent] {
        guard let remoteClient else { throw AgentError.providerUnavailable("Server 未连接") }
        historyLoadingID = archive.id
        defer { historyLoadingID = nil }
        let events = try await remoteClient.loadCopilotHistory(sessionID: archive.id)
        historyMessages[archive.id] = projectArchive(id: archive.id) != nil
            ? ProjectHistory.messages(from: events, provider: archive.toolKey)
            : CopilotHistory.messages(from: events)
        return events
    }

    func deleteCopilotHistory(_ archive: CopilotHistorySession, purge: Bool) async throws {
        guard archive.status == "finished" || archive.status == "failed",
              (copilotHistory.contains(where: { $0.id == archive.id }) || projectArchive(id: archive.id) != nil) else {
            throw AgentError.providerUnavailable("只能删除已经结束的历史会话。")
        }
        guard let remoteClient else { throw AgentError.providerUnavailable("Server 未连接") }
        try await remoteClient.deleteCopilotHistory(sessionID: archive.id, purge: purge)
        projectHistory.removeAll { UUID(uuidString: $0.id) == archive.id }
        copilotHistory.removeAll { $0.id == archive.id }
        historyMessages[archive.id] = nil
    }

    func importCopilotHistory(_ archive: CopilotHistorySession) async -> UUID? {
        guard let directory = archive.directory,
              FileManager.default.fileExists(atPath: directory.path) else {
            errorMessage = "找不到原工作目录；请检查这台 Mac 的工作区设置。"
            return nil
        }
        do {
            let events = try await loadCopilotHistory(archive)
            guard !CopilotHistory.messages(from: events, assistantName: archive.toolKey == "copilot" ? "Copilot" : archive.toolKey).isEmpty,
                  let context = CopilotHistory.context(from: events) else {
                throw AgentError.providerUnavailable("Server 没有可用于继续的对话记录；历史可能已过期。")
            }
            workingDirectory = directory
            selectedTool = .copilot
            return startStructuredSession(initialContext: context)
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    private func startStructuredSession(
        resuming savedSession: CopilotSavedSession? = nil,
        initialContext: String? = nil,
        id: UUID = UUID(), directory: URL? = nil, tool: BuiltInTool? = nil,
        name: String? = nil, publish: Bool = true
    ) -> UUID? {
        let selectedTool = tool ?? self.selectedTool
        let workingDirectory = directory ?? self.workingDirectory
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
        if let savedSession,
           savedSession.directory.standardizedFileURL != workingDirectory.standardizedFileURL {
            errorMessage = "会话工作目录与当前工作目录不一致，请重新选择。"
            return nil
        }
        if let savedSession, structuredSessions.values.contains(where: {
            $0.state.isActive && (
                $0.providerSessionID == savedSession.id || $0.providerReference?.opaqueID == savedSession.id
            )
        }) {
            errorMessage = "该 Copilot 会话已在 TermRelay 中运行。"
            return nil
        }
        let displayName = name ?? normalizedSessionName
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
        let sessionID = id
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
            adapter = CopilotStructuredAdapter(
                configuredExecutableURL: executableURL,
                reasoningEffort: copilotReasoningEffort,
                initialContext: initialContext
            )
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
            providerSessionID: savedSession?.id,
            defaults: defaults,
            environment: environment,
            eventHandler: { event in
                Task { await remoteClient.publishToolEvent(event) }
            },
            approvalHandler: { [weak self] event in
                self?.recordApprovalEvent(event)
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
        if publish { Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            await publishWorkspace(session.directory)
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
        } }
        errorMessage = nil
        if publish { sessionName = "" }
        return session.id
    }

    func terminalSession(id: UUID) -> LocalTerminalSession? {
        terminalSessions[id]
    }

    func saveQuickAction(_ action: QuickAction) throws {
        if let quickActionLoadError { throw QuickActionError.invalid(quickActionLoadError) }
        try action.validate()
        var actions = quickActions
        if let index = actions.firstIndex(where: { $0.id == action.id }) {
            guard !quickActionRunner.isRunning(actionID: action.id) else {
                throw QuickActionError.invalid("任务执行中，不能修改。")
            }
            var updated = action
            updated.revision = actions[index].revision + 1
            actions[index] = updated
        } else {
            guard actions.count < 100 else {
                throw QuickActionError.invalid("最多保存 100 个快捷任务。")
            }
            var created = action
            created.revision = 1
            actions.append(created)
        }
        try quickActionStore.save(actions)
        quickActions = actions
        publishQuickActions()
    }

    func deleteQuickAction(id: UUID) throws {
        if let quickActionLoadError { throw QuickActionError.invalid(quickActionLoadError) }
        guard !quickActionRunner.isRunning(actionID: id) else {
            throw QuickActionError.invalid("请先等待任务完成或停止任务。")
        }
        let actions = quickActions.filter { $0.id != id }
        try quickActionStore.save(actions)
        quickActions = actions
        publishQuickActions()
    }

    func runQuickAction(id: UUID) throws -> UUID {
        guard let action = quickActions.first(where: { $0.id == id }) else {
            throw QuickActionError.invalid("快捷任务不存在。")
        }
        let runID = UUID()
        try quickActionRunner.start(action, runID: runID)
        return runID
    }

    func cancelQuickAction(runID: UUID) {
        quickActionRunner.cancel(runID)
    }

    func sendQuickActionInput(runID: UUID, answer: QuickActionAnswer) throws {
        try quickActionRunner.sendInput(
            QuickActionInputRequest(runID: runID, commandID: UUID(), answer: answer)
        )
    }

    private func handleQuickActionInput(_ request: QuickActionInputRequest) -> QuickActionInputResult {
        guard remoteQuickRunIDs.contains(request.runID),
              quickRuns[request.runID]?.status == "running" else {
            return .rejected("此运行不属于远程快捷任务，或已结束。")
        }
        do {
            try quickActionRunner.sendInput(request)
            return .accepted
        } catch {
            return .rejected(error.localizedDescription)
        }
    }

    private func handleQuickActionCommand(_ command: QuickActionCommand) async {
        switch command {
        case .start(let runID, let shortcutID, let revision):
            if let existing = quickRuns[runID] {
                remoteQuickRunIDs.insert(runID)
                publishQuickActionRun(existing)
                return
            }
            remoteQuickRunIDs.insert(runID)
            guard let action = quickActions.first(where: { $0.id == shortcutID }),
                  action.revision == revision else {
                quickActionRunner.fail(runID: runID, shortcutID: shortcutID,
                                       message: "快捷任务已删除或版本已更新，请刷新列表。")
                return
            }
            do {
                try quickActionRunner.start(action, runID: runID)
            } catch {
                quickActionRunner.fail(runID: runID, shortcutID: shortcutID,
                                       message: error.localizedDescription)
            }
        case .cancel(let runID):
            quickActionRunner.cancel(runID)
        }
    }

    private func publishQuickActions() {
        guard let remoteClient else { return }
        let entries = quickActions.map { action in
            QuickActionCatalogEntry(
                id: action.id.uuidString.lowercased(), revision: action.revision,
                name: action.name, description: action.description,
                workspaceId: workspaceID(for: action.directory),
                proxyMode: action.proxy.mode.rawValue,
                requiresConfirmation: action.requiresConfirmation
            )
        }
        Task { await remoteClient.publishQuickActions(entries) }
    }

    private func publishQuickActionRun(_ run: QuickActionRun) {
        guard remoteQuickRunIDs.contains(run.id) else { return }
        guard let remoteClient else { return }
        if run.status == "running" {
            guard quickRunPublishTasks[run.id] == nil else { return }
            quickRunPublishTasks[run.id] = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, let self,
                      let latest = self.quickRuns[run.id], latest.status == "running" else { return }
                await remoteClient.publishQuickActionRun(latest)
                self.quickRunPublishTasks[run.id] = nil
            }
        } else {
            quickRunPublishTasks.removeValue(forKey: run.id)?.cancel()
            remoteQuickRunIDs.remove(run.id)
            Task { await remoteClient.publishQuickActionRun(run) }
        }
    }

    func structuredSession(id: UUID) -> LocalStructuredAgentSession? {
        structuredSessions[id]
    }

    func setAutoApprove(sessionID: UUID, enabled: Bool) {
        guard let session = structuredSessions[sessionID], !session.isExternal else { return }
        session.setAutoApproveEnabled(enabled)
        if enabled { pendingApprovals.clear(sessionID: sessionID) }
        pendingAutoApproveSync[sessionID] = enabled
        if connectionState == .connected, let remoteClient {
            Task { await remoteClient.publishAutoApprove(sessionID: sessionID, enabled: enabled) }
        }
    }

    func stopLocalTerminal(id: UUID) {
        pendingApprovals.clear(sessionID: id)
        terminalSessions[id]?.terminate()
        if let structured = structuredSessions[id] {
            Task { await structured.stop() }
        }
        updateActiveSessionCount()
    }

    func closeLocalTerminal(id: UUID) {
        pendingAutoApproveSync[id] = nil
        if sessions.contains(where: {$0.id == id && $0.projectID != nil}) {
            Task { await aiRuntime.close(id.uuidString.lowercased()) }
        }
        pendingApprovals.clear(sessionID: id)
        terminalSessions[id]?.terminate()
        terminalSessions[id] = nil
        if let structured = structuredSessions.removeValue(forKey: id) {
            Task { await structured.stop() }
        }
        sessions.removeAll { $0.id == id }
        updateActiveSessionCount()
    }

    func terminateAllSessions() async {
        await aiRuntime.disconnected()
        let hadQuickRuns = quickActionRunner.hasRunningProcesses
        quickActionRunner.terminateAll()
        for _ in 0..<20 where quickActionRunner.hasRunningProcesses {
            try? await Task.sleep(for: .milliseconds(100))
        }
        if hadQuickRuns { quickActionRunner.forceTerminateAll() }
        pendingApprovals.clearAll()
        for session in terminalSessions.values { session.terminate() }
        for session in structuredSessions.values { await session.stop() }
        if let remoteClient { await remoteClient.disconnect() }
    }

    private func syncRemoteState() {
        guard let remoteClient else { return }
        let activeSessions = terminalSessions.values.filter {
            $0.state.isActive && structuredSessions[$0.id] == nil
        }
        let activeStructured = structuredSessions.values.filter { $0.state.isActive && !$0.isExternal }
        let managedSessions = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
        Task {
            await remoteClient.setActiveSessionCount(activeSessionCount)
            await publishRemoteWorkspaces()
            for session in activeSessions {
                let workspaceID = workspaceID(for: session.directory)
                await publishWorkspace(session.directory)
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
                await publishWorkspace(session.directory)
                await remoteClient.publishSession(
                    id: session.id,
                    workspaceId: workspaceID,
                    toolKey: managedSessions[session.id]?.toolID ?? BuiltInTool.codex.rawValue,
                    displayName: managedSessions[session.id]?.displayName
                        ?? "Agent — \(session.directory.lastPathComponent)",
                    runtimeMode: .acp,
                    startedAt: session.startedAt
                )
                if let enabled = pendingAutoApproveSync[session.id] {
                    await remoteClient.publishAutoApprove(sessionID: session.id, enabled: enabled)
                }
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
        case .setConfiguration(_, let sessionID, let id, let value):
            guard let session = structuredSessions[sessionID] else {
                return .rejected("unknown_session", "The requested structured session is not active.")
            }
            return await session.setConfiguration(id: id, value: value)
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
        case .startTurn, .setConfiguration, .interruptTurn, .resolveApproval, .resolveUserInput:
            break
        }
        return .completed
    }

    var remoteStartDirectories: [URL] {
        let identifiers = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String] ?? [:]
        return identifiers.keys.filter { path in
            identifiers[path].map { remoteWorkspaceIDs.contains($0) } ?? false
        }.sorted().map { URL(fileURLWithPath: $0) }
    }

    func chooseRemoteStartDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser
        panel.prompt = "授权目录"
        panel.message = "允许 Web / 手机在所选目录新建会话。不会创建会话或更改本地新建会话的工作目录。"
        if panel.runModal() == .OK, let url = panel.url {
            setWorkspaceRemoteStart(true, for: url)
        }
    }

    func setWorkspaceRemoteStart(_ enabled: Bool, for directory: URL) {
        let directory = directory.resolvingSymlinksInPath()
        let id = workspaceID(for: directory)
        if enabled { remoteWorkspaceIDs.insert(id) } else { remoteWorkspaceIDs.remove(id) }
        defaults.set(Array(remoteWorkspaceIDs), forKey: "remoteWorkspaceIDs")
        Task { await publishWorkspace(directory) }
    }

    private func remoteLaunchOptions(for directory: URL) -> [RelayLaunchOption] {
        guard remoteWorkspaceIDs.contains(workspaceID(for: directory)) else { return [] }
        var options: [RelayLaunchOption] = []
        if BuiltInTool.shell.makeAdapter(executableURL: configuredExecutableURL(for: .shell)).detect().isAvailable {
            options.append(RelayLaunchOption(toolKey: "shell", runtimeMode: "pty"))
        }
        for tool in [BuiltInTool.codex, .copilot, .dsh] {
            if tool == .dsh && !dshAPIKeyConfigured { continue }
            guard tool.makeAdapter(executableURL: configuredExecutableURL(for: tool)).detect().isAvailable else { continue }
            options.append(RelayLaunchOption(toolKey: tool.rawValue, runtimeMode: "acp"))
            if tool == .codex { options.append(RelayLaunchOption(toolKey: tool.rawValue, runtimeMode: "pty")) }
        }
        return options
    }

    private func publishRemoteWorkspaces() async {
        let identifiers = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String] ?? [:]
        for (path, id) in identifiers where remoteWorkspaceIDs.contains(id) {
            await publishWorkspace(URL(fileURLWithPath: path))
        }
    }

    private func publishWorkspace(_ directory: URL) async {
        await remoteClient?.publishWorkspace(id: workspaceID(for: directory), directory: directory,
            launchOptions: remoteLaunchOptions(for: directory))
    }

    func startRemoteSession(_ request: RemoteSessionStart) async -> RemoteCommandResult {
        let identifiers = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String] ?? [:]
        guard remoteWorkspaceIDs.contains(request.workspaceID),
              let path = identifiers.first(where: { $0.value == request.workspaceID })?.key,
              sessions.allSatisfy({ $0.id != request.sessionID }),
              let tool = BuiltInTool(rawValue: request.toolKey) else {
            return .rejected("unauthorized_workspace", "工作区未在本机授权远程创建，或会话 ID 已存在")
        }
        let directory = URL(fileURLWithPath: path)
        var isDirectory: ObjCBool = false
        guard directory.resolvingSymlinksInPath().path == path,
              FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue,
              remoteLaunchOptions(for: directory).contains(RelayLaunchOption(toolKey: request.toolKey, runtimeMode: request.runtimeMode)) else {
            return .rejected("unavailable", "工作区路径已变化，或工具/模式不可用")
        }
        guard activeSessionCount < 8 else { return .rejected("limit", "最多同时运行 8 个会话") }
        let name = request.displayName ?? "\(tool.displayName) — \(directory.lastPathComponent)"
        if request.runtimeMode == "pty" {
            guard startLocalTerminal(id: request.sessionID, directory: directory, tool: tool, name: name, publish: false) != nil,
                  let terminal = terminalSessions[request.sessionID] else {
                return .rejected("startup_failed", "PTY 启动失败；请检查 Mac 上的错误信息")
            }
            terminal.startIfNeeded()
            terminal.resize(columns: request.columns, rows: request.rows)
            guard terminal.state == .running else { return .rejected("startup_failed", "PTY 启动失败") }
            await publishWorkspace(directory)
            await remoteClient?.publishSession(id: terminal.id, workspaceId: request.workspaceID,
                toolKey: tool.rawValue, displayName: name, startedAt: terminal.startedAt)
        } else {
            guard startStructuredSession(id: request.sessionID, directory: directory, tool: tool, name: name, publish: false) != nil,
                  let session = structuredSessions[request.sessionID] else {
                return .rejected("startup_failed", "ACP 启动失败；请检查 Mac 上的错误信息")
            }
            await session.start()
            guard session.state == .ready else {
                await session.stop()
                return .rejected("startup_failed", "ACP 启动失败；请检查 Mac 上的错误信息")
            }
            await publishWorkspace(directory)
            await remoteClient?.publishSession(id: session.id, workspaceId: request.workspaceID, toolKey: tool.rawValue,
                displayName: name, runtimeMode: .acp, startedAt: session.startedAt)
        }
        updateActiveSessionCount()
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
        pendingApprovals.clear(sessionID: id)
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

    private func recordApprovalEvent(_ event: ToolEvent) {
        switch event.payload {
        case .approvalRequested:
            pendingApprovals.apply(event)
        case .approvalResolved, .turnCompleted, .failed:
            if pendingApprovals.bySession[event.sessionID] != nil {
                pendingApprovals.apply(event)
            }
        default:
            break
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

    private func filePreviewWorkspace(sessionID: UUID, workspaceID: String) -> URL? {
        guard let session = sessions.first(where: { $0.id == sessionID }),
              let identifiers = defaults.dictionary(forKey: Keys.workspaceIDs) as? [String: String],
              identifiers[session.directory.path] == workspaceID else { return nil }
        return session.directory
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
