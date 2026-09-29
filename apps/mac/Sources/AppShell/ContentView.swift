import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel
    @State private var selectedSessionID: UUID?
    @State private var sidebarTab: SessionSidebarTab = .active
    @State private var isPresentingNewSession = false
    @State private var isPresentingQuickActions = false
    @State private var sessionPendingClose: ManagedSession?
    @State private var historyPendingDelete: CopilotHistorySession?
    @State private var purgeHistoryData = false
    @State private var isDeletingHistory = false
    @State private var historyDeleteError: String?

    var body: some View {
        HSplitView {
            SessionSidebar(
                sessions: visibleSessions,
                copilotHistory: appModel.copilotHistory,
                terminalSessions: appModel.terminalSessions,
                structuredSessions: appModel.structuredSessions,
                selection: $selectedSessionID,
                tab: $sidebarTab,
                addAction: { isPresentingNewSession = true },
                shortcutAction: { isPresentingQuickActions = true },
                closeAction: requestCloseSession,
                deleteHistoryAction: { archive in
                    purgeHistoryData = false
                    historyDeleteError = nil
                    historyPendingDelete = archive
                }
            )
            .frame(minWidth: 220, idealWidth: 260, maxWidth: 320)

            sessionDetail
                .frame(minWidth: 580, maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .windowBackgroundColor))
        }
        .frame(minWidth: 900, minHeight: 600)
        .overlay(alignment: .topTrailing) {
            ApprovalToastCenter(selectedSessionID: $selectedSessionID)
                .padding(.top, 12)
                .padding(.trailing, 16)
        }
        .sheet(isPresented: $isPresentingNewSession) {
            NewSessionSheet(
                didCreate: {
                    if let sessionID = appModel.startLocalSession() {
                        selectedSessionID = sessionID
                    }
                },
                didResume: { savedSession in
                    if let sessionID = appModel.startLocalSession(resuming: savedSession) {
                        selectedSessionID = sessionID
                    }
                }
            )
            .environmentObject(appModel)
        }
        .sheet(isPresented: $isPresentingQuickActions) {
            QuickActionManageView()
                .environmentObject(appModel)
        }
        .sheet(item: $historyPendingDelete) { archive in
            VStack(alignment: .leading, spacing: 16) {
                Text("删除历史会话？").font(.headline)
                Text(archive.displayName)
                Text(archive.id.uuidString)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Toggle("同时永久删除数据库关联数据", isOn: $purgeHistoryData)
                    .disabled(isDeletingHistory)
                Text(purgeHistoryData
                     ? "会话、终端事件、命令和审批记录将无法恢复。"
                     : "仅从 Web 和 Mac 历史列表隐藏；数据库历史数据仍然保留。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let historyDeleteError {
                    Text(historyDeleteError).foregroundStyle(.red)
                }
                HStack {
                    Spacer()
                    Button("取消") { historyPendingDelete = nil }
                        .disabled(isDeletingHistory)
                    Button(isDeletingHistory ? "删除中…" : "确认删除", role: .destructive) {
                        isDeletingHistory = true
                        Task {
                            do {
                                try await appModel.deleteCopilotHistory(archive, purge: purgeHistoryData)
                                historyPendingDelete = nil
                            } catch {
                                historyDeleteError = error.localizedDescription
                            }
                            isDeletingHistory = false
                        }
                    }
                    .disabled(isDeletingHistory)
                }
            }
            .padding(24)
            .frame(width: 420)
            .interactiveDismissDisabled(isDeletingHistory)
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
            selectedSessionID = appModel.sessions.last?.id ?? appModel.copilotHistory.first?.id
        }
        .onChange(of: visibleSessions.map(\.id) + appModel.copilotHistory.map(\.id)) { _, sessionIDs in
            guard let selectedSessionID, sessionIDs.contains(selectedSessionID) else {
                self.selectedSessionID = sidebarTab == .history
                    ? appModel.copilotHistory.first?.id
                    : visibleSessions.last?.id
                return
            }
        }
        .onChange(of: selectedSessionID) { _, id in
            if appModel.copilotHistory.contains(where: { $0.id == id }) {
                sidebarTab = .history
            } else if visibleSessions.contains(where: { $0.id == id }) {
                sidebarTab = .active
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
                displayName: selectedSession?.displayName ?? "Agent"
            )
        } else if let selectedSession {
            SessionSummaryView(session: selectedSession) {
                isPresentingNewSession = true
            }
        } else if let archive = appModel.copilotHistory.first(where: { $0.id == selectedSessionID }) {
            CopilotHistoryView(archive: archive) {
                if let id = await appModel.importCopilotHistory(archive) {
                    selectedSessionID = id
                    return true
                }
                return false
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

private struct ApprovalToastEntry: Identifiable {
    let session: LocalStructuredAgentSession
    let sessionName: String
    let request: ApprovalRequest

    var id: String { "\(session.id.uuidString):\(request.approvalID)" }
}

private struct ApprovalToastCenter: View {
    @EnvironmentObject private var appModel: AppModel
    @Binding var selectedSessionID: UUID?
    @State private var isExpanded = true

    private var entries: [ApprovalToastEntry] {
        appModel.pendingApprovals.bySession.flatMap { sessionID, requests -> [ApprovalToastEntry] in
            guard let session = appModel.structuredSessions[sessionID] else { return [] }
            let name = appModel.sessions.first(where: { $0.id == sessionID })?.displayName ?? "Agent"
            return requests.values.map {
                ApprovalToastEntry(session: session, sessionName: name, request: $0)
            }
        }
        .sorted {
            $0.request.expiresAt == $1.request.expiresAt
                ? $0.id < $1.id
                : $0.request.expiresAt < $1.request.expiresAt
        }
    }

    var body: some View {
        Group {
            if !entries.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        isExpanded.toggle()
                    } label: {
                        HStack {
                            Label("待审批 \(entries.count)", systemImage: "checkmark.shield")
                                .font(.headline)
                            Spacer()
                            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isExpanded ? "收起待审批消息" : "展开待审批消息")

                    if isExpanded {
                        ScrollView {
                            LazyVStack(spacing: 8) {
                                ForEach(entries) { entry in
                                    AgentApprovalToast(
                                        request: entry.request,
                                        session: entry.session,
                                        sessionName: entry.sessionName,
                                        showSession: { selectedSessionID = entry.session.id }
                                    )
                                    .id(entry.id)
                                }
                            }
                        }
                        .frame(maxHeight: 460)
                    }
                }
                .padding(10)
                .frame(width: 380)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(.separator) }
                .shadow(radius: 12, y: 5)
            }
        }
        .onChange(of: entries.map(\.id)) { old, new in
            if !Set(new).isSubset(of: Set(old)) { isExpanded = true }
        }
    }
}

private struct CopilotHistoryView: View {
    @EnvironmentObject private var appModel: AppModel
    let archive: CopilotHistorySession
    let resume: () async -> Bool
    @State private var error: String?
    @State private var importing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading) {
                    Text(archive.displayName).font(.headline)
                    Text(archive.directory?.path ?? "原工作目录未知")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("历史记录 · 无法直接向旧会话发送消息")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("最多读取最近 1000 条事件；过期的历史无法恢复。新会话会在第一条消息中参考这些记录。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("以历史创建新 Copilot 会话") {
                    importing = true
                    Task {
                        let success = await resume()
                        error = success ? nil : appModel.errorMessage
                        importing = false
                    }
                }
                .disabled(importing || archive.directory == nil || appModel.connectionState != .connected)
            }
            if appModel.historyLoadingID == archive.id || importing {
                ProgressView()
            }
            if let error { Text(error).foregroundStyle(.red) }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(Array((appModel.historyMessages[archive.id] ?? []).enumerated()), id: \.offset) { _, message in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(message.role).font(.caption.bold()).foregroundStyle(.secondary)
                            Text(message.text).textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: archive.id) {
            do { _ = try await appModel.loadCopilotHistory(archive) }
            catch { self.error = error.localizedDescription }
        }
    }
}

private struct StructuredAgentSessionView: View {
    private static let timelineBottomID = "structured-agent-timeline-bottom"

    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalStructuredAgentSession
    let displayName: String
    @State private var configurationError: String?

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
                Button("停止", role: .destructive) { appModel.stopLocalTerminal(id: session.id) }
                    .disabled([.finished, .failed].contains(session.state))
            }
            .padding()
            .background(Color(nsColor: .windowBackgroundColor))
            .overlay(alignment: .bottom) { Divider() }

            if let failure = session.failureMessage {
                Label(failure, systemImage: "xmark.octagon")
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(visibleTimeline) { item in
                            AgentTimelineRow(item: item, session: session)
                                .id(item.id)
                        }
                        if session.state == .running {
                            AgentTurnLoadingBubble()
                                .id("turn-loading-bubble")
                        }
                        Color.clear
                            .frame(height: 1)
                            .id(Self.timelineBottomID)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
                }
                .onAppear {
                    DispatchQueue.main.async {
                        proxy.scrollTo(Self.timelineBottomID, anchor: .bottom)
                    }
                }
                .onChange(of: appModel.connectionState) { _, state in
                    guard state == .connected else { return }
                    DispatchQueue.main.async {
                        proxy.scrollTo(Self.timelineBottomID, anchor: .bottom)
                    }
                }
                .onChange(of: visibleTimeline.last?.id) { _, id in
                    guard id != nil else { return }
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(Self.timelineBottomID, anchor: .bottom)
                    }
                }
                .onChange(of: session.state) { _, state in
                    guard state == .running else { return }
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(Self.timelineBottomID, anchor: .bottom)
                    }
                }
            }
            .background(Color(nsColor: .textBackgroundColor))

            VStack(alignment: .trailing, spacing: 10) {
                if !session.configurationOptions.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(session.configurationOptions, id: \.id) { option in
                            if option.choices.isEmpty && option.id == "model" {
                                TextField("模型 ID", text: $session.manualModelDraft)
                                    .textFieldStyle(.roundedBorder)
                                    .frame(maxWidth: 220)
                                Button("切换模型") { submitManualModel() }
                                    .disabled(session.state != .ready || session.configurationUpdating || !validManualModel)
                            } else if !option.choices.isEmpty {
                                Picker(option.name, selection: Binding(
                                    get: { option.currentValue },
                                    set: { value in
                                        Task {
                                            let result = await session.setConfiguration(id: option.id, value: value)
                                            configurationError = result.message
                                        }
                                    }
                                )) {
                                    ForEach(option.choices, id: \.value) { choice in
                                        Text(choice.name).tag(choice.value)
                                    }
                                }
                                .fixedSize()
                                .disabled(session.state != .ready || session.configurationUpdating)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
                if let configurationError {
                    Text(configurationError).font(.caption).foregroundStyle(.red)
                }
                TextEditor(text: $session.promptDraft)
                    .font(.body)
                    .frame(minHeight: 56, maxHeight: 110)
                    .overlay { RoundedRectangle(cornerRadius: 6).stroke(.separator) }
                    .onKeyPress(phases: .down) { keyPress in
                        guard keyPress.key == .return,
                              appModel.acpSendShortcut.matches(keyPress.modifiers) else {
                            return .ignored
                        }
                        submitPrompt()
                        return .handled
                    }
                HStack {
                    Text("发送快捷键：\(appModel.acpSendShortcut.displayName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Toggle("自动审批通过", isOn: Binding(
                        get: { session.autoApproveEnabled },
                        set: { appModel.setAutoApprove(sessionID: session.id, enabled: $0) }
                    ))
                        .toggleStyle(.checkbox)
                        .font(.caption)
                        .disabled(appModel.connectionState != .connected)
                        .help("开关由 Server 按会话保存，审批只在此 Mac 执行一次")
                    Button("中断当前任务") { Task { _ = await session.interrupt() } }
                        .buttonStyle(.bordered)
                        .tint(.orange)
                        .disabled(![.running, .awaitingApproval, .awaitingUserInput].contains(session.state))
                        .help("取消本次发送后正在执行的任务；不会关闭会话，也不能从中断处继续")
                    Button("发送并执行") { submitPrompt() }
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSend)
                }
            }
            .padding()
            .background(Color(nsColor: .windowBackgroundColor))
            .overlay(alignment: .top) { Divider() }
        }
    }

    private var canSend: Bool {
        !session.promptDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && session.state == .ready
    }

    private var visibleTimeline: [AgentTimelineItem] {
        session.timeline.filter {
            if case .approval = $0 { return false }
            return true
        }
    }

    private var validManualModel: Bool {
        let value = session.manualModelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !value.isEmpty && value.count <= 128 && value.allSatisfy {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-")
        }
    }

    private func submitManualModel() {
        guard session.state == .ready, validManualModel else { return }
        let model = session.manualModelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        session.manualModelDraft = ""
        Task {
            let result = await session.startTurn("/model --session \(model)", idempotencyKey: UUID())
            configurationError = result.message
        }
    }

    private func submitPrompt() {
        guard canSend else { return }
        let text = session.promptDraft
        session.promptDraft = ""
        Task { _ = await session.startTurn(text, idempotencyKey: UUID()) }
    }

}

private extension ACPSendShortcut {
    func matches(_ modifiers: EventModifiers) -> Bool {
        let command = modifiers.contains(.command)
        let control = modifiers.contains(.control)
        let option = modifiers.contains(.option)
        let shift = modifiers.contains(.shift)
        switch self {
        case .commandEnter: return command && !control && !option && !shift
        case .controlEnter: return !command && control && !option && !shift
        case .optionEnter: return !command && !control && option && !shift
        case .shiftEnter: return !command && !control && !option && shift
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
                    Text(message.role == .user ? "你" : "Agent")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    if message.role == .assistant {
                        AgentMarkdownView(text: message.text)
                    } else {
                        Text(message.text).textSelection(.enabled)
                    }
                }
                .padding(12)
                .background(message.role == .user ? Color.accentColor.opacity(0.16) : Color(nsColor: .controlBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                if message.role == .assistant { Spacer(minLength: 30) }
            }
        case .reasoning(_, let text):
            DisclosureGroup("思考过程") {
                AgentMarkdownView(text: text).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
            }
            .padding(10)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 9))
        case .plan(_, let text):
            AgentCard(title: "计划", icon: "list.bullet.clipboard") {
                AgentMarkdownView(text: text)
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
        case .approval:
            EmptyView()
        case .userInput(let input):
            AgentUserInputCard(value: input, session: session)
        case .notice(_, let text, let isError):
            Label(text, systemImage: isError ? "xmark.octagon.fill" : "checkmark.circle")
                .font(.callout)
                .foregroundStyle(isError ? Color.red : Color.secondary)
        }
    }
}

private struct AgentTurnLoadingBubble: View {
    @State private var isAnimating = false

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 4) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                        .scaleEffect(isAnimating ? 1 : 0.5)
                        .opacity(isAnimating ? 1 : 0.35)
                        .animation(
                            .easeInOut(duration: 0.6)
                                .repeatForever(autoreverses: true)
                                .delay(Double(index) * 0.15),
                            value: isAnimating
                        )
                }
            }
            Text("正在处理…")
                .font(.callout.weight(.medium))
                .foregroundStyle(Color.accentColor)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.accentColor.opacity(0.12))
        .clipShape(Capsule())
        .overlay {
            Capsule()
                .stroke(Color.accentColor.opacity(isAnimating ? 0.55 : 0.15), lineWidth: 1.2)
                .animation(
                    .easeInOut(duration: 1.2).repeatForever(autoreverses: true),
                    value: isAnimating
                )
        }
        .onAppear { isAnimating = true }
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

private struct AgentApprovalToast: View {
    let request: ApprovalRequest
    @ObservedObject var session: LocalStructuredAgentSession
    let sessionName: String
    let showSession: () -> Void
    @State private var submittingDecision: ApprovalDecision?
    @State private var submissionError: String?
    @State private var isShowingFullDetail = false

    var body: some View {
        AgentCard(title: request.title, icon: "checkmark.shield") {
            HStack {
                Button(sessionName, action: showSession)
                    .buttonStyle(.link)
                    .lineLimit(1)
                Spacer()
                Text(riskLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(request.risk == .critical || request.risk == .high
                        ? Color.red : Color.orange)
            }
            if let detail = request.detail {
                Text(detail)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(isShowingFullDetail ? nil : 6)
                    .textSelection(.enabled)
                Button(isShowingFullDetail ? "收起详情" : "展开完整详情") {
                    isShowingFullDetail.toggle()
                }
                .buttonStyle(.link)
                .font(.caption)
            }
            if request.availableDecisions.isEmpty {
                Text("Agent 未提供可用的审批操作")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { timeline in
                    if request.expiresAt <= timeline.date {
                        Text("审批已过期，等待 Agent 更新")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else {
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                            ForEach(request.availableDecisions, id: \.rawValue) { decision in
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
            if let submittingDecision {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("正在提交：\(decisionLabel(submittingDecision))")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            if let submissionError {
                Text(submissionError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
    }

    private func decisionButton(_ decision: ApprovalDecision) -> some View {
        Button(decisionLabel(decision), role: decision == .deny ? .destructive : nil) {
            Task {
                submissionError = nil
                submittingDecision = decision
                let result = await session.resolveApproval(
                    approvalID: request.approvalID,
                    turnID: request.turnID,
                    decision: decision
                )
                submittingDecision = nil
                if !result.succeeded {
                    submissionError = result.message ?? "审批提交失败，请重试。"
                }
            }
        }
        .disabled(
            submittingDecision != nil || session.state != .awaitingApproval
                || request.expiresAt <= Date()
        )
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

    private var riskLabel: String {
        switch request.risk {
        case .low: "低风险"
        case .medium: "中风险"
        case .high: "高风险"
        case .critical: "严重风险"
        }
    }
}

private struct AgentUserInputCard: View {
    let value: AgentUserInputViewState
    @ObservedObject var session: LocalStructuredAgentSession

    private var selected: [String: String] {
        session.userInputSelections[value.request.requestID] ?? [:]
    }

    private var custom: [String: String] {
        session.userInputCustomAnswers[value.request.requestID] ?? [:]
    }

    var body: some View {
        AgentCard(title: "Agent 需要你的回答", icon: "questionmark.bubble") {
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
                        let result = await session.resolveUserInput(
                            requestID: value.request.requestID,
                            turnID: value.request.turnID,
                            answers: answers
                        )
                        if result.succeeded {
                            session.userInputSelections[value.request.requestID] = nil
                            session.userInputCustomAnswers[value.request.requestID] = nil
                        }
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
        Binding(
            get: { selected[id] ?? "" },
            set: { session.userInputSelections[value.request.requestID, default: [:]][id] = $0 }
        )
    }

    private func customBinding(for id: String) -> Binding<String> {
        Binding(
            get: { custom[id] ?? "" },
            set: { session.userInputCustomAnswers[value.request.requestID, default: [:]][id] = $0 }
        )
    }
}

private struct ActiveSessionView: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var session: LocalTerminalSession
    let displayName: String

    var body: some View {
        VStack(spacing: 0) {
            SessionToolbar(session: session, displayName: displayName)

            LocalTerminalPane(
                session: session,
                connectionState: appModel.connectionState
            )
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
        .background(Color(nsColor: .windowBackgroundColor))
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct LocalTerminalPane: View {
    @ObservedObject var session: LocalTerminalSession
    let connectionState: ConnectionState

    var body: some View {
        VStack(spacing: 8) {
            TerminalContainerView(session: session, connectionState: connectionState)
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
