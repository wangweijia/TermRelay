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
    private var lastSequence: UInt64?
    private var stopped = false

    init(runtime: any StructuredAgentRuntime) {
        self.runtime = runtime
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start(request: AgentSessionRequest) async throws {
        guard state == .created else {
            throw AgentError.invalidState(expected: "created", actual: state)
        }
        state = .starting
        sessionID = request.sessionID
        do {
            try await runtime.start()
            beginConsumingEvents()
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
            guard state == .running || state == .awaitingApproval else {
                throw AgentError.invalidState(expected: "running/awaitingApproval", actual: state)
            }
            state = .interrupting
        case .resolveApproval(let resolution):
            guard state == .awaitingApproval,
                  let approval = pendingApprovals[resolution.approvalID],
                  approval.turnID == resolution.turnID,
                  activeTurnID == resolution.turnID else {
                throw AgentError.correlationMismatch("approval、turn 或 session 不一致")
            }
            guard approval.expiresAt > Date() else {
                pendingApprovals.removeValue(forKey: resolution.approvalID)
                throw AgentError.approvalExpired(resolution.approvalID)
            }
            pendingApprovals.removeValue(forKey: resolution.approvalID)
            state = .running
        }

        do {
            try await runtime.send(action)
        } catch {
            state = .degraded
            throw error
        }
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        consumeTask?.cancel()
        consumeTask = nil
        pendingApprovals.removeAll()
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
