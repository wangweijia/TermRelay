import Foundation

/// Terminal sessions and Agent tool calls can `cd` into any user directory, including
/// TCC-protected folders (Desktop/Documents/Downloads). Without pre-warming, macOS shows
/// the access prompt the first time an Agent subprocess touches one of those folders mid-turn,
/// which interrupts an otherwise unattended run. Probing them once at launch surfaces the
/// system prompt up front instead.
enum ProtectedFolderPreflight {
    static func beginWarmup() {
        Task.detached(priority: .utility) {
            let home = FileManager.default.homeDirectoryForCurrentUser
            let candidates = [
                home.appendingPathComponent("Desktop"),
                home.appendingPathComponent("Documents"),
                home.appendingPathComponent("Downloads"),
            ]
            for directory in candidates {
                _ = try? FileManager.default.contentsOfDirectory(
                    at: directory,
                    includingPropertiesForKeys: nil,
                    options: [.skipsHiddenFiles]
                )
            }
        }
    }
}
