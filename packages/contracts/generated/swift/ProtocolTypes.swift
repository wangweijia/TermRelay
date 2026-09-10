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
