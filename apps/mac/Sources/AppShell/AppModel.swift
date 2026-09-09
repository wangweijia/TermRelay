import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var connectionState: ConnectionState = .offline
    @Published private(set) var sessions: [ManagedSession] = []
    @Published var serverURL: String {
        didSet { defaults.set(serverURL, forKey: Keys.serverURL) }
    }

    let deviceID: UUID
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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

    private enum Keys {
        static let serverURL = "serverURL"
        static let deviceID = "deviceID"
    }
}

