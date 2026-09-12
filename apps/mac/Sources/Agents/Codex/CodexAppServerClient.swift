import Foundation

enum CodexServerMessage: Sendable {
    case notification(method: String, params: JSONValue)
    case request(id: JSONValue, method: String, params: JSONValue)
}

actor CodexAppServerClient {
    nonisolated let messages: AsyncStream<CodexServerMessage>

    private struct PendingRequest {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeoutTask: Task<Void, Never>
    }

    private let transport: any CodexAppServerTransport
    private let messageContinuation: AsyncStream<CodexServerMessage>.Continuation
    private let timeout: Duration
    private var readerTask: Task<Void, Never>?
    private var nextRequestID = 1
    private var pending: [Int: PendingRequest] = [:]
    private var started = false

    init(
        transport: any CodexAppServerTransport,
        timeout: Duration = .seconds(15)
    ) {
        self.transport = transport
        self.timeout = timeout
        let stream = AsyncStream<CodexServerMessage>.makeStream()
        messages = stream.stream
        messageContinuation = stream.continuation
    }

    func start() async throws -> JSONValue {
        guard !started else {
            throw AgentError.invalidState(expected: "not started", actual: .ready)
        }
        try transport.start()
        started = true
        readerTask = Task { [weak self, transport] in
            do {
                for try await line in transport.lines {
                    await self?.receive(line)
                }
                await self?.transportEnded(nil)
            } catch {
                await self?.transportEnded(error)
            }
        }
        do {
            let result = try await request(method: "initialize", params: .object([
                "clientInfo": .object([
                    "name": .string("termrelay"),
                    "title": .string("TermRelay"),
                    "version": .string("0.1.0"),
                ]),
                "capabilities": .object([
                    "experimentalApi": .bool(false),
                ]),
            ]))
            try notify(method: "initialized", params: .object([:]))
            return result
        } catch {
            stop()
            throw error
        }
    }

    func request(method: String, params: JSONValue) async throws -> JSONValue {
        guard started else {
            throw AgentError.providerUnavailable("Codex App Server 尚未初始化")
        }
        let id = nextRequestID
        nextRequestID += 1
        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = Task { [weak self, timeout] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                await self?.timeOut(id: id, method: method)
            }
            pending[id] = PendingRequest(
                continuation: continuation,
                timeoutTask: timeoutTask
            )
            do {
                try send(CodexOutboundRequest(id: id, method: method, params: params))
            } catch {
                pending.removeValue(forKey: id)?.timeoutTask.cancel()
                continuation.resume(throwing: error)
            }
        }
    }

    func notify(method: String, params: JSONValue) throws {
        guard started else {
            throw AgentError.providerUnavailable("Codex App Server 尚未初始化")
        }
        try send(CodexOutboundNotification(method: method, params: params))
    }

    func respond(id: JSONValue, result: JSONValue) throws {
        guard started else {
            throw AgentError.providerUnavailable("Codex App Server 尚未初始化")
        }
        try send(CodexOutboundResponse(id: id, result: result))
    }

    func respondError(id: JSONValue, code: Int, message: String) throws {
        guard started else {
            throw AgentError.providerUnavailable("Codex App Server 尚未初始化")
        }
        try send(CodexOutboundErrorResponse(
            id: id,
            error: CodexOutboundError(code: code, message: message)
        ))
    }

    func stop() {
        guard started else { return }
        started = false
        readerTask?.cancel()
        readerTask = nil
        transport.stop()
        failPending(AgentError.providerUnavailable("Codex App Server 已停止"))
        messageContinuation.finish()
    }

    private func receive(_ line: Data) {
        do {
            let envelope = try JSONDecoder().decode(CodexInboundEnvelope.self, from: line)
            if let method = envelope.method {
                let params = envelope.params ?? .object([:])
                if let id = envelope.id {
                    messageContinuation.yield(.request(id: id, method: method, params: params))
                } else {
                    messageContinuation.yield(.notification(method: method, params: params))
                }
                return
            }
            guard let id = envelope.id?.integer else { return }
            guard let request = pending.removeValue(forKey: id) else { return }
            request.timeoutTask.cancel()
            if let error = envelope.error {
                request.continuation.resume(throwing: AgentError.protocolFailure(
                    "\(error.code): \(error.message)"
                ))
            } else {
                request.continuation.resume(returning: envelope.result ?? .null)
            }
        } catch {
            transportEnded(AgentError.protocolFailure("无法解析 App Server JSON：\(error)"))
        }
    }

    private func timeOut(id: Int, method: String) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.continuation.resume(throwing: AgentError.protocolFailure(
            "App Server 请求超时：\(method)"
        ))
    }

    private func transportEnded(_ error: Error?) {
        guard started else { return }
        started = false
        failPending(error ?? AgentError.providerUnavailable("Codex App Server 已退出"))
        messageContinuation.finish()
    }

    private func failPending(_ error: Error) {
        let requests = pending.values
        pending.removeAll()
        for request in requests {
            request.timeoutTask.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func send<T: Encodable>(_ message: T) throws {
        try transport.send(JSONEncoder().encode(message))
    }
}

private struct CodexOutboundRequest: Encodable {
    let id: Int
    let method: String
    let params: JSONValue
}

private struct CodexOutboundNotification: Encodable {
    let method: String
    let params: JSONValue
}

private struct CodexOutboundResponse: Encodable {
    let id: JSONValue
    let result: JSONValue
}

private struct CodexOutboundErrorResponse: Encodable {
    let id: JSONValue
    let error: CodexOutboundError
}

private struct CodexOutboundError: Encodable {
    let code: Int
    let message: String
}

private struct CodexInboundEnvelope: Decodable {
    let id: JSONValue?
    let method: String?
    let params: JSONValue?
    let result: JSONValue?
    let error: CodexRPCError?
}

private struct CodexRPCError: Decodable {
    let code: Int
    let message: String
}
