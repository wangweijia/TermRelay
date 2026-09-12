import Foundation

struct ManagedSession: Identifiable, Equatable, Sendable {
    let id: UUID
    let directory: URL
    let toolID: String
    let displayName: String
    let runtimeMode: SessionRuntimeMode
    private(set) var state: SessionState

    init(
        id: UUID = UUID(),
        directory: URL,
        toolID: String,
        displayName: String? = nil,
        runtimeMode: SessionRuntimeMode = .terminal,
        state: SessionState = .starting
    ) {
        self.id = id
        self.directory = directory
        self.toolID = toolID
        self.displayName = displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty ?? directory.lastPathComponent
        self.runtimeMode = runtimeMode
        self.state = state
    }

    mutating func transition(to next: SessionState) throws {
        guard state.canTransition(to: next) else {
            throw SessionTransitionError.invalid(from: state, to: next)
        }
        state = next
    }
}

enum SessionRuntimeMode: String, Codable, Sendable {
    case terminal
    case structured
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

    func canTransition(to next: SessionState) -> Bool {
        switch (self, next) {
        case (.starting, .running), (.starting, .failed),
             (.running, .stopping), (.running, .finished), (.running, .failed),
             (.stopping, .finished), (.stopping, .failed):
            true
        default:
            false
        }
    }
}

enum SessionTransitionError: Error, Equatable {
    case invalid(from: SessionState, to: SessionState)
}
