import Foundation

actor StructuredSessionCoordinator {
    nonisolated let events: AsyncStream<ToolEvent>

    private let runtime: any StructuredAgentRuntime
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var consumeTask: Task<Void, Never>?
    private(set) var state: StructuredSessionState = .created
    private(set) var reference: AgentSessionReference?
    private(set) var activeTurnID: String?
    private var sessionID: UUID?
    private var pendingApprovals: [String: ApprovalRequest] = [:]
    private var resolvingApprovalIDs: Set<String> = []
    private var pendingUserInputs: [String: UserInputRequest] = [:]
    private var lastSequence: UInt64?
    private var stopped = false

    init(runtime: any StructuredAgentRuntime) {
        self.runtime = runtime
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start(
        request: AgentSessionRequest,
        afterRuntimeStart: @MainActor @Sendable () throws -> Void = {}
    ) async throws {
        guard state == .created else {
            throw AgentError.invalidState(expected: "created", actual: state)
        }
        state = .starting
        sessionID = request.sessionID
        do {
            try await runtime.start()
            beginConsumingEvents()
            try await afterRuntimeStart()
            reference = try await runtime.createSession(request)
            state = .ready
        } catch {
            state = .failed
            await runtime.stop()
            throw error
        }
    }

    func send(_ action: ToolAction) async throws {
        switch action {
        case .startTurn:
            guard state == .ready else {
                throw AgentError.invalidState(expected: "ready", actual: state)
            }
            state = .running
        case .steer:
            guard state == .running else {
                throw AgentError.invalidState(expected: "running", actual: state)
            }
            guard await runtime.descriptor.capabilities.contains(.steering) else {
                throw AgentError.unsupportedCapability("steering")
            }
        case .interrupt:
            guard state == .running || state == .awaitingApproval || state == .awaitingUserInput else {
                throw AgentError.invalidState(expected: "running/awaitingApproval/awaitingUserInput", actual: state)
            }
            state = .interrupting
        case .resolveApproval(let resolution):
            guard state == .awaitingApproval,
                  let approval = pendingApprovals[resolution.approvalID],
                  approval.turnID == resolution.turnID,
                  activeTurnID == resolution.turnID else {
                throw AgentError.correlationMismatch("approval、turn 或 session 不一致")
            }
            guard !resolvingApprovalIDs.contains(resolution.approvalID) else {
                throw AgentError.invalidState(expected: "approval awaiting response", actual: state)
            }
            guard approval.expiresAt > Date() else {
                throw AgentError.approvalExpired(resolution.approvalID)
            }
            resolvingApprovalIDs.insert(resolution.approvalID)
            do {
                try await runtime.send(action)
            } catch {
                resolvingApprovalIDs.remove(resolution.approvalID)
                throw error
            }
            resolvingApprovalIDs.remove(resolution.approvalID)
            if pendingApprovals.removeValue(forKey: resolution.approvalID) != nil,
               activeTurnID == resolution.turnID {
                state = pendingApprovals.isEmpty ? .running : .awaitingApproval
            }
            return
        case .resolveUserInput(let resolution):
            guard state == .awaitingUserInput || state == .running,
                  let request = pendingUserInputs[resolution.requestID],
                  request.turnID == resolution.turnID,
                  activeTurnID == resolution.turnID else {
                throw AgentError.correlationMismatch("用户问题、turn 或 session 不一致")
            }
            pendingUserInputs.removeValue(forKey: resolution.requestID)
            if state == .awaitingUserInput { state = .running }
        }

        do {
            try await runtime.send(action)
        } catch {
            state = .degraded
            throw error
        }
    }

    func configurationOptions() async throws -> [AgentConfigOption] {
        guard state == .ready else { return [] }
        return try await runtime.configurationOptions()
    }

    func setConfiguration(id: String, value: String) async throws -> [AgentConfigOption] {
        guard state == .ready else {
            throw AgentError.invalidState(expected: "ready", actual: state)
        }
        return try await runtime.setConfiguration(id: id, value: value)
    }

    func publishConfiguration(_ options: [AgentConfigOption]) async {
        await runtime.publishConfiguration(options)
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        consumeTask?.cancel()
        consumeTask = nil
        pendingApprovals.removeAll()
        resolvingApprovalIDs.removeAll()
        pendingUserInputs.removeAll()
        await runtime.stop()
        if state != .failed { state = .finished }
        continuation.finish()
    }

    func snapshot() -> (
        state: StructuredSessionState,
        reference: AgentSessionReference?,
        activeTurnID: String?,
        pendingApprovalIDs: [String]
    ) {
        (state, reference, activeTurnID, pendingApprovals.keys.sorted())
    }

    private func beginConsumingEvents() {
        let runtimeEvents = runtime.events
        consumeTask = Task { [weak self] in
            for await event in runtimeEvents {
                guard !Task.isCancelled else { return }
                await self?.receive(event)
            }
        }
    }

    private func receive(_ event: ToolEvent) {
        guard event.sessionID == sessionID else {
            state = .degraded
            continuation.yield(diagnosticEvent(
                after: event,
                error: .correlationMismatch("事件不属于当前 session")
            ))
            return
        }
        let expected = lastSequence.map { $0 + 1 } ?? 0
        guard event.sequence == expected else {
            state = .degraded
            continuation.yield(diagnosticEvent(
                after: event,
                error: .invalidEventSequence(expected: expected, actual: event.sequence)
            ))
            return
        }
        lastSequence = event.sequence

        switch event.payload {
        case .turnStarted(let turnID):
            activeTurnID = turnID
            state = .running
        case .approvalRequested(let approval):
            guard approval.turnID == activeTurnID else {
                state = .degraded
                continuation.yield(diagnosticEvent(
                    after: event,
                    error: .correlationMismatch("审批不属于当前 turn")
                ))
                return
            }
            pendingApprovals[approval.approvalID] = approval
            state = .awaitingApproval
        case .userInputRequested(let request):
            guard request.turnID == activeTurnID else {
                state = .degraded
                continuation.yield(diagnosticEvent(
                    after: event,
                    error: .correlationMismatch("用户问题不属于当前 turn")
                ))
                return
            }
            pendingUserInputs[request.requestID] = request
            if request.isBlocking { state = .awaitingUserInput }
        case .turnCompleted(let turnID, _):
            guard activeTurnID == nil || activeTurnID == turnID else {
                state = .degraded
                continuation.yield(diagnosticEvent(
                    after: event,
                    error: .correlationMismatch("完成事件不属于当前 turn")
                ))
                return
            }
            activeTurnID = nil
            pendingApprovals.removeAll()
            resolvingApprovalIDs.removeAll()
            pendingUserInputs.removeAll()
            state = .ready
        case .failed:
            state = .failed
        default:
            break
        }
        continuation.yield(event)
    }

    private func diagnosticEvent(after event: ToolEvent, error: AgentError) -> ToolEvent {
        ToolEvent(
            sessionID: event.sessionID,
            sequence: event.sequence,
            occurredAt: Date(),
            correlation: event.correlation,
            payload: .failed(code: "agent_core", message: error.localizedDescription)
        )
    }
}
