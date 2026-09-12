// Generated-file boundary. Replace this bootstrap with schema code generation.
import Foundation

public struct Envelope<Payload: Codable & Sendable>: Codable, Sendable {
    public let type: String
    public let protocolVersion: String
    public let messageId: UUID
    public let deviceId: String
    public let sessionId: String?
    public let commandId: UUID?
    public let seq: UInt64?
    public let sentAt: Date
    public let payload: Payload
}

public struct DeviceRegisterPayload: Codable, Sendable {
    public let name: String
    public let appVersion: String
    public let platform: String
    public let tools: [String]
}

public struct DeviceRegisteredPayload: Codable, Sendable {
    public let registeredAt: String
    public let heartbeatIntervalMs: Int
    public let heartbeatTimeoutMs: Int
}

public struct DeviceHeartbeatPayload: Codable, Sendable {
    public let connectionState: String
    public let activeSessionCount: Int?
}

public struct WorkspaceRegisteredPayload: Codable, Sendable {
    public let workspaceId: String
    public let displayName: String
    public let available: Bool
    public let remoteStartAllowed: Bool
}

public enum SessionRuntimeMode: String, Codable, Sendable {
    case terminal
    case structured
}

public struct SessionStartedPayload: Codable, Sendable {
    public let workspaceId: String
    public let toolKey: String
    public let displayName: String?
    public let runtimeMode: SessionRuntimeMode
    public let webDisplayMode: String?
    public let startedAt: String
}

public enum SessionEndedStatus: String, Codable, Sendable {
    case finished
    case failed
}

public struct SessionEndedPayload: Codable, Sendable {
    public let status: SessionEndedStatus
    public let finishedAt: String
}

public struct TerminalOutputPayload: Codable, Sendable {
    public let encoding: String
    public let data: String
}

public struct TerminalInputPayload: Codable, Sendable {
    public let encoding: String
    public let data: String
}

public struct TerminalResizePayload: Codable, Sendable {
    public let columns: Int
    public let rows: Int
}

public struct SessionInterruptPayload: Codable, Sendable {}
public struct SessionStopPayload: Codable, Sendable {}

public enum CommandStatus: String, Codable, Sendable {
    case accepted
    case completed
    case rejected
    case failed
}

public struct CommandAckPayload: Codable, Sendable {
    public let commandId: UUID
    public let status: CommandStatus
    public let errorCode: String?
    public let message: String?
}

public struct SessionSubscribePayload: Codable, Sendable {
    public let afterSeq: Int64?
}

public struct SessionUnsubscribePayload: Codable, Sendable {}
