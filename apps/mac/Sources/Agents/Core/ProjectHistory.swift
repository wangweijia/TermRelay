import Foundation

/// Reconstructs the retained event stream without starting an agent process.
enum ProjectHistory {
    static func messages(from events: [RelayHistoryEvent], provider: String) -> [CopilotHistoryMessage] {
        var result: [CopilotHistoryMessage] = []
        var detailIndices: [String: Int] = [:]
        var assistantIndices: [String: Int] = [:]
        for event in events {
            guard event.type == "tool.event", let payload = event.payload.object,
                  let kind = payload["kind"]?.string, let data = payload["data"]?.object else { continue }
            let correlation = payload["correlation"]?.object
            let key = "\(correlation?["turnId"]?.string ?? ""):\(correlation?["itemId"]?.string ?? "assistant")"
            switch kind {
            case "assistant.delta", "assistant.completed":
                guard let text = data["text"]?.string else { continue }
                if let index = assistantIndices[key] {
                    let previous = result[index].text
                    result[index] = .init(role: provider, text: kind == "assistant.delta" ? previous + text : text)
                } else {
                    assistantIndices[key] = result.count
                    result.append(.init(role: provider, text: text))
                }
            case "user.message":
                if let text = data["text"]?.string { result.append(.init(role: "用户", text: text)) }
            case "reasoning.delta", "plan.updated":
                if let text = data["text"]?.string {
                    let detailKey = "\(kind):\(key)"
                    let role = kind == "reasoning.delta" ? "思考" : "计划"
                    if let index = detailIndices[detailKey] {
                        result[index] = .init(role: role, text: kind == "reasoning.delta" ? result[index].text + text : text)
                    } else {
                        detailIndices[detailKey] = result.count
                        result.append(.init(role: role, text: text))
                    }
                }
            case "command.started":
                if let text = data["command"]?.string { result.append(.init(role: "执行命令", text: text)) }
            case "command.output":
                if let text = data["text"]?.string { result.append(.init(role: "命令输出", text: text)) }
            case "file.changed":
                if let text = data["summary"]?.string { result.append(.init(role: "文件变更", text: text)) }
            case "warning", "error":
                if let text = data["message"]?.string { result.append(.init(role: kind == "error" ? "错误" : "提示", text: text)) }
            default: break
            }
        }
        return result
    }
}
