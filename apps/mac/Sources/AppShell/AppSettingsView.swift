import SwiftUI

struct AppSettingsView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var selectedTool: BuiltInTool = .codex

    var body: some View {
        TabView {
            connectionSettings.tabItem { Label("连接与交互", systemImage:"network") }
            workspaceSettings.tabItem { Label("工作区", systemImage:"folder") }
            aiSettings.tabItem { Label("AI 服务", systemImage:"sparkles") }
            toolSettings.tabItem { Label("工具与凭据", systemImage:"wrench.and.screwdriver") }
        }
        .padding(16)
        .frame(width:620,height:600)
    }

    private var connectionSettings: some View {
        Form {
            Section("TermRelay Server") {
                TextField("连接地址", text: $appModel.serverURL, prompt:Text("ws://服务器地址:3006/ws/client"))
                LabeledContent("本机设备 ID") {
                    Text(appModel.deviceID.uuidString.lowercased()).font(.system(.caption,design:.monospaced)).textSelection(.enabled)
                    Button("复制") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(appModel.deviceID.uuidString.lowercased(),forType:.string)
                    }
                }
                Text("设备 ID 固定保存在本机，开发运行与打包运行共用；更换 Server 不改变它。")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("重新连接") { appModel.reconnectToServer() }
                    Button("使用公网地址") { appModel.useDefaultPublicServer() }
                }
            }

            if appModel.clientAuthorizationState != .notRequired {
                Section("公网设备授权") {
                    ClientAuthorizationSettings()
                }
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

        }
        .formStyle(.grouped)
    }

    private var workspaceSettings: some View {
        Form {
            Section("远程新建会话授权") {
                Text("允许 Web / 手机在以下目录新建会话，实际进程仍在这台 Mac 上运行。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if appModel.remoteStartDirectories.isEmpty {
                    Text("尚未授权任何目录")
                        .foregroundStyle(.secondary)
                }
                ForEach(appModel.remoteStartDirectories, id: \.path) { directory in
                    HStack {
                        Text(directory.path)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("取消授权", role: .destructive) {
                            appModel.setWorkspaceRemoteStart(false, for: directory)
                        }
                    }
                }
                Button("添加授权目录…") { appModel.chooseRemoteStartDirectory() }
                Text("仅授权所选目录，不包含子目录；真实路径与 CLI 凭据不上传。取消授权不影响已有会话的运行或远程访问。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private var aiSettings: some View {
        Form {
            Section("对外提供 AI 能力") {
                Toggle("开启 AI 服务",isOn:$appModel.aiServiceEnabled)
                Text("通过局域网 Server 为持有 API Key 的调用方提供本机可用的 Codex／DSH。任务内容、提示词和输出格式由调用方决定。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("工具路径与 DeepSeek Key 在“工具与凭据”中设置；API Key 在 Web 配置页生成。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Codex 工作目录（可选）") {
                LabeledContent("已授权目录") {
                    Text(appModel.aiWorkingDirectory.isEmpty ? "未授权":appModel.aiWorkingDirectory)
                        .textSelection(.enabled).lineLimit(3)
                }
                HStack {
                    Button("选择文件夹…") { appModel.chooseAIWorkingDirectory() }
                    if !appModel.aiWorkingDirectory.isEmpty {
                        Button("取消目录授权",role:.destructive) { appModel.aiWorkingDirectory = "" }
                    }
                }
                Text("未选择目录时使用隔离临时目录，不允许文件写入或启动工具子进程。选择目录后，新的 Codex 会话可在该目录使用工具，并保留人工审批。DSH 不支持工作目录工具。")
                    .font(.caption).foregroundStyle(.secondary)
                Text("目录与权限由本机授权，真实路径不上传 Server。配置改变只影响新会话；已有会话需先关闭。每台 Mac 最多保留 4 个外部会话，空闲长会话也占容量。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }

    private var toolSettings: some View {
        VStack {
            Picker("工具",selection:$selectedTool) {
                ForEach(BuiltInTool.allCases) { tool in Text(tool.displayName).tag(tool) }
            }.pickerStyle(.segmented)
            Form {
                ToolExecutableSettingsSection(tool:selectedTool)
                if selectedTool == .dsh { DSHCredentialSettingsSection() }
                ToolProxySettingsSection(tool:selectedTool)
                Section {
                    Text("可执行文件和代理配置只保存在本机，应用于新建会话，不上传 Server。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.formStyle(.grouped)
        }
    }
}

private struct ClientAuthorizationSettings: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        switch appModel.clientAuthorizationState {
        case .notRequired:
            EmptyView()
        case .unauthorized:
            LabeledContent("状态") {
                Label("未授权", systemImage: "key.slash").foregroundStyle(.secondary)
            }
            Button("授权此 Mac") { appModel.authorizeClient() }
        case .requesting:
            LabeledContent("状态") {
                ProgressView().controlSize(.small)
                Text("正在创建授权请求")
            }
            Button("取消", role: .cancel) { appModel.cancelClientAuthorization() }
        case .awaitingApproval(let userCode):
            LabeledContent("配对码") {
                Text(userCode).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
            LabeledContent("状态") {
                ProgressView().controlSize(.small)
                Text("等待浏览器确认")
            }
            Button("取消", role: .cancel) { appModel.cancelClientAuthorization() }
        case .authorized:
            LabeledContent("状态") {
                Label("已授权", systemImage: "checkmark.shield").foregroundStyle(.green)
            }
            Button("移除本机凭据", role: .destructive) { appModel.removeClientCredential() }
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .foregroundStyle(.orange)
            HStack {
                Button("重新授权") { appModel.authorizeClient() }
                Button("取消", role: .cancel) { appModel.cancelClientAuthorization() }
            }
        }
        Text("授权凭据仅保存在这台 Mac 的钥匙串中，不会写入偏好设置或 URL。")
            .font(.caption)
            .foregroundStyle(.secondary)
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

    var body: some View {
        let path = appModel.executablePath(for: tool)
        let availability = appModel.toolAvailability(for: tool)
        Section("\(tool.displayName) 可执行文件") {
            HStack {
                Text(path.isEmpty ? "自动查找":path)
                    .textSelection(.enabled).lineLimit(2)
                Button("选择…") { appModel.chooseExecutable(for: tool) }
                if !path.isEmpty {
                    Button("自动查找") { appModel.setExecutablePath("", for: tool) }
                }
            }
            Text(path.isEmpty
                 ? "留空时自动从 PATH 和常用安装目录查找。"
                 : availability.detail)
                .font(.caption)
                .foregroundStyle(availability.isAvailable ? Color.secondary : Color.orange)
        }
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
