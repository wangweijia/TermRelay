import Foundation

struct CodexStructuredAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID.codex
    let displayName = "Codex 结构化 Agent"
    let configuredExecutableURL: URL?
    let host: CodexAppServerHost?

    init(configuredExecutableURL: URL? = nil, host: CodexAppServerHost? = nil) {
        self.configuredExecutableURL = configuredExecutableURL
        self.host = host
    }

    func detect() async throws -> AgentInstallation {
        guard let executable = configuredExecutableURL ?? ExecutableLocator.find(named: "codex") else {
            throw AgentError.providerUnavailable("找不到 codex 可执行程序")
        }
        let version = try readVersion(executable)
        return AgentInstallation(
            executableURL: executable,
            version: version,
            supported: true,
            unsupportedReason: nil
        )
    }

    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime {
        let installation = try await detect()
        guard installation.supported else {
            throw AgentError.providerUnavailable(
                installation.unsupportedReason ?? "Codex 版本未通过兼容性验证"
            )
        }
        if let host {
            try await host.start()
        }
        let transport: any CodexAppServerTransport = if let host {
            CodexUnixSocketTransport(socketPath: host.socketPath)
        } else {
            CodexAppServerProcess(
                executableURL: installation.executableURL,
                directory: configuration.workspaceURL,
                environment: configuration.environment
            )
        }
        return CodexStructuredRuntime(
            sessionID: configuration.sessionID,
            workspaceURL: configuration.workspaceURL,
            providerVersion: installation.version,
            client: CodexAppServerClient(transport: transport),
            host: host
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
        guard process.terminationStatus == 0 else {
            let detail = value.isEmpty ? "退出码 \(process.terminationStatus)" : value
            throw AgentError.providerUnavailable("无法读取 Codex 版本：\(detail)")
        }
        guard !value.isEmpty else {
            throw AgentError.providerUnavailable("Codex 未返回版本")
        }
        return value
    }
}

actor CodexStructuredRuntime: StructuredAgentRuntime {
    nonisolated let events: AsyncStream<ToolEvent>
    let descriptor: AgentDescriptor

    private struct PendingApproval {
        let rpcID: JSONValue
        let turnID: String
        let itemID: String
        let kind: String
        let results: [ApprovalDecision: JSONValue]
    }

    private struct PendingUserInput {
        let rpcID: JSONValue
        let request: UserInputRequest
    }

    private let sessionID: UUID
    private let workspaceURL: URL
    private let client: CodexAppServerClient
    private let host: CodexAppServerHost?
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var messageTask: Task<Void, Never>?
    private var threadID: String?
    private var didEmitSessionStarted = false
    private var activeTurnID: String?
    private var pendingApprovals: [String: PendingApproval] = [:]
    private var pendingUserInputs: [String: PendingUserInput] = [:]
    private var sequence: UInt64 = 0
    private var stopped = false

    init(
        sessionID: UUID,
        workspaceURL: URL,
        providerVersion: String,
        client: CodexAppServerClient,
        host: CodexAppServerHost? = nil
    ) {
        self.sessionID = sessionID
        self.workspaceURL = workspaceURL
        self.client = client
        self.host = host
        descriptor = AgentDescriptor(
            providerID: .codex,
            providerVersion: providerVersion,
            protocolName: "codex-app-server",
            protocolVersion: "v2",
            capabilities: [
                .streamingText, .reasoning, .commandExecution, .commandOutput,
                .fileChanges, .approvals, .plans,
            ]
        )
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start() async throws {
        _ = try await client.start()
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
            throw AgentError.correlationMismatch("创建请求不属于当前 runtime")
        }
        let result = try await client.request(method: "thread/start", params: .object([
            "cwd": .string(workspaceURL.path),
            "approvalPolicy": .string("on-request"),
            "approvalsReviewer": .string("user"),
            "sandbox": .string("workspace-write"),
            "ephemeral": .bool(true),
            "serviceName": .string("termrelay"),
        ]))
        guard let id = result.object?["thread"]?.object?["id"]?.string else {
            throw AgentError.protocolFailure("thread/start 未返回 thread.id")
        }
        let reference = AgentSessionReference(providerID: .codex, opaqueID: id)
        threadID = id
        announceSession(reference)
        return reference
    }

    func send(_ action: ToolAction) async throws {
        guard let threadID else {
            throw AgentError.invalidState(expected: "thread created", actual: .starting)
        }
        switch action {
        case .startTurn(let input, let idempotencyKey):
            guard !input.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw AgentError.protocolFailure("Turn 输入不能为空")
            }
            let result = try await request(method: "turn/start", params: .object([
                "threadId": .string(threadID),
                "clientUserMessageId": .string(idempotencyKey.uuidString.lowercased()),
                "input": .array([
                    .object(["type": .string("text"), "text": .string(input.text)]),
                ]),
            ]))
            guard let turnID = result.object?["turn"]?.object?["id"]?.string else {
                throw AgentError.protocolFailure("turn/start 未返回 turn.id")
            }
            emit(
                .userMessage(messageID: idempotencyKey.uuidString.lowercased(), text: input.text),
                turnID: turnID,
                itemID: idempotencyKey.uuidString.lowercased()
            )
            if activeTurnID != turnID {
                activeTurnID = turnID
                emit(.turnStarted(turnID: turnID), turnID: turnID)
            }
        case .steer:
            throw AgentError.unsupportedCapability("steering")
        case .interrupt:
            guard let activeTurnID else {
                throw AgentError.invalidState(expected: "active turn", actual: .ready)
            }
            _ = try await request(method: "turn/interrupt", params: .object([
                "threadId": .string(threadID),
                "turnId": .string(activeTurnID),
            ]))
        case .resolveApproval(let resolution):
            guard let pending = pendingApprovals[resolution.approvalID],
                  pending.turnID == resolution.turnID,
                  pending.turnID == activeTurnID else {
                throw AgentError.correlationMismatch("审批响应不属于当前 Codex turn")
            }
            guard let result = pending.results[resolution.decision] else {
                throw AgentError.protocolFailure("该审批不支持 \(resolution.decision.rawValue)")
            }
            try await respond(id: pending.rpcID, result: result)
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
        case .resolveUserInput(let resolution):
            guard let pending = pendingUserInputs[resolution.requestID],
                  pending.request.turnID == resolution.turnID,
                  resolution.answers.keys.allSatisfy({ key in
                      pending.request.questions.contains { $0.id == key }
                  }),
                  pending.request.questions.allSatisfy({ question in
                      resolution.answers[question.id]?.contains(where: {
                          !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                      }) == true
                  }) else {
                throw AgentError.correlationMismatch("用户问题响应不属于当前 Codex turn")
            }
            let answers = resolution.answers.mapValues { values in
                JSONValue.object(["answers": .array(values.map(JSONValue.string))])
            }
            try await respond(id: pending.rpcID, result: .object(["answers": .object(answers)]))
            pendingUserInputs.removeValue(forKey: resolution.requestID)
            emit(
                .userInputResolved(
                    requestID: resolution.requestID,
                    turnID: resolution.turnID,
                    answers: resolution.answers
                ),
                turnID: resolution.turnID,
                itemID: pending.request.itemID
            )
        }
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        for pending in pendingApprovals.values {
            if let result = pending.results[.cancel] ?? pending.results[.deny] {
                try? await respond(id: pending.rpcID, result: result)
            }
        }
        pendingApprovals.removeAll()
        for pending in pendingUserInputs.values {
            try? await respondError(id: pending.rpcID, code: -32800, message: "TermRelay session stopped")
        }
        pendingUserInputs.removeAll()
        if let threadID {
            if let activeTurnID {
                _ = try? await request(method: "turn/interrupt", params: .object([
                    "threadId": .string(threadID),
                    "turnId": .string(activeTurnID),
                ]))
                self.activeTurnID = nil
            }
            _ = try? await request(method: "thread/delete", params: .object([
                "threadId": .string(threadID),
            ]))
            self.threadID = nil
        }
        messageTask?.cancel()
        messageTask = nil
        await client.stop()
        host?.stop()
        continuation.finish()
    }

    private func receive(_ message: CodexServerMessage) async {
        switch message {
        case .notification(let method, let params):
            receiveNotification(method: method, params: params)
        case .request(let id, let method, let params):
            await receiveRequest(id: id, method: method, params: params)
        }
    }

    private func receiveNotification(method: String, params: JSONValue) {
        let object = params.object ?? [:]
        let turnID = object["turnId"]?.string
        let itemID = object["itemId"]?.string
        switch method {
        case "thread/started":
            guard let thread = object["thread"]?.object,
                  let id = thread["id"]?.string,
                  threadID == nil else { return }
            threadID = id
            announceSession(AgentSessionReference(providerID: .codex, opaqueID: id))
        case "turn/started":
            guard let turn = object["turn"]?.object,
                  let startedID = turn["id"]?.string,
                  activeTurnID != startedID else { return }
            activeTurnID = startedID
            emit(.turnStarted(turnID: startedID), turnID: startedID)
        case "item/agentMessage/delta":
            if let text = object["delta"]?.string {
                emit(.assistantTextDelta(text: text), turnID: turnID, itemID: itemID)
            }
        case "item/reasoning/textDelta", "item/reasoning/summaryTextDelta":
            if let text = object["delta"]?.string {
                emit(.reasoningDelta(text: text), turnID: turnID, itemID: itemID)
            }
        case "item/plan/delta":
            if let text = object["delta"]?.string {
                emit(.planUpdated(text: text), turnID: turnID, itemID: itemID)
            }
        case "turn/plan/updated":
            let planText = object["plan"]?.array?.compactMap { step -> String? in
                let value = step.object ?? [:]
                return value["step"]?.string ?? value["text"]?.string
            }.joined(separator: "\n")
            if let planText, !planText.isEmpty {
                emit(.planUpdated(text: planText), turnID: turnID)
            }
        case "item/commandExecution/outputDelta":
            if let text = object["delta"]?.string, let itemID {
                emit(.commandOutput(commandID: itemID, text: text), turnID: turnID, itemID: itemID)
            }
        case "item/fileChange/outputDelta":
            if let text = object["delta"]?.string, let itemID {
                emit(.fileChanged(itemID: itemID, summary: text), turnID: turnID, itemID: itemID)
            }
        case "item/started":
            receiveItemStarted(object)
        case "item/completed":
            receiveItemCompleted(object)
        case "turn/completed":
            guard let turn = object["turn"]?.object,
                  let completedID = turn["id"]?.string else { return }
            let status = completionStatus(turn["status"]?.string)
            emit(.turnCompleted(turnID: completedID, status: status), turnID: completedID)
            if activeTurnID == completedID { activeTurnID = nil }
        case "error":
            let message = object["message"]?.string ?? "Codex App Server reported an error"
            emit(.failed(code: "codex_error", message: message), turnID: turnID)
        default:
            break
        }
    }

    private func receiveItemStarted(_ params: [String: JSONValue]) {
        guard let turnID = params["turnId"]?.string,
              let item = params["item"]?.object,
              let type = item["type"]?.string,
              let itemID = item["id"]?.string else { return }
        if type == "commandExecution", let command = item["command"]?.string {
            emit(
                .commandStarted(commandID: itemID, command: command),
                turnID: turnID,
                itemID: itemID
            )
        }
    }

    private func receiveItemCompleted(_ params: [String: JSONValue]) {
        guard let turnID = params["turnId"]?.string,
              let item = params["item"]?.object,
              let type = item["type"]?.string,
              let itemID = item["id"]?.string else { return }
        if type == "commandExecution" {
            emit(
                .commandCompleted(commandID: itemID, exitCode: item["exitCode"]?.integer),
                turnID: turnID,
                itemID: itemID
            )
        } else if type == "agentMessage", let text = item["text"]?.string {
            emit(.assistantMessageCompleted(text: text), turnID: turnID, itemID: itemID)
        } else if type == "fileChange" {
            let count = item["changes"]?.array?.count ?? 0
            emit(
                .fileChanged(itemID: itemID, summary: "\(count) 个文件变更"),
                turnID: turnID,
                itemID: itemID
            )
        }
    }

    private func receiveRequest(id: JSONValue, method: String, params: JSONValue) async {
        if method == "item/tool/requestUserInput" {
            await receiveUserInputRequest(id: id, params: params)
            return
        }
        guard method == "item/commandExecution/requestApproval"
                || method == "item/fileChange/requestApproval"
                || method == "item/permissions/requestApproval",
              let object = params.object,
              let turnID = object["turnId"]?.string,
              let itemID = object["itemId"]?.string,
              turnID == activeTurnID else {
            try? await respondError(
                id: id, code: -32601, message: "Unsupported or mismatched approval request"
            )
            return
        }
        let kind = method.contains("fileChange") ? "fileChange"
            : method.contains("permissions") ? "permissions" : "command"
        let providerApprovalID = object["approvalId"]?.string ?? itemID
        let approvalID = "\(kind):\(providerApprovalID)"
        let request = ApprovalRequest(
            approvalID: approvalID,
            turnID: turnID,
            itemID: itemID,
            kind: kind,
            risk: kind == "fileChange" || kind == "permissions" ? .high : .medium,
            title: kind == "fileChange" ? "批准文件变更"
                : kind == "permissions" ? "批准额外权限" : "批准运行命令",
            detail: approvalDetail(object),
            availableDecisions: approvalDecisions(kind: kind, object: object),
            expiresAt: Date().addingTimeInterval(5 * 60)
        )
        pendingApprovals[approvalID] = PendingApproval(
            rpcID: id,
            turnID: turnID,
            itemID: itemID,
            kind: kind,
            results: approvalResults(kind: kind, object: object)
        )
        emit(
            .approvalRequested(request),
            turnID: turnID,
            itemID: itemID,
            approvalID: approvalID
        )
    }

    private func receiveUserInputRequest(id: JSONValue, params: JSONValue) async {
        guard let object = params.object,
              let turnID = object["turnId"]?.string,
              let itemID = object["itemId"]?.string,
              turnID == activeTurnID else {
            try? await client.respondError(id: id, code: -32602, message: "Invalid requestUserInput correlation")
            return
        }
        let questions = object["questions"]?.array?.compactMap { value -> UserInputQuestion? in
            guard let question = value.object,
                  let id = question["id"]?.string,
                  let header = question["header"]?.string,
                  let text = question["question"]?.string else { return nil }
            let options = question["options"]?.array?.compactMap { option -> UserInputOption? in
                guard let value = option.object,
                      let label = value["label"]?.string,
                      let description = value["description"]?.string else { return nil }
                return UserInputOption(label: label, description: description)
            } ?? []
            return UserInputQuestion(
                id: id,
                header: header,
                question: text,
                options: options,
                allowsOther: question["isOther"]?.bool ?? options.isEmpty,
                isSecret: question["isSecret"]?.bool ?? false
            )
        } ?? []
        guard !questions.isEmpty else {
            try? await client.respondError(id: id, code: -32602, message: "requestUserInput has no valid questions")
            return
        }
        let requestID = "input:\(rpcKey(id))"
        let timeoutMs = object["autoResolutionMs"]?.integer
        let request = UserInputRequest(
            requestID: requestID,
            turnID: turnID,
            itemID: itemID,
            questions: questions,
            isBlocking: object["isBlocking"]?.bool ?? true,
            expiresAt: timeoutMs.map { Date().addingTimeInterval(Double($0) / 1_000) }
        )
        pendingUserInputs[requestID] = PendingUserInput(rpcID: id, request: request)
        emit(.userInputRequested(request), turnID: turnID, itemID: itemID)
    }

    private func approvalDecisions(kind: String, object: [String: JSONValue]) -> [ApprovalDecision] {
        var decisions = object["availableDecisions"]?.array?.compactMap { value in
            Self.approvalDecision(value.string)
        } ?? []
        if decisions.isEmpty {
            decisions = [.allowOnce, .allowSession, .deny, .cancel]
        }
        if kind == "command",
           object["proposedExecpolicyAmendment"]?.array?.isEmpty == false
            || object["proposedNetworkPolicyAmendments"]?.array?.isEmpty == false {
            decisions.insert(.allowPolicy, at: min(2, decisions.count))
        }
        return decisions.reduce(into: []) { result, decision in
            if !result.contains(decision) { result.append(decision) }
        }
    }

    private func approvalResults(kind: String, object: [String: JSONValue]) -> [ApprovalDecision: JSONValue] {
        if kind == "permissions" {
            let permissions = object["permissions"] ?? .object([:])
            return [
                .allowOnce: .object(["permissions": permissions, "scope": .string("turn")]),
                .allowSession: .object(["permissions": permissions, "scope": .string("session")]),
                .deny: .object(["permissions": .object([:]), "scope": .string("turn")]),
                .cancel: .object(["permissions": .object([:]), "scope": .string("turn")]),
            ]
        }
        var results: [ApprovalDecision: JSONValue] = [
            .allowOnce: .object(["decision": .string("accept")]),
            .allowSession: .object(["decision": .string("acceptForSession")]),
            .deny: .object(["decision": .string("decline")]),
            .cancel: .object(["decision": .string("cancel")]),
        ]
        if let amendment = object["proposedExecpolicyAmendment"]?.array {
            results[.allowPolicy] = .object(["decision": .object([
                "acceptWithExecpolicyAmendment": .object([
                    "execpolicy_amendment": .array(amendment),
                ]),
            ])])
        } else if let amendment = object["proposedNetworkPolicyAmendments"]?.array?.first {
            results[.allowPolicy] = .object(["decision": .object([
                "applyNetworkPolicyAmendment": .object([
                    "network_policy_amendment": amendment,
                ]),
            ])])
        }
        return results
    }

    private func approvalDetail(_ object: [String: JSONValue]) -> String? {
        var parts: [String] = []
        if let command = object["command"]?.string { parts.append(command) }
        if let cwd = object["cwd"]?.string { parts.append("目录：\(cwd)") }
        if let reason = object["reason"]?.string { parts.append(reason) }
        if let network = object["networkApprovalContext"]?.object {
            let host = network["host"]?.string ?? "未知主机"
            let protocolName = network["protocol"]?.string ?? "network"
            parts.append("网络：\(protocolName)://\(host)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    private static func approvalDecision(_ value: String?) -> ApprovalDecision? {
        switch value {
        case "accept": .allowOnce
        case "acceptForSession": .allowSession
        case "decline": .deny
        case "cancel": .cancel
        default: nil
        }
    }

    private func request(method: String, params: JSONValue) async throws -> JSONValue {
        try await client.request(method: method, params: params)
    }

    private func respond(id: JSONValue, result: JSONValue) async throws {
        try await client.respond(id: id, result: result)
    }

    private func respondError(id: JSONValue, code: Int, message: String) async throws {
        try await client.respondError(id: id, code: code, message: message)
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
            correlation: AgentCorrelation(
                turnID: turnID,
                itemID: itemID,
                approvalID: approvalID
            ),
            payload: payload
        ))
        sequence += 1
    }

    private func announceSession(_ reference: AgentSessionReference) {
        guard !didEmitSessionStarted else { return }
        didEmitSessionStarted = true
        emit(.sessionStarted(reference: reference))
    }

    private func completionStatus(_ status: String?) -> TurnCompletionStatus {
        switch status {
        case "interrupted": .interrupted
        case "failed": .failed
        default: .completed
        }
    }

    private func rpcKey(_ id: JSONValue) -> String {
        (try? String(decoding: JSONEncoder().encode(id), as: UTF8.self)) ?? "null"
    }
}
