import SwiftUI

struct SessionSidebar: View {
    let sessions: [ManagedSession]
    let terminalSessions: [UUID: LocalTerminalSession]
    let structuredSessions: [UUID: LocalStructuredAgentSession]
    @Binding var selection: UUID?
    let addAction: () -> Void
    let closeAction: (UUID) -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("终端")
                    .font(.headline)
                Spacer()
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

            if sessions.isEmpty {
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
            } else {
                List(sessions, selection: $selection) { session in
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
                .listStyle(.sidebar)
            }

            Divider()
            ConnectionFooter()
        }
        .navigationTitle("TermRelay")
        .background(Color(nsColor: .controlBackgroundColor))
    }
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
        case .ready, .running, .awaitingApproval, .interrupting, .degraded: .running
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
        session.toolID == BuiltInTool.codex.rawValue ? "sparkles" : "terminal"
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

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(appModel.connectionState.color)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text("Server \(appModel.connectionState.label)")
                    .font(.caption.weight(.medium))
                if let errorMessage = appModel.errorMessage {
                    Text(errorMessage)
                        .font(.caption2)
                        .foregroundStyle(.red)
                        .lineLimit(2)
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
