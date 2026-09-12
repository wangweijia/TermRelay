import SwiftUI

struct ServerSettingsView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        Form {
            Section("TermRelay Server") {
                TextField("Server WebSocket URL", text: $appModel.serverURL)
                LabeledContent("Device ID", value: appModel.deviceID.uuidString)
                Button("重新连接") { appModel.reconnectToServer() }
            }

            ForEach(BuiltInTool.allCases) { tool in
                ToolProxySettingsSection(tool: tool)
            }

            Section {
                Text("代理配置仅保存在这台 Mac，并在新建对应会话时注入进程环境；不会上传到 TermRelay Server。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .frame(width: 520)
    }
}

private struct ToolProxySettingsSection: View {
    @EnvironmentObject private var appModel: AppModel
    let tool: BuiltInTool

    private var configuration: Binding<ToolProxyConfiguration> {
        Binding(
            get: { appModel.proxyConfiguration(for: tool) },
            set: { appModel.setProxyConfiguration($0, for: tool) }
        )
    }

    var body: some View {
        Section("\(tool.displayName) 启动代理") {
            Picker("代理模式", selection: configuration.mode) {
                Text("跟随 App 环境").tag(ToolProxyMode.inherit)
                Text("禁用").tag(ToolProxyMode.disabled)
                Text("自定义").tag(ToolProxyMode.custom)
            }
            if configuration.wrappedValue.mode == .custom {
                TextField("HTTP Proxy", text: configuration.httpProxy, prompt: Text("http://127.0.0.1:7890"))
                TextField("HTTPS Proxy", text: configuration.httpsProxy, prompt: Text("http://127.0.0.1:7890"))
                TextField("ALL Proxy", text: configuration.allProxy, prompt: Text("socks5://127.0.0.1:7890"))
                TextField("NO_PROXY", text: configuration.noProxy)
                if let message = configuration.wrappedValue.validationMessage {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }
}
