import Foundation

struct RelaySocketPacket<Payload: Encodable & Sendable>: Encodable, Sendable {
    let event = "message"
    let data: RelayEnvelope<Payload>
}

struct RelayEnvelope<Payload: Encodable & Sendable>: Encodable, Sendable {
    let type: String
    let protocolVersion: String
    let messageId: UUID
    let deviceId: String
    let sessionId: String?
    let commandId: UUID?
    let seq: UInt64?
    let sentAt: String
    let payload: Payload
}

struct RelayDeviceRegister: Encodable, Sendable {
    let name: String
    let appVersion: String
    let platform = "macOS"
    let tools: [String]
}

struct RelayHeartbeat: Encodable, Sendable {
    let connectionState: String
    let activeSessionCount: Int
}

struct RelayWorkspace: Encodable, Sendable {
    let workspaceId: String
    let displayName: String
    let available: Bool
    let remoteStartAllowed: Bool
}

struct RelaySessionStarted: Encodable, Sendable {
    let workspaceId: String
    let toolKey: String
    let runtimeMode = "terminal"
    let startedAt: String
}

struct RelayTerminalOutput: Encodable, Sendable {
    let encoding = "base64"
    let data: String
}

struct RelayCommandAck: Encodable, Sendable {
    let commandId: UUID
    let status: String
    let errorCode: String?
    let message: String?
}

struct IncomingRelayPacket: Decodable, Sendable {
    let event: String
    let data: IncomingRelayEnvelope
}

struct IncomingRelayEnvelope: Decodable, Sendable {
    let type: String
    let protocolVersion: String
    let messageId: UUID
    let deviceId: String
    let sessionId: String?
    let commandId: UUID?
    let payload: JSONValue
}

indirect enum JSONValue: Codable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    var object: [String: JSONValue]? {
        if case .object(let value) = self { value } else { nil }
    }

    var string: String? {
        if case .string(let value) = self { value } else { nil }
    }

    var integer: Int? {
        if case .number(let value) = self, value.rounded() == value { Int(value) } else { nil }
    }
}

enum RemoteTerminalCommand: Sendable {
    case input(commandId: UUID, sessionId: UUID, data: Data)
    case resize(commandId: UUID, sessionId: UUID, columns: Int, rows: Int)
    case interrupt(commandId: UUID, sessionId: UUID)
    case stop(commandId: UUID, sessionId: UUID)

    var commandId: UUID {
        switch self {
        case .input(let id, _, _), .resize(let id, _, _, _),
             .interrupt(let id, _), .stop(let id, _): id
        }
    }

    var sessionId: UUID {
        switch self {
        case .input(_, let id, _), .resize(_, let id, _, _),
             .interrupt(_, let id), .stop(_, let id): id
        }
    }
}

struct RemoteCommandResult: Sendable {
    let succeeded: Bool
    let errorCode: String?
    let message: String?

    static let completed = RemoteCommandResult(succeeded: true, errorCode: nil, message: nil)

    static func rejected(_ code: String, _ message: String) -> RemoteCommandResult {
        RemoteCommandResult(succeeded: false, errorCode: code, message: message)
    }
}

enum RelayDate {
    static func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
