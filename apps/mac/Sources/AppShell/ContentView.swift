import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var selectedSessionID: UUID?
    @State private var isPresentingNewSession = false
    @State private var closedSessionIDs: Set<UUID> = []
    @State private var sessionPendingClose: ManagedSession?

    var body: some View {
        NavigationSplitView {
            SessionSidebar(
                sessions: visibleSessions,
                activeSession: appModel.activeTerminalSession,
                selection: $selectedSessionID,
                addAction: { isPresentingNewSession = true },
                closeAction: requestCloseSession
            )
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            sessionDetail
        }
        .frame(minWidth: 900, minHeight: 600)
        .sheet(isPresented: $isPresentingNewSession) {
            NewSessionSheet {
                appModel.startLocalTerminal()
                selectedSessionID = appModel.activeTerminalSession?.id
            }
            .environmentObject(appModel)
        }
        .alert(
            "关闭会话？",
            isPresented: Binding(
                get: { sessionPendingClose != nil },
                set: { if !$0 { sessionPendingClose = nil } }
            )
        ) {
            Button("取消", role: .cancel) {
                sessionPendingClose = nil
            }
            Button("关闭", role: .destructive) {
                confirmCloseSession()
            }
        } message: {
            if let sessionPendingClose {
                Text("关闭“\(sessionPendingClose.directory.lastPathComponent)”将终止其中正在运行的终端进程。")
            }
        }
        .onAppear {
            selectedSessionID = appModel.activeTerminalSession?.id ?? appModel.sessions.last?.id
        }
        .onChange(of: appModel.activeTerminalSession?.id) { _, activeID in
            if let activeID { selectedSessionID = activeID }
        }
        .onChange(of: visibleSessions.map(\.id)) { _, sessionIDs in
            guard let selectedSessionID, sessionIDs.contains(selectedSessionID) else {
                self.selectedSessionID = appModel.activeTerminalSession?.id ?? sessionIDs.last
                return
            }
        }
    }

    @ViewBuilder
    private var sessionDetail: some View {
        if let session = selectedTerminalSession {
            ActiveSessionView(session: session)
        } else if let selectedSession {
            SessionSummaryView(session: selectedSession) {
                isPresentingNewSession = true
            }
        } else {
            EmptySessionView {
                isPresentingNewSession = true
            }
        }
    }

    private var selectedTerminalSession: LocalTerminalSession? {
        guard let activeSession = appModel.activeTerminalSession else { return nil }
        guard selectedSessionID == nil || selectedSessionID == activeSession.id else { return nil }
        return activeSession
    }

    private var selectedSession: ManagedSession? {
        guard let selectedSessionID else { return nil }
        return visibleSessions.first { $0.id == selectedSessionID }
    }

    private var visibleSessions: [ManagedSession] {
        appModel.sessions.filter { !closedSessionIDs.contains($0.id) }
    }

    private func requestCloseSession(_ sessionID: UUID) {
        sessionPendingClose = visibleSessions.first { $0.id == sessionID }
    }

    private func confirmCloseSession() {
        guard let sessionID = sessionPendingClose?.id else { return }
        sessionPendingClose = nil
        if appModel.activeTerminalSession?.id == sessionID {
            appModel.closeLocalTerminal()
        }
        closedSessionIDs.insert(sessionID)
        selectedSessionID = visibleSessions.last?.id
    }
}

private struct ActiveSessionView: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalTerminalSession

    var body: some View {
        VStack(spacing: 0) {
            SessionToolbar(session: session)

            LocalTerminalPane(session: session)
                .padding(14)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct SessionToolbar: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalTerminalSession

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(session.title)
                    .font(.headline)
                    .lineLimit(1)
                Text(session.currentDirectory)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(session.currentDirectory)
            }

            Spacer(minLength: 16)

            Button {
                session.sendInterrupt()
            } label: {
                Label("中断", systemImage: "stop.circle")
            }
            .disabled(session.state != .running)
            .help("向当前终端发送 Ctrl-C")

            Button(role: .destructive) {
                appModel.stopLocalTerminal()
            } label: {
                Label("停止", systemImage: "xmark.circle")
            }
            .disabled(session.state != .running)

            if session.tool == .shell {
                Button {
                    session.runVisualProbe()
                } label: {
                    Image(systemName: "testtube.2")
                }
                .help("输出 ANSI、TrueColor、中文、Emoji 和 PTY 尺寸探针")
            }

            SettingsLink {
                Image(systemName: "gearshape")
            }
            .help("设置")
        }
        .buttonStyle(.bordered)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct LocalTerminalPane: View {
    @ObservedObject var session: LocalTerminalSession

    var body: some View {
        VStack(spacing: 8) {
            TerminalContainerView(session: session)
                .id(session.id)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .overlay {
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(.separator, lineWidth: 1)
                }

            HStack(spacing: 12) {
                Label("PTY \(session.state.rawValue)", systemImage: "terminal")
                Spacer()
                Text("\(session.probeSnapshot.totalBytes) B")
                Text("\(session.probeSnapshot.batchCount) batches")
                Text("seq \(session.probeSnapshot.lastSequence)")
            }
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
        }
    }
}

private struct SessionSummaryView: View {
    let session: ManagedSession
    let newSessionAction: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(session.directory.lastPathComponent, systemImage: "rectangle.stack")
        } description: {
            Text("已选择该会话。当前多终端运行时正在独立开发，接入后将在这里切换对应终端。")
        } actions: {
            Button("创建新会话", action: newSessionAction)
        }
    }
}

private struct EmptySessionView: View {
    let newSessionAction: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("还没有终端会话", systemImage: "terminal")
        } description: {
            Text("从左侧边栏点击添加按钮，选择工作目录和工具。")
        } actions: {
            Button(action: newSessionAction) {
                Label("创建新会话", systemImage: "plus")
            }
            .keyboardShortcut("n", modifiers: [.command])
        }
    }
}
