import Foundation
import XCTest
@testable import TermRelay

final class PreviewSharingTests: XCTestCase {
    func testConfigurationIsLocalOnlyAndKeepsMultipleProjectPorts() throws {
        let configuration = try PreviewSharingConfiguration(
            ports: "8081, 8080,8081", publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        XCTAssertEqual(configuration.ports, [8080, 8081])
        XCTAssertEqual(configuration.shareHost, "10.1.2.3")
    }

    func testConfigurationRejectsBadPortsAndNonLANPairingAddresses() {
        for ports in ["", "8080,", "abc", "0", "65536", "18420", "18421"] {
            XCTAssertThrowsError(try PreviewSharingConfiguration(ports: ports,
                publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3"))
        }
        for address in ["127.0.0.1", "localhost", "example.com", "10.999.1.1", "1.1.1.1"] {
            XCTAssertThrowsError(try PreviewSharingConfiguration(ports: "8080",
                publicPort: "18420", ownerPort: "18421", shareHost: address))
        }
        XCTAssertThrowsError(try PreviewSharingConfiguration(ports: "8080",
            publicPort: "18420", ownerPort: "18420", shareHost: "10.1.2.3"))
    }

    @MainActor
    func testAppResourcesResolveToExistingCompanionAndExtensionWithoutCLIInput() throws {
        let assets = try PreviewSharingController.assetsURL()
        XCTAssertTrue(FileManager.default.fileExists(atPath: assets.appendingPathComponent("companion/main.mjs").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: assets.appendingPathComponent("extension/manifest.json").path))
    }

    @MainActor
    func testMissingNodeSurfacesErrorAndDoesNotLeaveSharingActive() async throws {
        let controller = PreviewSharingController()
        controller.nodePath = "/missing/termrelay-node-\(UUID())"
        let configuration = try PreviewSharingConfiguration(
            ports: "8080", publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        let session = ManagedSession(directory: FileManager.default.temporaryDirectory, toolID: "codex", runtimeMode: .acp)
        await controller.start(session: session, deviceID: UUID(), workspaceID: "workspace-opaque", configuration: configuration) { _, _ in
            XCTFail("Missing Node must never start a turn.")
            return .completed
        }
        XCTAssertFalse(controller.isStarting)
        XCTAssertFalse(controller.isRunning)
        XCTAssertFalse(controller.isStopping)
        XCTAssertTrue(controller.errorMessage?.contains("Node") == true)
        XCTAssertThrowsError(try controller.pairingJSON())
    }

    @MainActor
    func testPTYCannotStartSharing() async throws {
        let controller = PreviewSharingController()
        let configuration = try PreviewSharingConfiguration(
            ports: "8080", publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        let session = ManagedSession(directory: FileManager.default.temporaryDirectory, toolID: "shell")
        await controller.start(session: session, deviceID: UUID(), workspaceID: "workspace-opaque", configuration: configuration) { _, _ in
            XCTFail("PTY must never receive feedback.")
            return .completed
        }
        XCTAssertNil(controller.sessionID)
        XCTAssertFalse(controller.isRunning)
        XCTAssertTrue(controller.errorMessage?.contains("ACP") == true)
    }

    func testStatusDistinguishesDeliveryFromAcceptance() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": UUID().uuidString, "page": "https://page-gateway-local.nioint.com:8080/",
            "description": "change button", "steps": "", "status": "delivered", "note": "",
        ])
        let record = try JSONDecoder().decode(PreviewFeedback.self, from: data)
        XCTAssertEqual(record.statusLabel, "已送达会话，待核实")
        XCTAssertNotEqual(record.statusLabel, "已验收")
    }

    @MainActor
    func testOfflineAndPublicAppSettingsDoNotInterruptLocalSharingOrBoundTurn() async throws {
        try await withSharing { controller, managed, configuration in
            let suite = "PreviewSharingOffline-\(UUID())"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defer { defaults.removePersistentDomain(forName: suite) }
            defaults.set("wss://public.example.com/ws/client-public", forKey: "serverURL")
            let model = AppModel(defaults: defaults, previewSharing: controller)
            XCTAssertEqual(model.connectionState, .offline)
            let runtime = PreviewTestRuntime()
            let local = LocalStructuredAgentSession(
                id: managed.id, directory: managed.directory, adapter: PreviewTestAdapter(runtime: runtime),
                eventHandler: { _ in }, stateHandler: { _, _ in })
            await local.start()
            XCTAssertEqual(local.state, .ready)
            await controller.start(session: managed, deviceID: UUID(), workspaceID: "workspace-local", configuration: configuration) { text, commandID in
                await local.startTurn(text, idempotencyKey: commandID)
            }
            XCTAssertTrue(controller.isRunning, controller.errorMessage ?? "Sharing did not start.")
            XCTAssertEqual(controller.sessionID, managed.id)
            XCTAssertEqual(controller.previewURLs, [
                "https://page-gateway-local.nioint.com:8080/",
                "https://page-gateway-local.nioint.com:8081/",
            ])
            let pairing = try pairing(controller)
            XCTAssertEqual(pairing["companionURL"], "http://10.1.2.3:\(configuration.publicPort)")
            XCTAssertEqual(pairing["reviewerToken"]?.count, 64)
            XCTAssertEqual(pairing["proxyToken"]?.count, 64)
            XCTAssertNil(pairing["adminToken"])
            XCTAssertNil(pairing["sessionId"])
            model.serverURL = "wss://another-public.example.com/ws/client-public"
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertTrue(controller.isRunning, "Changing the remote Server must not stop LAN sharing.")
            let id = try await submitFeedback(configuration, pairing)
            try await controller.refresh()
            let record = try XCTUnwrap(controller.feedback.first { $0.id == id })
            await controller.deliver(record)
            XCTAssertNil(controller.errorMessage)
            XCTAssertEqual(controller.feedback.first?.status, "delivered")
            let actions = await runtime.actions
            XCTAssertEqual(actions.count, 1)
            guard case .startTurn(let input, let key) = actions.first else { return XCTFail("Expected a local turn.") }
            XCTAssertTrue(input.text.contains("Move the button"))
            XCTAssertTrue(input.text.contains("untrusted observations"))
            let state = try readStoredFeedback(managed)
            XCTAssertEqual(state.first?["commandId"] as? String, key.uuidString.lowercased())
            await controller.deliver(record)
            let count = await runtime.actions.count
            XCTAssertEqual(count, 1, "Duplicate feedback must not execute a second turn.")
            await controller.resolve(try XCTUnwrap(controller.feedback.first), summary: "Checked the local result.", failed: false)
            XCTAssertEqual(controller.feedback.first?.status, "awaiting_review")
            await local.stop()
            controller.stopIfBound(to: managed.id)
            for _ in 0..<100 where controller.isRunning || controller.isStopping {
                try await Task.sleep(for: .milliseconds(50))
            }
            XCTAssertFalse(controller.isRunning)
            XCTAssertFalse(controller.isStopping)
            XCTAssertThrowsError(try controller.pairingJSON())
        }
    }

    @MainActor
    func testLocalRejectionAndUncertainExecutionAreReportedWithoutReplay() async throws {
        for (result, expected) in [
            (RemoteCommandResult.rejected("agent_not_ready", "Local session busy."), "failed"),
            (.rejected("agent_action_failed", "Local transport outcome uncertain."), "unknown"),
        ] {
            try await withSharing { controller, managed, configuration in
                var calls = 0
                await controller.start(session: managed, deviceID: UUID(), workspaceID: "workspace-local", configuration: configuration) { _, _ in
                    calls += 1
                    return result
                }
                XCTAssertTrue(controller.isRunning, controller.errorMessage ?? "")
                let id = try await submitFeedback(configuration, pairing(controller))
                try await controller.refresh()
                let record = try XCTUnwrap(controller.feedback.first { $0.id == id })
                await controller.deliver(record)
                XCTAssertNil(controller.errorMessage)
                XCTAssertEqual(controller.feedback.first?.status, expected)
                await controller.deliver(record)
                XCTAssertEqual(calls, 1)
            }
        }
    }

    @MainActor
    private func withSharing(
        _ body: @MainActor (PreviewSharingController, ManagedSession, PreviewSharingConfiguration) async throws -> Void
    ) async throws {
        guard let node = ExecutableLocator.find(named: "node") else { throw XCTSkip("Node.js is not installed.") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("termrelay-preview-local-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let portsFile = directory.appendingPathComponent("ports.json")
        let probe = Process()
        probe.executableURL = node
        probe.arguments = ["-e", """
            const http=require('node:http'), fs=require('node:fs');
            (async()=>{
              const a=http.createServer(),b=http.createServer();
              await new Promise(r=>a.listen(0,'127.0.0.1',r));
              await new Promise(r=>b.listen(0,'127.0.0.1',r));
              fs.writeFileSync(process.argv[1],JSON.stringify({publicPort:a.address().port,ownerPort:b.address().port}));
              await Promise.all([a,b].map(s=>new Promise(r=>s.close(r))));
            })().catch(e=>{console.error(e);process.exit(1)});
            """, portsFile.path]
        try probe.run()
        defer { if probe.isRunning { probe.terminate() } }
        for _ in 0..<100 where probe.isRunning { try await Task.sleep(for: .milliseconds(50)) }
        guard !probe.isRunning, probe.terminationStatus == 0 else { return XCTFail("Local port probe failed.") }
        struct Ports: Decodable { let publicPort: Int; let ownerPort: Int }
        let ports = try JSONDecoder().decode(Ports.self, from: Data(contentsOf: portsFile))
        let configuration = try PreviewSharingConfiguration(ports: "8080,8081",
            publicPort: String(ports.publicPort), ownerPort: String(ports.ownerPort), shareHost: "10.1.2.3")
        let controller = PreviewSharingController(directory: directory.appendingPathComponent("sharing"))
        controller.nodePath = node.path
        let managed = ManagedSession(directory: directory, toolID: "codex", displayName: "Local fixture", runtimeMode: .acp)
        do {
            try await body(controller, managed, configuration)
            await controller.stop()
            let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
            XCTAssertFalse(files?.allObjects.compactMap { $0 as? URL }.contains { $0.lastPathComponent == "running.lock" } ?? true)
        } catch {
            await controller.stop()
            throw error
        }
    }

    @MainActor
    private func pairing(_ controller: PreviewSharingController) throws -> [String: String] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(controller.pairingJSON().utf8)) as? [String: String])
    }

    @MainActor
    private func submitFeedback(_ configuration: PreviewSharingConfiguration, _ pairing: [String: String]) async throws -> String {
        let id = UUID().uuidString.lowercased()
        var request = URLRequest(url: try XCTUnwrap(URL(string: "http://127.0.0.1:\(configuration.publicPort)/v1/feedback")))
        request.httpMethod = "POST"
        request.setValue("Bearer \(try XCTUnwrap(pairing["reviewerToken"]))", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "id": id, "page": "https://page-gateway-local.nioint.com:8080/",
            "description": "Move the button", "steps": "",
        ])
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        return id
    }

    @MainActor
    private func readStoredFeedback(_ managed: ManagedSession) throws -> [[String: Any]] {
        let root = try XCTUnwrap(FileManager.default.enumerator(
            at: managed.directory.appendingPathComponent("sharing"), includingPropertiesForKeys: nil))
        let path = try XCTUnwrap(root.allObjects.compactMap { $0 as? URL }.first { $0.lastPathComponent == "feedback.json" })
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [[String: Any]])
    }
}

private struct PreviewTestAdapter: StructuredAgentAdapter {
    let providerID = AgentProviderID(rawValue: "preview-test")
    let displayName = "Local preview test"
    let runtime: PreviewTestRuntime

    func detect() async throws -> AgentInstallation {
        AgentInstallation(executableURL: URL(fileURLWithPath: "/usr/bin/false"), version: "1", supported: true, unsupportedReason: nil)
    }

    func makeRuntime(configuration: AgentLaunchConfiguration) async throws -> any StructuredAgentRuntime { runtime }
}

private actor PreviewTestRuntime: StructuredAgentRuntime {
    nonisolated let events: AsyncStream<ToolEvent>
    private let continuation: AsyncStream<ToolEvent>.Continuation
    let descriptor = AgentDescriptor(providerID: AgentProviderID(rawValue: "preview-test"),
        providerVersion: "1", protocolName: "fake", protocolVersion: "1", capabilities: [])
    private(set) var actions: [ToolAction] = []

    init() {
        let stream = AsyncStream<ToolEvent>.makeStream()
        events = stream.stream
        continuation = stream.continuation
    }
    func start() async throws {}
    func createSession(_ request: AgentSessionRequest) async throws -> AgentSessionReference {
        AgentSessionReference(providerID: descriptor.providerID, opaqueID: request.sessionID.uuidString)
    }
    func send(_ action: ToolAction) async throws { actions.append(action) }
    func stop() async { continuation.finish() }
}
