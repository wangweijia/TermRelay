import Foundation

enum AgentMessageRole: Sendable, Equatable { case user, assistant }

struct AgentMessageViewState: Identifiable, Sendable, Equatable {
    let id: String
    let role: AgentMessageRole
    var text: String
    var isStreaming: Bool
}

struct AgentCommandViewState: Identifiable, Sendable, Equatable {
    let id: String
    var command: String
    var output: String
    var exitCode: Int?
    var isRunning: Bool
}

struct AgentFileChangeViewState: Identifiable, Sendable, Equatable {
    let id: String
    var summary: String
}

struct AgentApprovalViewState: Identifiable, Sendable, Equatable {
    var id: String { request.approvalID }
    let request: ApprovalRequest
    var decision: ApprovalDecision?
}

struct AgentUserInputViewState: Identifiable, Sendable, Equatable {
    var id: String { request.requestID }
    let request: UserInputRequest
    var answers: [String: [String]]?
}

enum AgentTimelineItem: Identifiable, Sendable, Equatable {
    case message(AgentMessageViewState)
    case reasoning(id: String, text: String)
    case plan(id: String, text: String)
    case command(AgentCommandViewState)
    case fileChange(AgentFileChangeViewState)
    case approval(AgentApprovalViewState)
    case userInput(AgentUserInputViewState)
    case notice(id: String, text: String, isError: Bool)

    var id: String {
        switch self {
        case .message(let value): "message:\(value.id)"
        case .reasoning(let id, _): "reasoning:\(id)"
        case .plan(let id, _): "plan:\(id)"
        case .command(let value): "command:\(value.id)"
        case .fileChange(let value): "file:\(value.id)"
        case .approval(let value): "approval:\(value.id)"
        case .userInput(let value): "input:\(value.id)"
        case .notice(let id, _, _): "notice:\(id)"
        }
    }
}

enum AgentTimelineProjector {
    private static let maximumCommandOutputCharacters = 200_000
    private static let maximumStreamingTextCharacters = 1_000_000

    static func apply(_ event: ToolEvent, to items: inout [AgentTimelineItem]) {
        let fallbackID = "seq-\(event.sequence)"
        let itemID = event.correlation.itemID ?? fallbackID
        switch event.payload {
        case .sessionStarted:
            break
        case .turnStarted(let turnID):
            upsertNotice(id: "turn-start-\(turnID)", text: "开始执行", isError: false, in: &items)
        case .userMessage(let messageID, let text):
            upsertMessage(
                AgentMessageViewState(id: messageID, role: .user, text: text, isStreaming: false),
                append: false,
                in: &items
            )
        case .assistantTextDelta(let text):
            upsertMessage(
                AgentMessageViewState(id: itemID, role: .assistant, text: text, isStreaming: true),
                append: true,
                in: &items
            )
        case .assistantMessageCompleted(let text):
            upsertMessage(
                AgentMessageViewState(id: itemID, role: .assistant, text: text, isStreaming: false),
                append: false,
                in: &items
            )
        case .reasoningDelta(let text):
            let reasoningID = event.correlation.itemID
                ?? event.correlation.turnID
                ?? fallbackID
            upsertText(kind: "reasoning", id: reasoningID, text: text, append: true, in: &items)
        case .planUpdated(let text):
            upsertText(
                kind: "plan",
                id: event.correlation.turnID ?? itemID,
                text: text,
                append: true,
                in: &items
            )
        case .commandStarted(let commandID, let command):
            upsertCommand(id: commandID, in: &items) {
                $0.command = command
                $0.isRunning = true
            }
        case .commandOutput(let commandID, let text):
            upsertCommand(id: commandID, in: &items) {
                $0.output = appendBounded(
                    $0.output,
                    text,
                    maximum: maximumCommandOutputCharacters
                )
            }
        case .commandCompleted(let commandID, let exitCode):
            upsertCommand(id: commandID, in: &items) {
                $0.exitCode = exitCode
                $0.isRunning = false
            }
        case .fileChanged(let itemID, let summary):
            if let index = items.firstIndex(where: { $0.id == "file:\(itemID)" }),
               case .fileChange(var value) = items[index] {
                value.summary += summary
                items[index] = .fileChange(value)
            } else {
                items.append(.fileChange(AgentFileChangeViewState(id: itemID, summary: summary)))
            }
        case .approvalRequested(let request):
            if !items.contains(where: { $0.id == "approval:\(request.approvalID)" }) {
                items.append(.approval(AgentApprovalViewState(request: request, decision: nil)))
            }
        case .approvalResolved(let approvalID, _, let decision):
            if let index = items.firstIndex(where: { $0.id == "approval:\(approvalID)" }),
               case .approval(var value) = items[index] {
                value.decision = decision
                items[index] = .approval(value)
            }
        case .userInputRequested(let request):
            if !items.contains(where: { $0.id == "input:\(request.requestID)" }) {
                items.append(.userInput(AgentUserInputViewState(request: request, answers: nil)))
            }
        case .userInputResolved(let requestID, _, let answers):
            if let index = items.firstIndex(where: { $0.id == "input:\(requestID)" }),
               case .userInput(var value) = items[index] {
                value.answers = answers
                items[index] = .userInput(value)
            }
        case .turnCompleted(let turnID, let status):
            upsertNotice(
                id: "turn-complete-\(turnID)",
                text: status == .completed ? "执行完成" : "执行结束：\(status.rawValue)",
                isError: status == .failed,
                in: &items
            )
        case .configurationUpdated:
            break
        case .warning(let code, let message):
            upsertNotice(id: "\(code)-\(fallbackID)", text: message, isError: false, in: &items)
        case .failed(let code, let message):
            upsertNotice(id: "\(code)-\(fallbackID)", text: message, isError: true, in: &items)
        }
    }

    private static func upsertMessage(
        _ message: AgentMessageViewState,
        append: Bool,
        in items: inout [AgentTimelineItem]
    ) {
        if let index = items.firstIndex(where: { $0.id == "message:\(message.id)" }),
           case .message(var existing) = items[index] {
            existing.text = append
                ? appendBounded(
                    existing.text,
                    message.text,
                    maximum: maximumStreamingTextCharacters
                )
                : String(message.text.suffix(maximumStreamingTextCharacters))
            existing.isStreaming = message.isStreaming
            items[index] = .message(existing)
        } else {
            items.append(.message(message))
        }
    }

    private static func upsertCommand(
        id: String,
        in items: inout [AgentTimelineItem],
        update: (inout AgentCommandViewState) -> Void
    ) {
        if let index = items.firstIndex(where: { $0.id == "command:\(id)" }),
           case .command(var value) = items[index] {
            update(&value)
            items[index] = .command(value)
        } else {
            var value = AgentCommandViewState(
                id: id,
                command: "",
                output: "",
                exitCode: nil,
                isRunning: true
            )
            update(&value)
            items.append(.command(value))
        }
    }

    private static func upsertText(
        kind: String,
        id: String,
        text: String,
        append: Bool,
        in items: inout [AgentTimelineItem]
    ) {
        let key = "\(kind):\(id)"
        if let index = items.firstIndex(where: { $0.id == key }) {
            switch items[index] {
            case .reasoning:
                let existing = if case .reasoning(_, let value) = items[index] { value } else { "" }
                items[index] = .reasoning(id: id, text: append ? existing + text : text)
            case .plan:
                let existing = if case .plan(_, let value) = items[index] { value } else { "" }
                items[index] = .plan(id: id, text: append ? existing + text : text)
            default: break
            }
        } else if kind == "reasoning" {
            items.append(.reasoning(id: id, text: text))
        } else {
            items.append(.plan(id: id, text: text))
        }
    }

    private static func upsertNotice(
        id: String,
        text: String,
        isError: Bool,
        in items: inout [AgentTimelineItem]
    ) {
        let item = AgentTimelineItem.notice(id: id, text: text, isError: isError)
        if let index = items.firstIndex(where: { $0.id == item.id }) { items[index] = item }
        else { items.append(item) }
    }

    private static func appendBounded(
        _ current: String,
        _ addition: String,
        maximum: Int
    ) -> String {
        let combined = current + addition
        guard combined.count > maximum else { return combined }
        return "[更早内容已省略]\n" + String(combined.suffix(maximum))
    }
}
