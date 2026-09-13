import Foundation

enum ACPMessage: Sendable {
    case notification(method: String, params: JSONValue)
    case request(id: JSONValue, method: String, params: JSONValue)
}

protocol ACPTransport: Sendable {
    var lines: AsyncThrowingStream<Data, Error> { get }
    func start() throws
    func send(_ line: Data) throws
    func stop()
    func diagnosticTail() -> String
}

actor DSHACPClient {
    nonisolated let messages: AsyncStream<ACPMessage>

    private struct PendingRequest {
        let continuation: CheckedContinuation<JSONValue, Error>
        let timeoutTask: Task<Void, Never>?
    }

    private let transport: any ACPTransport
    private let messageContinuation: AsyncStream<ACPMessage>.Continuation
    private var readerTask: Task<Void, Never>?
    private var nextRequestID = 1
    private var pending: [Int: PendingRequest] = [:]
    private var started = false

    init(transport: any ACPTransport) {
        self.transport = transport
        let stream = AsyncStream<ACPMessage>.makeStream()
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
                for try await line in transport.lines { await self?.receive(line) }
                await self?.transportEnded(nil)
            } catch {
                await self?.transportEnded(error)
            }
        }
        do {
            return try await request(method: "initialize", params: .object([
                "protocolVersion": .number(1),
                "clientCapabilities": .object([:]),
                "clientInfo": .object([
                    "name": .string("termrelay"),
                    "title": .string("TermRelay"),
                    "version": .string("0.1.0"),
                ]),
            ]), timeout: .seconds(30))
        } catch {
            stop()
            throw error
        }
    }

    func request(
        method: String,
        params: JSONValue,
        timeout: Duration? = .seconds(20)
    ) async throws -> JSONValue {
        guard started else { throw AgentError.providerUnavailable("DSH ACP 尚未初始化") }
        let id = nextRequestID
        nextRequestID += 1
        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = timeout.map { timeout in
                Task { [weak self] in
                    try? await Task.sleep(for: timeout)
                    guard !Task.isCancelled else { return }
                    await self?.timeOut(id: id, method: method)
                }
            }
            pending[id] = PendingRequest(continuation: continuation, timeoutTask: timeoutTask)
            do {
                try send(ACPOutboundRequest(id: id, method: method, params: params))
            } catch {
                pending.removeValue(forKey: id)?.timeoutTask?.cancel()
                continuation.resume(throwing: error)
            }
        }
    }

    func notify(method: String, params: JSONValue) throws {
        guard started else { throw AgentError.providerUnavailable("DSH ACP 尚未初始化") }
        try send(ACPOutboundNotification(method: method, params: params))
    }

    func respond(id: JSONValue, result: JSONValue) throws {
        guard started else { throw AgentError.providerUnavailable("DSH ACP 尚未初始化") }
        try send(ACPOutboundResponse(id: id, result: result))
    }

    func stop() {
        guard started else { return }
        started = false
        readerTask?.cancel()
        readerTask = nil
        transport.stop()
        failPending(AgentError.providerUnavailable("DSH ACP 已停止"))
        messageContinuation.finish()
    }

    private func receive(_ line: Data) {
        do {
            let envelope = try JSONDecoder().decode(ACPInboundEnvelope.self, from: line)
            if let method = envelope.method {
                let params = envelope.params ?? .object([:])
                if let id = envelope.id {
                    messageContinuation.yield(.request(id: id, method: method, params: params))
                } else {
                    messageContinuation.yield(.notification(method: method, params: params))
                }
                return
            }
            guard let id = envelope.id?.integer,
                  let request = pending.removeValue(forKey: id) else { return }
            request.timeoutTask?.cancel()
            if let error = envelope.error {
                request.continuation.resume(throwing: AgentError.protocolFailure(
                    "\(error.code): \(error.message)"
                ))
            } else {
                request.continuation.resume(returning: envelope.result ?? .null)
            }
        } catch {
            transportEnded(AgentError.protocolFailure("无法解析 DSH ACP JSON：\(error)"))
        }
    }

    private func timeOut(id: Int, method: String) {
        guard let request = pending.removeValue(forKey: id) else { return }
        let diagnostic = transport.diagnosticTail().trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = diagnostic.isEmpty ? "" : "：\(diagnostic)"
        request.continuation.resume(throwing: AgentError.protocolFailure(
            "DSH ACP 请求超时：\(method)\(suffix)"
        ))
    }

    private func transportEnded(_ error: Error?) {
        guard started else { return }
        started = false
        let diagnostic = transport.diagnosticTail().trimmingCharacters(in: .whitespacesAndNewlines)
        let failure = error ?? AgentError.providerUnavailable(
            diagnostic.isEmpty ? "DSH ACP 进程已退出" : "DSH ACP 进程已退出：\(diagnostic)"
        )
        failPending(failure)
        messageContinuation.finish()
    }

    private func failPending(_ error: Error) {
        let requests = pending.values
        pending.removeAll()
        for request in requests {
            request.timeoutTask?.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func send<T: Encodable>(_ message: T) throws {
        try transport.send(JSONEncoder().encode(message))
    }
}

private struct ACPOutboundRequest: Encodable {
    let jsonrpc = "2.0"
    let id: Int
    let method: String
    let params: JSONValue
}

private struct ACPOutboundNotification: Encodable {
    let jsonrpc = "2.0"
    let method: String
    let params: JSONValue
}

private struct ACPOutboundResponse: Encodable {
    let jsonrpc = "2.0"
    let id: JSONValue
    let result: JSONValue
}

private struct ACPInboundEnvelope: Decodable {
    let id: JSONValue?
    let method: String?
    let params: JSONValue?
    let result: JSONValue?
    let error: ACPRPCError?
}

private struct ACPRPCError: Decodable {
    let code: Int
    let message: String
}
