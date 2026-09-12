import Foundation

actor RemoteClient {
    typealias StateHandler = @Sendable (ConnectionState, String?) -> Void
    typealias CommandHandler = @Sendable (RemoteTerminalCommand) async -> RemoteCommandResult

    private let deviceID: UUID
    private let stateHandler: StateHandler
    private let commandHandler: CommandHandler
    private var serverURL: URL?
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
    private var pendingEvents: [UUID: [PendingSessionEvent]] = [:]
    private var nextSequenceBySession: [UUID: UInt64] = [:]
    private var relaySequenceBySource: [UUID: [RelayEventSource: UInt64]] = [:]
    private var pendingOutputBytes = 0
    private let maximumPendingOutputBytes = 16 * 1_024 * 1_024

    init(
        deviceID: UUID,
        stateHandler: @escaping StateHandler,
        commandHandler: @escaping CommandHandler
    ) {
        self.deviceID = deviceID
        self.stateHandler = stateHandler
        self.commandHandler = commandHandler
    }

    func connect(to value: String) {
        guard let url = URL(string: value), ["ws", "wss"].contains(url.scheme?.lowercased()) else {
            stateHandler(.offline, "Server URL 必须使用 ws:// 或 wss://")
            return
        }
        disconnect()
        serverURL = url
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
        heartbeatTask?.cancel()
        heartbeatTask = nil
        runTask?.cancel()
        runTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
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
        runtimeMode: SessionRuntimeMode = .terminal,
        webDisplayMode: AgentWebDisplayMode? = nil,
        startedAt: String
    ) async {
        if nextSequenceBySession[id] == nil { nextSequenceBySession[id] = 1 }
        let sent = await send(
            type: "session.started",
            sessionId: id.uuidString.lowercased(),
            seq: 0,
            payload: RelaySessionStarted(
                workspaceId: workspaceId,
                toolKey: toolKey,
                displayName: displayName,
                runtimeMode: runtimeMode.rawValue,
                webDisplayMode: webDisplayMode?.rawValue,
                startedAt: startedAt
            )
        )
        guard sent else { return }
        announcedSessions.insert(id)
        await flushPendingEvents(sessionId: id)
        if let pendingEnd = pendingSessionEnds.removeValue(forKey: id) {
            await sendSessionEnded(id: id, payload: pendingEnd)
        }
    }

    func publishSessionEnded(id: UUID, status: SessionState, finishedAt: String) async {
        guard status == .finished || status == .failed else { return }
        guard endedSessions.insert(id).inserted else { return }
        let payload = RelaySessionEnded(
            status: status == .failed ? "failed" : "finished",
            finishedAt: finishedAt
        )
        guard registered, announcedSessions.contains(id) else {
            pendingSessionEnds[id] = payload
            return
        }
        await sendSessionEnded(id: id, payload: payload)
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
        let pending = PendingSessionEvent.terminal(sequenced)
        guard registered, announcedSessions.contains(sequenced.sessionID) else {
            enqueue(pending)
            return
        }
        if !(await send(pending)) { enqueue(pending) }
    }

    func publishToolEvent(_ event: ToolEvent) async {
        // Provider session startup is represented by session.started. All other
        // providers share one relay sequence with terminal output for this session.
        if case .sessionStarted = event.payload { return }
        let sequence = relaySequence(
            for: RelayEventSource(kind: .tool, sequence: event.sequence),
            sessionID: event.sessionID
        )
        let pending = PendingSessionEvent.tool(sequence: sequence, event: event)
        guard registered, announcedSessions.contains(event.sessionID) else {
            enqueue(pending)
            return
        }
        if !(await send(pending)) { enqueue(pending) }
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
            let task = URLSession.shared.webSocketTask(with: serverURL)
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
            guard packet.event == "message", packet.data.protocolVersion == "1" else { continue }
            await handle(packet.data)
        }
    }

    private func handle(_ envelope: IncomingRelayEnvelope) async {
        guard envelope.deviceId.caseInsensitiveCompare(deviceID.uuidString) == .orderedSame else { return }
        if envelope.type == "device.registered" {
            registered = true
            if let interval = envelope.payload.object?["heartbeatIntervalMs"]?.integer {
                heartbeatIntervalMs = max(1_000, interval)
            }
            startHeartbeat()
            stateHandler(.connected, nil)
            return
        }
        if envelope.type == "protocol.error" {
            let message = envelope.payload.object?["message"]?.string ?? "Server 拒绝了消息"
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

    private func enqueue(_ event: PendingSessionEvent) {
        var sessionEvents = pendingEvents[event.sessionID] ?? []
        if sessionEvents.contains(where: { $0.sequence == event.sequence }) { return }
        sessionEvents.append(event)
        sessionEvents.sort { $0.sequence < $1.sequence }
        pendingEvents[event.sessionID] = sessionEvents
        pendingOutputBytes += event.byteCount

        while pendingOutputBytes > maximumPendingOutputBytes {
            guard
                let oldestSession = pendingEvents.min(by: {
                    ($0.value.first?.occurredAt ?? .distantFuture) <
                        ($1.value.first?.occurredAt ?? .distantFuture)
                })?.key,
                var events = pendingEvents[oldestSession],
                !events.isEmpty
            else { break }
            let removed = events.removeFirst()
            pendingOutputBytes -= removed.byteCount
            pendingEvents[oldestSession] = events.isEmpty ? nil : events
            stateHandler(.degraded, "离线事件缓存已满，最旧的会话数据被丢弃。")
        }
    }

    private func flushPendingEvents(sessionId: UUID) async {
        guard var events = pendingEvents[sessionId] else { return }
        pendingEvents[sessionId] = nil
        pendingOutputBytes -= events.reduce(0) { $0 + $1.byteCount }
        for (index, event) in events.enumerated() {
            let sent = await send(event)
            if sent { continue }
            for remaining in events[index...] { enqueue(remaining) }
            return
        }
        events.removeAll()
    }

    private func send(_ event: PendingSessionEvent) async -> Bool {
        switch event {
        case .terminal(let batch):
            await send(
                type: "terminal.output",
                sessionId: batch.sessionID.uuidString.lowercased(),
                seq: batch.sequence,
                payload: RelayTerminalOutput(data: batch.bytes.base64EncodedString())
            )
        case .tool(let sequence, let event):
            await send(
                type: "tool.event",
                sessionId: event.sessionID.uuidString.lowercased(),
                seq: sequence,
                payload: RelayToolEvent(event)
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
            protocolVersion: "1",
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

private enum PendingSessionEvent {
    case terminal(TerminalOutputBatch)
    case tool(sequence: UInt64, event: ToolEvent)

    var sessionID: UUID {
        switch self {
        case .terminal(let batch): batch.sessionID
        case .tool(_, let event): event.sessionID
        }
    }

    var sequence: UInt64 {
        switch self {
        case .terminal(let batch): batch.sequence
        case .tool(let sequence, _): sequence
        }
    }

    var occurredAt: Date {
        switch self {
        case .terminal(let batch): batch.capturedAt
        case .tool(_, let event): event.occurredAt
        }
    }

    var byteCount: Int {
        switch self {
        case .terminal(let batch): batch.bytes.count
        case .tool: 1_024
        }
    }
}

private extension RelayToolEvent {
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
        case .assistantTextDelta(let text):
            kind = "assistant.delta"; data = ["text": .string(text)]
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
            ]
            if let itemID = request.itemID { value["itemId"] = .string(itemID) }
            if let detail = request.detail { value["detail"] = .string(detail) }
            data = value
        case .approvalResolved(let approvalID, let turnID, let decision):
            kind = "approval.resolved"
            data = ["approvalId": .string(approvalID), "turnId": .string(turnID), "decision": .string(decision.rawValue)]
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
