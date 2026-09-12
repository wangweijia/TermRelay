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

    func testCapabilityIntersectionDoesNotInventSupport() {
        let provider: AgentCapabilities = [.streamingText, .reasoning, .approvals]
        let client: AgentCapabilities = [.streamingText, .approvals, .steering]
        XCTAssertEqual(provider.intersection(client), [.streamingText, .approvals])
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

private actor FakeAgentRuntime: StructuredAgentRuntime {
    nonisolated let events: AsyncStream<ToolEvent>
    let descriptor = AgentDescriptor(
        providerID: .fake,
        providerVersion: "1.0",
        protocolName: "fake",
        protocolVersion: "1",
        capabilities: [.streamingText, .approvals]
    )
    private let sessionID: UUID
    private let continuation: AsyncStream<ToolEvent>.Continuation
    private var sequence: UInt64 = 0
    private(set) var actions: [ToolAction] = []
    private(set) var stopCount = 0

    init(sessionID: UUID) {
        self.sessionID = sessionID
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }

    func start() async throws {}

    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference {
        AgentSessionReference(providerID: .fake, opaqueID: request.sessionID.uuidString)
    }

    func resumeSession(_ reference: AgentSessionReference) async throws {}

    func send(_ action: ToolAction) async throws {
        actions.append(action)
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
