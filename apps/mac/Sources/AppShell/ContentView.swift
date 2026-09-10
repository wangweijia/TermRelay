import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Circle()
                    .fill(appModel.connectionState.color)
                    .frame(width: 9, height: 9)
                Text("本地模式 · Server \(appModel.connectionState.label)")
                    .foregroundStyle(.secondary)
                Spacer()
                SettingsLink { Label("设置", systemImage: "gear") }
            }

            HStack(spacing: 10) {
                Button("选择目录…") { appModel.chooseWorkingDirectory() }
                Text(appModel.workingDirectory.path)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(.secondary)
                    .help(appModel.workingDirectory.path)
                Spacer()
            }

            HStack(spacing: 12) {
                Picker("启动", selection: $appModel.selectedTool) {
                    ForEach(BuiltInTool.allCases) { tool in
                        Text(tool.displayName).tag(tool)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 230)

                Button("启动") { appModel.startLocalTerminal() }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(!appModel.selectedToolAvailability.isAvailable)

                if let session = appModel.activeTerminalSession {
                    LocalTerminalControls(session: session)
                }
                Spacer()
            }

            if !appModel.selectedToolAvailability.isAvailable {
                Label(appModel.selectedToolAvailability.detail, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if let errorMessage = appModel.errorMessage {
                Label(errorMessage, systemImage: "xmark.octagon")
                    .foregroundStyle(.red)
            }

            if let session = appModel.activeTerminalSession {
                LocalTerminalPane(session: session)
            } else {
                ContentUnavailableView(
                    "本地终端尚未启动",
                    systemImage: "terminal",
                    description: Text("选择工作目录和登录 Shell 或 Codex，然后点击启动")
                )
            }
        }
        .padding(18)
        .frame(minWidth: 820, minHeight: 560)
    }
}

private struct LocalTerminalControls: View {
    @ObservedObject var session: LocalTerminalSession

    var body: some View {
        Button("Ctrl-C") { session.sendInterrupt() }
            .disabled(session.state != .running)

        Button("停止") { session.terminate() }
            .disabled(session.state != .running)

        if session.tool == .shell {
            Button("显示探针") { session.runVisualProbe() }
                .help("输出 ANSI、TrueColor、中文、Emoji 和 PTY 尺寸")
        }
    }
}

private struct LocalTerminalPane: View {
    @ObservedObject var session: LocalTerminalSession

    var body: some View {
        TerminalContainerView(session: session)
            .id(session.id)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay {
                RoundedRectangle(cornerRadius: 8)
                    .stroke(.separator, lineWidth: 1)
            }

        HStack {
            Text(session.title)
            Text(session.currentDirectory)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text("PTY \(session.state.rawValue)")
            Text("Relay probe: \(session.probeSnapshot.totalBytes) B / \(session.probeSnapshot.batchCount) batches / seq \(session.probeSnapshot.lastSequence)")
        }
        .font(.caption.monospaced())
        .foregroundStyle(.secondary)
    }
}
