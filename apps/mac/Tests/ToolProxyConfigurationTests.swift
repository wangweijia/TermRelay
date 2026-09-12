import Foundation
import XCTest
@testable import TermRelay

final class ToolProxyConfigurationTests: XCTestCase {
    func testCustomProxyOverridesBothEnvironmentSpellings() {
        let configuration = ToolProxyConfiguration(
            mode: .custom,
            httpProxy: "http://127.0.0.1:7890",
            httpsProxy: "http://127.0.0.1:7890",
            allProxy: "socks5://127.0.0.1:7891",
            noProxy: "localhost,127.0.0.1"
        )
        let environment = configuration.applying(to: [
            "PATH": "/bin",
            "HTTP_PROXY": "http://old:1",
            "https_proxy": "http://old:2",
        ])

        XCTAssertEqual(environment["HTTP_PROXY"], "http://127.0.0.1:7890")
        XCTAssertEqual(environment["http_proxy"], "http://127.0.0.1:7890")
        XCTAssertEqual(environment["HTTPS_PROXY"], "http://127.0.0.1:7890")
        XCTAssertEqual(environment["ALL_PROXY"], "socks5://127.0.0.1:7891")
        XCTAssertEqual(environment["no_proxy"], "localhost,127.0.0.1")
        XCTAssertEqual(environment["PATH"], "/bin")
        XCTAssertNil(configuration.validationMessage)
    }

    func testDisabledProxyRemovesInheritedProxyVariables() {
        var configuration = ToolProxyConfiguration.inherited
        configuration.mode = .disabled
        let environment = configuration.applying(to: [
            "PATH": "/bin",
            "HTTP_PROXY": "http://proxy:1",
            "all_proxy": "socks5://proxy:2",
            "NO_PROXY": "localhost",
        ])

        XCTAssertEqual(environment, ["PATH": "/bin"])
    }

    func testRejectsInvalidAndEmptyCustomProxy() {
        var configuration = ToolProxyConfiguration.inherited
        configuration.mode = .custom
        XCTAssertNotNil(configuration.validationMessage)
        configuration.httpProxy = "127.0.0.1:7890"
        XCTAssertNotNil(configuration.validationMessage)
        configuration.httpProxy = "http://127.0.0.1:7890"
        XCTAssertNil(configuration.validationMessage)
    }

    @MainActor
    func testAppModelPersistsConfigurationPerTool() throws {
        let suiteName = "ToolProxyConfigurationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        var codex = ToolProxyConfiguration.inherited
        codex.mode = .custom
        codex.httpsProxy = "http://127.0.0.1:7890"

        let first = AppModel(defaults: defaults)
        first.setProxyConfiguration(codex, for: .codex)
        first.setExecutablePath("/opt/homebrew/bin/codex", for: .codex)
        let restored = AppModel(defaults: defaults)

        XCTAssertEqual(restored.proxyConfiguration(for: .codex), codex)
        XCTAssertEqual(restored.proxyConfiguration(for: .shell), .inherited)
        XCTAssertEqual(restored.executablePath(for: .codex), "/opt/homebrew/bin/codex")
        XCTAssertEqual(restored.executablePath(for: .shell), "")
    }
}
