import AppKit
import SwiftUI
import XCTest
@testable import TermRelay

private final class FlippedTranscriptDocument: NSView {
    override var isFlipped: Bool { true }
}

private struct ScrollTestMessage: Identifiable {
    let id: Int
    var text: String
    var isCommand = false
}

private struct ScrollTestTranscript: View {
    var messages: [ScrollTestMessage]
    let sessionID: UUID
    let interaction: AgentTextInteraction

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    ForEach(messages) { message in
                        if message.isCommand {
                            AgentCommandOutputView(text: message.text)
                        } else {
                            AgentMarkdownView(text: message.text)
                        }
                    }
                    AgentTranscriptBottomMarker().frame(height: 1).id("bottom")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
                .background {
                    AgentTranscriptScrollObserver(sessionID: sessionID, interaction: interaction) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
        .environment(\.agentTextInteraction, interaction)
    }
}

final class AgentChatScrollingTests: XCTestCase {
    @MainActor
    func testLargeCommandOutputHasBoundedViewportAndCopiesMultipleLines() async throws {
        let scroll = AgentCommandOutputScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 220))
        let text = String(repeating: "命令输出😀: long output line\n", count: 5_000)
        scroll.update(text: text, interaction: AgentTextInteraction())
        let size = scroll.outputView.contentSize(for: 300, maximumHeight: 220)
        XCTAssertEqual(size.height, 220)
        scroll.layoutOutput()
        XCTAssertEqual(scroll.frame.height, 220)
        XCTAssertGreaterThan(scroll.outputView.frame.height, 220)
        XCTAssertEqual(scroll.documentVisibleRect.maxY, scroll.outputView.frame.maxY, accuracy: 1)
        XCTAssertEqual(scroll.outputView.string, text)
        let range = (text as NSString).range(of: "命令输出😀: long output line\n命令输出😀: long output line")
        scroll.outputView.setSelectedRange(range)
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertTrue(scroll.outputView.writeSelection(to: pasteboard, types: scroll.outputView.writablePasteboardTypes))
        XCTAssertEqual(pasteboard.string(forType: .string), (text as NSString).substring(with: range))
    }

    @MainActor
    func testCommandOutputFollowsAppendButPreservesReadingPositionAndSelection() async {
        let interaction = AgentTextInteraction()
        let scroll = AgentCommandOutputScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 220))
        let initial = String(repeating: "output line\n", count: 200)
        scroll.update(text: initial, interaction: interaction)
        scroll.layoutOutput()
        scroll.update(text: initial + "new line\n", interaction: interaction)
        scroll.layoutOutput()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, scroll.outputView.frame.maxY, accuracy: 1)

        scroll.contentView.scroll(to: CGPoint(x: 0, y: 100))
        scroll.recordUserScroll()
        XCTAssertTrue(interaction.preventsAutomaticScroll)
        scroll.isHidden = true
        XCTAssertFalse(interaction.preventsAutomaticScroll)
        scroll.isHidden = false
        scroll.update(text: initial + String(repeating: "new line\n", count: 30), interaction: interaction)
        scroll.layoutOutput()
        XCTAssertEqual(scroll.contentView.bounds.minY, 100, accuracy: 1)

        let selection = NSRange(location: 0, length: 20)
        scroll.outputView.setSelectedRange(selection)
        scroll.update(text: initial + String(repeating: "new line\n", count: 60), interaction: interaction)
        scroll.layoutOutput()
        XCTAssertEqual(scroll.outputView.selectedRange(), selection)
        XCTAssertEqual(scroll.contentView.bounds.minY, 100, accuracy: 1)

        scroll.outputView.setSelectedRange(NSRange(location: 0, length: 0))
        scroll.contentView.scroll(to: CGPoint(x: 0, y: scroll.outputView.frame.height - 220))
        scroll.recordUserScroll()
        XCTAssertFalse(interaction.preventsAutomaticScroll)
        scroll.update(text: initial + String(repeating: "new line\n", count: 70), interaction: interaction)
        scroll.layoutOutput()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, scroll.outputView.frame.maxY, accuracy: 1)
    }

    @MainActor
    func testCommandOutputMeasurementIsShortForSmallOutputAndDoesNotChangeLiveFrame() async {
        let scroll = AgentCommandOutputScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 220))
        scroll.update(text: "short output", interaction: nil)
        scroll.layoutOutput()
        let frame = scroll.outputView.frame
        let short = scroll.outputView.contentSize(for: 300, maximumHeight: 220)
        XCTAssertGreaterThan(short.height, 0)
        XCTAssertLessThan(short.height, 220)
        XCTAssertEqual(scroll.outputView.contentSize(for: 0, maximumHeight: 220), .zero)
        _ = scroll.outputView.contentSize(for: 30, maximumHeight: 220)
        XCTAssertEqual(scroll.outputView.frame, frame)
    }

    @MainActor
    func testTranscriptFollowsActualDocumentAfterGrowthAndShrink() async {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        let document = FlippedTranscriptDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 4_000))
        scroll.documentView = document
        let anchor = AgentTranscriptScrollAnchor(frame: .zero)
        let interaction = AgentTextInteraction()
        configure(anchor, scroll: scroll, interaction: interaction)
        anchor.attach(to: scroll)
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 4_000, accuracy: 1)
        document.setFrameSize(CGSize(width: 400, height: 8_000))
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 8_000, accuracy: 1)
        document.setFrameSize(CGSize(width: 400, height: 600))
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 600, accuracy: 1)
        XCTAssertLessThanOrEqual(scroll.contentView.bounds.maxY, document.frame.maxY + 1)
    }

    @MainActor
    func testTranscriptDoesNotPullReaderOrTextSelectionToBottom() async {
        let interaction = AgentTextInteraction()
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        let document = FlippedTranscriptDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 4_000))
        scroll.documentView = document
        let anchor = AgentTranscriptScrollAnchor(frame: .zero)
        configure(anchor, scroll: scroll, interaction: interaction)
        anchor.attach(to: scroll)
        anchor.scrollToEndIfNeeded()
        scroll.contentView.scroll(to: CGPoint(x: 0, y: 100))
        anchor.recordUserScroll()
        document.setFrameSize(CGSize(width: 400, height: 5_000))
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.contentView.bounds.minY, 100, accuracy: 1)

        scroll.contentView.scroll(to: CGPoint(x: 0, y: 4_600))
        anchor.recordUserScroll()
        let text = AgentSelectableTextView(frame: .zero)
        text.interaction = interaction
        text.update(text: "selected text", markdown: false, style: .body)
        text.setSelectedRange(NSRange(location: 0, length: 8))
        document.setFrameSize(CGSize(width: 400, height: 6_000))
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.contentView.bounds.minY, 4_600, accuracy: 1)
        text.setSelectedRange(NSRange(location: 0, length: 0))
        anchor.scrollToEndIfNeeded()
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 6_000, accuracy: 1)
    }

    @MainActor
    func testTranscriptRecognizesNativeLiveScrollNotifications() async {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        scroll.documentView = FlippedTranscriptDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 4_000))
        let interaction = AgentTextInteraction()
        let anchor = AgentTranscriptScrollAnchor(frame: .zero)
        configure(anchor, scroll: scroll, interaction: interaction)
        anchor.attach(to: scroll)
        anchor.scrollToEndIfNeeded()
        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        scroll.contentView.scroll(to: CGPoint(x: 0, y: 3_000))
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        XCTAssertLessThan(scroll.contentView.bounds.minY, 3_600)
        XCTAssertFalse(anchor.followsEnd)
        anchor.scrollToEndIfNeeded()
        XCTAssertLessThan(scroll.contentView.bounds.minY, 3_600)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
    }

    @MainActor
    func testTranscriptDoesNotCorrectElasticScrollingOrUnchangedLayout() async {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        scroll.documentView = FlippedTranscriptDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 4_000))
        let interaction = AgentTextInteraction()
        let anchor = AgentTranscriptScrollAnchor(frame: .zero)
        let sessionID = UUID()
        var corrections = 0
        let follow = {
            corrections += 1
            scroll.contentView.scroll(to: CGPoint(x: 0, y: 3_600))
        }
        anchor.configure(sessionID: sessionID, interaction: interaction, scrollToEnd: follow)
        anchor.attach(to: scroll)
        await settle(scroll)
        XCTAssertEqual(corrections, 1)

        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        scroll.contentView.setBoundsOrigin(CGPoint(x: 0, y: 3_640))
        NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: scroll)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        XCTAssertTrue(anchor.followsEnd)
        await settle(scroll)
        XCTAssertEqual(corrections, 1, "Native rubber-banding must not trigger another scrollTo.")

        scroll.contentView.setBoundsOrigin(CGPoint(x: 0, y: 3_580))
        anchor.configure(sessionID: sessionID, interaction: interaction, scrollToEnd: follow)
        NotificationCenter.default.post(name: NSView.frameDidChangeNotification, object: scroll.documentView)
        await settle(scroll)
        XCTAssertEqual(corrections, 1, "An unchanged layout must not snap a near-bottom reader back.")
        XCTAssertEqual(scroll.contentView.bounds.minY, 3_580, accuracy: 1)
        anchor.stopObserving()
    }

    @MainActor
    func testTranscriptFollowsGrowthAfterLiveScrollEndsAndViewportResizes() async {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 400, height: 400))
        let document = FlippedTranscriptDocument(frame: NSRect(x: 0, y: 0, width: 400, height: 4_000))
        scroll.documentView = document
        let anchor = AgentTranscriptScrollAnchor(frame: .zero)
        let interaction = AgentTextInteraction()
        configure(anchor, scroll: scroll, interaction: interaction)
        anchor.attach(to: scroll)
        await settle(scroll)

        NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: scroll)
        document.setFrameSize(CGSize(width: 400, height: 4_020))
        await settle(scroll)
        XCTAssertEqual(scroll.contentView.bounds.minY, 3_600, accuracy: 1)
        NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: scroll)
        await settle(scroll)
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 4_020, accuracy: 1)

        scroll.setFrameSize(CGSize(width: 400, height: 300))
        await settle(scroll)
        XCTAssertEqual(scroll.documentVisibleRect.maxY, 4_020, accuracy: 1)
        anchor.stopObserving()
    }

    @MainActor
    func testLazyTranscriptRemainsAtRealBottomDuringLongCommandUpdatesAndReordering() async throws {
        let sessionID = UUID()
        let interaction = AgentTextInteraction()
        var messages = (0..<70).map {
            ScrollTestMessage(id: $0, text: "Message \($0)\n" + String(repeating: "- wrapped line of text\n", count: $0 % 5 + 1))
        }
        let host = NSHostingView(rootView: ScrollTestTranscript(messages: messages, sessionID: sessionID, interaction: interaction))
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 600, height: 500),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        await settle(host)
        let anchor = try XCTUnwrap(descendants(host).compactMap { $0 as? AgentTranscriptScrollAnchor }.first)
        let scroll = try XCTUnwrap(anchor.enclosingScrollView)
        assertAtBottom(scroll, interaction: interaction)

        for index in 0..<6 {
            messages.append(ScrollTestMessage(
                id: 100 + index, text: String(repeating: "command output 中文😀\n", count: 3_000 + index * 100),
                isCommand: true
            ))
            host.rootView = ScrollTestTranscript(messages: messages, sessionID: sessionID, interaction: interaction)
            await settle(host)
            assertAtBottom(scroll, interaction: interaction)
            let outputs = descendants(host).compactMap { $0 as? AgentCommandOutputScrollView }
            XCTAssertFalse(outputs.isEmpty)
            XCTAssertTrue(outputs.allSatisfy { $0.frame.height <= 220 })
        }

        messages.append(ScrollTestMessage(id: 200, text: String(repeating: "- Long final answer\n", count: 100)))
        host.rootView = ScrollTestTranscript(messages: messages, sessionID: sessionID, interaction: interaction)
        await settle(host)
        assertAtBottom(scroll, interaction: interaction)
        let answer = messages.removeLast()
        messages.append(ScrollTestMessage(id: 201, text: "Completed"))
        messages.append(answer)
        host.rootView = ScrollTestTranscript(messages: messages, sessionID: sessionID, interaction: interaction)
        await settle(host)
        assertAtBottom(scroll, interaction: interaction)
        messages[messages.count - 1].text = "Short final answer"
        host.rootView = ScrollTestTranscript(messages: messages, sessionID: sessionID, interaction: interaction)
        await settle(host)
        assertAtBottom(scroll, interaction: interaction)
        window.setContentSize(CGSize(width: 360, height: 400))
        await settle(host)
        assertAtBottom(scroll, interaction: interaction)

        let document = try XCTUnwrap(scroll.documentView)
        let texts = descendants(host).compactMap { $0 as? AgentSelectableTextView }
        let visibleTexts = texts.filter {
            $0.convert($0.bounds, to: document).intersects(scroll.documentVisibleRect)
        }
        XCTAssertFalse(visibleTexts.isEmpty, """
        The viewport must contain message text, not an empty estimated region.
        document=\(document.frame) visible=\(scroll.documentVisibleRect)
        \(texts.map { "\($0.string.prefix(25)): \($0.convert($0.bounds, to: document)) visibleRect=\($0.visibleRect)" }.joined(separator: "\n"))
        """)
        XCTAssertTrue(visibleTexts.contains { $0.string == "Short final answer" })
    }

    @MainActor
    private func settle(_ host: NSView) async {
        for _ in 0..<8 {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    private func configure(_ anchor: AgentTranscriptScrollAnchor, scroll: NSScrollView, interaction: AgentTextInteraction) {
        anchor.configure(sessionID: UUID(), interaction: interaction) {
            guard let document = scroll.documentView else { return }
            scroll.contentView.scroll(to: CGPoint(x: 0, y: max(0, document.frame.height - scroll.contentView.bounds.height)))
        }
    }

    @MainActor
    private func descendants(_ view: NSView) -> [NSView] {
        [view] + view.subviews.flatMap { descendants($0) }
    }

    @MainActor
    private func assertAtBottom(
        _ scroll: NSScrollView, interaction: AgentTextInteraction, file: StaticString = #filePath, line: UInt = #line
    ) {
        guard let document = scroll.documentView, let end = interaction.timelineEnd else {
            XCTFail("Missing transcript document or bottom marker", file: file, line: line)
            return
        }
        XCTAssertTrue(scroll.contentView.bounds.minY.isFinite, file: file, line: line)
        XCTAssertEqual(scroll.documentVisibleRect.maxY, end.convert(end.bounds, to: document).maxY, accuracy: 1, file: file, line: line)
    }
}
