import SwiftUI

@MainActor
final class TermRelayAppDelegate: NSObject, NSApplicationDelegate {
    weak var appModel: AppModel?
    private var terminationCleanupStarted = false
    private var terminationCleanupFinished = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Process enumeration and stale-process termination must never block AppKit's main thread.
        CodexAppServerHost.beginStartupCleanup()
        // Surface the Desktop/Documents/Downloads access prompt now instead of mid-Agent-run.
        ProtectedFolderPreflight.beginWarmup()
        // `swift run TermRelay` launches a plain SwiftPM executable rather than
        // an application bundle, so opt into a foreground GUI process here.
        NSApplication.shared.setActivationPolicy(.regular)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminationCleanupFinished { return .terminateNow }
        if terminationCleanupStarted { return .terminateLater }
        guard let appModel else { return .terminateNow }
        terminationCleanupStarted = true
        Task { @MainActor [weak self] in
            await appModel.terminateAllSessions()
            self?.terminationCleanupFinished = true
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
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
