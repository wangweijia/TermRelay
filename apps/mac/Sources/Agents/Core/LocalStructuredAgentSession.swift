import Foundation

@MainActor
final class LocalStructuredAgentSession: ObservableObject, Identifiable {
    let id: UUID
    let directory: URL
    let startedAt: String
    let webDisplayMode: AgentWebDisplayMode
    @Published private(set) var state: StructuredSessionState = .created
    @Published private(set) var events: [ToolEvent] = []

    private let adapter: any StructuredAgentAdapter
    private let environment: [String: String]
    private let eventHandler: @Sendable (ToolEvent) -> Void
    private let stateHandler: @MainActor (UUID, StructuredSessionState) -> Void
    private var coordinator: StructuredSessionCoordinator?
    private var eventTask: Task<Void, Never>?

    init(
        id: UUID = UUID(),
        directory: URL,
        adapter: any StructuredAgentAdapter,
        webDisplayMode: AgentWebDisplayMode = .full,
        environment: [String: String] = TerminalEnvironment.make(),
        eventHandler: @escaping @Sendable (ToolEvent) -> Void,
        stateHandler: @escaping @MainActor (UUID, StructuredSessionState) -> Void
    ) {
        self.id = id
        self.directory = directory
        self.adapter = adapter
        self.webDisplayMode = webDisplayMode
        self.environment = environment
        self.eventHandler = eventHandler
        self.stateHandler = stateHandler
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
                    self.eventHandler(event)
                    await self.refreshState()
                }
            }
            try await coordinator.start(request: AgentSessionRequest(
                sessionID: id,
                workspaceURL: directory
            ))
            await refreshState()
        } catch {
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

    func stop() async {
        eventTask?.cancel()
        eventTask = nil
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
}
