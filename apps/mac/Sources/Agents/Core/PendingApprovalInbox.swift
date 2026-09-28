import Foundation

struct PendingApprovalInbox {
    private(set) var bySession: [UUID: [String: ApprovalRequest]] = [:]

    mutating func apply(_ event: ToolEvent) {
        switch event.payload {
        case .approvalRequested(let request):
            bySession[event.sessionID, default: [:]][request.approvalID] = request
        case .approvalResolved(let approvalID, _, _):
            bySession[event.sessionID]?[approvalID] = nil
            if bySession[event.sessionID]?.isEmpty == true {
                bySession.removeValue(forKey: event.sessionID)
            }
        case .turnCompleted, .failed:
            clear(sessionID: event.sessionID)
        default:
            break
        }
    }

    mutating func clear(sessionID: UUID) {
        bySession.removeValue(forKey: sessionID)
    }

    mutating func clearAll() {
        bySession.removeAll()
    }
}
