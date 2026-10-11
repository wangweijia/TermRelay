// Generated from ai.schema.json. Do not edit.
import Foundation

struct AiInput: Codable, Sendable {
    let instructions: String?
    let facts: [String: JSONValue]?
    init(instructions: String? = nil, facts: [String: JSONValue]? = nil) {
        self.instructions = instructions
        self.facts = facts
    }
}

struct AiOutput: Codable, Sendable {
    let kind: String
    let schema: [String: JSONValue]?
    init(kind: String, schema: [String: JSONValue]? = nil) {
        self.kind = kind
        self.schema = schema
    }
}

struct AiCapabilities: Codable, Sendable {
    let providers: [AiProviderCapability]
    init(providers: [AiProviderCapability]) {
        self.providers = providers
    }
}

struct AiCreate: Codable, Sendable {
    let id: String
    let projectId: String
    let provider: String
    let lifecycle: String
    let displayName: String
    let model: String?
    let effort: String?
    let turn: AiTurn?
    init(id: String, projectId: String, provider: String, lifecycle: String, displayName: String, model: String? = nil, effort: String? = nil, turn: AiTurn? = nil) {
        self.id = id
        self.projectId = projectId
        self.provider = provider
        self.lifecycle = lifecycle
        self.displayName = displayName
        self.model = model
        self.effort = effort
        self.turn = turn
    }
}

struct AiTurn: Codable, Sendable {
    let id: String
    let sessionId: String
    let input: AiInput
    let output: AiOutput
    let deadlineAt: String
    init(id: String, sessionId: String, input: AiInput, output: AiOutput, deadlineAt: String) {
        self.id = id
        self.sessionId = sessionId
        self.input = input
        self.output = output
        self.deadlineAt = deadlineAt
    }
}

struct AiControl: Codable, Sendable {
    let id: String
    let turnId: String?
    init(id: String, turnId: String? = nil) {
        self.id = id
        self.turnId = turnId
    }
}

struct AiUpdate: Codable, Sendable {
    let id: String
    let turnId: String?
    let status: String
    let text: String?
    let errorCode: String?
    let waitingFor: String?
    let model: String?
    let effort: String?
    init(id: String, turnId: String? = nil, status: String, text: String? = nil, errorCode: String? = nil, waitingFor: String? = nil, model: String? = nil, effort: String? = nil) {
        self.id = id
        self.turnId = turnId
        self.status = status
        self.text = text
        self.errorCode = errorCode
        self.waitingFor = waitingFor
        self.model = model
        self.effort = effort
    }
}

struct AiProviderCapability: Codable, Sendable {
    let provider: String
    let capacity: Int
    let workspaceEnabled: Bool
    init(provider: String, capacity: Int, workspaceEnabled: Bool) {
        self.provider = provider
        self.capacity = capacity
        self.workspaceEnabled = workspaceEnabled
    }
}

struct AiJobRequest: Codable, Sendable {
    let target: [String: JSONValue]
    let provider: String
    let model: String?
    let effort: String?
    let displayName: String?
    let input: AiInput
    let output: AiOutput
    let deadlineSeconds: Int?
    let contextId: String?
    init(target: [String: JSONValue], provider: String, model: String? = nil, effort: String? = nil, displayName: String? = nil, input: AiInput, output: AiOutput, deadlineSeconds: Int? = nil, contextId: String? = nil) {
        self.target = target
        self.provider = provider
        self.model = model
        self.effort = effort
        self.displayName = displayName
        self.input = input
        self.output = output
        self.deadlineSeconds = deadlineSeconds
        self.contextId = contextId
    }
}

struct AiConversationRequest: Codable, Sendable {
    let target: [String: JSONValue]
    let provider: String
    let model: String?
    let effort: String?
    let displayName: String?
    init(target: [String: JSONValue], provider: String, model: String? = nil, effort: String? = nil, displayName: String? = nil) {
        self.target = target
        self.provider = provider
        self.model = model
        self.effort = effort
        self.displayName = displayName
    }
}

struct AiTurnRequest: Codable, Sendable {
    let input: AiInput
    let output: AiOutput
    let deadlineSeconds: Int?
    init(input: AiInput, output: AiOutput, deadlineSeconds: Int? = nil) {
        self.input = input
        self.output = output
        self.deadlineSeconds = deadlineSeconds
    }
}

