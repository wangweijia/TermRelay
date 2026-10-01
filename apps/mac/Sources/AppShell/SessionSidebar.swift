import AppKit
import SwiftUI

enum SessionSidebarTab: String, CaseIterable {
    case active = "当前"
    case history = "历史"
}

struct SessionSidebar: View {
    @Environment(\.displayScale) private var displayScale
    let sessions: [ManagedSession]
    let copilotHistory: [CopilotHistorySession]
    let terminalSessions: [UUID: LocalTerminalSession]
    let structuredSessions: [UUID: LocalStructuredAgentSession]
    @Binding var selection: UUID?
    @Binding var tab: SessionSidebarTab
    let addAction: () -> Void
    let shortcutAction: () -> Void
    let closeAction: (UUID) -> Void
    let deleteHistoryAction: (CopilotHistorySession) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("终端")
                    .font(.headline)
                Spacer()
                Button(action: shortcutAction) {
                    Image(systemName: "bolt.square")
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.borderless)
                .help("管理快捷任务")
                .accessibilityLabel("管理快捷任务")
                Button(action: addAction) {
                    Image(systemName: "plus")
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.borderless)
                .help("创建新会话")
                .keyboardShortcut("n", modifiers: [.command])
                .accessibilityLabel("创建新会话")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .overlay(alignment: .bottom) { horizontalSeparator }

            Picker("会话列表", selection: $tab) {
                ForEach(SessionSidebarTab.allCases, id: \.self) { item in
                    Text(item.rawValue).tag(item)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .onChange(of: tab) { _, value in
                if value == .active {
                    if !sessions.contains(where: { $0.id == selection }) {
                        selection = sessions.last?.id
                    }
                } else if !copilotHistory.contains(where: { $0.id == selection }) {
                    selection = copilotHistory.first?.id
                }
            }

            if tab == .active && sessions.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "rectangle.stack.badge.plus")
                        .font(.title2)
                        .foregroundStyle(.tertiary)
                    Text("暂无会话")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Button("创建会话", action: addAction)
                        .buttonStyle(.link)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if tab == .history && copilotHistory.isEmpty {
                ContentUnavailableView(
                    "暂无历史会话",
                    systemImage: "clock.arrow.circlepath",
                    description: Text("连接 Server 后可查看这台 Mac 的 Copilot 历史。")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $selection) {
                    if tab == .active {
                        ForEach(sessions) { session in
                            ClosableSessionSidebarRow(
                                session: session,
                                terminalSession: terminalSessions[session.id],
                                structuredSession: structuredSessions[session.id],
                                isSelected: selection == session.id,
                                closeAction: { closeAction(session.id) }
                            )
                            .tag(session.id)
                            .contextMenu {
                                Button(role: .destructive) {
                                    closeAction(session.id)
                                } label: {
                                    Label("关闭会话", systemImage: "xmark")
                                }
                            }
                        }
                    } else {
                        ForEach(copilotHistory) { archive in
                            HistorySidebarRow(
                                archive: archive,
                                isSelected: selection == archive.id,
                                deleteAction: { deleteHistoryAction(archive) }
                            )
                            .tag(archive.id)
                            .contextMenu {
                                if archive.status == "finished" || archive.status == "failed" {
                                    Button(role: .destructive) {
                                        deleteHistoryAction(archive)
                                    } label: {
                                        Label("删除历史", systemImage: "trash")
                                    }
                                }
                            }
                        }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }

            ConnectionFooter()
                .overlay(alignment: .top) { horizontalSeparator }
        }
        .frame(maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private struct HistorySidebarRow: View {
        let archive: CopilotHistorySession
        let isSelected: Bool
        let deleteAction: () -> Void
        @State private var isHovered = false

        var body: some View {
            HStack(spacing: 8) {
                Image(systemName: "clock.arrow.circlepath")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text(archive.displayName).lineLimit(1)
                    Text(archive.status == "failed" ? "失败 · Copilot" : "已结束 · Copilot")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if archive.status == "finished" || archive.status == "failed" {
                    Button(action: deleteAction) {
                        Image(systemName: "trash")
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.borderless)
                    .opacity(isHovered || isSelected ? 1 : 0)
                    .allowsHitTesting(isHovered || isSelected)
                    .help("删除历史")
                    .accessibilityLabel("删除历史")
                }
            }
            .padding(.vertical, 3)
            .onHover { isHovered = $0 }
        }
    }

    private var horizontalSeparator: some View {
        Rectangle()
            .fill(Color(nsColor: .separatorColor))
            .frame(height: separatorWidth)
            .allowsHitTesting(false)
    }

    private var separatorWidth: CGFloat { 1 / displayScale }
}

private struct ClosableSessionSidebarRow: View {
    let session: ManagedSession
    let terminalSession: LocalTerminalSession?
    let structuredSession: LocalStructuredAgentSession?
    let isSelected: Bool
    let closeAction: () -> Void
    @State private var isHovered = false

    var body: some View {
        HStack(spacing: 4) {
            SessionSidebarRow(
                session: session,
                terminalSession: terminalSession,
                structuredSession: structuredSession
            )
            Spacer(minLength: 4)
            Button(action: closeAction) {
                Image(systemName: "xmark")
                    .font(.caption.weight(.semibold))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .opacity(isHovered || isSelected ? 1 : 0)
            .allowsHitTesting(isHovered || isSelected)
            .help("关闭会话")
            .accessibilityLabel("关闭会话")
        }
        .onHover { isHovered = $0 }
    }
}

private struct SessionSidebarRow: View {
    let session: ManagedSession
    let terminalSession: LocalTerminalSession?
    let structuredSession: LocalStructuredAgentSession?

    @ViewBuilder
    var body: some View {
        if let terminalSession {
            ActiveSessionSidebarRow(session: session, activeSession: terminalSession)
        } else if let structuredSession {
            StructuredSessionSidebarRow(session: session, activeSession: structuredSession)
        } else {
            SessionSidebarRowContent(
                session: session,
                title: session.displayName,
                state: session.state
            )
        }
    }
}

private struct StructuredSessionSidebarRow: View {
    let session: ManagedSession
    @ObservedObject var activeSession: LocalStructuredAgentSession

    var body: some View {
        SessionSidebarRowContent(
            session: session,
            title: session.displayName,
            state: activeSession.state.sidebarState
        )
    }
}

private struct ActiveSessionSidebarRow: View {
    let session: ManagedSession
    @ObservedObject var activeSession: LocalTerminalSession

    var body: some View {
        SessionSidebarRowContent(
            session: session,
            title: session.displayName,
            state: activeSession.state
        )
    }
}

private extension StructuredSessionState {
    var sidebarState: SessionState {
        switch self {
        case .created, .starting: .starting
        case .ready, .running, .awaitingApproval, .awaitingUserInput, .interrupting, .degraded: .running
        case .finished: .finished
        case .failed: .failed
        }
    }
}

private struct SessionSidebarRowContent: View {
    let session: ManagedSession
    let title: String
    let state: SessionState

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: toolIcon)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(isRunning ? Color.accentColor : .secondary)
                .frame(width: 24, height: 24)
                .background(isRunning ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 6))

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 5) {
                    Circle()
                        .fill(stateColor)
                        .frame(width: 6, height: 6)
                    Text(toolName)
                    Text("·")
                    Text(state.rawValue)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
        .help(session.directory.path)
    }

    private var isRunning: Bool { state == .running }

    private var toolName: String {
        BuiltInTool(rawValue: session.toolID)?.displayName ?? session.toolID
    }

    private var toolIcon: String {
        switch BuiltInTool(rawValue: session.toolID) {
        case .codex: "sparkles"
        case .copilot: "chevron.left.forwardslash.chevron.right"
        case .dsh: "brain.head.profile"
        default: "terminal"
        }
    }

    private var stateColor: Color {
        switch state {
        case .running: .green
        case .starting, .stopping: .orange
        case .finished: .secondary
        case .failed: .red
        }
    }
}

private struct ConnectionFooter: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var isShowingErrorDetail = false

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(appModel.connectionState.color)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text("Server \(appModel.connectionState.label)")
                    .font(.caption.weight(.medium))
                if let errorMessage = appModel.errorMessage {
                    Button {
                        isShowingErrorDetail = true
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(errorMessage)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 8, weight: .semibold))
                        }
                        .font(.caption2)
                        .foregroundStyle(.red)
                    }
                    .buttonStyle(.plain)
                    .help("点击查看并复制完整错误信息")
                    .popover(isPresented: $isShowingErrorDetail, arrowEdge: .bottom) {
                        ErrorDiagnosticPopover(message: errorMessage)
                    }
                }
            }
            Spacer()
            SettingsLink {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.borderless)
            .help("Server 设置")
        }
        .padding(12)
    }
}

private struct ErrorDiagnosticPopover: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("错误详情", systemImage: "xmark.octagon.fill")
                    .font(.headline)
                    .foregroundStyle(.red)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(message, forType: .string)
                } label: {
                    Label("复制", systemImage: "doc.on.doc")
                }
            }

            ScrollView {
                Text(message)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(16)
        .frame(width: 460, height: 240)
    }
}
