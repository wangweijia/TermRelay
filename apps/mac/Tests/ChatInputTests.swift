import AppKit
import SwiftUI
import XCTest
@testable import TermRelay

final class ChatInputTests: XCTestCase {
    @MainActor
    func testInputWrapsLongLinesAndOnlyScrollsVertically() async throws {
        var draft = String(repeating: "a", count: 2_000) + "\n"
            + String(repeating: "long-path/中文😀", count: 100)
        let host = NSHostingView(rootView: AttachmentTextEditor(
            text: Binding(get: { draft }, set: { draft = $0 }), disabled: false,
            onFiles: { _ in }, onImage: { _ in }, onKey: { _ in false }
        ))
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 360, height: 110),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        await settle(host)
        let view = try XCTUnwrap(textView(in: host))
        let scroll = try XCTUnwrap(view.enclosingScrollView)
        XCTAssertFalse(scroll.hasHorizontalScroller)
        XCTAssertEqual(scroll.horizontalScrollElasticity, .none)
        XCTAssertFalse(view.isHorizontallyResizable)
        for width in [360.0, 240.0, 600.0] {
            window.setContentSize(NSSize(width: width, height: 110))
            await settle(host)
            let manager = try XCTUnwrap(view.layoutManager)
            let container = try XCTUnwrap(view.textContainer)
            manager.ensureLayout(for: container)
            XCTAssertLessThanOrEqual(view.frame.width, scroll.contentSize.width + 1)
            XCTAssertGreaterThan(manager.usedRect(for: container).height, scroll.contentSize.height)
            view.setSelectedRange(NSRange(location: (draft as NSString).length, length: 0))
            view.scrollRangeToVisible(view.selectedRange())
            XCTAssertEqual(scroll.contentView.bounds.minX, 0, accuracy: 0.5)
            XCTAssertGreaterThan(scroll.contentView.bounds.minY, 0, "Vertical scrolling must remain available.")
        }
    }

    @MainActor
    func testRefreshPreservesMarkedTextAndSelectionUntilCommit() async throws {
        var draft = "问题："
        func editor() -> AttachmentTextEditor {
            AttachmentTextEditor(text: Binding(get: { draft }, set: { draft = $0 }), disabled: false,
                                 onFiles: { _ in }, onImage: { _ in }, onKey: { _ in false })
        }
        let host = NSHostingView(rootView: editor())
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 400, height: 160),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        await settle(host)
        let view = try XCTUnwrap(textView(in: host))
        window.makeFirstResponder(view)
        view.setSelectedRange(NSRange(location: (draft as NSString).length, length: 0))
        view.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
                           replacementRange: NSRange(location: NSNotFound, length: 0))
        let composingText = view.string
        let markedRange = view.markedRange()
        let selection = view.selectedRange()
        XCTAssertTrue(view.hasMarkedText())
        XCTAssertNotEqual(draft, composingText, "Uncommitted input can be ahead of the SwiftUI draft.")

        for _ in 0..<3 {
            host.rootView = editor()
            await settle(host)
            XCTAssertTrue(textView(in: host) === view, "Refreshing must reuse the editor.")
            XCTAssertTrue(view.hasMarkedText(), "Refreshing must not end IME composition.")
            XCTAssertEqual(view.string, composingText)
            XCTAssertEqual(view.markedRange(), markedRange)
            XCTAssertEqual(view.selectedRange(), selection)
            XCTAssertTrue(window.firstResponder === view)
        }

        draft = composingText
        host.rootView = editor()
        await settle(host)
        XCTAssertTrue(view.hasMarkedText(), "Matching preedit text must not reset editor state either.")
        XCTAssertEqual(view.markedRange(), markedRange)
        XCTAssertEqual(view.selectedRange(), selection)

        view.insertText("中", replacementRange: view.markedRange())
        XCTAssertFalse(view.hasMarkedText())
        XCTAssertEqual(draft, "问题：中")
        host.rootView = editor()
        await settle(host)
        XCTAssertEqual(view.string, draft)

        draft = ""
        host.rootView = editor()
        await settle(host)
        XCTAssertEqual(view.string, "", "A successful send must still clear the committed draft.")
    }

    @MainActor
    func testReturnDuringCompositionDoesNotInvokeSendShortcut() async throws {
        var draft = ""
        var shortcutCalls = 0
        let host = NSHostingView(rootView: AttachmentTextEditor(
            text: Binding(get: { draft }, set: { draft = $0 }), disabled: false,
            onFiles: { _ in }, onImage: { _ in },
            onKey: { _ in shortcutCalls += 1; return true }
        ))
        let window = NSWindow(contentRect: NSRect(x: -10_000, y: -10_000, width: 400, height: 160),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        await settle(host)
        let view = try XCTUnwrap(textView(in: host))
        window.makeFirstResponder(view)
        for modifiers: NSEvent.ModifierFlags in [[], .command, .control] {
            view.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0),
                               replacementRange: NSRange(location: NSNotFound, length: 0))
            let event = try XCTUnwrap(NSEvent.keyEvent(
                with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                windowNumber: window.windowNumber, context: nil, characters: "\r",
                charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36
            ))
            view.keyDown(with: event)
            XCTAssertEqual(shortcutCalls, 0, "Candidate confirmation belongs to the input method.")
            view.unmarkText()
        }
        let event = try XCTUnwrap(NSEvent.keyEvent(
            with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36
        ))
        view.keyDown(with: event)
        XCTAssertEqual(shortcutCalls, 1, "The normal send shortcut must still work after composition.")
    }

    @MainActor
    private func settle(_ host: NSView) async {
        for _ in 0..<4 {
            host.layoutSubtreeIfNeeded()
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    @MainActor
    private func textView(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.lazy.compactMap { self.textView(in: $0) }.first
    }
}
