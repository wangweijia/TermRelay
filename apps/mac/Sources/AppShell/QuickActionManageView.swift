import AppKit
import SwiftUI

struct QuickActionManageView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft = QuickAction.draft(
        directory: FileManager.default.homeDirectoryForCurrentUser
    )
    @State private var error: String?
    @State private var pendingRun = false
    @State private var pendingDelete = false

    private var saved: QuickAction? {
        appModel.quickActions.first { $0.id == draft.id }
    }

    private var latestRun: QuickActionRun? {
        appModel.quickRuns.values
            .filter { $0.shortcutID == draft.id }
            .max { $0.startedAt < $1.startedAt }
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("快捷任务").font(.headline)
                    Spacer()
                    Button {
                        draft = .draft(directory: appModel.workingDirectory)
                        error = nil
                    } label: {
                        Label("新建", systemImage: "plus")
                    }
                }
                List(appModel.quickActions) { action in
                    Button {
                        draft = action
                        error = nil
                    } label: {
                        VStack(alignment: .leading) {
                            Text(action.name).font(.headline)
                            Text(action.directory.lastPathComponent)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(action.id == draft.id ? Color.accentColor.opacity(0.15) : Color.clear)
                }
                .listStyle(.plain)
            }
            .padding()
            .frame(width: 240)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Text(saved == nil ? "新建任务" : "编辑任务").font(.title3.bold())
                        Spacer()
                        Button("完成") { dismiss() }
                    }
                    TextField("名称（例如：部署项目）", text: $draft.name)
                    TextField("说明", text: $draft.description)
                    HStack {
                        Text(draft.directory.path)
                            .lineLimit(1).truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("选择工作目录…") { chooseDirectory() }
                    }
                    Text("命令（由本机 /bin/zsh -f -c 执行，不加载用户配置）")
                        .font(.callout.weight(.medium))
                    TextEditor(text: $draft.command)
                        .font(.system(.body, design: .monospaced))
                        .frame(height: 110)
                        .overlay { RoundedRectangle(cornerRadius: 5).stroke(.separator) }
                    Picker("代理", selection: $draft.proxy.mode) {
                        Text("跟随 App 环境").tag(ToolProxyMode.inherit)
                        Text("禁用").tag(ToolProxyMode.disabled)
                        Text("自定义").tag(ToolProxyMode.custom)
                    }
                    if draft.proxy.mode == .custom {
                        TextField("HTTP Proxy", text: $draft.proxy.httpProxy)
                        TextField("HTTPS Proxy", text: $draft.proxy.httpsProxy)
                        TextField("ALL Proxy", text: $draft.proxy.allProxy)
                        TextField("NO_PROXY", text: $draft.proxy.noProxy)
                    }
                    Toggle("每次执行前确认", isOn: $draft.requiresConfirmation)
                    Text("命令和代理地址仅保存在这台 Mac；Web 只能运行已保存的任务。")
                        .font(.caption).foregroundStyle(.secondary)
                    if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                    HStack {
                        Button("保存") { save() }
                        if saved != nil {
                            Button("试运行") { pendingRun = true }
                            Button("删除", role: .destructive) { pendingDelete = true }
                        }
                    }
                    if let latestRun {
                        Divider()
                        HStack {
                            Text("最近一次：\(latestRun.status)")
                            if let code = latestRun.exitCode { Text("退出码 \(code)") }
                            Spacer()
                            if latestRun.status == "running" {
                                Button("停止", role: .destructive) {
                                    appModel.cancelQuickAction(runID: latestRun.id)
                                }
                            }
                        }
                        Text(latestRun.output.isEmpty ? "暂无输出" : latestRun.output)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(20)
            }
        }
        .frame(width: 850, height: 600)
        .onAppear {
            if let first = appModel.quickActions.first { draft = first }
            else { draft = .draft(directory: appModel.workingDirectory) }
        }
        .alert("运行“\(saved?.name ?? "快捷任务")”？", isPresented: $pendingRun) {
            Button("取消", role: .cancel) {}
            Button("运行") {
                do {
                    _ = try appModel.runQuickAction(id: draft.id)
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
        } message: {
            Text("在 \(saved?.directory.path ?? "") 执行；代理模式：\(saved?.proxy.mode.rawValue ?? "")")
        }
        .alert("删除这个快捷任务？", isPresented: $pendingDelete) {
            Button("取消", role: .cancel) {}
            Button("删除", role: .destructive) {
                do {
                    try appModel.deleteQuickAction(id: draft.id)
                    draft = .draft(directory: appModel.workingDirectory)
                    error = nil
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }

    private func save() {
        do {
            try appModel.saveQuickAction(draft)
            if let updated = appModel.quickActions.first(where: { $0.id == draft.id }) {
                draft = updated
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func chooseDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.directoryURL = draft.directory
        if panel.runModal() == .OK, let url = panel.url { draft.directory = url }
    }
}
