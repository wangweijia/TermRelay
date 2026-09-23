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
    func send(_ action: ToolAction) async throws
    func configurationOptions() async throws -> [AgentConfigOption]
    func setConfiguration(id: String, value: String) async throws -> [AgentConfigOption]
    func publishConfiguration(_ options: [AgentConfigOption]) async
    func stop() async
}

struct AgentConfigOption: Sendable, Equatable {
    struct Choice: Sendable, Equatable {
        let value: String
        let name: String
    }

    let id: String
    let name: String
    let currentValue: String
    let choices: [Choice]
}

extension StructuredAgentRuntime {
    func configurationOptions() async throws -> [AgentConfigOption] { [] }

    func setConfiguration(id: String, value: String) async throws -> [AgentConfigOption] {
        throw AgentError.unsupportedCapability("session configuration")
    }

    func publishConfiguration(_ options: [AgentConfigOption]) async {}
}
