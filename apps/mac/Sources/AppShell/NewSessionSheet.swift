import SwiftUI

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var appModel: AppModel
    let didCreate: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("创建新会话")
                        .font(.title2.weight(.semibold))
                    Text("命名会话，选择工具以及交互模式。")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("关闭")
            }

            VStack(alignment: .leading, spacing: 9) {
                Text("会话名称")
                    .font(.headline)
                TextField(
                    "会话名称",
                    text: $appModel.sessionName,
                    prompt: Text(appModel.suggestedSessionName)
                )
                .textFieldStyle(.roundedBorder)
                .onChange(of: appModel.sessionName) { _, value in
                    if value.count > 128 {
                        appModel.sessionName = String(value.prefix(128))
                    }
                }
                Text("留空将使用“\(appModel.suggestedSessionName)”。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 9) {
                Text("工作目录")
                    .font(.headline)
                HStack(spacing: 10) {
                    Image(systemName: "folder")
                        .foregroundStyle(.secondary)
                    Text(appModel.workingDirectory.path)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .help(appModel.workingDirectory.path)
                    Button("选择…") { appModel.chooseWorkingDirectory() }
                }
                .padding(12)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 9))
            }

            VStack(alignment: .leading, spacing: 9) {
                Text("会话")
                    .font(.headline)
                Picker("终端工具", selection: $appModel.selectedTool) {
                    ForEach(BuiltInTool.allCases) { tool in
                        Label(tool.displayName, systemImage: tool == .codex ? "sparkles" : "terminal")
                            .tag(tool)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)

                Label(
                    appModel.selectedToolAvailability.detail,
                    systemImage: appModel.selectedToolAvailability.isAvailable
                        ? "checkmark.circle"
                        : "exclamationmark.triangle"
                )
                .font(.caption)
                .foregroundStyle(
                    appModel.selectedToolAvailability.isAvailable ? Color.secondary : Color.orange
                )
            }

            if appModel.selectedTool == .codex {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Codex 交互模式")
                        .font(.headline)
                    Picker("Codex 交互模式", selection: $appModel.codexInteractionMode) {
                        Text("PTY").tag(CodexInteractionMode.pty)
                        Text("ACP").tag(CodexInteractionMode.acp)
                    }
                    .labelsHidden()
                    .pickerStyle(.segmented)
                    Text(appModel.codexInteractionMode == .pty
                         ? "运行普通 Codex 终端界面，Mac 和 Web 都使用终端渲染。"
                         : "通过 Codex App Server 运行；Mac 和 Web 都使用原生 Agent 界面，不启动终端。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack {
                Label(
                    proxySummary,
                    systemImage: appModel.proxyConfiguration(for: appModel.selectedTool).mode == .custom
                        ? "network" : "network.slash"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                Spacer()
                SettingsLink { Text("配置工具路径和代理…") }
                    .font(.caption)
            }

            if let errorMessage = appModel.errorMessage {
                Label(errorMessage, systemImage: "xmark.octagon")
                    .font(.callout)
                    .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button("取消", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("创建") {
                    didCreate()
                    if appModel.errorMessage == nil { dismiss() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!appModel.selectedToolAvailability.isAvailable)
            }
        }
        .padding(24)
        .frame(width: 560)
    }

    private var proxySummary: String {
        switch appModel.proxyConfiguration(for: appModel.selectedTool).mode {
        case .inherit: "启动代理：跟随 App 环境"
        case .disabled: "启动代理：已禁用"
        case .custom: "启动代理：使用 \(appModel.selectedTool.displayName) 的独立配置"
        }
    }
}
