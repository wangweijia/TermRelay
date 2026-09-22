import AppKit
import Foundation

/// Full Disk Access cannot be granted programmatically. On first launch, explain why
/// TermRelay needs it and take the user directly to the corresponding System Settings pane.
enum FullDiskAccessOnboarding {
    static let systemSettingsURL = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    )!

    private static let presentationKey = "fullDiskAccessOnboardingPresented"

    static func claimFirstPresentation(defaults: UserDefaults = .standard) -> Bool {
        guard !defaults.bool(forKey: presentationKey) else { return false }
        defaults.set(true, forKey: presentationKey)
        return true
    }

    @MainActor
    static func requestIfNeeded(defaults: UserDefaults = .standard) {
        guard claimFirstPresentation(defaults: defaults) else { return }

        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.alertStyle = .informational
            alert.messageText = "授予 TermRelay 完整磁盘访问权限"
            alert.informativeText = "TermRelay 需要完整磁盘访问权限，才能让你启动的终端和 Agent 访问本机工作区。请在系统设置中添加并开启 TermRelay，然后重新启动 App。"
            alert.addButton(withTitle: "打开系统设置")
            alert.addButton(withTitle: "暂不")

            if alert.runModal() == .alertFirstButtonReturn {
                NSWorkspace.shared.open(systemSettingsURL)
            }
        }
    }
}
