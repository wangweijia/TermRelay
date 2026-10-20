import AppKit
import SwiftUI

struct AgentTranscriptBottomMarker: NSViewRepresentable {
    @Environment(\.agentTextInteraction) private var interaction

    func makeNSView(context: Context) -> NSView { NSView(frame: .zero) }

    func updateNSView(_ view: NSView, context: Context) {
        interaction?.timelineEnd = view
    }
}

struct AgentTranscriptScrollObserver: NSViewRepresentable {
    let sessionID: UUID
    let interaction: AgentTextInteraction
    let scrollToEnd: () -> Void

    func makeNSView(context: Context) -> AgentTranscriptScrollAnchor {
        AgentTranscriptScrollAnchor(frame: .zero)
    }

    func updateNSView(_ view: AgentTranscriptScrollAnchor, context: Context) {
        view.configure(sessionID: sessionID, interaction: interaction, scrollToEnd: scrollToEnd)
    }

    static func dismantleNSView(_ view: AgentTranscriptScrollAnchor, coordinator: ()) {
        view.stopObserving()
    }
}

@MainActor
final class AgentTranscriptScrollAnchor: NSView {
    private struct FollowLayout: Equatable {
        let documentBounds: NSRect
        let end: NSRect
        let viewportSize: NSSize
    }

    private weak var scrollView: NSScrollView?
    private weak var observedDocument: NSView?
    private weak var interaction: AgentTextInteraction?
    private var sessionID: UUID?
    private var followScheduled = false
    private var isUserScrolling = false
    private var scrollToEnd: (() -> Void)?
    private var isStopped = false
    private var viewportSize: NSSize?
    private var lastFollowLayout: FollowLayout?
    private(set) var followsEnd = true

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil {
            scheduleFollow()
        } else {
            detach()
        }
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        if superview != nil { scheduleFollow() }
    }

    func configure(sessionID: UUID, interaction: AgentTextInteraction, scrollToEnd: @escaping () -> Void) {
        isStopped = false
        if self.sessionID != sessionID {
            self.sessionID = sessionID
            followsEnd = true
            lastFollowLayout = nil
        }
        self.interaction = interaction
        self.scrollToEnd = scrollToEnd
        scheduleFollow()
    }

    func attach(to scrollView: NSScrollView) {
        guard let document = scrollView.documentView else { return }
        guard self.scrollView !== scrollView || observedDocument !== scrollView.documentView else { return }
        detach()
        self.scrollView = scrollView
        observedDocument = document
        viewportSize = scrollView.contentView.bounds.size
        document.postsFrameChangedNotifications = true
        scrollView.contentView.postsFrameChangedNotifications = true
        scrollView.contentView.postsBoundsChangedNotifications = true
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(layoutChanged), name: NSView.frameDidChangeNotification,
                           object: document)
        center.addObserver(self, selector: #selector(layoutChanged), name: NSView.frameDidChangeNotification,
                           object: scrollView.contentView)
        center.addObserver(self, selector: #selector(boundsChanged), name: NSView.boundsDidChangeNotification,
                           object: scrollView.contentView)
        center.addObserver(self, selector: #selector(userScrollStarted), name: NSScrollView.willStartLiveScrollNotification,
                           object: scrollView)
        center.addObserver(self, selector: #selector(userScrolled), name: NSScrollView.didLiveScrollNotification,
                           object: scrollView)
        center.addObserver(self, selector: #selector(userScrollEnded), name: NSScrollView.didEndLiveScrollNotification,
                           object: scrollView)
    }

    private func detach() {
        NotificationCenter.default.removeObserver(self)
        scrollView = nil
        observedDocument = nil
        isUserScrolling = false
        viewportSize = nil
        lastFollowLayout = nil
    }

    func stopObserving() {
        isStopped = true
        detach()
        scrollToEnd = nil
    }

    @objc private func layoutChanged(_ notification: Notification) {
        scheduleFollow()
    }

    @objc private func boundsChanged(_ notification: Notification) {
        guard let size = scrollView?.contentView.bounds.size, size != viewportSize else { return }
        viewportSize = size
        scheduleFollow()
    }

    @objc private func userScrollStarted(_ notification: Notification) {
        isUserScrolling = true
    }

    @objc private func userScrolled(_ notification: Notification) {
        recordUserScroll()
    }

    @objc private func userScrollEnded(_ notification: Notification) {
        recordUserScroll()
        isUserScrolling = false
        scheduleFollow()
    }

    func recordUserScroll() {
        guard let scrollView, let document = scrollView.documentView else { return }
        let visible = scrollView.documentVisibleRect
        let end = endRect(in: document, scrollView: scrollView)
        let gap = document.isFlipped ? end.maxY - visible.maxY : visible.minY - end.minY
        followsEnd = gap <= 32
    }

    private func endRect(in document: NSView, scrollView: NSScrollView) -> NSRect {
        if let marker = interaction?.timelineEnd, marker.enclosingScrollView === scrollView {
            return marker.convert(marker.bounds, to: document)
        }
        return document.bounds
    }

    private func scheduleFollow() {
        guard !isStopped, !followScheduled else { return }
        followScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.followScheduled = false
            guard !self.isStopped else { return }
            if let enclosingScrollView = self.enclosingScrollView {
                self.attach(to: enclosingScrollView)
            }
            self.scrollToEndIfNeeded()
        }
    }

    func scrollToEndIfNeeded() {
        guard followsEnd, !isUserScrolling, interaction?.preventsAutomaticScroll != true,
              let scrollView, let document = scrollView.documentView else { return }
        scrollView.layoutSubtreeIfNeeded()
        let clip = scrollView.contentView
        let end = endRect(in: document, scrollView: scrollView)
        let layout = FollowLayout(documentBounds: document.bounds, end: end, viewportSize: clip.bounds.size)
        // A changed scroll origin alone is not new content; leave native rebound scrolling alone.
        guard layout != lastFollowLayout else { return }
        lastFollowLayout = layout
        let y = document.isFlipped
            ? max(document.bounds.minY, end.maxY - clip.bounds.height)
            : max(document.bounds.minY, end.minY)
        guard abs(clip.bounds.minY - y) > 0.5 else { return }
        // SwiftUI must perform the scroll so LazyVStack also updates its realized rows.
        scrollToEnd?()
    }
}
