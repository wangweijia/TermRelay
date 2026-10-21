import Foundation

struct ManagedSession: Identifiable, Equatable, Sendable {
    let id: UUID
    let directory: URL
    let toolID: String
    let displayName: String
    let runtimeMode: SessionRuntimeMode
    let projectID: String?
    let state: SessionState

    init(
        id: UUID = UUID(),
        directory: URL,
        toolID: String,
        displayName: String? = nil,
        runtimeMode: SessionRuntimeMode = .pty,
        state: SessionState = .starting,
        projectID: String? = nil
    ) {
        self.id = id
        self.directory = directory
        self.toolID = toolID
        self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty ?? directory.lastPathComponent
        self.runtimeMode = runtimeMode
        self.projectID = projectID
        self.state = state
    }
}

enum SessionRuntimeMode: String, Codable, Sendable {
    case pty
    case acp
}

enum ACPSendShortcut: String, Codable, CaseIterable, Sendable {
    case commandEnter
    case controlEnter
    case optionEnter
    case shiftEnter

    var displayName: String {
        switch self {
        case .commandEnter: "⌘ + 回车"
        case .controlEnter: "⌃ + 回车"
        case .optionEnter: "⌥ + 回车"
        case .shiftEnter: "⇧ + 回车"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

enum SessionState: String, Codable, Sendable {
    case starting
    case running
    case stopping
    case finished
    case failed
}
