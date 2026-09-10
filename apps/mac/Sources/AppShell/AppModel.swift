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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        workingDirectory = FileManager.default.homeDirectoryForCurrentUser
        serverURL = defaults.string(forKey: Keys.serverURL) ?? "ws://localhost:3000/ws/client"
        if let stored = defaults.string(forKey: Keys.deviceID), let id = UUID(uuidString: stored) {
            deviceID = id
        } else {
            let id = UUID()
            deviceID = id
            defaults.set(id.uuidString, forKey: Keys.deviceID)
        }
    }

    func beginConnecting() { connectionState = .connecting }
    func markConnected() { connectionState = .connected }
    func markOffline() { connectionState = .offline }

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
            let terminalSession = try LocalTerminalSession(
                directory: workingDirectory,
                tool: selectedTool
            )
            activeTerminalSession = terminalSession
            sessions.append(
                ManagedSession(id: terminalSession.id, directory: workingDirectory, toolID: selectedTool.rawValue)
            )
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func stopLocalTerminal() {
        activeTerminalSession?.terminate()
    }

    func closeLocalTerminal() {
        activeTerminalSession?.terminate()
        activeTerminalSession = nil
    }

    func terminateAllSessions() {
        activeTerminalSession?.terminate()
    }

    private enum Keys {
        static let serverURL = "serverURL"
        static let deviceID = "deviceID"
    }
}
