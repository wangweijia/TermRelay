import SwiftUI

struct TerminalContainerView: NSViewRepresentable {
    let session: LocalTerminalSession

    func makeNSView(context: Context) -> CapturingTerminalView {
        let view = session.terminalView
        DispatchQueue.main.async {
            session.startIfNeeded()
            view.window?.makeFirstResponder(view)
        }
        return view
    }

    func updateNSView(_ view: CapturingTerminalView, context: Context) {}
}
