import AppKit
import SwiftUI

struct AgentCommandOutputView: NSViewRepresentable {
    let text: String
    @Environment(\.agentTextInteraction) private var interaction

    func makeNSView(context: Context) -> AgentCommandOutputScrollView {
        AgentCommandOutputScrollView(frame: .zero)
    }

    func updateNSView(_ view: AgentCommandOutputScrollView, context: Context) {
        view.update(text: text, interaction: interaction)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: AgentCommandOutputScrollView, context: Context) -> CGSize? {
        nsView.outputView.contentSize(for: proposal.width ?? 400, maximumHeight: AgentCommandOutputScrollView.maximumHeight)
    }
}

@MainActor
final class AgentCommandOutputScrollView: NSScrollView {
    static let maximumHeight: CGFloat = 220
    let outputView = AgentSelectableTextView(frame: .zero)
    private weak var interaction: AgentTextInteraction?
    private var followsEnd = true

    var isReadingEarlierOutput: Bool {
        !followsEnd && !visibleRect.isEmpty && !isHiddenOrHasHiddenAncestor
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        borderType = .noBorder
        drawsBackground = false
        hasVerticalScroller = true
        hasHorizontalScroller = false
        autohidesScrollers = true
        scrollerStyle = .overlay
        documentView = outputView
        NotificationCenter.default.addObserver(
            self, selector: #selector(didScrollOutput), name: NSScrollView.didLiveScrollNotification, object: self
        )
    }

    func update(text: String, interaction: AgentTextInteraction?) {
        self.interaction = interaction
        outputView.interaction = interaction
        outputView.update(text: text, markdown: false, style: .output)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        layoutOutput()
    }

    func layoutOutput() {
        let viewport = contentView.bounds
        guard viewport.width > 0, viewport.height > 0,
              let container = outputView.textContainer, let manager = outputView.layoutManager else { return }
        let origin = viewport.origin
        outputView.setFrameSize(CGSize(width: viewport.width, height: max(viewport.height, outputView.frame.height)))
        manager.ensureLayout(for: container)
        let height = max(viewport.height, ceil(manager.usedRect(for: container).height))
        outputView.setFrameSize(CGSize(width: viewport.width, height: height))
        let selecting = outputView.isSelecting || outputView.selectedRange().length > 0
        let y = followsEnd && !selecting ? height - viewport.height : min(origin.y, height - viewport.height)
        contentView.scroll(to: CGPoint(x: 0, y: max(0, y)))
        reflectScrolledClipView(contentView)
    }

    @objc private func didScrollOutput(_ notification: Notification) {
        recordUserScroll()
    }

    override func scrollWheel(with event: NSEvent) {
        super.scrollWheel(with: event)
        recordUserScroll()
    }

    func recordUserScroll() {
        followsEnd = outputView.frame.maxY - contentView.bounds.maxY <= 16
        if followsEnd {
            if interaction?.outputBeingRead === self { interaction?.outputBeingRead = nil }
        } else {
            interaction?.outputBeingRead = self
        }
    }
}
