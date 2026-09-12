import Foundation

struct AgentProviderID: RawRepresentable, Hashable, Codable, Sendable {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    static let codex = Self(rawValue: "codex")
    static let fake = Self(rawValue: "fake")
}

struct AgentCapabilities: OptionSet, Codable, Sendable {
    let rawValue: UInt64

    static let streamingText = Self(rawValue: 1 << 0)
    static let reasoning = Self(rawValue: 1 << 1)
    static let commandExecution = Self(rawValue: 1 << 2)
    static let commandOutput = Self(rawValue: 1 << 3)
    static let fileChanges = Self(rawValue: 1 << 4)
    static let approvals = Self(rawValue: 1 << 5)
    static let plans = Self(rawValue: 1 << 6)
    static let steering = Self(rawValue: 1 << 7)
    static let sessionResume = Self(rawValue: 1 << 8)
    static let sessionFork = Self(rawValue: 1 << 9)
    static let images = Self(rawValue: 1 << 10)
    static let subagents = Self(rawValue: 1 << 11)
    static let usage = Self(rawValue: 1 << 12)
}

struct AgentInstallation: Sendable, Equatable {
    let executableURL: URL
    let version: String
    let supported: Bool
    let unsupportedReason: String?
}

struct AgentDescriptor: Sendable, Equatable {
    let providerID: AgentProviderID
    let providerVersion: String
    let protocolName: String
    let protocolVersion: String?
    let capabilities: AgentCapabilities
}

struct AgentLaunchConfiguration: Sendable {
    let sessionID: UUID
    let workspaceURL: URL
    let ephemeral: Bool
    let environment: [String: String]

    init(
        sessionID: UUID,
        workspaceURL: URL,
        ephemeral: Bool = false,
        environment: [String: String] = TerminalEnvironment.make()
    ) {
        self.sessionID = sessionID
        self.workspaceURL = workspaceURL
        self.ephemeral = ephemeral
        self.environment = environment
    }
}

struct AgentSessionRequest: Sendable {
    let sessionID: UUID
    let workspaceURL: URL
    let ephemeral: Bool

    init(sessionID: UUID, workspaceURL: URL, ephemeral: Bool = false) {
        self.sessionID = sessionID
        self.workspaceURL = workspaceURL
        self.ephemeral = ephemeral
    }
}

struct AgentSessionReference: Codable, Sendable, Equatable {
    let providerID: AgentProviderID
    let opaqueID: String
}

struct TurnInput: Sendable, Equatable {
    let text: String
}

enum ApprovalDecision: String, Codable, Sendable {
    case allowOnce
    case deny
}

struct ApprovalResolution: Sendable, Equatable {
    let approvalID: String
    let turnID: String
    let decision: ApprovalDecision
}

enum ToolAction: Sendable, Equatable {
    case startTurn(TurnInput, idempotencyKey: UUID)
    case steer(TurnInput)
    case interrupt
    case resolveApproval(ApprovalResolution)
}

struct AgentCorrelation: Sendable, Equatable {
    let turnID: String?
    let itemID: String?
    let approvalID: String?
}

enum ApprovalRisk: String, Codable, Sendable {
    case low
    case medium
    case high
    case critical
}

struct ApprovalRequest: Sendable, Equatable {
    let approvalID: String
    let turnID: String
    let itemID: String?
    let kind: String
    let risk: ApprovalRisk
    let title: String
    let detail: String?
    let expiresAt: Date
}

enum TurnCompletionStatus: String, Codable, Sendable {
    case completed
    case interrupted
    case failed
}

enum ToolEventPayload: Sendable, Equatable {
    case sessionStarted(reference: AgentSessionReference)
    case turnStarted(turnID: String)
    case assistantTextDelta(text: String)
    case reasoningDelta(text: String)
    case commandStarted(commandID: String, command: String)
    case commandOutput(commandID: String, text: String)
    case commandCompleted(commandID: String, exitCode: Int?)
    case fileChanged(itemID: String, summary: String)
    case approvalRequested(ApprovalRequest)
    case approvalResolved(approvalID: String, turnID: String, decision: ApprovalDecision)
    case planUpdated(text: String)
    case turnCompleted(turnID: String, status: TurnCompletionStatus)
    case warning(code: String, message: String)
    case failed(code: String, message: String)
}

struct ToolEvent: Sendable, Equatable {
    let sessionID: UUID
    let sequence: UInt64
    let occurredAt: Date
    let correlation: AgentCorrelation
    let payload: ToolEventPayload
}

enum StructuredSessionState: String, Codable, Sendable {
    case created
    case starting
    case ready
    case running
    case awaitingApproval
    case interrupting
    case degraded
    case finished
    case failed
}

enum AgentError: LocalizedError, Equatable {
    case invalidState(expected: String, actual: StructuredSessionState)
    case unsupportedCapability(String)
    case invalidEventSequence(expected: UInt64, actual: UInt64)
    case correlationMismatch(String)
    case approvalExpired(String)
    case providerUnavailable(String)
    case protocolFailure(String)

    var errorDescription: String? {
        switch self {
        case .invalidState(let expected, let actual):
            "Agent 状态错误：需要 \(expected)，当前为 \(actual.rawValue)。"
        case .unsupportedCapability(let capability):
            "Agent 不支持能力：\(capability)。"
        case .invalidEventSequence(let expected, let actual):
            "Agent 事件序号错误：需要 \(expected)，收到 \(actual)。"
        case .correlationMismatch(let detail):
            "Agent 事件关联不匹配：\(detail)。"
        case .approvalExpired(let approvalID):
            "Agent 审批已过期：\(approvalID)。"
        case .providerUnavailable(let detail):
            "Agent Provider 不可用：\(detail)。"
        case .protocolFailure(let detail):
            "Agent 协议错误：\(detail)。"
        }
    }
}
