import Foundation
import XCTest
@testable import TermRelay

final class PreviewSharingTests: XCTestCase {
    func testConfigurationDerivesRelayFromAppConnectionAndKeepsMultipleProjectPorts() throws {
        let configuration = try PreviewSharingConfiguration(
            serverURL: "ws://localhost:3007/ws/client", ports: "8081, 8080,8081",
            publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        XCTAssertEqual(configuration.relayURL.absoluteString, "http://localhost:3007")
        XCTAssertEqual(configuration.ports, [8080, 8081])
        XCTAssertEqual(configuration.shareHost, "10.1.2.3")
        let secure = try PreviewSharingConfiguration(
            serverURL: "wss://192.168.1.2:3006/ws/client", ports: "8080",
            publicPort: "18420", ownerPort: "18421", shareHost: "192.168.1.3")
        XCTAssertEqual(secure.relayURL.scheme, "https")
    }

    func testConfigurationRejectsPublicConnectionsBadPortsAndLoopbackPairingAddresses() {
        for server in ["wss://example.com/ws/client-public", "ws://8.8.8.8/ws/client", "ws://localhost:3007/ws/client?secret=x"] {
            XCTAssertThrowsError(try PreviewSharingConfiguration(serverURL: server, ports: "8080",
                publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3"))
        }
        for ports in ["", "8080,", "abc", "0", "65536", "18420"] {
            XCTAssertThrowsError(try PreviewSharingConfiguration(serverURL: "ws://localhost:3007/ws/client", ports: ports,
                publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3"))
        }
        for address in ["127.0.0.1", "localhost", "example.com", "10.999.1.1", "1.1.1.1"] {
            XCTAssertThrowsError(try PreviewSharingConfiguration(serverURL: "ws://localhost:3007/ws/client", ports: "8080",
                publicPort: "18420", ownerPort: "18421", shareHost: address))
        }
        XCTAssertThrowsError(try PreviewSharingConfiguration(serverURL: "ws://localhost:3007/ws/client", ports: "8080",
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
            serverURL: "ws://localhost:3007/ws/client", ports: "8080",
            publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        let session = ManagedSession(directory: FileManager.default.temporaryDirectory, toolID: "codex", runtimeMode: .acp)
        await controller.start(session: session, deviceID: UUID(), workspaceID: "workspace-opaque", configuration: configuration)
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
            serverURL: "ws://localhost:3007/ws/client", ports: "8080",
            publicPort: "18420", ownerPort: "18421", shareHost: "10.1.2.3")
        let session = ManagedSession(directory: FileManager.default.temporaryDirectory, toolID: "shell")
        await controller.start(session: session, deviceID: UUID(), workspaceID: "workspace-opaque", configuration: configuration)
        XCTAssertNil(controller.sessionID)
        XCTAssertFalse(controller.isRunning)
        XCTAssertTrue(controller.errorMessage?.contains("ACP") == true)
    }

    func testStatusDistinguishesDeliveryFromAcceptance() throws {
        let base: [String: Any] = [
            "id": UUID().uuidString, "page": "https://page-gateway-local.nioint.com:8080/",
            "description": "change button", "steps": "", "status": "delivered", "note": "",
        ]
        let record = try JSONDecoder().decode(PreviewFeedback.self, from: JSONSerialization.data(withJSONObject: base))
        XCTAssertEqual(record.statusLabel, "已送达会话，待核实")
        XCTAssertNotEqual(record.statusLabel, "已验收")
    }

    @MainActor
    func testAppStartsAndStopsOwnedHelperAndCopiesOnlyReviewerPairing() async throws {
        guard let node = ExecutableLocator.find(named: "node") else { throw XCTSkip("Node.js is not installed.") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("termrelay-preview-ui-\(UUID())")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let configurationFile = directory.appendingPathComponent("fixture.json")
        let sessionID = UUID(), deviceID = UUID()
        let session: [String: String] = [
            "id": sessionID.uuidString.lowercased(), "deviceId": deviceID.uuidString.lowercased(),
            "workspaceId": "workspace-opaque-project", "runtimeMode": "acp", "origin": "local",
            "status": "running", "displayName": "Synthetic UI project",
        ]
        let sessionJSON = String(decoding: try JSONSerialization.data(withJSONObject: session), as: UTF8.self)
        let fixture = Process()
        fixture.executableURL = node
        fixture.arguments = ["-e", """
            const http=require('node:http'), fs=require('node:fs');
            const session=JSON.parse(process.argv[2]);
            async function freePort(){
              const s=http.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));
              const port=s.address().port;await new Promise(r=>s.close(r));return port;
            }
            const s=http.createServer((req,res)=>{
              res.setHeader('content-type','application/json');res.end(JSON.stringify(session));
            });
            s.listen(0,'127.0.0.1',async()=>{
              const publicPort=await freePort(),ownerPort=await freePort();
              fs.writeFileSync(process.argv[1],JSON.stringify({relay:s.address().port,publicPort,ownerPort}));
            });
            """, configurationFile.path, sessionJSON]
        fixture.standardOutput = FileHandle.nullDevice
        fixture.standardError = FileHandle.nullDevice
        try fixture.run()
        let controller = PreviewSharingController(directory: directory.appendingPathComponent("sharing"))
        controller.nodePath = node.path
        defer {
            if fixture.isRunning { fixture.terminate() }
            try? FileManager.default.removeItem(at: directory)
        }
        do {
            for _ in 0..<100 where !FileManager.default.fileExists(atPath: configurationFile.path) {
                try await Task.sleep(for: .milliseconds(50))
            }
            struct Ports: Decodable { let relay: Int; let publicPort: Int; let ownerPort: Int }
            let ports = try JSONDecoder().decode(Ports.self, from: Data(contentsOf: configurationFile))
            let configuration = try PreviewSharingConfiguration(
                serverURL: "ws://127.0.0.1:\(ports.relay)/ws/client", ports: "8080",
                publicPort: String(ports.publicPort), ownerPort: String(ports.ownerPort), shareHost: "10.1.2.3")
            let managed = ManagedSession(id: sessionID, directory: directory, toolID: "codex",
                                         displayName: "Synthetic UI project", runtimeMode: .acp)
            await controller.start(session: managed, deviceID: deviceID, workspaceID: "workspace-opaque-project", configuration: configuration)
            XCTAssertTrue(controller.isRunning, controller.errorMessage ?? "Sharing did not start.")
            XCTAssertEqual(controller.sessionID, sessionID)
            let json = try JSONSerialization.jsonObject(with: Data(controller.pairingJSON().utf8))
            let pairing = try XCTUnwrap(json as? [String: String])
            XCTAssertEqual(pairing["companionURL"], "http://10.1.2.3:\(ports.publicPort)")
            XCTAssertEqual(pairing["reviewerToken"]?.count, 64)
            XCTAssertEqual(pairing["proxyToken"]?.count, 64)
            XCTAssertNil(pairing["adminToken"])
            XCTAssertNil(pairing["sessionId"])
            await controller.stop()
            XCTAssertFalse(controller.isRunning)
            XCTAssertFalse(controller.isStopping)
            XCTAssertThrowsError(try controller.pairingJSON())
            let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
            XCTAssertFalse(files?.allObjects.compactMap { $0 as? URL }.contains { $0.lastPathComponent == "running.lock" } ?? true)
        } catch {
            await controller.stop()
            throw error
        }
    }
}
