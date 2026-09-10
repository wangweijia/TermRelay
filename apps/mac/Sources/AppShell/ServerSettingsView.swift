import SwiftUI

struct ServerSettingsView: View {
    @EnvironmentObject private var appModel: AppModel

    var body: some View {
        Form {
            TextField("Server WebSocket URL", text: $appModel.serverURL)
            LabeledContent("Device ID", value: appModel.deviceID.uuidString)
            Button("重新连接") { appModel.reconnectToServer() }
        }
        .formStyle(.grouped)
        .padding()
        .frame(width: 520)
    }
}
