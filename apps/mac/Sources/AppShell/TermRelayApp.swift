import SwiftUI

@MainActor
final class TermRelayAppDelegate: NSObject, NSApplicationDelegate {
    weak var appModel: AppModel?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // `swift run TermRelay` launches a plain SwiftPM executable rather than
        // an application bundle, so opt into a foreground GUI process here.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        appModel?.terminateAllSessions()
    }
}

@main
struct TermRelayApp: App {
    @NSApplicationDelegateAdaptor(TermRelayAppDelegate.self) private var appDelegate
    @StateObject private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appModel)
                .onAppear { appDelegate.appModel = appModel }
                .task { appModel.connectToServer() }
        }
        Settings {
            ServerSettingsView()
                .environmentObject(appModel)
        }
    }
}
