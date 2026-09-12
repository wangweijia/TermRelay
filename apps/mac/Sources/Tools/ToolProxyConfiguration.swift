import Foundation

enum ToolProxyMode: String, Codable, CaseIterable, Sendable {
    case inherit
    case disabled
    case custom
}

struct ToolProxyConfiguration: Codable, Equatable, Sendable {
    var mode: ToolProxyMode = .inherit
    var httpProxy = ""
    var httpsProxy = ""
    var allProxy = ""
    var noProxy = "localhost,127.0.0.1,::1"

    static let inherited = ToolProxyConfiguration()

    var validationMessage: String? {
        guard mode == .custom else { return nil }
        for (label, value) in [
            ("HTTP Proxy", httpProxy),
            ("HTTPS Proxy", httpsProxy),
            ("ALL Proxy", allProxy),
        ] where !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let components = URLComponents(string: value),
                  let scheme = components.scheme?.lowercased(),
                  ["http", "https", "socks5", "socks5h"].contains(scheme),
                  components.host != nil else {
                return "\(label) 不是有效的 http://、https://、socks5:// 或 socks5h:// 地址。"
            }
        }
        if httpProxy.isBlank && httpsProxy.isBlank && allProxy.isBlank {
            return "自定义代理至少需要填写一个代理地址。"
        }
        return nil
    }

    func applying(to source: [String: String]) -> [String: String] {
        guard mode != .inherit else { return source }
        var environment = source
        for key in Self.proxyKeys { environment.removeValue(forKey: key) }
        guard mode == .custom else { return environment }
        set(httpProxy, keys: ["HTTP_PROXY", "http_proxy"], in: &environment)
        set(httpsProxy, keys: ["HTTPS_PROXY", "https_proxy"], in: &environment)
        set(allProxy, keys: ["ALL_PROXY", "all_proxy"], in: &environment)
        set(noProxy, keys: ["NO_PROXY", "no_proxy"], in: &environment)
        return environment
    }

    private func set(_ rawValue: String, keys: [String], in environment: inout [String: String]) {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        for key in keys { environment[key] = value }
    }

    private static let proxyKeys = [
        "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
        "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
    ]
}

private extension String {
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
