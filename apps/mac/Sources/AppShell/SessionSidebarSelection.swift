import Foundation

enum SessionSidebarTab: String, CaseIterable {
    case active = "当前"
    case projects = "项目调用"
    case history = "历史"

    func contains(_ session: ManagedSession) -> Bool {
        switch self {
        case .active: session.projectID == nil
        case .projects: session.projectID != nil
        case .history: false
        }
    }

    func selection(current: UUID?, sessions: [ManagedSession], historyIDs: [UUID]) -> UUID? {
        let ids = self == .history ? historyIDs : sessions.filter(contains).map(\.id)
        if let current, ids.contains(current) { return current }
        return self == .history ? ids.first : ids.last
    }

    static func containing(selection: UUID?, sessions: [ManagedSession], historyIDs: [UUID]) -> Self? {
        guard let selection else { return nil }
        if let session = sessions.first(where: { $0.id == selection }) {
            return session.projectID == nil ? .active : .projects
        }
        return historyIDs.contains(selection) ? .history : nil
    }
}
