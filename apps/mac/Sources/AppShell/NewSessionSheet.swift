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
                    Text("命名会话，然后选择终端或结构化 Agent 模式。")
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
                Text("运行模式")
                    .font(.headline)
                Picker("运行模式", selection: $appModel.selectedRuntimeMode) {
                    Text("终端").tag(SessionRuntimeMode.terminal)
                    Text("结构化 Agent").tag(SessionRuntimeMode.structured)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                Text(appModel.selectedRuntimeMode == .structured
                     ? "通过 Codex App Server 获取结构化事件，并支持远程审批。"
                     : "启动独立 PTY，可在本机和 Web 中直接操作。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 9) {
                Text("终端工具")
                    .font(.headline)
                Picker("终端工具", selection: $appModel.selectedTool) {
                    ForEach(BuiltInTool.allCases) { tool in
                        Label(tool.displayName, systemImage: tool == .codex ? "sparkles" : "terminal")
                            .tag(tool)
                    }
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .disabled(appModel.selectedRuntimeMode == .structured)
                .onChange(of: appModel.selectedRuntimeMode) { _, mode in
                    if mode == .structured { appModel.selectedTool = .codex }
                }

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

            HStack {
                Label(
                    proxySummary,
                    systemImage: appModel.proxyConfiguration(for: appModel.selectedTool).mode == .custom
                        ? "network" : "network.slash"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                Spacer()
                SettingsLink { Text("配置启动代理…") }
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
                .disabled(!appModel.selectedToolAvailability.isAvailable
                          || (appModel.selectedRuntimeMode == .structured && appModel.selectedTool != .codex))
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
