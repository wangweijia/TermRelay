import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var selectedSessionID: UUID?
    @State private var isPresentingNewSession = false
    @State private var sessionPendingClose: ManagedSession?

    var body: some View {
        NavigationSplitView {
            SessionSidebar(
                sessions: visibleSessions,
                terminalSessions: appModel.terminalSessions,
                structuredSessions: appModel.structuredSessions,
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
                if let sessionID = appModel.startLocalSession() {
                    selectedSessionID = sessionID
                }
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
                Text("关闭“\(sessionPendingClose.displayName)”将终止其中正在运行的终端进程。")
            }
        }
        .onAppear {
            selectedSessionID = appModel.sessions.last?.id
        }
        .onChange(of: visibleSessions.map(\.id)) { _, sessionIDs in
            guard let selectedSessionID, sessionIDs.contains(selectedSessionID) else {
                self.selectedSessionID = sessionIDs.last
                return
            }
        }
    }

    @ViewBuilder
    private var sessionDetail: some View {
        if let session = selectedTerminalSession {
            ActiveSessionView(
                session: session,
                displayName: selectedSession?.displayName ?? session.title
            )
        } else if let session = selectedStructuredSession {
            StructuredAgentSessionView(
                session: session,
                displayName: selectedSession?.displayName ?? "Codex Agent"
            )
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
        guard let selectedSessionID else { return nil }
        return appModel.terminalSession(id: selectedSessionID)
    }

    private var selectedSession: ManagedSession? {
        guard let selectedSessionID else { return nil }
        return visibleSessions.first { $0.id == selectedSessionID }
    }

    private var selectedStructuredSession: LocalStructuredAgentSession? {
        guard let selectedSessionID else { return nil }
        return appModel.structuredSession(id: selectedSessionID)
    }

    private var visibleSessions: [ManagedSession] {
        appModel.sessions
    }

    private func requestCloseSession(_ sessionID: UUID) {
        sessionPendingClose = visibleSessions.first { $0.id == sessionID }
    }

    private func confirmCloseSession() {
        guard let sessionID = sessionPendingClose?.id else { return }
        sessionPendingClose = nil
        appModel.closeLocalTerminal(id: sessionID)
        selectedSessionID = visibleSessions.last?.id
    }
}

private struct StructuredAgentSessionView: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalStructuredAgentSession
    let displayName: String
    @State private var prompt = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(displayName).font(.headline)
                    Text(session.directory.path).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Label("ACP \(session.state.rawValue)", systemImage: "sparkles")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Button("中断") { Task { _ = await session.interrupt() } }
                    .disabled(![.running, .awaitingApproval, .awaitingUserInput].contains(session.state))
                Button("停止", role: .destructive) { appModel.stopLocalTerminal(id: session.id) }
                    .disabled([.finished, .failed].contains(session.state))
            }
            .padding()
            .background(.bar)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(session.timeline) { item in
                            AgentTimelineRow(item: item, session: session)
                                .id(item.id)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
                }
                .onChange(of: session.timeline.last?.id) { _, id in
                    guard let id else { return }
                    withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .background(Color(nsColor: .textBackgroundColor))

            HStack(alignment: .bottom, spacing: 10) {
                TextEditor(text: $prompt)
                    .font(.body)
                    .frame(minHeight: 56, maxHeight: 110)
                    .overlay { RoundedRectangle(cornerRadius: 6).stroke(.separator) }
                Button("发送") {
                    let text = prompt
                    prompt = ""
                    Task { _ = await session.startTurn(text, idempotencyKey: UUID()) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.state != .ready)
            }
            .padding()
        }
    }
}

private struct AgentTimelineRow: View {
    let item: AgentTimelineItem
    @ObservedObject var session: LocalStructuredAgentSession

    @ViewBuilder
    var body: some View {
        switch item {
        case .message(let message):
            HStack {
                if message.role == .user { Spacer(minLength: 80) }
                VStack(alignment: .leading, spacing: 5) {
                    Text(message.role == .user ? "你" : "Codex")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(message.text).textSelection(.enabled)
                }
                .padding(12)
                .background(message.role == .user ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                if message.role == .assistant { Spacer(minLength: 30) }
            }
        case .reasoning(_, let text):
            DisclosureGroup("思考过程") {
                Text(text).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            }
            .padding(10).background(.quaternary).clipShape(RoundedRectangle(cornerRadius: 9))
        case .plan(_, let text):
            AgentCard(title: "计划", icon: "list.bullet.clipboard") {
                Text(text).textSelection(.enabled)
            }
        case .command(let command):
            AgentCard(
                title: command.isRunning ? "命令执行中" : "命令已完成",
                icon: command.isRunning ? "gearshape.2" : "terminal"
            ) {
                Text(command.command.isEmpty ? "等待命令详情…" : command.command)
                    .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                if !command.output.isEmpty {
                    ScrollView {
                        Text(command.output)
                            .font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .frame(maxHeight: 220)
                }
                if !command.isRunning { Text("退出码：\(command.exitCode.map(String.init) ?? "—")").font(.caption) }
            }
        case .fileChange(let file):
            AgentCard(title: "文件变更", icon: "doc.badge.gearshape") {
                Text(file.summary).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
        case .approval(let approval):
            AgentApprovalCard(value: approval, session: session)
        case .userInput(let input):
            AgentUserInputCard(value: input, session: session)
        case .notice(_, let text, let isError):
            Label(text, systemImage: isError ? "xmark.octagon.fill" : "checkmark.circle")
                .font(.callout)
                .foregroundStyle(isError ? Color.red : Color.secondary)
        }
    }
}

private struct AgentCard<Content: View>: View {
    let title: String
    let icon: String
    let content: Content

    init(title: String, icon: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.icon = icon
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: icon).font(.headline)
            content
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(.separator) }
    }
}

private struct AgentApprovalCard: View {
    let value: AgentApprovalViewState
    @ObservedObject var session: LocalStructuredAgentSession

    var body: some View {
        AgentCard(title: value.request.title, icon: "checkmark.shield") {
            if let detail = value.request.detail {
                Text(detail).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
            if let decision = value.decision {
                Text("已处理：\(decisionLabel(decision))").font(.caption).foregroundStyle(.secondary)
            } else {
                HStack {
                    ForEach(value.request.availableDecisions, id: \.rawValue) { decision in
                        if decision == .allowOnce {
                            decisionButton(decision).buttonStyle(.borderedProminent)
                        } else {
                            decisionButton(decision).buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
    }

    private func decisionButton(_ decision: ApprovalDecision) -> some View {
        Button(decisionLabel(decision), role: decision == .deny ? .destructive : nil) {
            Task {
                _ = await session.resolveApproval(
                    approvalID: value.request.approvalID,
                    turnID: value.request.turnID,
                    decision: decision
                )
            }
        }
    }

    private func decisionLabel(_ decision: ApprovalDecision) -> String {
        switch decision {
        case .allowOnce: "允许一次"
        case .allowSession: "本会话允许"
        case .allowPolicy: "允许并应用规则"
        case .deny: "拒绝"
        case .cancel: "取消"
        }
    }
}

private struct AgentUserInputCard: View {
    let value: AgentUserInputViewState
    @ObservedObject var session: LocalStructuredAgentSession
    @State private var selected: [String: String] = [:]
    @State private var custom: [String: String] = [:]

    var body: some View {
        AgentCard(title: "Codex 需要你的回答", icon: "questionmark.bubble") {
            if let answers = value.answers {
                ForEach(value.request.questions, id: \.id) { question in
                    Text("\(question.header)：\(answers[question.id]?.joined(separator: "、") ?? "—")")
                }
            } else {
                ForEach(value.request.questions, id: \.id) { question in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(question.header).font(.headline)
                        Text(question.question).font(.callout)
                        if !question.options.isEmpty {
                            Picker(question.header, selection: binding(for: question.id)) {
                                Text("请选择").tag("")
                                ForEach(question.options, id: \.label) { option in
                                    Text(option.label).tag(option.label)
                                }
                            }
                            .labelsHidden()
                        }
                        if question.allowsOther || question.options.isEmpty {
                            if question.isSecret {
                                SecureField("输入回答", text: customBinding(for: question.id))
                            } else {
                                TextField("输入回答", text: customBinding(for: question.id))
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                Button("提交回答") {
                    let answers = Dictionary(uniqueKeysWithValues: value.request.questions.map { question in
                        let answer = custom[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines)
                        return (question.id, [answer?.isEmpty == false ? answer! : selected[question.id] ?? ""])
                    })
                    Task {
                        _ = await session.resolveUserInput(
                            requestID: value.request.requestID,
                            turnID: value.request.turnID,
                            answers: answers
                        )
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(!hasAllAnswers)
            }
        }
    }

    private var hasAllAnswers: Bool {
        value.request.questions.allSatisfy { question in
            custom[question.id]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
                || selected[question.id]?.isEmpty == false
        }
    }

    private func binding(for id: String) -> Binding<String> {
        Binding(get: { selected[id] ?? "" }, set: { selected[id] = $0 })
    }

    private func customBinding(for id: String) -> Binding<String> {
        Binding(get: { custom[id] ?? "" }, set: { custom[id] = $0 })
    }
}

private struct ActiveSessionView: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalTerminalSession
    let displayName: String

    var body: some View {
        VStack(spacing: 0) {
            SessionToolbar(session: session, displayName: displayName)

            LocalTerminalPane(session: session)
                .padding(14)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct SessionToolbar: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalTerminalSession
    let displayName: String

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
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
                appModel.stopLocalTerminal(id: session.id)
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
            Label(session.displayName, systemImage: "rectangle.stack")
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
