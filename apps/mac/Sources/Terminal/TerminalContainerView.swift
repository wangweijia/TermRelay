import SwiftUI

struct TerminalContainerView: NSViewRepresentable {
    let session: LocalTerminalSession
    let connectionState: ConnectionState

    final class Coordinator {
        var connectionState: ConnectionState?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> CapturingTerminalView {
        let view = session.terminalView
        context.coordinator.connectionState = connectionState
        DispatchQueue.main.async {
            session.startIfNeeded()
            view.scroll(toPosition: 1)
            view.window?.makeFirstResponder(view)
        }
        return view
    }

    func updateNSView(_ view: CapturingTerminalView, context: Context) {
        guard context.coordinator.connectionState != connectionState else { return }
        context.coordinator.connectionState = connectionState
        guard connectionState == .connected else { return }
        DispatchQueue.main.async {
            view.scroll(toPosition: 1)
        }
    }
}
