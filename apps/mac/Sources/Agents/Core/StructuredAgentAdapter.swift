import Foundation

protocol StructuredAgentAdapter: Sendable {
    var providerID: AgentProviderID { get }
    var displayName: String { get }

    func detect() async throws -> AgentInstallation
    func makeRuntime(
        configuration: AgentLaunchConfiguration
    ) async throws -> any StructuredAgentRuntime
}

protocol StructuredAgentRuntime: Actor {
    var descriptor: AgentDescriptor { get }
    nonisolated var events: AsyncStream<ToolEvent> { get }

    func start() async throws
    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference
    func resumeSession(_ reference: AgentSessionReference) async throws
    func send(_ action: ToolAction) async throws
    func stop() async
}
