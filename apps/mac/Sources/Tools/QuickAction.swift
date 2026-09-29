import Foundation

struct QuickAction: Codable, Identifiable, Sendable, Equatable {
    var id: UUID
    var revision: Int
    var name: String
    var description: String
    var directory: URL
    var command: String
    var proxy: ToolProxyConfiguration
    var requiresConfirmation: Bool

    static func draft(directory: URL) -> QuickAction {
        QuickAction(
            id: UUID(), revision: 0, name: "", description: "",
            directory: directory, command: "", proxy: .inherited,
            requiresConfirmation: true
        )
    }

    func validate() throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              name.count <= 128, description.count <= 500,
              !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              command.utf8.count <= 16_384 else {
            throw QuickActionError.invalid("请填写名称和命令；名称最多 128 字，命令最多 16 KiB。")
        }
        var isDirectory: ObjCBool = false
        guard directory.isFileURL,
              FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw QuickActionError.invalid("工作目录不存在：\(directory.path)")
        }
        if let message = proxy.validationMessage { throw QuickActionError.invalid(message) }
    }
}

enum QuickActionError: LocalizedError {
    case invalid(String)

    var errorDescription: String? {
        if case .invalid(let message) = self { message } else { nil }
    }
}

struct QuickActionStore {
    let fileURL: URL

    init(directory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("TermRelay", isDirectory: true)) {
        fileURL = directory.appendingPathComponent("shortcuts.json")
    }

    func load() throws -> [QuickAction] {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return [] }
        let actions = try JSONDecoder().decode([QuickAction].self, from: Data(contentsOf: fileURL))
        guard actions.count <= 100,
              Set(actions.map(\.id)).count == actions.count,
              actions.allSatisfy({
                  $0.revision > 0 && $0.name.count <= 128 && $0.description.count <= 500
                      && $0.command.utf8.count <= 16_384
              }) else {
            throw QuickActionError.invalid("本机快捷任务文件包含无效或重复的定义。")
        }
        return actions
    }

    func save(_ actions: [QuickAction]) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(actions)
        let tempURL = directory.appendingPathComponent(".shortcuts-\(UUID().uuidString).tmp")
        guard FileManager.default.createFile(
            atPath: tempURL.path, contents: nil, attributes: [.posixPermissions: 0o600]
        ) else {
            throw QuickActionError.invalid("无法创建本机快捷任务文件。")
        }
        defer { try? FileManager.default.removeItem(at: tempURL) }
        try data.write(to: tempURL)
        if FileManager.default.fileExists(atPath: fileURL.path) {
            _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tempURL)
        } else {
            try FileManager.default.moveItem(at: tempURL, to: fileURL)
        }
    }
}

struct QuickActionRun: Identifiable, Sendable {
    let id: UUID
    let shortcutID: UUID
    var status: String
    var exitCode: Int?
    var output: String
    var startedAt = Date()
}

struct QuickActionCatalogEntry: Encodable, Sendable {
    let id: String
    let revision: Int
    let name: String
    let description: String
    let workspaceId: String
    let proxyMode: String
    let requiresConfirmation: Bool
}

enum QuickActionCommand: Sendable {
    case start(runID: UUID, shortcutID: UUID, revision: Int)
    case cancel(runID: UUID)
}
