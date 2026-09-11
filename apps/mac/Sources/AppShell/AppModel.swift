import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var connectionState: ConnectionState = .offline
    @Published private(set) var sessions: [ManagedSession] = []
    @Published private(set) var activeTerminalSession: LocalTerminalSession?
    @Published private(set) var workingDirectory: URL
    @Published private(set) var errorMessage: String?
    @Published var selectedTool: BuiltInTool = .shell
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Keys.serverURL) }
    }

    let deviceID: UUID
    private let defaults: UserDefaults
    private var remoteClient: RemoteClient?
    private var connectionStarted = false

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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

    func addSession(directory: URL, toolID: String) {
        sessions.append(ManagedSession(directory: directory, toolID: toolID))
    }

    var selectedToolAvailability: ToolAvailability { selectedTool.adapter.detect() }

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

    func startLocalTerminal() {
        activeTerminalSession?.terminate()
        do {
            guard let remoteClient else { return }
            let terminalSession = try LocalTerminalSession(
                directory: workingDirectory,
                tool: selectedTool,
                outputHandler: { batch in
                    Task { await remoteClient.publishTerminalOutput(batch) }
                }
            )
            activeTerminalSession = terminalSession
            sessions.append(
                ManagedSession(id: terminalSession.id, directory: workingDirectory, toolID: selectedTool.rawValue)
            )
            let workspaceID = workspaceID(for: workingDirectory)
            let directory = terminalSession.directory
            let toolKey = terminalSession.tool.rawValue
            Task {
                await remoteClient.setActiveSessionCount(1)
                await remoteClient.publishWorkspace(id: workspaceID, directory: directory)
                await remoteClient.publishSession(
                    id: terminalSession.id,
                    workspaceId: workspaceID,
                    toolKey: toolKey,
                    startedAt: terminalSession.startedAt
                )
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stopLocalTerminal() {
        activeTerminalSession?.terminate()
        if let remoteClient { Task { await remoteClient.setActiveSessionCount(0) } }
    }

    func closeLocalTerminal() {
        activeTerminalSession?.terminate()
        activeTerminalSession = nil
        if let remoteClient { Task { await remoteClient.setActiveSessionCount(0) } }
    }

    func terminateAllSessions() {
        activeTerminalSession?.terminate()
        if let remoteClient { Task { await remoteClient.disconnect() } }
    }

    private func syncRemoteState() {
        guard let remoteClient, let session = activeTerminalSession else { return }
        let workspaceID = workspaceID(for: session.directory)
        Task {
            await remoteClient.setActiveSessionCount(session.state == .running ? 1 : 0)
            await remoteClient.publishWorkspace(id: workspaceID, directory: session.directory)
            await remoteClient.publishSession(
                id: session.id,
                workspaceId: workspaceID,
                toolKey: session.tool.rawValue,
                startedAt: session.startedAt
            )
        }
    }

    private func handleRemoteCommand(_ command: RemoteTerminalCommand) -> RemoteCommandResult {
        guard let session = activeTerminalSession, session.id == command.sessionId else {
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
            if let remoteClient { Task { await remoteClient.setActiveSessionCount(0) } }
        }
        return .completed
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
        static let legacyServerURLs = [
            "ws://localhost:3000/ws/client",
            "ws://127.0.0.1:3000/ws/client",
        ]
    }
}
