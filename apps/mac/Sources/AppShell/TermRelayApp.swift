import SwiftUI

@main
struct TermRelayApp: App {
    @StateObject private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appModel)
        }
        Settings {
            ServerSettingsView()
                .environmentObject(appModel)
        }
    }
}

