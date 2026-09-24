import Foundation
import XCTest
@testable import TermRelay

final class StructuredAgentCoreTests: XCTestCase {
    func testFakeRuntimeCompletesTurnAndApprovalLifecycle() async throws {
        let sessionID = UUID()
        let adapter = FakeAgentAdapter()
        let runtime = try await adapter.makeRuntime(configuration: AgentLaunchConfiguration(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp")
        )) as! FakeAgentRuntime
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        let request = AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp")
        )

        try await coordinator.start(request: request)
        try await coordinator.send(.startTurn(TurnInput(text: "检查项目"), idempotencyKey: UUID()))
        await runtime.emitTurnStarted("turn-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await settle()

        var snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .awaitingApproval)
        XCTAssertEqual(snapshot.pendingApprovalIDs, ["approval-a"])

        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: "approval-a",
            turnID: "turn-a",
            decision: .allowOnce
        )))
        await runtime.emitTurnCompleted("turn-a")
        await settle()

        snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .ready)
        XCTAssertNil(snapshot.activeTurnID)
        let actionCount = await runtime.actions.count
        XCTAssertEqual(actionCount, 2)

        await coordinator.stop()
        await coordinator.stop()
        let stopCount = await runtime.stopCount
        XCTAssertEqual(stopCount, 1)
    }

    func testRejectsApprovalFromAnotherTurn() async throws {
        let sessionID = UUID()
        let runtime = FakeAgentRuntime(sessionID: sessionID)
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(request: AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp")
        ))
        try await coordinator.send(.startTurn(TurnInput(text: "test"), idempotencyKey: UUID()))
        await runtime.emitTurnStarted("turn-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await settle()

        await XCTAssertThrowsErrorAsync {
            try await coordinator.send(.resolveApproval(ApprovalResolution(
                approvalID: "approval-a",
                turnID: "turn-b",
                decision: .allowOnce
            )))
        }
    }

    func testFailedApprovalSubmissionRemainsRetryable() async throws {
        let sessionID = UUID()
        let runtime = FakeAgentRuntime(sessionID: sessionID)
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(request: AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp")
        ))
        try await coordinator.send(.startTurn(TurnInput(text: "test"), idempotencyKey: UUID()))
        await runtime.emitTurnStarted("turn-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await settle()

        await runtime.failNextSend()
        await XCTAssertThrowsErrorAsync {
            try await coordinator.send(.resolveApproval(ApprovalResolution(
                approvalID: "approval-a",
                turnID: "turn-a",
                decision: .allowOnce
            )))
        }
        var snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .awaitingApproval)
        XCTAssertEqual(snapshot.pendingApprovalIDs, ["approval-a"])

        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: "approval-a",
            turnID: "turn-a",
            decision: .cancel
        )))
        snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .running)
        XCTAssertTrue(snapshot.pendingApprovalIDs.isEmpty)
    }

    func testResolvingOneOfTwoApprovalsKeepsSecondApprovalActionable() async throws {
        let sessionID = UUID()
        let runtime = FakeAgentRuntime(sessionID: sessionID)
        let coordinator = StructuredSessionCoordinator(runtime: runtime)
        try await coordinator.start(request: AgentSessionRequest(
            sessionID: sessionID,
            workspaceURL: URL(fileURLWithPath: "/tmp")
        ))
        try await coordinator.send(.startTurn(TurnInput(text: "test"), idempotencyKey: UUID()))
        await runtime.emitTurnStarted("turn-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-b")
        await settle()

        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: "approval-a",
            turnID: "turn-a",
            decision: .allowOnce
        )))
        var snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .awaitingApproval)
        XCTAssertEqual(snapshot.pendingApprovalIDs, ["approval-b"])

        try await coordinator.send(.resolveApproval(ApprovalResolution(
            approvalID: "approval-b",
            turnID: "turn-a",
            decision: .allowOnce
        )))
        snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot.state, .running)
        XCTAssertTrue(snapshot.pendingApprovalIDs.isEmpty)
    }

    func testReasoningChunksWithoutItemIDMergeByTurn() {
        let sessionID = UUID()
        var items: [AgentTimelineItem] = []
        for (sequence, text) in ["正在分析", "项目结构"].enumerated() {
            AgentTimelineProjector.apply(ToolEvent(
                sessionID: sessionID,
                sequence: UInt64(sequence),
                occurredAt: Date(),
                correlation: AgentCorrelation(
                    turnID: "turn-a",
                    itemID: nil,
                    approvalID: nil
                ),
                payload: .reasoningDelta(text: text)
            ), to: &items)
        }

        XCTAssertEqual(items, [.reasoning(id: "turn-a", text: "正在分析项目结构")])
    }

    func testCapabilityIntersectionDoesNotInventSupport() {
        let provider: AgentCapabilities = [.streamingText, .reasoning, .approvals]
        let client: AgentCapabilities = [.streamingText, .approvals, .steering]
        XCTAssertEqual(provider.intersection(client), [.streamingText, .approvals])
    }

    func testLocalSessionAutoApprovesEachApprovalOnlyOnce() async throws {
        let sessionID = UUID()
        let runtime = FakeAgentRuntime(sessionID: sessionID)
        let session = await MainActor.run {
            LocalStructuredAgentSession(
                id: sessionID,
                directory: URL(fileURLWithPath: "/tmp"),
                adapter: FixedRuntimeAdapter(runtime: runtime),
                eventHandler: { _ in },
                stateHandler: { _, _ in }
            )
        }

        await session.start()
        _ = await session.startTurn("test", idempotencyKey: UUID())
        await MainActor.run { session.setAutoApproveEnabled(true) }
        await runtime.emitTurnStarted("turn-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await runtime.emitApproval(turnID: "turn-a", approvalID: "approval-a")
        await settle()

        var approvalCount = await runtime.approvalActionCount()
        XCTAssertEqual(approvalCount, 1)
        await MainActor.run { session.setAutoApproveEnabled(false) }
        await MainActor.run { session.setAutoApproveEnabled(true) }
        await settle()
        approvalCount = await runtime.approvalActionCount()
        XCTAssertEqual(approvalCount, 1)
        await session.stop()
    }

    @MainActor
    func testLocalSessionRestoresLastModelAndEffortPerProvider() async throws {
        let suiteName = "AgentConfiguration-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let firstRuntime = FakeAgentRuntime(sessionID: UUID(), supportsConfiguration: true)
        let first = LocalStructuredAgentSession(
            directory: URL(fileURLWithPath: "/tmp"),
            adapter: FixedRuntimeAdapter(runtime: firstRuntime),
            defaults: defaults,
            eventHandler: { _ in }, stateHandler: { _, _ in }
        )
        await first.start()
        let initialOptions = first.configurationOptions
        XCTAssertEqual(initialOptions.first?.currentValue, "model-a")
        let modelChange = await first.setConfiguration(id: "model", value: "model-b")
        XCTAssertTrue(modelChange.succeeded)
        let effortChange = await first.setConfiguration(id: "effort", value: "high")
        XCTAssertTrue(effortChange.succeeded)
        await first.stop()

        let otherRuntime = FakeAgentRuntime(sessionID: UUID(), supportsConfiguration: true)
        let other = LocalStructuredAgentSession(
            directory: URL(fileURLWithPath: "/tmp"),
            adapter: FixedRuntimeAdapter(providerID: .copilot, runtime: otherRuntime),
            defaults: defaults,
            eventHandler: { _ in }, stateHandler: { _, _ in }
        )
        await other.start()
        let otherOptions = other.configurationOptions
        XCTAssertEqual(otherOptions.first?.currentValue, "model-a")
        await other.stop()

        let secondRuntime = FakeAgentRuntime(sessionID: UUID(), supportsConfiguration: true)
        let second = LocalStructuredAgentSession(
            directory: URL(fileURLWithPath: "/tmp"),
            adapter: FixedRuntimeAdapter(runtime: secondRuntime),
            defaults: defaults,
            eventHandler: { _ in }, stateHandler: { _, _ in }
        )
        await second.start()
        let restored = second.configurationOptions
        XCTAssertEqual(restored.first(where: { $0.id == "model" })?.currentValue, "model-b")
        XCTAssertEqual(restored.first(where: { $0.id == "effort" })?.currentValue, "high")
        let changes = await secondRuntime.configurationChanges()
        XCTAssertEqual(changes, ["model", "effort"])
        await second.stop()
    }

    private func settle() async {
        await Task.yield()
        try? await Task.sleep(for: .milliseconds(10))
    }
}

private struct FakeAgentAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID.fake
    let displayName = "Fake Agent"

    func detect() async throws -> AgentInstallation {
        AgentInstallation(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            version: "1.0",
            supported: true,
            unsupportedReason: nil
        )
    }

    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime {
        FakeAgentRuntime(sessionID: configuration.sessionID)
    }
}

private struct FixedRuntimeAdapter: StructuredAgentAdapter {
    let providerID: AgentProviderID
    let displayName = "Fixed Fake Agent"
    let runtime: FakeAgentRuntime

    init(providerID: AgentProviderID = .fake, runtime: FakeAgentRuntime) {
        self.providerID = providerID
        self.runtime = runtime
    }

    func detect() async throws -> AgentInstallation {
        AgentInstallation(
            executableURL: URL(fileURLWithPath: "/usr/bin/false"),
            version: "1.0",
            supported: true,
            unsupportedReason: nil
        )
    }

    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime {
        runtime
    }
}

private actor FakeAgentRuntime: StructuredAgentRuntime {
    nonisolated let events: AsyncStream<ToolEvent>
    let descriptor = AgentDescriptor(
        providerID: .fake,
        providerVersion: "1.0",
        protocolName: "fake",
        protocolVersion: "2",
        capabilities: [.streamingText, .approvals]
    )
    private let sessionID: UUID
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var sequence: UInt64 = 0
    private(set) var actions: [ToolAction] = []
    private(set) var stopCount = 0
    private var shouldFailNextSend = false
    private let supportsConfiguration: Bool
    private var selectedModel = "model-a"
    private var selectedEffort = "low"
    private var changedConfigurationIDs: [String] = []

    init(sessionID: UUID, supportsConfiguration: Bool = false) {
        self.sessionID = sessionID
        self.supportsConfiguration = supportsConfiguration
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start() async throws {}

    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference {
        AgentSessionReference(providerID: .fake, opaqueID: request.sessionID.uuidString)
    }

    func configurationOptions() throws -> [AgentConfigOption] {
        guard supportsConfiguration else { return [] }
        return [
            AgentConfigOption(id: "model", name: "Model", currentValue: selectedModel, choices: [
                .init(value: "model-a", name: "Model A"), .init(value: "model-b", name: "Model B")
            ]),
            AgentConfigOption(id: "effort", name: "Effort", currentValue: selectedEffort, choices: [
                .init(value: "low", name: "Low"), .init(value: "high", name: "High")
            ])
        ]
    }

    func setConfiguration(id: String, value: String) throws -> [AgentConfigOption] {
        guard try configurationOptions().contains(where: {
            $0.id == id && $0.choices.contains(where: { $0.value == value })
        }) else { throw AgentError.protocolFailure("unsupported configuration") }
        changedConfigurationIDs.append(id)
        if id == "model" {
            selectedModel = value
            selectedEffort = "low"
        } else {
            selectedEffort = value
        }
        return try configurationOptions()
    }

    func configurationChanges() -> [String] { changedConfigurationIDs }

    func send(_ action: ToolAction) async throws {
        if shouldFailNextSend {
            shouldFailNextSend = false
            throw AgentError.protocolFailure("simulated approval transport failure")
        }
        actions.append(action)
    }

    func failNextSend() {
        shouldFailNextSend = true
    }

    func approvalActionCount() -> Int {
        actions.reduce(into: 0) { count, action in
            if case .resolveApproval = action { count += 1 }
        }
    }

    func stop() async {
        stopCount += 1
        continuation.finish()
    }

    func emitTurnStarted(_ turnID: String) {
        emit(.turnStarted(turnID: turnID), turnID: turnID)
    }

    func emitApproval(turnID: String, approvalID: String) {
        emit(.approvalRequested(ApprovalRequest(
            approvalID: approvalID,
            turnID: turnID,
            itemID: "item-a",
            kind: "command",
            risk: .high,
            title: "运行命令",
            detail: "echo test",
            availableDecisions: [.allowOnce, .allowSession, .deny, .cancel],
            expiresAt: Date().addingTimeInterval(60)
        )), turnID: turnID, approvalID: approvalID)
    }

    func emitTurnCompleted(_ turnID: String) {
        emit(.turnCompleted(turnID: turnID, status: .completed), turnID: turnID)
    }

    private func emit(
        _ payload: ToolEventPayload,
        turnID: String? = nil,
        approvalID: String? = nil
    ) {
        continuation.yield(ToolEvent(
            sessionID: sessionID,
            sequence: sequence,
            occurredAt: Date(),
            correlation: AgentCorrelation(
                turnID: turnID,
                itemID: nil,
                approvalID: approvalID
            ),
            payload: payload
        ))
        sequence += 1
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    file: StaticString = #filePath,
    line: UInt = #line
) async {
    do {
        try await expression()
        XCTFail("Expected expression to throw", file: file, line: line)
    } catch {}
}
