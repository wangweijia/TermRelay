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
    @State private var previewURL = ""
    @State private var accessMode = "direct"
    @State private var publicPort = "18420"
    @State private var ownerPort = "18421"
    @State private var addresses = PreviewSharingConfiguration.localAddresses()
    @State private var shareHost = ""
    @State private var selectedTab = "setup"
    @State private var error: String?
    @State private var notice: String?
    @State private var isConfirmingStop = false

    private var isBoundHere: Bool { sharing.sessionID == session.id }
    private var anotherActive: Bool {
        !isBoundHere && (sharing.isRunning || sharing.isStarting || sharing.isStopping)
    }
    private var canStart: Bool {
        session.state == .ready
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
        .onAppear {
            if isBoundHere, let configuration = sharing.configuration {
                previewURL = configuration.previewURLs.first ?? ""
                accessMode = configuration.accessMode
                publicPort = String(configuration.publicPort)
                ownerPort = String(configuration.ownerPort)
                shareHost = configuration.shareHost
                if !addresses.contains(shareHost) { addresses.append(shareHost) }
            } else {
                shareHost = addresses.first ?? ""
            }
        }
        .alert("停止共享？", isPresented: $isConfirmingStop) {
            Button("取消", role: .cancel) {}
            Button("停止共享", role: .destructive) {
                Task { await sharing.stop(reason: "共享已停止；项目会话和已启动的 AI 轮次不会因此终止。") }
            }
        } message: {
            Text(accessMode == "direct"
                 ? "业务方将无法继续提交反馈；项目的直接访问不受影响。已开始的 AI 修改不会被取消。"
                 : "业务方将无法继续通过代理访问或提交反馈。已开始的 AI 修改不会被取消，请到项目会话核实结果。")
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
                        Text("开启共享即允许插件反馈自动进入此 Chat；AI 工具审批沿用此会话设置。整个 App 同时只接受一个插件实例。")
                            .font(.caption).foregroundStyle(.orange)
                        if isBoundHere && sharing.isRunning {
                            Label(sharing.pluginConnected ? "插件已连接" : "等待插件连接",
                                  systemImage: sharing.pluginConnected ? "link" : "link.badge.plus")
                                .font(.caption)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
                GroupBox("2. 项目访问与反馈连接") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("项目访问地址，例如 http://192.168.1.20:5173/ 或 https://project.test:8080/", text: $previewURL)
                            .disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                        Picker("访问方式", selection: $accessMode) {
                            Text("直接访问（默认）").tag("direct")
                            Text("通过开发者电脑代理").tag("proxy")
                        }.pickerStyle(.segmented)
                            .disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                        HStack {
                            Text("反馈服务局域网地址")
                            Picker("局域网地址", selection: $shareHost) {
                                Text("请选择").tag("")
                                ForEach(addresses, id: \.self) { Text($0).tag($0) }
                            }.labelsHidden()
                            Button("重新检测") {
                                addresses = PreviewSharingConfiguration.localAddresses()
                                if !addresses.contains(shareHost) { shareHost = addresses.first ?? "" }
                            }
                        }.disabled(sharing.isRunning || sharing.isStarting || sharing.isStopping)
                            Text(accessMode == "direct"
                                ? "验收者直接访问项目地址，插件只提交反馈，不修改 Chrome 代理或 ZeroOmega。"
                                : "仅代理填写的项目主机，各端口转发到开发者本机原端口；建议验收者使用专用 Chrome 用户配置。")
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
                                                previewURL: previewURL, accessMode: accessMode,
                                                publicPort: publicPort, ownerPort: ownerPort, shareHost: shareHost)
                                            try await appModel.startPreviewSharing(sessionID: session.id, configuration: configuration)
                                        } catch { self.error = error.localizedDescription }
                                    }
                                }.buttonStyle(.borderedProminent).disabled(!canStart)
                                if session.state != .ready {
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
                        Text("试用版仅用于受信局域网。停止后重新开启会恢复原配对；尚无在线撤销。")
                            .font(.caption).foregroundStyle(.orange)
                        if accessMode == "proxy" {
                            Text("代理模式允许通过项目主机连接本机全部 TCP 端口；其他域名直连，请使用专用 Chrome Profile。")
                                .font(.caption).foregroundStyle(.orange)
                        }
                        Text("网页访问与反馈均在本机和局域网内完成，不依赖 Server 连接或公网配对。")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
                }
            }
        }
    }

    private var feedback: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("插件反馈自动排队进入此 Chat；AI 工具审批保持原设置。").font(.caption)
                Spacer()
                Button("刷新") {
                    Task { do { try await sharing.synchronize() } catch { self.error = error.localizedDescription } }
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
                                                canExecute: session.state == .ready && sharing.isRunning)
                        }
                    }
                }
            }
            Text("开始、等待审批与完成状态自动同步到插件；完成仅代表本轮执行结束，不代表验收通过。未知结果须人工核实，不自动重发。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct PreviewFeedbackCard: View {
    let record: PreviewFeedback
    @ObservedObject var sharing: PreviewSharingController
    let canExecute: Bool
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
                if ["sending", "delivered", "unknown"].contains(record.status) {
                    TextField("核实结果后，填写给业务方看的摘要", text: $summary, axis: .vertical)
                        .lineLimit(2...4)
                    HStack {
                        Button("已完成，交业务方验收") { resolutionFailed = false; confirmResolution = true }
                        Button("已核实失败 / 未执行") { resolutionFailed = true; confirmResolution = true }
                    }.disabled(!canExecute || sharing.isSending || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if record.status == "changes_requested" {
                    Text("请在项目会话中继续处理；当前版本不会自动再次发送。").font(.caption).foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
        }
        .alert("确认已在会话中核实执行结束？", isPresented: $confirmResolution) {
            Button("取消", role: .cancel) {}
            Button("确认") { Task { await sharing.resolve(record, summary: summary, failed: resolutionFailed) } }
                .disabled(!canExecute || sharing.isSending)
        } message: {
            Text(resolutionFailed ? "记录将标为失败，不会自动重发。" : "记录将交业务方验收，不代表已经验收通过。")
        }
    }
}
