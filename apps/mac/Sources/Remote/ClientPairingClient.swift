import Foundation

struct ClientPairingSession: Sendable {
    let pairingID: String
    let deviceCode: String
    let userCode: String
    let verificationURL: URL
    let expiresIn: Int
    let pollInterval: Int
}

enum ClientPairingExchange: Sendable {
    case pending
    case issued(credential: String, expiresAt: Date?)
    case denied
    case expired
    case invalid
}

struct ClientPairingClient: Sendable {
    private let session: URLSession
    private let decoder: JSONDecoder

    init(session: URLSession = .shared) {
        self.session = session
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
    }

    func create(
        serverWebSocketURL: URL,
        deviceID: UUID,
        deviceName: String,
        appVersion: String
    ) async throws -> ClientPairingSession {
        let request = try jsonRequest(
            serverWebSocketURL: serverWebSocketURL,
            path: "/api/client-pairings",
            body: CreateRequest(
                deviceId: deviceID.uuidString.lowercased(),
                deviceName: deviceName,
                appVersion: appVersion
            )
        )
        let response: CreateResponse = try await send(request)
        guard let verificationURL = URL(string: response.verificationURL) else {
            throw ClientPairingError.invalidResponse
        }
        return ClientPairingSession(
            pairingID: response.pairingId,
            deviceCode: response.deviceCode,
            userCode: response.userCode,
            verificationURL: verificationURL,
            expiresIn: response.expiresIn,
            pollInterval: response.pollInterval
        )
    }

    func exchange(
        serverWebSocketURL: URL,
        pairingID: String,
        deviceCode: String
    ) async throws -> ClientPairingExchange {
        let request = try jsonRequest(
            serverWebSocketURL: serverWebSocketURL,
            path: "/api/client-pairings/token",
            body: ExchangeRequest(pairingId: pairingID, deviceCode: deviceCode)
        )
        let response: ExchangeResponse = try await send(request)
        switch response.status {
        case "authorization_pending": return .pending
        case "issued":
            guard let credential = response.credential else {
                throw ClientPairingError.invalidResponse
            }
            return .issued(credential: credential, expiresAt: response.expiresAt)
        case "access_denied": return .denied
        case "expired_token": return .expired
        default: return .invalid
        }
    }

    static func apiURL(serverWebSocketURL: URL, path: String) throws -> URL {
        guard var components = URLComponents(url: serverWebSocketURL, resolvingAgainstBaseURL: false) else {
            throw ClientPairingError.invalidServerURL
        }
        switch components.scheme?.lowercased() {
        case "wss": components.scheme = "https"
        case "ws": components.scheme = "http"
        default: throw ClientPairingError.invalidServerURL
        }
        components.path = path
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw ClientPairingError.invalidServerURL }
        return url
    }

    private func jsonRequest<Body: Encodable>(
        serverWebSocketURL: URL,
        path: String,
        body: Body
    ) throws -> URLRequest {
        var request = URLRequest(url: try Self.apiURL(serverWebSocketURL: serverWebSocketURL, path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private func send<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            throw ClientPairingError.serverRejected
        }
        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw ClientPairingError.invalidResponse
        }
    }
}

private struct CreateRequest: Encodable {
    let deviceId: String
    let deviceName: String
    let appVersion: String
}

private struct CreateResponse: Decodable {
    let pairingId: String
    let deviceCode: String
    let userCode: String
    let verificationURL: String
    let expiresIn: Int
    let pollInterval: Int
}

private struct ExchangeRequest: Encodable {
    let pairingId: String
    let deviceCode: String
}

private struct ExchangeResponse: Decodable {
    let status: String
    let credential: String?
    let expiresAt: Date?
}

enum ClientPairingError: LocalizedError {
    case invalidServerURL
    case serverRejected
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidServerURL: "Server URL 必须使用 ws:// 或 wss://"
        case .serverRejected: "Server 拒绝了配对请求"
        case .invalidResponse: "Server 返回了无效的配对响应"
        }
    }
}