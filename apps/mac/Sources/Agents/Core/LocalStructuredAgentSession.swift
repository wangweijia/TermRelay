import Foundation

@MainActor
final class LocalStructuredAgentSession: ObservableObject, Identifiable {
    private static let maximumRetainedEvents = 2_000
    private static let eventTrimThreshold = 2_200
    private static let maximumTimelineItems = 500

    let id: UUID
    let directory: URL
    let startedAt: String
    @Published private(set) var state: StructuredSessionState = .created
    private(set) var events: [ToolEvent] = []
    @Published private(set) var timeline: [AgentTimelineItem] = []
    @Published private(set) var failureMessage: String?
    @Published private(set) var autoApproveEnabled = false

    private let adapter: any StructuredAgentAdapter
    private let environment: [String: String]
    private let eventHandler: @Sendable (ToolEvent) -> Void
    private let stateHandler: @MainActor (UUID, StructuredSessionState) -> Void
    private let runtimeReadyHandler: @MainActor @Sendable () throws -> Void
    private var coordinator: StructuredSessionCoordinator?
    private var eventTask: Task<Void, Never>?
    private var timelineFlushTask: Task<Void, Never>?
    private var pendingTimelineEvents: [ToolEvent] = []
    private var autoApprovalAttemptedIDs = Set<String>()

    init(
        id: UUID = UUID(),
        directory: URL,
        adapter: any StructuredAgentAdapter,
        environment: [String: String] = TerminalEnvironment.make(),
        eventHandler: @escaping @Sendable (ToolEvent) -> Void,
        stateHandler: @escaping @MainActor (UUID, StructuredSessionState) -> Void,
        runtimeReadyHandler: @escaping @MainActor @Sendable () throws -> Void = {}
    ) {
        self.id = id
        self.directory = directory
        self.adapter = adapter
        self.environment = environment
        self.eventHandler = eventHandler
        self.stateHandler = stateHandler
        self.runtimeReadyHandler = runtimeReadyHandler
        startedAt = RelayDate.now()
    }

    func start() async {
        guard state == .created else { return }
        setState(.starting)
        do {
            let runtime = try await adapter.makeRuntime(configuration: AgentLaunchConfiguration(
                sessionID: id,
                workspaceURL: directory,
                environment: environment
            ))
            let coordinator = StructuredSessionCoordinator(runtime: runtime)
            self.coordinator = coordinator
            let stream = coordinator.events
            eventTask = Task { [weak self] in
                for await event in stream {
                    guard !Task.isCancelled, let self else { return }
                    self.events.append(event)
                    if self.events.count > Self.eventTrimThreshold {
                        self.events.removeFirst(self.events.count - Self.maximumRetainedEvents)
                    }
                    self.eventHandler(event)
                    self.scheduleAutoApproval(for: event)
                    self.enqueueTimelineEvent(event)
                }
            }
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: id,
                workspaceURL: directory
            ), afterRuntimeStart: runtimeReadyHandler)
            await refreshState()
        } catch {
            failureMessage = error.localizedDescription
            eventTask?.cancel()
            eventTask = nil
            timelineFlushTask?.cancel()
            timelineFlushTask = nil
            await coordinator?.stop()
            coordinator = nil
            setState(.failed)
        }
    }

    func startTurn(_ text: String, idempotencyKey: UUID) async -> RemoteCommandResult {
        await send(.startTurn(TurnInput(text: text), idempotencyKey: idempotencyKey))
    }

    func interrupt() async -> RemoteCommandResult { await send(.interrupt) }

    func resolveApproval(
        approvalID: String,
        turnID: String,
        decision: ApprovalDecision
    ) async -> RemoteCommandResult {
        await send(.resolveApproval(ApprovalResolution(
            approvalID: approvalID,
            turnID: turnID,
            decision: decision
        )))
    }

    func resolveUserInput(
        requestID: String,
        turnID: String,
        answers: [String: [String]]
    ) async -> RemoteCommandResult {
        await send(.resolveUserInput(UserInputResolution(
            requestID: requestID,
            turnID: turnID,
            answers: answers
        )))
    }

    func setAutoApproveEnabled(_ enabled: Bool) {
        guard autoApproveEnabled != enabled else { return }
        autoApproveEnabled = enabled
        if enabled { schedulePendingAutoApprovals() }
    }

    func stop() async {
        eventTask?.cancel()
        eventTask = nil
        timelineFlushTask?.cancel()
        timelineFlushTask = nil
        flushTimelineEvents()
        await coordinator?.stop()
        coordinator = nil
        setState(.finished)
    }

    private func send(_ action: ToolAction) async -> RemoteCommandResult {
        guard let coordinator else {
            return .rejected("agent_not_ready", "The structured Agent is not ready.")
        }
        do {
            try await coordinator.send(action)
            await refreshState()
            return .completed
        } catch {
            await refreshState()
            return .rejected("agent_action_failed", error.localizedDescription)
        }
    }

    private func refreshState() async {
        guard let coordinator else { return }
        let snapshot = await coordinator.snapshot()
        setState(snapshot.state)
    }

    private func setState(_ value: StructuredSessionState) {
        guard state != value else { return }
        state = value
        stateHandler(id, value)
    }

    private func enqueueTimelineEvent(_ event: ToolEvent) {
        pendingTimelineEvents.append(event)
        guard timelineFlushTask == nil else { return }
        timelineFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(33))
            guard !Task.isCancelled, let self else { return }
            self.timelineFlushTask = nil
            self.flushTimelineEvents()
            await self.refreshState()
        }
    }

    private func scheduleAutoApproval(for event: ToolEvent) {
        guard autoApproveEnabled,
              case .approvalRequested(let request) = event.payload else { return }
        scheduleAutoApproval(request)
    }

    private func schedulePendingAutoApprovals() {
        var pending: [String: ApprovalRequest] = [:]
        for event in events {
            switch event.payload {
            case .approvalRequested(let request):
                pending[request.approvalID] = request
            case .approvalResolved(let approvalID, _, _):
                pending.removeValue(forKey: approvalID)
            default:
                break
            }
        }
        for request in pending.values { scheduleAutoApproval(request) }
    }

    private func scheduleAutoApproval(_ request: ApprovalRequest) {
        guard autoApprovalAttemptedIDs.insert(request.approvalID).inserted else { return }
        Task { [weak self] in
            _ = await self?.resolveApproval(
                approvalID: request.approvalID,
                turnID: request.turnID,
                decision: .allowOnce
            )
        }
    }

    private func flushTimelineEvents() {
        guard !pendingTimelineEvents.isEmpty else { return }
        var projected = timeline
        for event in pendingTimelineEvents {
            AgentTimelineProjector.apply(event, to: &projected)
        }
        pendingTimelineEvents.removeAll(keepingCapacity: true)
        timeline = Self.trimTimeline(projected)
    }

    private static func trimTimeline(_ items: [AgentTimelineItem]) -> [AgentTimelineItem] {
        var removeCount = max(0, items.count - maximumTimelineItems)
        guard removeCount > 0 else { return items }
        return items.filter { item in
            if removeCount > 0 && !item.requiresUserAction {
                removeCount -= 1
                return false
            }
            return true
        }
    }
}

private extension AgentTimelineItem {
    var requiresUserAction: Bool {
        switch self {
        case .approval(let value): value.decision == nil
        case .userInput(let value): value.answers == nil
        default: false
        }
    }
}
