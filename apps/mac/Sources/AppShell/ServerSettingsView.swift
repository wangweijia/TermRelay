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

            Section("ACP 交互") {
                Picker("发送快捷键", selection: $appModel.acpSendShortcut) {
                    ForEach(ACPSendShortcut.allCases, id: \.self) { shortcut in
                        Text(shortcut.displayName).tag(shortcut)
                    }
                }
                Text("输入框中的普通回车用于换行；所选组合键用于发送消息。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            DSHCredentialSettingsSection()

            ForEach(BuiltInTool.allCases) { tool in
                ToolExecutableSettingsSection(tool: tool)
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

private struct DSHCredentialSettingsSection: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var draft = ""
    @State private var statusMessage: String?

    var body: some View {
        Section("DeepSeek DSH API Key") {
            SecureField(
                appModel.dshAPIKeyConfigured ? "已配置；输入新 Key 可替换" : "sk-…",
                text: $draft
            )
            HStack {
                Button(appModel.dshAPIKeyConfigured ? "更新 API Key" : "保存 API Key") {
                    do {
                        try appModel.saveDSHAPIKey(draft)
                        draft = ""
                        statusMessage = "已保存到 macOS 钥匙串"
                    } catch {
                        statusMessage = error.localizedDescription
                    }
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if appModel.dshAPIKeyConfigured {
                    Button("移除", role: .destructive) {
                        do {
                            try appModel.removeDSHAPIKey()
                            draft = ""
                            statusMessage = "已移除"
                        } catch {
                            statusMessage = error.localizedDescription
                        }
                    }
                }
                Spacer()
                Label(
                    appModel.dshAPIKeyConfigured ? "已配置" : "未配置",
                    systemImage: appModel.dshAPIKeyConfigured ? "checkmark.circle" : "key"
                )
                .foregroundStyle(appModel.dshAPIKeyConfigured ? Color.green : Color.secondary)
            }
            if let statusMessage {
                Text(statusMessage).font(.caption).foregroundStyle(.secondary)
            }
            Text("Key 仅保存在这台 Mac 的钥匙串，并以 DEEPSEEK_API_KEY 注入新启动的 DSH 进程；不会上传 Server。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private struct ToolExecutableSettingsSection: View {
    @EnvironmentObject private var appModel: AppModel
    let tool: BuiltInTool

    private var path: Binding<String> {
        Binding(
            get: { appModel.executablePath(for: tool) },
            set: { appModel.setExecutablePath($0, for: tool) }
        )
    }

    var body: some View {
        Section("\(tool.displayName) 可执行文件") {
            HStack {
                TextField("自动从 PATH 查找", text: path)
                Button("选择…") { appModel.chooseExecutable(for: tool) }
                if !path.wrappedValue.isEmpty {
                    Button("自动查找") { appModel.setExecutablePath("", for: tool) }
                }
            }
            Text(path.wrappedValue.isEmpty
                 ? "留空时自动从 PATH 和常用安装目录查找。"
                 : tool.makeAdapter(executableURL: expandedURL).detect().detail)
                .font(.caption)
                .foregroundStyle(tool.makeAdapter(executableURL: expandedURL).detect().isAvailable
                                 ? Color.secondary : Color.orange)
        }
    }

    private var expandedURL: URL? {
        let value = path.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        return URL(fileURLWithPath: (value as NSString).expandingTildeInPath)
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
