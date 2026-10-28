import AppKit
import Darwin
import Foundation

struct PreviewFeedback: Decodable, Identifiable, Sendable {
    struct Element: Decodable, Sendable {
        let tag: String
        let text: String
        let locator: String
    }

    let id: String
    let page: String
    let description: String
    let steps: String
    let status: String
    let note: String
    let element: Element?

    var statusLabel: String {
        switch status {
        case "pending": "待处理"
        case "sending": "发送中"
        case "delivered": "已送达会话，待核实"
        case "unknown": "结果未知，需核实"
        case "failed": "处理失败"
        case "awaiting_review": "待业务验收"
        case "verified": "已验收"
        case "changes_requested": "需继续修改"
        default: "未知状态：\(status)"
        }
    }
}

struct PreviewSharingConfiguration: Sendable {
    let ports: [Int]
    let publicPort: Int
    let ownerPort: Int
    let shareHost: String

    init(ports: String, publicPort: String, ownerPort: String, shareHost: String) throws {
        let parts = ports.split(separator: ",", omittingEmptySubsequences: false)
        guard !parts.isEmpty else { throw PreviewSharingError("请填写项目端口。") }
        self.ports = try Array(Set(parts.map { try Self.port(String($0).trimmingCharacters(in: .whitespaces)) })).sorted()
        self.publicPort = try Self.port(publicPort)
        self.ownerPort = try Self.port(ownerPort)
        guard self.publicPort != self.ownerPort, !self.ports.contains(self.publicPort), !self.ports.contains(self.ownerPort) else {
            throw PreviewSharingError("共享端口、管理端口不能相同，也不能占用项目端口。")
        }
        guard Self.isLocalHost(shareHost), shareHost != "localhost", !shareHost.hasPrefix("127.") else {
            throw PreviewSharingError("请选择业务方可访问的本机局域网 IPv4 地址。")
        }
        self.shareHost = shareHost
    }

    static func port(_ text: String) throws -> Int {
        guard !text.isEmpty, text.allSatisfy(\.isNumber), let value = Int(text), (1...65535).contains(value) else {
            throw PreviewSharingError("端口必须为 1 至 65535 的整数，多个项目端口使用英文逗号分隔。")
        }
        return value
    }

    static func isLocalHost(_ value: String) -> Bool {
        if value == "localhost" { return true }
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let numbers = parts.compactMap { Int($0) }
        guard numbers.count == 4, numbers.allSatisfy({ (0...255).contains($0) }) else { return false }
        return numbers[0] == 10 || numbers[0] == 127
            || (numbers[0] == 192 && numbers[1] == 168)
            || (numbers[0] == 172 && (16...31).contains(numbers[1]))
    }

    static func localAddresses() -> [String] {
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0 else { return [] }
        defer { freeifaddrs(addresses) }
        var result: [String] = []
        var current = addresses
        while let entry = current {
            defer { current = entry.pointee.ifa_next }
            guard let address = entry.pointee.ifa_addr, address.pointee.sa_family == UInt8(AF_INET),
                  entry.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                  entry.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let value = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
                if Self.isLocalHost(value) { result.append(value) }
            }
        }
        return Array(Set(result)).sorted()
    }
}

struct PreviewSharingError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private struct PreviewCredentials: Decodable {
    let adminToken: String
    let reviewerToken: String
    let proxyToken: String
}

private struct PreviewOwnerState: Decodable {
    struct Binding: Decodable {
        let sessionId: String
        let deviceId: String
        let workspaceId: String
    }
    let binding: Binding
    let records: [PreviewFeedback]
}

private struct PreviewDispatch: Decodable {
    let commandId: UUID
    let text: String
    let binding: PreviewOwnerState.Binding
}

private struct PreviewResponseFailure: Decodable {
    let error: String
}

@MainActor
final class PreviewSharingController: ObservableObject {
    @Published private(set) var sessionID: UUID?
    @Published private(set) var sessionName = ""
    @Published private(set) var isStarting = false
    @Published private(set) var isRunning = false
    @Published private(set) var isStopping = false
    @Published private(set) var isSending = false
    @Published private(set) var feedback: [PreviewFeedback] = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var previewURLs: [String] = []
    @Published private(set) var configuration: PreviewSharingConfiguration?
    @Published var nodePath = ""

    private var process: Process?
    private var generation: UUID?
    private var credentials: PreviewCredentials?
    private var expectedDeviceID = ""
    private var expectedWorkspaceID = ""
    private var output = ""
    private var pollTask: Task<Void, Never>?
    private var startLocalTurn: (@MainActor (String, UUID) async -> RemoteCommandResult)?
    private let network: URLSession
    private let dataRoot: URL

    init(network: URLSession? = nil, directory: URL? = nil) {
        let options = URLSessionConfiguration.ephemeral
        options.connectionProxyDictionary = [:]
        self.network = network ?? URLSession(configuration: options)
        dataRoot = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("TermRelay/PreviewSharing", isDirectory: true)
    }

    static func assetsURL() throws -> URL {
        if let root = Bundle.main.resourceURL?.appendingPathComponent("ChromeFeedback"),
           FileManager.default.fileExists(atPath: root.appendingPathComponent("companion/main.mjs").path) {
            return root
        }
        if Bundle.main.bundleURL.pathExtension == "app" {
            throw PreviewSharingError("App 中缺少页面共享资源，请更新到包含 ChromeFeedback 的完整发布包。")
        }
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("chrome-extension")
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("companion/main.mjs").path) else {
            throw PreviewSharingError("缺少页面共享资源，请使用包含 ChromeFeedback 的新版 App。")
        }
        return root
    }

    var hasUnresolvedExecution: Bool {
        feedback.contains { ["sending", "delivered", "unknown"].contains($0.status) }
    }

    func start(
        session: ManagedSession, deviceID: UUID, workspaceID: String, configuration: PreviewSharingConfiguration,
        startLocalTurn: @escaping @MainActor (String, UUID) async -> RemoteCommandResult
    ) async {
        guard process == nil, !isStarting, !isStopping else {
            errorMessage = "一次只能共享一个项目，请先停止当前共享。"
            return
        }
        guard session.runtimeMode == .acp, session.projectID == nil else {
            errorMessage = "请选择本机普通 ACP 项目会话。"
            return
        }
        isStarting = true
        errorMessage = nil
        output = ""
        feedback = []
        previewURLs = []
        let operation = UUID()
        generation = operation
        sessionID = session.id
        sessionName = session.displayName
        self.configuration = configuration
        self.startLocalTurn = startLocalTurn
        expectedDeviceID = deviceID.uuidString.lowercased()
        expectedWorkspaceID = workspaceID
        defer { if generation == operation { isStarting = false } }
        do {
            let assets = try Self.assetsURL()
            let node = nodePath.isEmpty ? ExecutableLocator.find(named: "node") : URL(fileURLWithPath: nodePath)
            guard let node, FileManager.default.isExecutableFile(atPath: node.path) else {
                throw PreviewSharingError("未找到 Node.js 22+。请在高级设置中选择已安装的 Node 可执行文件。")
            }
            let directory = dataRoot.appendingPathComponent("local", isDirectory: true)
                .appendingPathComponent(session.id.uuidString.lowercased(), isDirectory: true)
            let child = Process()
            child.executableURL = node
            child.arguments = [
                assets.appendingPathComponent("companion/main.mjs").path,
                "--session", session.id.uuidString.lowercased(),
                "--device", expectedDeviceID, "--workspace", workspaceID,
                "--name", session.displayName,
                "--ports", configuration.ports.map(String.init).joined(separator: ","),
                "--port", String(configuration.publicPort), "--owner-port", String(configuration.ownerPort),
                "--data-dir", directory.path,
                "--parent-pid", String(getpid()),
            ]
            child.environment = TerminalEnvironment.make(executableURL: node)
            let pipe = Pipe()
            child.standardOutput = pipe
            child.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                if data.isEmpty { handle.readabilityHandler = nil; return }
                Task { @MainActor [weak self] in
                    guard let self, self.generation == operation else { return }
                    self.output = String((self.output + String(decoding: data, as: UTF8.self)).suffix(8192))
                }
            }
            child.terminationHandler = { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, self.generation == operation else { return }
                    self.process = nil
                    self.isRunning = false
                    self.isStarting = false
                    self.credentials = nil
                    self.startLocalTurn = nil
                    self.pollTask?.cancel()
                    self.errorMessage = "页面共享服务已退出。\(self.output)"
                }
            }
            process = child
            try child.run()
            var lastError = "等待共享服务启动。"
            for _ in 0..<120 {
                guard generation == operation else { return }
                guard child.isRunning else { throw PreviewSharingError("共享启动失败：\(output)") }
                do {
                    let data = try Data(contentsOf: directory.appendingPathComponent("credentials.json"))
                    credentials = try JSONDecoder().decode(PreviewCredentials.self, from: data)
                    try await refresh()
                    guard generation == operation, child.isRunning else { return }
                    isRunning = true
                    previewURLs = configuration.ports.map { "https://page-gateway-local.nioint.com:\($0)/" }
                    pollTask = Task { [weak self] in
                        while !Task.isCancelled {
                            do { try await Task.sleep(for: .seconds(3)) } catch { break }
                            guard let self, self.generation == operation else { break }
                            do { try await self.refresh() }
                            catch {
                                if self.generation == operation { self.errorMessage = "反馈同步失败：\(error.localizedDescription)" }
                            }
                        }
                    }
                    return
                } catch { lastError = error.localizedDescription }
                try await Task.sleep(for: .milliseconds(100))
            }
            throw PreviewSharingError("共享启动超时：\(lastError)\n\(output)")
        } catch {
            let message = error.localizedDescription
            if generation == operation {
                await stop()
                errorMessage = message
            }
        }
    }

    func stop(reason: String? = nil) async {
        guard !isStopping else { return }
        isStopping = true
        generation = nil
        pollTask?.cancel()
        pollTask = nil
        isRunning = false
        isStarting = false
        if let child = process, child.isRunning {
            child.terminate()
            for _ in 0..<30 where child.isRunning {
                try? await Task.sleep(for: .milliseconds(100))
            }
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
        }
        process = nil
        credentials = nil
        startLocalTurn = nil
        isSending = false
        isStopping = false
        if let reason { errorMessage = reason }
    }

    func stopIfBound(to id: UUID) {
        guard sessionID == id, process != nil else { return }
        let operation = generation
        Task {
            guard sessionID == id, generation == operation else { return }
            await stop(reason: "项目会话已结束，共享已停止。")
        }
    }

    func refresh() async throws {
        let operation = generation
        let state: PreviewOwnerState = try await request("/api/state")
        guard generation == operation else { throw CancellationError() }
        guard state.binding.sessionId == sessionID?.uuidString.lowercased(),
              state.binding.deviceId == expectedDeviceID, state.binding.workspaceId == expectedWorkspaceID else {
            throw PreviewSharingError("共享服务绑定与 App 会话不一致，已拒绝读取或执行。")
        }
        feedback = state.records
    }

    func deliver(_ record: PreviewFeedback) async {
        guard isRunning, !isSending, !hasUnresolvedExecution, record.status == "pending", let startLocalTurn else {
            errorMessage = "请先核实上一条执行结果，并确认当前共享可用。"
            return
        }
        let operation = generation
        isSending = true
        defer { if generation == operation { isSending = false } }
        do {
            let dispatch: PreviewDispatch = try await request("/api/feedback/\(record.id)/deliver", body: [:])
            guard generation == operation, isRunning else { return }
            guard dispatch.binding.sessionId == sessionID?.uuidString.lowercased(),
                  dispatch.binding.deviceId == expectedDeviceID, dispatch.binding.workspaceId == expectedWorkspaceID else {
                throw PreviewSharingError("反馈执行绑定与本机会话不一致，已拒绝执行。")
            }
            let result = await startLocalTurn(dispatch.text, dispatch.commandId)
            guard generation == operation, isRunning else { return }
            let status = result.succeeded ? "delivered" : (result.errorCode == "agent_action_failed" ? "unknown" : "failed")
            let note = result.succeeded ? "本地会话已接收，开发者仍需核实 AI 执行结果。" : (result.message ?? "本地会话拒绝执行。")
            let _: PreviewFeedback = try await request("/api/feedback/\(record.id)/result", body: [
                "commandId": dispatch.commandId.uuidString.lowercased(), "status": status, "note": String(note.prefix(2000)),
            ])
            guard generation == operation else { return }
            try await refresh()
            errorMessage = nil
        } catch {
            if generation == operation { errorMessage = "提交执行结果待确认，请刷新并到会话中核实：\(error.localizedDescription)" }
        }
    }

    func resolve(_ record: PreviewFeedback, summary: String, failed: Bool) async {
        guard isRunning, !isSending, !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            errorMessage = "请核实会话执行结束，并填写给验收者看的结果摘要。"
            return
        }
        let operation = generation
        do {
            let _: PreviewFeedback = try await request("/api/feedback/\(record.id)/review", body: [
                "checked": true, "note": summary, "outcome": failed ? "failed" : "completed",
            ])
            guard generation == operation else { return }
            try await refresh()
            errorMessage = nil
        } catch {
            if generation == operation { errorMessage = error.localizedDescription }
        }
    }

    func pairingJSON() throws -> String {
        guard isRunning, let configuration, let credentials else { throw PreviewSharingError("请先开启共享。") }
        let data = try JSONSerialization.data(withJSONObject: [
            "companionURL": "http://\(configuration.shareHost):\(configuration.publicPort)",
            "reviewerToken": credentials.reviewerToken, "proxyToken": credentials.proxyToken,
        ], options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    func showExtension() throws {
        let directory = try Self.assetsURL().appendingPathComponent("extension", isDirectory: true)
        NSWorkspace.shared.activateFileViewerSelecting([directory])
    }

    private func request<Result: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> Result {
        guard let configuration, let credentials,
              let url = URL(string: "http://127.0.0.1:\(configuration.ownerPort)\(path)") else {
            throw PreviewSharingError("共享服务尚未就绪。")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = path.hasSuffix("/deliver") ? 30 : 3
        request.setValue("Bearer \(credentials.adminToken)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await network.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw PreviewSharingError("共享服务响应无效。") }
        guard (200..<300).contains(response.statusCode) else {
            let detail = try JSONDecoder().decode(PreviewResponseFailure.self, from: data)
            throw PreviewSharingError(detail.error)
        }
        return try JSONDecoder().decode(Result.self, from: data)
    }
}
