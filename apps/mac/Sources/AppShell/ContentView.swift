import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Circle()
                    .fill(appModel.connectionState.color)
                    .frame(width: 9, height: 9)
                Text(appModel.connectionState.label)
                    .foregroundStyle(.secondary)
                Spacer()
                SettingsLink { Label("设置", systemImage: "gear") }
            }

            Text("TermRelay")
                .font(.system(size: 30, weight: .semibold, design: .rounded))
            Text("终端会话将在完成 PTY 探针后显示在这里。")
                .foregroundStyle(.secondary)

            if appModel.sessions.isEmpty {
                ContentUnavailableView(
                    "暂无会话",
                    systemImage: "terminal",
                    description: Text("从文件菜单创建第一个本地会话")
                )
            }
        }
        .padding(28)
        .frame(minWidth: 620, minHeight: 400)
    }
}

