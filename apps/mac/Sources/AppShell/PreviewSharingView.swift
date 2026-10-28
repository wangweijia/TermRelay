import SwiftUI

struct PreviewSharingButton: View {
    @ObservedObject var sharing: PreviewSharingController
    @ObservedObject var session: LocalStructuredAgentSession
    let displayName: String
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented = true
        } label: {
            Label(sharing.isRunning && sharing.sessionID == session.id ? "管理共享与反馈" : "共享预览与反馈",
                  systemImage: sharing.isRunning && sharing.sessionID == session.id ? "dot.radiowaves.left.and.right" : "square.and.arrow.up")
        }
        .help("此入口固定绑定本项目会话，不随窗口选择自动切换。")
        .sheet(isPresented: $isPresented) {
            PreviewSharingView(sharing: sharing, session: session, displayName: displayName)
        }
    }
}

private struct PreviewSharingView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var sharing: PreviewSharingController
    @ObservedObject var session: LocalStructuredAgentSession
    let displayName: String
    @State private var ports = "8080"
    @State private var publicPort = "18420"
    @State private var ownerPort = "18421"
    @State private var addresses = PreviewSharingConfiguration.localAddresses()
    @State private var shareHost = ""
    @State private var selectedTab = "setup"
    @State private var error: String?
    @State private var notice: String?
    @State private var pendingDelivery: PreviewFeedback?
    @State private var isConfirmingStop = false

    private var isBoundHere: Bool { sharing.sessionID == session.id }
    private var anotherActive: Bool {
        !isBoundHere && (sharing.isRunning || sharing.isStarting || sharing.isStopping)
    }
    private var canStart: Bool {
        appModel.connectionState == .connected && session.state == .ready
            && !sharing.isRunning && !sharing.isStarting && !sharing.isStopping && !anotherActive
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("共享预览与反馈").font(.title2.bold())
                    Text("\(displayName) · \(session.directory.lastPathComponent)").font(.headline)
                }
                Spacer()
                Button("完成") { dismiss() }
            }
            Text("反馈固定送到这个会话；业务方不需要选择会话或知道会话 ID。")
                .foregroundStyle(.secondary)
            if anotherActive {
                Label("“\(sharing.sessionName)”正在共享；先停止它才能共享当前项目。", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                Button("停止另一个项目的共享") { isConfirmingStop = true }
            }
            Picker("管理", selection: $selectedTab) {
                Text("共享与配对").tag("setup")
                Text("页面反馈 \(isBoundHere ? sharing.feedback.filter { $0.status == "pending" }.count : 0)").tag("feedback")
            }.pickerStyle(.segmented)
            if selectedTab == "setup" { setup } else { feedback }
            if let message = error ?? sharing.errorMessage {
                Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    .lineLimit(5)
            }
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(24)
        .frame(width: 720, height: 680)
        .onAppear { shareHost = addresses.first ?? "" }
        .alert("把此反馈交给当前项目会话？", isPresented: Binding(
            get: { pendingDelivery != nil }, set: { if !$0 { pendingDelivery = nil } }
        )) {
            Button("取消", role: .cancel) { pendingDelivery = nil }
            Button("确认修改") {
                guard let record = pendingDelivery else { return }
                pendingDelivery = nil
                Task { await sharing.deliver(record) }
            }
        } message: {
            Text("目标：\(displayName)。请确认没有其他会话同时修改这个项目。工具权限沿用此会话的审批设置，不会自动重试。")
        }
        .alert("停止共享？", isPresented: $isConfirmingStop) {
            Button("取消", role: .cancel) {}
            Button("停止共享", role: .destructive) {
                Task { await sharing.stop(reason: "共享已停止；项目会话和已启动的 AI 轮次不会因此终止。") }
            }
        } message: {
            Text("业务方将无法继续通过代理访问或提交反馈。已开始的 AI 修改不会被取消，请到项目会话核实结果。")
        }
    }

    private var setup: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("1. 当前项目") {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(session.directory.path).textSelection(.enabled)
                        Text("会话：\(displayName) · \(session.state.rawValue)").font(.caption)
                        Text("此窗口绑定创建时的会话，不会跟随主窗口切换。一次只共享一个项目。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                GroupBox("2. 开放本机预览") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("项目端口，例如 8080,8081", text: $ports)
                            .disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                        HStack {
                            Text("业务方连接的本机地址")
                            Picker("局域网地址", selection: $shareHost) {
                                Text("请选择").tag("")
                                ForEach(addresses, id: \.self) { Text($0).tag($0) }
                            }.labelsHidden()
                            Button("重新检测") {
                                addresses = PreviewSharingConfiguration.localAddresses()
                                if !addresses.contains(shareHost) { shareHost = addresses.first ?? "" }
                            }
                        }.disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                        Text("保留 page-gateway-local.nioint.com 和项目原端口，使用项目已有 HTTPS。仅授权这里列出的端口。")
                            .font(.caption).foregroundStyle(.secondary)
                        DisclosureGroup("高级设置") {
                            TextField("共享服务端口", text: $publicPort)
                            TextField("本机管理端口", text: $ownerPort)
                            HStack {
                                Text(sharing.nodePath.isEmpty ? "Node.js 22+：自动查找" : sharing.nodePath)
                                    .font(.caption).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Button("选择 Node…") {
                                    let panel = NSOpenPanel()
                                    panel.canChooseDirectories = false
                                    panel.canChooseFiles = true
                                    if panel.runModal() == .OK, let url = panel.url { sharing.nodePath = url.path }
                                }
                            }
                        }.disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                        HStack {
                            if isBoundHere && sharing.isRunning {
                                Label("共享已开启", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                                Spacer()
                                Button("停止共享", role: .destructive) { isConfirmingStop = true }
                            } else {
                                Button(sharing.isStarting ? "正在启动…" : "开启共享") {
                                    error = nil
                                    Task {
                                        do {
                                            let configuration = try PreviewSharingConfiguration(
                                                serverURL: appModel.serverURL, ports: ports,
                                                publicPort: publicPort, ownerPort: ownerPort, shareHost: shareHost)
                                            try await appModel.startPreviewSharing(sessionID: session.id, configuration: configuration)
                                        } catch { self.error = error.localizedDescription }
                                    }
                                }.buttonStyle(.borderedProminent).disabled(!canStart)
                                if appModel.connectionState != .connected {
                                    Text("请先连接 Server").font(.caption).foregroundStyle(.secondary)
                                } else if session.state != .ready {
                                    Text("等待当前会话就绪 / 空闲").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }.padding(6)
                }
                GroupBox("3. 发给业务方") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("先安装 Chrome 插件，再将配对配置粘贴到扩展设置。只分享给可信验收者。")
                        HStack {
                            Button("显示插件目录") {
                                do { try sharing.showExtension() } catch { self.error = error.localizedDescription }
                            }
                            Button("复制插件配对配置") {
                                do {
                                    let value = try sharing.pairingJSON()
                                    NSPasteboard.general.clearContents()
                                    NSPasteboard.general.setString(value, forType: .string)
                                    notice = "已复制，只包含验收者和代理凭据，不含管理凭据。"
                                } catch { self.error = error.localizedDescription }
                            }.disabled(!isBoundHere || !sharing.isRunning)
                        }
                        if isBoundHere && sharing.isRunning {
                            ForEach(sharing.previewURLs, id: \.self) { Text($0).font(.caption.monospaced()).textSelection(.enabled) }
                        }
                        Text("每个 URL 后接项目原路径。共享配置不是网址；插件设置中导入配置后再访问页面。")
                            .font(.caption).foregroundStyle(.secondary)
                        Text("试用版仅用于受信局域网。插件的其他域名走 DIRECT，请使用独立 Chrome Profile。停止后重新开启会恢复原配对；尚无在线撤销。")
                            .font(.caption).foregroundStyle(.orange)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
            }
        }
    }

    private var feedback: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("插件提交后出现在这里；点击确认才发送给当前会话。").font(.caption)
                Spacer()
                Button("刷新") {
                    Task { do { try await sharing.refresh() } catch { self.error = error.localizedDescription } }
                }.disabled(!isBoundHere || !sharing.isRunning)
            }
            if !isBoundHere || sharing.feedback.isEmpty {
                ContentUnavailableView("暂无页面反馈", systemImage: "text.bubble",
                                       description: Text("开启共享并配对插件后，让业务方在页面选择元素并提交文字反馈。"))
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(sharing.feedback) { record in
                            PreviewFeedbackCard(record: record, sharing: sharing,
                                                canExecute: session.state == .ready && sharing.isRunning,
                                                requestExecution: { pendingDelivery = record })
                        }
                    }
                }
            }
            Text("“已送达”不是 AI 完成。请回到会话查看审批及修改结果，核实轮次结束后再交付验收。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct PreviewFeedbackCard: View {
    let record: PreviewFeedback
    @ObservedObject var sharing: PreviewSharingController
    let canExecute: Bool
    let requestExecution: () -> Void
    @State private var summary = ""
    @State private var confirmResolution = false
    @State private var resolutionFailed = false

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(record.statusLabel).font(.headline)
                    Spacer()
                    Text(String(record.id.prefix(8))).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
                Text(record.description).textSelection(.enabled)
                Text(record.page).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                if let element = record.element {
                    Text("元素：\(element.tag) · \(element.text)").font(.caption).lineLimit(3)
                }
                if !record.steps.isEmpty { Text("复现：\(record.steps)").font(.caption) }
                if !record.note.isEmpty { Text(record.note).font(.caption).textSelection(.enabled) }
                if record.status == "pending" {
                    Button("确认交给此会话修改", action: requestExecution)
                        .disabled(!canExecute || sharing.isSending || sharing.hasUnresolvedExecution)
                }
                if ["delivered", "unknown"].contains(record.status) {
                    TextField("核实结果后，填写给业务方看的摘要", text: $summary, axis: .vertical)
                        .lineLimit(2...4)
                    HStack {
                        Button("已完成，交业务方验收") { resolutionFailed = false; confirmResolution = true }
                        Button("已核实失败 / 未执行") { resolutionFailed = true; confirmResolution = true }
                    }.disabled(!sharing.isRunning || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if record.status == "changes_requested" {
                    Text("请在项目会话中继续处理；当前版本不会自动再次发送。").font(.caption).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
        }
        .alert("确认已在会话中核实执行结束？", isPresented: $confirmResolution) {
            Button("取消", role: .cancel) {}
            Button("确认") { Task { await sharing.resolve(record, summary: summary, failed: resolutionFailed) } }
        } message: {
            Text(resolutionFailed ? "记录将标为失败，不会自动重发。" : "记录将交业务方验收，不代表已经验收通过。")
        }
    }
}
