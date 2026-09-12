import Foundation

struct CodexStructuredAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID.codex
    let displayName = "Codex 结构化 Agent"

    func detect() async throws -> AgentInstallation {
        guard let executable = ExecutableLocator.find(named: "codex") else {
            throw AgentError.providerUnavailable("找不到 codex 可执行程序")
        }
        let version = try readVersion(executable)
        let support = CodexVersionSupport.evaluate(version)
        return AgentInstallation(
            executableURL: executable,
            version: version,
            supported: support.supported,
            unsupportedReason: support.reason
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
        let transport = CodexAppServerProcess(
            executableURL: installation.executableURL,
            directory: configuration.workspaceURL
        )
        return CodexStructuredRuntime(
            sessionID: configuration.sessionID,
            workspaceURL: configuration.workspaceURL,
            providerVersion: installation.version,
            client: CodexAppServerClient(transport: transport)
        )
    }

    private func readVersion(_ executable: URL) throws -> String {
        let process = Process()
        let output = Pipe()
        process.executableURL = executable
        process.arguments = ["--version"]
        process.standardOutput = output
        process.standardError = output
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw AgentError.providerUnavailable("无法读取 Codex 版本")
        }
        let value = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            throw AgentError.providerUnavailable("Codex 未返回版本")
        }
        return value
    }
}

enum CodexVersionSupport {
    static let verified = "0.153.4"

    static func evaluate(_ output: String) -> (supported: Bool, reason: String?) {
        guard let version = output.split(separator: " ").last.map(String.init) else {
            return (false, "无法解析 Codex 版本：\(output)")
        }
        let pieces = version.split(separator: ".").compactMap { Int($0) }
        guard pieces.count >= 3 else {
            return (false, "无法解析 Codex 版本：\(output)")
        }
        guard pieces[0] == 0, pieces[1] == 153, pieces[2] >= 4 else {
            return (
                false,
                "当前仅验证 codex-cli 0.153.4～0.153.x；检测到 \(version)，请使用终端模式。"
            )
        }
        return (true, nil)
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
    }

    private let sessionID: UUID
    private let workspaceURL: URL
    private let client: CodexAppServerClient
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var messageTask: Task<Void, Never>?
    private var threadID: String?
    private var activeTurnID: String?
    private var pendingApprovals: [String: PendingApproval] = [:]
    private var sequence: UInt64 = 0
    private var stopped = false

    init(
        sessionID: UUID,
        workspaceURL: URL,
        providerVersion: String,
        client: CodexAppServerClient
    ) {
        self.sessionID = sessionID
        self.workspaceURL = workspaceURL
        self.client = client
        descriptor = AgentDescriptor(
            providerID: .codex,
            providerVersion: providerVersion,
            protocolName: "codex-app-server",
            protocolVersion: "v2",
            capabilities: [
                .streamingText,
                .reasoning,
                .commandExecution,
                .commandOutput,
                .fileChanges,
                .approvals,
                .plans,
                .sessionResume,
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
            "ephemeral": .bool(request.ephemeral),
        ]))
        guard let id = result.object?["thread"]?.object?["id"]?.string else {
            throw AgentError.protocolFailure("thread/start 未返回 thread.id")
        }
        threadID = id
        let reference = AgentSessionReference(providerID: .codex, opaqueID: id)
        emit(.sessionStarted(reference: reference))
        return reference
    }

    func resumeSession(_ reference: AgentSessionReference) async throws {
        guard reference.providerID == .codex else {
            throw AgentError.correlationMismatch("Provider reference 不属于 Codex")
        }
        let result = try await client.request(method: "thread/resume", params: .object([
            "threadId": .string(reference.opaqueID),
        ]))
        guard result.object?["thread"]?.object?["id"]?.string == reference.opaqueID else {
            throw AgentError.protocolFailure("thread/resume 返回了不同 thread")
        }
        threadID = reference.opaqueID
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
            let result = try await client.request(method: "turn/start", params: .object([
                "threadId": .string(threadID),
                "clientUserMessageId": .string(idempotencyKey.uuidString.lowercased()),
                "input": .array([
                    .object(["type": .string("text"), "text": .string(input.text)]),
                ]),
            ]))
            guard let turnID = result.object?["turn"]?.object?["id"]?.string else {
                throw AgentError.protocolFailure("turn/start 未返回 turn.id")
            }
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
            _ = try await client.request(method: "turn/interrupt", params: .object([
                "threadId": .string(threadID),
                "turnId": .string(activeTurnID),
            ]))
        case .resolveApproval(let resolution):
            guard let pending = pendingApprovals.removeValue(forKey: resolution.approvalID),
                  pending.turnID == resolution.turnID,
                  pending.turnID == activeTurnID else {
                throw AgentError.correlationMismatch("审批响应不属于当前 Codex turn")
            }
            let decision = resolution.decision == .allowOnce ? "accept" : "decline"
            try await client.respond(
                id: pending.rpcID,
                result: .object(["decision": .string(decision)])
            )
        }
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        for pending in pendingApprovals.values {
            try? await client.respond(
                id: pending.rpcID,
                result: .object(["decision": .string("decline")])
            )
        }
        pendingApprovals.removeAll()
        messageTask?.cancel()
        messageTask = nil
        await client.stop()
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
        case "item/commandExecution/outputDelta":
            if let text = object["delta"]?.string, let itemID {
                emit(.commandOutput(commandID: itemID, text: text), turnID: turnID, itemID: itemID)
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
        guard method == "item/commandExecution/requestApproval"
                || method == "item/fileChange/requestApproval",
              let object = params.object,
              let turnID = object["turnId"]?.string,
              let itemID = object["itemId"]?.string,
              turnID == activeTurnID else {
            try? await client.respondError(
                id: id,
                code: -32601,
                message: "Unsupported or mismatched approval request"
            )
            return
        }
        let kind = method.contains("fileChange") ? "fileChange" : "command"
        let providerApprovalID = object["approvalId"]?.string ?? itemID
        let approvalID = "\(kind):\(providerApprovalID)"
        let request = ApprovalRequest(
            approvalID: approvalID,
            turnID: turnID,
            itemID: itemID,
            kind: kind,
            risk: kind == "fileChange" ? .high : .medium,
            title: kind == "fileChange" ? "批准文件变更" : "批准运行命令",
            detail: object["command"]?.string ?? object["reason"]?.string,
            expiresAt: Date().addingTimeInterval(5 * 60)
        )
        pendingApprovals[approvalID] = PendingApproval(
            rpcID: id,
            turnID: turnID,
            itemID: itemID,
            kind: kind
        )
        emit(
            .approvalRequested(request),
            turnID: turnID,
            itemID: itemID,
            approvalID: approvalID
        )
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

    private func completionStatus(_ status: String?) -> TurnCompletionStatus {
        switch status {
        case "interrupted": .interrupted
        case "failed": .failed
        default: .completed
        }
    }
}

private extension JSONValue {
    var array: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
}
