import Foundation

struct CopilotStructuredAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID.copilot
    let displayName = "GitHub Copilot"
    let configuredExecutableURL: URL?
    let transportFactory: (@Sendable (URL, URL, [String: String]) -> any CopilotACPTransport)?

    init(
        configuredExecutableURL: URL? = nil,
        transportFactory: (@Sendable (URL, URL, [String: String]) -> any CopilotACPTransport)? = nil
    ) {
        self.configuredExecutableURL = configuredExecutableURL
        self.transportFactory = transportFactory
    }

    func detect() async throws -> AgentInstallation {
        guard let executable = configuredExecutableURL ?? ExecutableLocator.find(named: "copilot") else {
            throw AgentError.providerUnavailable("找不到 copilot 可执行程序")
        }
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw AgentError.providerUnavailable("copilot 文件不存在或不可执行：\(executable.path)")
        }
        return AgentInstallation(
            executableURL: executable,
            version: try readVersion(executable),
            supported: true,
            unsupportedReason: nil
        )
    }

    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime {
        let installation = try await detect()
        let transport = transportFactory?(
            installation.executableURL,
            configuration.workspaceURL,
            configuration.environment
        ) ?? CopilotACPProcess(
            executableURL: installation.executableURL,
            directory: configuration.workspaceURL,
            environment: configuration.environment
        )
        return CopilotStructuredRuntime(
            sessionID: configuration.sessionID,
            workspaceURL: configuration.workspaceURL,
            providerVersion: installation.version,
            client: CopilotACPClient(transport: transport)
        )
    }

    private func readVersion(_ executable: URL) throws -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["--version"]
        process.environment = TerminalEnvironment.make(executableURL: executable)
        process.standardOutput = output
        process.standardError = output
        try process.run()
        process.waitUntilExit()
        let value = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0, !value.isEmpty else {
            throw AgentError.providerUnavailable(
                value.isEmpty ? "无法读取 Copilot CLI 版本" : "无法读取 Copilot CLI 版本：\(value)"
            )
        }
        return value
    }
}

actor CopilotStructuredRuntime: StructuredAgentRuntime {
    nonisolated let events: AsyncStream<ToolEvent>
    let descriptor: AgentDescriptor

    private struct PendingApproval {
        let rpcID: JSONValue
        let turnID: String
        let itemID: String
        let optionIDs: [ApprovalDecision: String]
    }

    private let sessionID: UUID
    private let workspaceURL: URL
    private let client: CopilotACPClient
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var messageTask: Task<Void, Never>?
    private var promptTask: Task<Void, Never>?
    private var providerSessionID: String?
    private var configOptions: [AgentConfigOption] = []
    private var modelConfigID: String?
    private var modelCommandAvailable = false
    private var activeTurnID: String?
    private var pendingApprovals: [String: PendingApproval] = [:]
    private var assistantMessages: [String: String] = [:]
    private var sequence: UInt64 = 0
    private var stopped = false

    init(
        sessionID: UUID,
        workspaceURL: URL,
        providerVersion: String,
        client: CopilotACPClient
    ) {
        self.sessionID = sessionID
        self.workspaceURL = workspaceURL
        self.client = client
        descriptor = AgentDescriptor(
            providerID: .copilot,
            providerVersion: providerVersion,
            protocolName: "agent-client-protocol",
            protocolVersion: "1",
            capabilities: [
                .streamingText, .reasoning, .commandExecution, .commandOutput,
                .fileChanges, .approvals, .plans, .subagents, .usage,
            ]
        )
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start() async throws {
        let initialized = try await client.start()
        guard initialized.object?["protocolVersion"]?.integer == 1 else {
            throw AgentError.protocolFailure("Copilot CLI 未协商到 ACP v1")
        }
        let messages = client.messages
        messageTask = Task { [weak self] in
            for await message in messages {
                guard !Task.isCancelled else { return }
                await self?.receive(message)
            }
        }
    }

    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference {
        guard request.sessionID == sessionID,
              request.workspaceURL.standardizedFileURL == workspaceURL.standardizedFileURL else {
            throw AgentError.correlationMismatch("创建请求不属于当前 Copilot runtime")
        }
        let result = try await client.request(method: "session/new", params: .object([
            "cwd": .string(workspaceURL.path),
            "mcpServers": .array([]),
        ]), timeout: .seconds(30))
        guard let id = result.object?["sessionId"]?.string, !id.isEmpty else {
            throw AgentError.protocolFailure("session/new 未返回 sessionId")
        }
        providerSessionID = id
        updateConfigOptions(result.object?["configOptions"])
        let reference = AgentSessionReference(providerID: .copilot, opaqueID: id)
        emit(.sessionStarted(reference: reference))
        return reference
    }

    func configurationOptions() async throws -> [AgentConfigOption] { visibleConfigurationOptions() }

    private func visibleConfigurationOptions() -> [AgentConfigOption] {
        if configOptions.isEmpty && modelCommandAvailable {
            return [AgentConfigOption(id: "model", name: "模型 ID", currentValue: "", choices: [])]
        }
        return configOptions
    }

    func setConfiguration(id: String, value: String) async throws -> [AgentConfigOption] {
        guard let providerSessionID,
              let option = configOptions.first(where: { $0.id == id }),
              let modelConfigID,
              option.choices.contains(where: { $0.value == value }) else {
            throw AgentError.unsupportedCapability("Copilot ACP model configuration")
        }
        let result = try await client.request(method: "session/set_config_option", params: .object([
            "sessionId": .string(providerSessionID), "configId": .string(modelConfigID), "value": .string(value),
        ]))
        guard result.object?["configOptions"]?.array != nil else {
            throw AgentError.protocolFailure("Copilot 未确认配置变更")
        }
        updateConfigOptions(result.object?["configOptions"])
        return configOptions
    }

    func publishConfiguration(_ options: [AgentConfigOption]) {
        emit(.configurationUpdated(options: options))
    }

    private func updateConfigOptions(_ value: JSONValue?) {
        let models = (value?.array ?? []).compactMap { item -> AgentConfigOption? in
            guard let option = item.object,
                  option["type"]?.string == "select",
                  let category = option["category"]?.string,
                  category == "model",
                  let id = option["id"]?.string,
                  let name = option["name"]?.string,
                  let current = option["currentValue"]?.string else { return nil }
            let values = (option["options"]?.array ?? []).flatMap { choice -> [JSONValue] in
                choice.object?["options"]?.array ?? [choice]
            }
            let choices = values.compactMap { choice -> AgentConfigOption.Choice? in
                guard let value = choice.object?["value"]?.string,
                      let name = choice.object?["name"]?.string else { return nil }
                return .init(value: value, name: name)
            }
            guard !choices.isEmpty else { return nil }
            return AgentConfigOption(id: id, name: name, currentValue: current, choices: choices)
        }
        modelConfigID = models.first?.id
        configOptions = models.prefix(1).map {
            AgentConfigOption(id: "model", name: $0.name, currentValue: $0.currentValue, choices: $0.choices)
        }
    }

    func send(_ action: ToolAction) async throws {
        guard let providerSessionID else {
            throw AgentError.invalidState(expected: "session created", actual: .starting)
        }
        switch action {
        case .startTurn(let input, let idempotencyKey):
            guard promptTask == nil else {
                throw AgentError.invalidState(expected: "no active prompt", actual: .running)
            }
            let text = input.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw AgentError.protocolFailure("Turn 输入不能为空") }
            let turnID = idempotencyKey.uuidString.lowercased()
            activeTurnID = turnID
            assistantMessages.removeAll()
            emit(.userMessage(messageID: turnID, text: input.text), turnID: turnID, itemID: turnID)
            emit(.turnStarted(turnID: turnID), turnID: turnID)
            promptTask = Task { [weak self] in
                await self?.runPrompt(sessionID: providerSessionID, turnID: turnID, text: input.text)
            }
        case .steer:
            throw AgentError.unsupportedCapability("steering")
        case .interrupt:
            guard activeTurnID != nil else {
                throw AgentError.invalidState(expected: "active turn", actual: .ready)
            }
            try await client.notify(method: "session/cancel", params: .object([
                "sessionId": .string(providerSessionID),
            ]))
        case .resolveApproval(let resolution):
            guard let pending = pendingApprovals[resolution.approvalID],
                  pending.turnID == resolution.turnID,
                  pending.turnID == activeTurnID else {
                throw AgentError.correlationMismatch("审批响应不属于当前 Copilot turn")
            }
            let result: JSONValue
            if resolution.decision == .cancel {
                result = .object(["outcome": .object(["outcome": .string("cancelled")])])
            } else if let optionID = pending.optionIDs[resolution.decision] {
                result = .object(["outcome": .object([
                    "outcome": .string("selected"),
                    "optionId": .string(optionID),
                ])])
            } else {
                throw AgentError.protocolFailure("该 Copilot 审批不支持 \(resolution.decision.rawValue)")
            }
            try await client.respond(id: pending.rpcID, result: result)
            pendingApprovals.removeValue(forKey: resolution.approvalID)
            emit(
                .approvalResolved(
                    approvalID: resolution.approvalID,
                    turnID: resolution.turnID,
                    decision: resolution.decision
                ),
                turnID: resolution.turnID,
                itemID: pending.itemID,
                approvalID: resolution.approvalID
            )
        case .resolveUserInput:
            throw AgentError.unsupportedCapability("requestUserInput")
        }
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        for pending in pendingApprovals.values {
            try? await client.respond(
                id: pending.rpcID,
                result: .object(["outcome": .object(["outcome": .string("cancelled")])])
            )
        }
        pendingApprovals.removeAll()
        if let providerSessionID, activeTurnID != nil {
            try? await client.notify(method: "session/cancel", params: .object([
                "sessionId": .string(providerSessionID),
            ]))
        }
        promptTask?.cancel()
        promptTask = nil
        messageTask?.cancel()
        messageTask = nil
        providerSessionID = nil
        activeTurnID = nil
        await client.stop()
        continuation.finish()
    }

    private func runPrompt(sessionID: String, turnID: String, text: String) async {
        do {
            let result = try await client.request(method: "session/prompt", params: .object([
                "sessionId": .string(sessionID),
                "prompt": .array([.object([
                    "type": .string("text"),
                    "text": .string(text),
                ])]),
            ]), timeout: nil)
            guard activeTurnID == turnID else { return }
            for (messageID, text) in assistantMessages where !text.isEmpty {
                emit(.assistantMessageCompleted(text: text), turnID: turnID, itemID: messageID)
            }
            let stopReason = result.object?["stopReason"]?.string
            let status: TurnCompletionStatus = stopReason == "cancelled" ? .interrupted
                : stopReason == nil ? .failed : .completed
            emit(.turnCompleted(turnID: turnID, status: status), turnID: turnID)
        } catch {
            guard activeTurnID == turnID, !stopped else { return }
            emit(.failed(code: "copilot_prompt", message: error.localizedDescription), turnID: turnID)
            emit(.turnCompleted(turnID: turnID, status: .failed), turnID: turnID)
        }
        if activeTurnID == turnID { activeTurnID = nil }
        promptTask = nil
    }

    private func receive(_ message: CopilotACPMessage) async {
        switch message {
        case .notification(let method, let params):
            if method == "session/update" { receiveSessionUpdate(params) }
        case .request(let id, let method, let params):
            if method == "session/request_permission" {
                await receivePermissionRequest(id: id, params: params)
            } else {
                try? await client.respond(
                    id: id,
                    result: .object(["outcome": .object(["outcome": .string("cancelled")])])
                )
            }
        }
    }

    private func receiveSessionUpdate(_ params: JSONValue) {
          guard let object = params.object,
              object["sessionId"]?.string == providerSessionID,
              let update = object["update"]?.object,
              let kind = update["sessionUpdate"]?.string else { return }
          if kind == "config_option_update" {
            updateConfigOptions(update["configOptions"])
            emit(.configurationUpdated(options: visibleConfigurationOptions()))
            return
        }
        if kind == "available_commands_update" {
            modelCommandAvailable = (update["availableCommands"]?.array ?? []).contains {
                $0.object?["name"]?.string == "model"
            }
            emit(.configurationUpdated(options: visibleConfigurationOptions()))
            return
          }
          guard let turnID = activeTurnID else { return }
        let itemID = update["messageId"]?.string ?? update["toolCallId"]?.string
        switch kind {
        case "agent_message_chunk":
            guard let text = textContent(update["content"]), !text.isEmpty else { return }
            let messageID = update["messageId"]?.string ?? "assistant-\(turnID)"
            assistantMessages[messageID, default: ""] += text
            emit(.assistantTextDelta(text: text), turnID: turnID, itemID: messageID)
        case "agent_thought_chunk":
            if let text = textContent(update["content"]), !text.isEmpty {
                emit(.reasoningDelta(text: text), turnID: turnID, itemID: itemID)
            }
        case "tool_call":
            guard let toolID = update["toolCallId"]?.string else { return }
            let title = update["title"]?.string ?? "Copilot 工具"
            let input = update["rawInput"].flatMap(jsonDescription)
            emit(
                .commandStarted(commandID: toolID, command: input.map { "\(title)\n\($0)" } ?? title),
                turnID: turnID,
                itemID: toolID
            )
        case "tool_call_update":
            guard let toolID = update["toolCallId"]?.string else { return }
            if let output = toolOutput(update), !output.isEmpty {
                emit(.commandOutput(commandID: toolID, text: output), turnID: turnID, itemID: toolID)
            }
            if let status = update["status"]?.string, status == "completed" || status == "failed" {
                emit(
                    .commandCompleted(commandID: toolID, exitCode: status == "failed" ? 1 : 0),
                    turnID: turnID,
                    itemID: toolID
                )
            }
        case "plan", "plan_update":
            if let text = planDescription(update), !text.isEmpty {
                emit(.planUpdated(text: text), turnID: turnID, itemID: itemID)
            }
        case "usage_update":
            if let used = update["used"]?.integer, let size = update["size"]?.integer {
                emit(.warning(code: "usage", message: "上下文用量：\(used) / \(size)"), turnID: turnID)
            }
        default:
            break
        }
    }

    private func receivePermissionRequest(id: JSONValue, params: JSONValue) async {
        guard let object = params.object,
              object["sessionId"]?.string == providerSessionID,
              let tool = object["toolCall"]?.object,
              let toolID = tool["toolCallId"]?.string,
              let turnID = activeTurnID else {
            try? await client.respond(
                id: id,
                result: .object(["outcome": .object(["outcome": .string("cancelled")])])
            )
            return
        }
        var optionIDs: [ApprovalDecision: String] = [:]
        for value in object["options"]?.array ?? [] {
            guard let option = value.object,
                  let optionID = option["optionId"]?.string else { continue }
            switch option["kind"]?.string {
            case "allow_once": optionIDs[.allowOnce] = optionID
            case "allow_always": optionIDs[.allowSession] = optionID
            case "reject_once", "reject_always": optionIDs[.deny] = optionID
            default: break
            }
        }
        let approvalID = "copilot:\(toolID):\(rpcKey(id))"
        var decisions = ApprovalDecision.allCases.filter { optionIDs[$0] != nil }
        decisions.append(.cancel)
        pendingApprovals[approvalID] = PendingApproval(
            rpcID: id,
            turnID: turnID,
            itemID: toolID,
            optionIDs: optionIDs
        )
        emit(.approvalRequested(ApprovalRequest(
            approvalID: approvalID,
            turnID: turnID,
            itemID: toolID,
            kind: tool["kind"]?.string ?? "other",
            risk: .high,
            title: tool["title"]?.string ?? "批准 Copilot 工具操作",
            detail: tool["rawInput"].flatMap(jsonDescription),
            availableDecisions: decisions,
            expiresAt: .distantFuture
        )), turnID: turnID, itemID: toolID, approvalID: approvalID)
    }

    private func textContent(_ value: JSONValue?) -> String? {
        guard let object = value?.object, object["type"]?.string == "text" else { return nil }
        return object["text"]?.string
    }

    private func toolOutput(_ update: [String: JSONValue]) -> String? {
        let values = update["content"]?.array ?? []
        let texts = values.compactMap { value -> String? in
            let object = value.object ?? [:]
            if object["type"]?.string == "content" { return textContent(object["content"]) }
            if object["type"]?.string == "diff" {
                return object["newText"]?.string ?? object["oldText"]?.string
            }
            return nil
        }
        return texts.isEmpty ? update["rawOutput"].flatMap(jsonDescription) : texts.joined(separator: "\n")
    }

    private func planDescription(_ update: [String: JSONValue]) -> String? {
        if let text = update["text"]?.string { return text }
        return update["entries"]?.array?.compactMap { entry in
            let object = entry.object ?? [:]
            return object["content"]?.string ?? object["title"]?.string
        }.joined(separator: "\n")
    }

    private func jsonDescription(_ value: JSONValue) -> String? {
        guard let data = try? JSONEncoder().encode(value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func rpcKey(_ id: JSONValue) -> String {
        (try? String(decoding: JSONEncoder().encode(id), as: UTF8.self)) ?? "null"
    }

    private func emit(
        _ payload: ToolEventPayload,
        turnID: String? = nil,
        itemID: String? = nil,
        approvalID: String? = nil
    ) {
        continuation.yield(ToolEvent(
            sessionID: sessionID,
            sequence: sequence,
            occurredAt: Date(),
            correlation: AgentCorrelation(turnID: turnID, itemID: itemID, approvalID: approvalID),
            payload: payload
        ))
        sequence += 1
    }
}