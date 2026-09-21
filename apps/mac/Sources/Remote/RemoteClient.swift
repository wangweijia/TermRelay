import Foundation

actor RemoteClient {
    typealias StateHandler = @Sendable (ConnectionState, String?) -> Void
    typealias CommandHandler = @Sendable (RemoteTerminalCommand) async -> RemoteCommandResult
    typealias AuthorizationInvalidatedHandler = @Sendable () -> Void

    private let deviceID: UUID
    private let stateHandler: StateHandler
    private let commandHandler: CommandHandler
    private let authorizationInvalidatedHandler: AuthorizationInvalidatedHandler
    private var serverURL: URL?
    private var credential: String?
    private var socket: URLSessionWebSocketTask?
    private var runTask: Task<Void, Never>?
    private var heartbeatTask: Task<Void, Never>?
    private var shouldRun = false
    private var registered = false
    private var heartbeatIntervalMs = 15_000
    private var activeSessionCount = 0
    private var generation = 0
    private var completedCommands: [UUID] = []
    private var announcedSessions = Set<UUID>()
    private var endedSessions = Set<UUID>()
    private var pendingSessionEnds: [UUID: RelaySessionEnded] = [:]
    private var pendingEvents: [UUID: [RelayPendingEvent]] = [:]
    private var nextSequenceBySession: [UUID: UInt64] = [:]
    private var relaySequenceBySource: [UUID: [RelayEventSource: UInt64]] = [:]
    private var sentThroughBySession: [UUID: UInt64] = [:]
    private var sendsSinceSyncBySession: [UUID: Int] = [:]
    private var drainingSessions = Set<UUID>()
    private var sessionsAwaitingSync = Set<UUID>()
    private var sessionsFinalizingSync = Set<UUID>()
    private var sessionsWithLocalGap = Set<UUID>()
    private let syncEveryEventCount = 64
    private let outbox: RelayOutboxStore

    init(
        deviceID: UUID,
        stateHandler: @escaping StateHandler,
        commandHandler: @escaping CommandHandler,
        authorizationInvalidatedHandler: @escaping AuthorizationInvalidatedHandler = {},
        outboxDirectory: URL? = nil
    ) {
        self.deviceID = deviceID
        self.stateHandler = stateHandler
        self.commandHandler = commandHandler
        self.authorizationInvalidatedHandler = authorizationInvalidatedHandler
        outbox = RelayOutboxStore(deviceID: deviceID, directory: outboxDirectory)
        let recovered = (try? outbox.load()) ?? []
        for event in recovered {
            pendingEvents[event.sessionID, default: []].append(event)
            nextSequenceBySession[event.sessionID] = max(
                nextSequenceBySession[event.sessionID] ?? 1,
                event.sequence + 1
            )
        }
    }

    func connect(to value: String, credential: String? = nil) {
        guard let url = URL(string: value), ["ws", "wss"].contains(url.scheme?.lowercased()) else {
            stateHandler(.offline, "Server URL 必须使用 ws:// 或 wss://")
            return
        }
        disconnect()
        serverURL = url
        self.credential = credential
        shouldRun = true
        generation += 1
        let currentGeneration = generation
        runTask = Task { [weak self] in
            await self?.connectionLoop(generation: currentGeneration)
        }
    }

    func disconnect() {
        shouldRun = false
        generation += 1
        registered = false
        announcedSessions.removeAll()
        sentThroughBySession.removeAll()
        drainingSessions.removeAll()
        sessionsAwaitingSync.removeAll()
        sessionsFinalizingSync.removeAll()
        heartbeatTask?.cancel()
        heartbeatTask = nil
        runTask?.cancel()
        runTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        credential = nil
        stateHandler(.offline, nil)
    }

    func setActiveSessionCount(_ count: Int) {
        activeSessionCount = max(0, count)
    }

    func publishWorkspace(id: String, directory: URL) async {
        await send(
            type: "workspace.registered",
            payload: RelayWorkspace(
                workspaceId: id,
                displayName: directory.lastPathComponent,
                available: FileManager.default.fileExists(atPath: directory.path),
                remoteStartAllowed: false
            )
        )
    }

    func publishSession(
        id: UUID,
        workspaceId: String,
        toolKey: String,
        displayName: String,
        runtimeMode: SessionRuntimeMode = .pty,
        startedAt: String
    ) async {
        if nextSequenceBySession[id] == nil { nextSequenceBySession[id] = 1 }
        sessionsAwaitingSync.insert(id)
        let sent = await send(
            type: "session.started",
            sessionId: id.uuidString.lowercased(),
            seq: 0,
            payload: RelaySessionStarted(
                workspaceId: workspaceId,
                toolKey: toolKey,
                displayName: displayName,
                runtimeMode: runtimeMode.rawValue,
                startedAt: startedAt
            )
        )
        guard sent else { return }
    }

    func publishSessionEnded(id: UUID, status: SessionState, finishedAt: String) async {
        guard status == .finished || status == .failed else { return }
        guard endedSessions.insert(id).inserted else { return }
        let payload = RelaySessionEnded(
            status: status == .failed ? "failed" : "finished",
            finishedAt: finishedAt
        )
        pendingSessionEnds[id] = payload
        guard registered, announcedSessions.contains(id) else {
            return
        }
        await drainPendingEvents(sessionId: id)
    }

    func publishTerminalOutput(_ batch: TerminalOutputBatch) async {
        let sequence = relaySequence(
            for: RelayEventSource(kind: .terminal, sequence: batch.sequence),
            sessionID: batch.sessionID
        )
        let sequenced = TerminalOutputBatch(
            sessionID: batch.sessionID,
            sequence: sequence,
            capturedAt: batch.capturedAt,
            bytes: batch.bytes
        )
        let pending = RelayPendingEvent.terminal(sequenced)
        guard enqueue(pending) else { return }
        await drainPendingEvents(sessionId: sequenced.sessionID)
    }

    func publishToolEvent(_ event: ToolEvent) async {
        // Provider session startup is represented by session.started. All other
        // providers share one relay sequence with terminal output for this session.
        if case .sessionStarted = event.payload { return }
        let sequence = relaySequence(
            for: RelayEventSource(kind: .tool, sequence: event.sequence),
            sessionID: event.sessionID
        )
        let pending = RelayPendingEvent.tool(sequence: sequence, event: event)
        guard enqueue(pending) else { return }
        await drainPendingEvents(sessionId: event.sessionID)
    }

    private func relaySequence(for source: RelayEventSource, sessionID: UUID) -> UInt64 {
        if let existing = relaySequenceBySource[sessionID]?[source] { return existing }
        let next = nextSequenceBySession[sessionID] ?? 1
        nextSequenceBySession[sessionID] = next + 1
        relaySequenceBySource[sessionID, default: [:]][source] = next
        return next
    }

    private func connectionLoop(generation expectedGeneration: Int) async {
        var retry = 0
        while shouldRun, generation == expectedGeneration, !Task.isCancelled {
            guard let serverURL else { return }
            stateHandler(.connecting, nil)
            var request = URLRequest(url: serverURL)
            if serverURL.path == "/ws/client-public", let credential {
                request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
            }
            let task = URLSession.shared.webSocketTask(with: request)
            socket = task
            registered = false
            announcedSessions.removeAll()
            task.resume()

            do {
                try await sendRegistration()
                try await receiveLoop(task: task, generation: expectedGeneration)
            } catch is CancellationError {
                return
            } catch {
                if shouldRun, generation == expectedGeneration {
                    let responseCode = (task.response as? HTTPURLResponse)?.statusCode
                    if task.closeCode.rawValue == 4003 || responseCode == 401 {
                        invalidateAuthorization()
                        return
                    }
                    stateHandler(.degraded, error.localizedDescription)
                }
            }

            registered = false
            heartbeatTask?.cancel()
            heartbeatTask = nil
            task.cancel(with: .goingAway, reason: nil)
            if socket === task { socket = nil }
            guard shouldRun, generation == expectedGeneration, !Task.isCancelled else { return }
            let delay = min(10.0, 0.5 * pow(2.0, Double(retry)))
            retry = min(retry + 1, 5)
            try? await Task.sleep(for: .seconds(delay))
        }
    }

    private func receiveLoop(task: URLSessionWebSocketTask, generation expectedGeneration: Int) async throws {
        while shouldRun, generation == expectedGeneration, !Task.isCancelled {
            let message = try await task.receive()
            let data: Data
            switch message {
            case .data(let value): data = value
            case .string(let value): data = Data(value.utf8)
            @unknown default: continue
            }
            let packet = try JSONDecoder().decode(IncomingRelayPacket.self, from: data)
            guard packet.event == "message", packet.data.protocolVersion == "2" else { continue }
            await handle(packet.data)
        }
    }

    private func handle(_ envelope: IncomingRelayEnvelope) async {
        guard envelope.deviceId.caseInsensitiveCompare(deviceID.uuidString) == .orderedSame else { return }
        if envelope.type == "client.authorization-revoked" {
            invalidateAuthorization()
            return
        }
        if envelope.type == "device.registered" {
            registered = true
            sessionsFinalizingSync.removeAll()
            if let interval = envelope.payload.object?["heartbeatIntervalMs"]?.integer {
                heartbeatIntervalMs = max(1_000, interval)
            }
            startHeartbeat()
            stateHandler(.connected, nil)
            return
        }
        if envelope.type == "session.synced" {
            guard
                let rawSessionID = envelope.sessionId,
                let sessionID = UUID(uuidString: rawSessionID),
                let accepted = envelope.payload.object?["lastAcceptedSeq"]?.integer,
                accepted >= 0
            else { return }
            await reconcileSession(sessionID, lastAcceptedSequence: UInt64(accepted))
            return
        }
        if envelope.type == "protocol.error" {
            let message = envelope.payload.object?["message"]?.string ?? "Server 拒绝了消息"
            if
                envelope.payload.object?["code"]?.string == "conflict",
                envelope.payload.object?["expectedSeq"]?.integer != nil,
                let rawSessionID = envelope.sessionId,
                let sessionID = UUID(uuidString: rawSessionID)
            {
                sessionsAwaitingSync.insert(sessionID)
                stateHandler(.degraded, "会话序号不同步，正在自动对账并补发。")
                await requestSessionSync(sessionID)
                return
            }
            stateHandler(.degraded, message)
            return
        }
        guard registered, let command = decodeCommand(envelope) else { return }
        if completedCommands.contains(command.commandId) {
            await acknowledge(command, result: .completed)
            return
        }
        let result = await commandHandler(command)
        if result.succeeded {
            completedCommands.append(command.commandId)
            if completedCommands.count > 512 { completedCommands.removeFirst(128) }
        }
        await acknowledge(command, result: result)
    }

    private func invalidateAuthorization() {
        guard shouldRun else { return }
        shouldRun = false
        registered = false
        heartbeatTask?.cancel()
        heartbeatTask = nil
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: 4003) ?? .policyViolation
        socket?.cancel(with: closeCode, reason: nil)
        socket = nil
        credential = nil
        stateHandler(.offline, "此 Mac 的 Server 授权已失效，需要重新授权。")
        authorizationInvalidatedHandler()
    }

    func decodeCommand(_ envelope: IncomingRelayEnvelope) -> RemoteTerminalCommand? {
        guard
            let commandId = envelope.commandId,
            let rawSessionId = envelope.sessionId,
            let sessionId = UUID(uuidString: rawSessionId)
        else { return nil }
        let payload = envelope.payload.object ?? [:]
        switch envelope.type {
        case "terminal.input":
            guard
                payload["encoding"]?.string == "base64",
                let encoded = payload["data"]?.string,
                let data = Data(base64Encoded: encoded)
            else { return nil }
            return .input(commandId: commandId, sessionId: sessionId, data: data)
        case "terminal.resize":
            guard
                let columns = payload["columns"]?.integer,
                let rows = payload["rows"]?.integer,
                (1...1000).contains(columns),
                (1...1000).contains(rows)
            else { return nil }
            return .resize(commandId: commandId, sessionId: sessionId, columns: columns, rows: rows)
        case "session.interrupt": return .interrupt(commandId: commandId, sessionId: sessionId)
        case "session.stop": return .stop(commandId: commandId, sessionId: sessionId)
        case "tool.turn.start":
            guard let text = payload["text"]?.string,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return .startTurn(commandId: commandId, sessionId: sessionId, text: text)
        case "tool.turn.interrupt":
            return .interruptTurn(commandId: commandId, sessionId: sessionId)
        case "tool.approval.resolve":
            guard let approvalId = payload["approvalId"]?.string,
                  let turnId = payload["turnId"]?.string,
                  let rawDecision = payload["decision"]?.string,
                  let decision = ApprovalDecision(rawValue: rawDecision) else { return nil }
            return .resolveApproval(
                commandId: commandId,
                sessionId: sessionId,
                approvalId: approvalId,
                turnId: turnId,
                decision: decision
            )
        case "tool.user-input.resolve":
            guard let requestId = payload["requestId"]?.string,
                  let turnId = payload["turnId"]?.string,
                  let rawAnswers = payload["answers"]?.object else { return nil }
            var answers: [String: [String]] = [:]
            for (questionID, value) in rawAnswers {
                guard let values = value.array?.compactMap(\.string), !values.isEmpty else { return nil }
                answers[questionID] = values
            }
            guard !answers.isEmpty else { return nil }
            return .resolveUserInput(
                commandId: commandId,
                sessionId: sessionId,
                requestId: requestId,
                turnId: turnId,
                answers: answers
            )
        default: return nil
        }
    }

    private func acknowledge(_ command: RemoteTerminalCommand, result: RemoteCommandResult) async {
        await send(
            type: "command.ack",
            sessionId: command.sessionId.uuidString.lowercased(),
            commandId: command.commandId,
            payload: RelayCommandAck(
                commandId: command.commandId,
                status: result.succeeded ? "completed" : "rejected",
                errorCode: result.errorCode,
                message: result.message
            )
        )
    }

    private func sendRegistration() async throws {
        let payload = RelayDeviceRegister(
            name: Host.current().localizedName ?? "Mac",
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0",
            tools: BuiltInTool.allCases.map(\.rawValue)
        )
        try await sendRaw(type: "device.register", payload: payload)
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        let interval = heartbeatIntervalMs
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(interval))
                guard !Task.isCancelled else { return }
                await self?.sendHeartbeat()
            }
        }
    }

    private func sendHeartbeat() async {
        await send(
            type: "device.heartbeat",
            payload: RelayHeartbeat(
                connectionState: "connected",
                activeSessionCount: activeSessionCount
            )
        )
    }

    @discardableResult
    private func send<Payload: Encodable & Sendable>(
        type: String,
        sessionId: String? = nil,
        commandId: UUID? = nil,
        seq: UInt64? = nil,
        payload: Payload
    ) async -> Bool {
        guard registered else { return false }
        do {
            try await sendRaw(
                type: type,
                sessionId: sessionId,
                commandId: commandId,
                seq: seq,
                payload: payload
            )
            return true
        } catch {
            stateHandler(.degraded, error.localizedDescription)
            socket?.cancel(with: .goingAway, reason: nil)
            return false
        }
    }

    @discardableResult
    private func enqueue(_ event: RelayPendingEvent) -> Bool {
        var sessionEvents = pendingEvents[event.sessionID] ?? []
        if sessionEvents.contains(where: { $0.sequence == event.sequence }) { return true }
        do {
            try outbox.save(event)
        } catch {
            stateHandler(.degraded, "无法保存待同步事件：\(error.localizedDescription)")
            return false
        }
        sessionEvents.append(event)
        sessionEvents.sort { $0.sequence < $1.sequence }
        pendingEvents[event.sessionID] = sessionEvents
        return true
    }

    private func drainPendingEvents(sessionId: UUID) async {
        guard registered,
              announcedSessions.contains(sessionId),
              !sessionsAwaitingSync.contains(sessionId),
              !sessionsWithLocalGap.contains(sessionId),
              drainingSessions.insert(sessionId).inserted else { return }
        defer { drainingSessions.remove(sessionId) }

        while registered,
              announcedSessions.contains(sessionId),
              !sessionsAwaitingSync.contains(sessionId)
        {
            let sentThrough = sentThroughBySession[sessionId] ?? 0
            guard let event = pendingEvents[sessionId]?.first(where: {
                $0.sequence > sentThrough
            }) else {
                if let pendingEnd = pendingSessionEnds.removeValue(forKey: sessionId) {
                    if pendingEvents[sessionId]?.isEmpty == false,
                       sessionsFinalizingSync.insert(sessionId).inserted
                    {
                        pendingSessionEnds[sessionId] = pendingEnd
                        if !(await requestSessionSync(sessionId)) {
                            sessionsFinalizingSync.remove(sessionId)
                        }
                        return
                    }
                    sessionsFinalizingSync.remove(sessionId)
                    await sendSessionEnded(id: sessionId, payload: pendingEnd)
                }
                return
            }
            guard event.sequence == sentThrough + 1 else {
                sessionsWithLocalGap.insert(sessionId)
                stateHandler(
                    .degraded,
                    "本地待发送队列缺少序号 \(sentThrough + 1)，已暂停该会话同步。"
                )
                return
            }
            guard await send(event) else { return }
            sentThroughBySession[sessionId] = event.sequence
            let count = (sendsSinceSyncBySession[sessionId] ?? 0) + 1
            sendsSinceSyncBySession[sessionId] = count
            if count >= syncEveryEventCount {
                sendsSinceSyncBySession[sessionId] = 0
                await requestSessionSync(sessionId)
            }
        }
    }

    private func reconcileSession(_ sessionID: UUID, lastAcceptedSequence: UInt64) async {
        let wasWaiting = sessionsAwaitingSync.remove(sessionID) != nil
        let removed = pendingEvents[sessionID]?.filter {
            $0.sequence <= lastAcceptedSequence
        } ?? []
        if !removed.isEmpty {
            pendingEvents[sessionID]?.removeAll { $0.sequence <= lastAcceptedSequence }
            if pendingEvents[sessionID]?.isEmpty == true { pendingEvents[sessionID] = nil }
        }
        do {
            try outbox.remove(sessionID: sessionID, through: lastAcceptedSequence)
        } catch {
            stateHandler(.degraded, "无法清理已同步事件：\(error.localizedDescription)")
        }

        let firstPending = pendingEvents[sessionID]?.first?.sequence
        if let firstPending, firstPending > lastAcceptedSequence + 1 {
            sessionsWithLocalGap.insert(sessionID)
            stateHandler(
                .degraded,
                "服务端需要序号 \(lastAcceptedSequence + 1)，但本地最早只有 \(firstPending)，无法自动补发。"
            )
            return
        }

        sessionsWithLocalGap.remove(sessionID)
        sessionsFinalizingSync.remove(sessionID)
        announcedSessions.insert(sessionID)
        if wasWaiting {
            sentThroughBySession[sessionID] = lastAcceptedSequence
        } else {
            sentThroughBySession[sessionID] = max(
                sentThroughBySession[sessionID] ?? lastAcceptedSequence,
                lastAcceptedSequence
            )
        }
        nextSequenceBySession[sessionID] = max(
            nextSequenceBySession[sessionID] ?? 1,
            (pendingEvents[sessionID]?.last?.sequence ?? lastAcceptedSequence) + 1
        )
        Task { [weak self] in
            await self?.drainPendingEvents(sessionId: sessionID)
        }
    }

    @discardableResult
    private func requestSessionSync(_ sessionID: UUID) async -> Bool {
        guard registered else { return false }
        return await send(
            type: "session.sync",
            sessionId: sessionID.uuidString.lowercased(),
            payload: RelaySessionSync()
        )
    }

    private func send(_ event: RelayPendingEvent) async -> Bool {
        switch event.kind {
        case .terminal:
            guard let data = event.terminalData else { return false }
            return await send(
                type: "terminal.output",
                sessionId: event.sessionID.uuidString.lowercased(),
                seq: event.sequence,
                payload: RelayTerminalOutput(data: data.base64EncodedString())
            )
        case .tool:
            guard let payload = event.toolPayload else { return false }
            return await send(
                type: "tool.event",
                sessionId: event.sessionID.uuidString.lowercased(),
                seq: event.sequence,
                payload: payload
            )
        }
    }

    private func sendSessionEnded(id: UUID, payload: RelaySessionEnded) async {
        let sent = await send(
            type: "session.ended",
            sessionId: id.uuidString.lowercased(),
            payload: payload
        )
        if !sent { pendingSessionEnds[id] = payload }
    }

    private func sendRaw<Payload: Encodable & Sendable>(
        type: String,
        sessionId: String? = nil,
        commandId: UUID? = nil,
        seq: UInt64? = nil,
        payload: Payload
    ) async throws {
        guard let socket else { throw URLError(.notConnectedToInternet) }
        let envelope = RelayEnvelope(
            type: type,
            protocolVersion: "2",
            messageId: UUID(),
            deviceId: deviceID.uuidString.lowercased(),
            sessionId: sessionId,
            commandId: commandId,
            seq: seq,
            sentAt: RelayDate.now(),
            payload: payload
        )
        let bytes = try JSONEncoder().encode(RelaySocketPacket(data: envelope))
        try await socket.send(.data(bytes))
    }
}

private struct RelayEventSource: Hashable {
    enum Kind: Hashable { case terminal, tool }

    let kind: Kind
    let sequence: UInt64
}

extension RelayToolEvent {
    init(_ event: ToolEvent) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        occurredAt = formatter.string(from: event.occurredAt)
        correlation = RelayToolCorrelation(
            turnId: event.correlation.turnID,
            itemId: event.correlation.itemID,
            approvalId: event.correlation.approvalID
        )
        switch event.payload {
        case .sessionStarted(let reference):
            kind = "warning"
            data = ["code": .string("provider_session_started"), "message": .string(reference.opaqueID)]
        case .turnStarted(let turnID):
            kind = "turn.started"; data = ["turnId": .string(turnID)]
        case .userMessage(let messageID, let text):
            kind = "user.message"
            data = ["messageId": .string(messageID), "text": .string(text)]
        case .assistantTextDelta(let text):
            kind = "assistant.delta"; data = ["text": .string(text)]
        case .assistantMessageCompleted(let text):
            kind = "assistant.completed"; data = ["text": .string(text)]
        case .reasoningDelta(let text):
            kind = "reasoning.delta"; data = ["text": .string(text)]
        case .commandStarted(let commandID, let command):
            kind = "command.started"; data = ["commandId": .string(commandID), "command": .string(command)]
        case .commandOutput(let commandID, let text):
            kind = "command.output"; data = ["commandId": .string(commandID), "text": .string(text)]
        case .commandCompleted(let commandID, let exitCode):
            kind = "command.completed"
            data = ["commandId": .string(commandID), "exitCode": exitCode.map { .number(Double($0)) } ?? .null]
        case .fileChanged(let itemID, let summary):
            kind = "file.changed"; data = ["itemId": .string(itemID), "summary": .string(summary)]
        case .approvalRequested(let request):
            kind = "approval.requested"
            var value: [String: JSONValue] = [
                "approvalId": .string(request.approvalID), "turnId": .string(request.turnID),
                "kind": .string(request.kind), "risk": .string(request.risk.rawValue),
                "title": .string(request.title), "expiresAt": .string(formatter.string(from: request.expiresAt)),
                "availableDecisions": .array(request.availableDecisions.map { .string($0.rawValue) }),
            ]
            if let itemID = request.itemID { value["itemId"] = .string(itemID) }
            if let detail = request.detail { value["detail"] = .string(detail) }
            data = value
        case .approvalResolved(let approvalID, let turnID, let decision):
            kind = "approval.resolved"
            data = ["approvalId": .string(approvalID), "turnId": .string(turnID), "decision": .string(decision.rawValue)]
        case .userInputRequested(let request):
            kind = "user-input.requested"
            let questions = request.questions.map { question in
                JSONValue.object([
                    "id": .string(question.id),
                    "header": .string(question.header),
                    "question": .string(question.question),
                    "options": .array(question.options.map { option in
                        .object(["label": .string(option.label), "description": .string(option.description)])
                    }),
                    "allowsOther": .bool(question.allowsOther),
                    "isSecret": .bool(question.isSecret),
                ])
            }
            var value: [String: JSONValue] = [
                "requestId": .string(request.requestID),
                "turnId": .string(request.turnID),
                "itemId": .string(request.itemID),
                "questions": .array(questions),
                "isBlocking": .bool(request.isBlocking),
            ]
            if let expiresAt = request.expiresAt { value["expiresAt"] = .string(formatter.string(from: expiresAt)) }
            data = value
        case .userInputResolved(let requestID, let turnID, let answers):
            kind = "user-input.resolved"
            data = [
                "requestId": .string(requestID),
                "turnId": .string(turnID),
                "answers": .object(answers.mapValues { .array($0.map(JSONValue.string)) }),
            ]
        case .planUpdated(let text):
            kind = "plan.updated"; data = ["text": .string(text)]
        case .turnCompleted(let turnID, let status):
            kind = "turn.completed"; data = ["turnId": .string(turnID), "status": .string(status.rawValue)]
        case .warning(let code, let message):
            kind = "warning"; data = ["code": .string(code), "message": .string(message)]
        case .failed(let code, let message):
            kind = "error"; data = ["code": .string(code), "message": .string(message)]
        }
    }
}
