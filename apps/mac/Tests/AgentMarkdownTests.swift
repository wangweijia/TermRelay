import AppKit
import SwiftUI
import XCTest
@testable import TermRelay

final class AgentMarkdownTests: XCTestCase {
    func testDetectsStructuredMarkdownButNotPlainOutput() {
        for value in [
            "# Heading", "Heading\n===", "- first\n- second", "```swift\nlet x = 1\n```",
            "| A | B |\n| --- | --- |", "**bold**", "*italic*", "_italic_", "[site](https://example.com)"
        ] {
            XCTAssertTrue(AgentMarkdown.containsMarkup(value), value)
        }
        for value in ["普通回答", "result: 42\nnext line", "a * b = c", "https://example.com"] {
            XCTAssertFalse(AgentMarkdown.containsMarkup(value), value)
        }
    }

    @MainActor
    func testMarkdownIsOneSelectableDocumentWithReadableBlocks() async throws {
        let rendered = AgentRichText.render("""
        # Heading

        Paragraph with **bold**, *italic*, ~~removed~~ and [site](https://example.com).

        - first
        - second
        > quote one
        > quote two

        ```swift
        let first = 1
        let second = 2
        ```
        """)
        XCTAssertEqual(rendered.string, """
        Heading
        Paragraph with bold, italic, removed and site.
        •\tfirst
        •\tsecond
        quote one
        quote two
        let first = 1
        let second = 2
        """)
        let plain = rendered.string as NSString
        let heading = try XCTUnwrap(rendered.attribute(.font, at: 0, effectiveRange: nil) as? NSFont)
        XCTAssertEqual(heading.pointSize, 22)
        let bold = try XCTUnwrap(rendered.attribute(.font, at: plain.range(of: "bold").location, effectiveRange: nil) as? NSFont)
        XCTAssertTrue(NSFontManager.shared.traits(of: bold).contains(.boldFontMask))
        let italic = try XCTUnwrap(rendered.attribute(.font, at: plain.range(of: "italic").location, effectiveRange: nil) as? NSFont)
        XCTAssertTrue(NSFontManager.shared.traits(of: italic).contains(.italicFontMask))
        XCTAssertEqual(rendered.attribute(.link, at: plain.range(of: "site").location, effectiveRange: nil) as? URL,
                       URL(string: "https://example.com"))
        XCTAssertNotNil(rendered.attribute(.strikethroughStyle, at: plain.range(of: "removed").location, effectiveRange: nil))
        let code = try XCTUnwrap(rendered.attribute(.font, at: plain.range(of: "let first").location, effectiveRange: nil) as? NSFont)
        XCTAssertTrue(code.isFixedPitch)
    }

    @MainActor
    func testTableUsesNativeCellsInTheSameDocument() async throws {
        let rendered = AgentRichText.render("Before\n\n| A | B |\n| --- | --- |\n| 中文 | 😀 |\n\nAfter")
        XCTAssertEqual(rendered.string, "Before\nA\nB\n中文\n😀\nAfter")
        let text = rendered.string as NSString
        let first = try XCTUnwrap(rendered.attribute(
            .paragraphStyle, at: text.range(of: "A\n").location, effectiveRange: nil
        ) as? NSParagraphStyle)
        let second = try XCTUnwrap(rendered.attribute(
            .paragraphStyle, at: text.range(of: "😀").location, effectiveRange: nil
        ) as? NSParagraphStyle)
        let firstCell = try XCTUnwrap(first.textBlocks.first as? NSTextTableBlock)
        let secondCell = try XCTUnwrap(second.textBlocks.first as? NSTextTableBlock)
        XCTAssertTrue(firstCell.table === secondCell.table)
        XCTAssertEqual(firstCell.table.numberOfColumns, 2)
        XCTAssertEqual(secondCell.startingRow, 1)
        XCTAssertEqual(secondCell.startingColumn, 1)
    }

    @MainActor
    func testCopySpansParagraphListCodeAndTableWithUnicode() async {
        let view = AgentSelectableTextView(frame: .zero)
        view.isEditable = false
        view.isSelectable = true
        view.update(text: "中文😀\n\n- one\n- two\n```\nline 1\nline 2\n```\n| A | B |\n| --- | --- |\n| C | D |",
                    markdown: true, style: .body)
        let expected = "中文😀\n•\tone\n•\ttwo\nline 1\nline 2\nA\nB\nC\nD\n"
        XCTAssertEqual(view.string, expected)
        view.setSelectedRange(NSRange(location: 0, length: (expected as NSString).length))
        let pasteboard = NSPasteboard.withUniqueName()
        defer { pasteboard.releaseGlobally() }
        XCTAssertEqual(view.selectedRange(), NSRange(location: 0, length: (expected as NSString).length))
        XCTAssertTrue(view.writeSelection(to: pasteboard, types: view.writablePasteboardTypes))
        XCTAssertEqual(pasteboard.string(forType: .string), expected)
    }

    @MainActor
    func testStreamingAppendPreservesSelectionAndDoesNotMoveFocus() async {
        let view = AgentSelectableTextView(frame: .zero)
        view.update(text: "中文😀\n- first\n- second", markdown: true, style: .body)
        let interaction = AgentTextInteraction()
        view.interaction = interaction
        let selection = (view.string as NSString).range(of: "中文😀\n•\tfirst")
        view.setSelectedRange(selection)
        XCTAssertTrue(interaction.preventsAutomaticScroll)
        view.update(text: "中文😀\n- first\n- second\n- third", markdown: true, style: .body)
        XCTAssertEqual(view.selectedRange(), selection)
        XCTAssertEqual((view.string as NSString).substring(with: view.selectedRange()), "中文😀\n•\tfirst")
        XCTAssertTrue(interaction.preventsAutomaticScroll)
        view.setSelectedRange(NSRange(location: 0, length: 0))
        XCTAssertFalse(interaction.preventsAutomaticScroll)
    }

    @MainActor
    func testSelectionTracksEarlierEditsAndClearsWhenSelectedTextIsRewritten() async {
        let view = AgentSelectableTextView(frame: .zero)
        view.update(text: "before\nselected😀\nafter", markdown: false, style: .body)
        view.setSelectedRange((view.string as NSString).range(of: "selected😀"))
        view.update(text: "longer before\nselected😀\nafter", markdown: false, style: .body)
        XCTAssertEqual((view.string as NSString).substring(with: view.selectedRange()), "selected😀")
        view.update(text: "longer before\nrewritten\nafter", markdown: false, style: .body)
        XCTAssertEqual(view.selectedRange().length, 0)
        view.update(text: "", markdown: false, style: .body)
        XCTAssertEqual(view.selectedRange(), NSRange(location: 0, length: 0))
    }

    @MainActor
    func testPlainTextRemainsLiteralAndNarrowLayoutGrowsVertically() async {
        let text = "**literal**\n中文😀 " + String(repeating: "long output ", count: 40)
        let view = AgentSelectableTextView(frame: .zero)
        view.update(text: text, markdown: false, style: .output)
        XCTAssertEqual(view.string, text)
        let wide = view.contentSize(for: 600)
        let narrow = view.contentSize(for: 160)
        XCTAssertEqual(narrow.width, 160)
        XCTAssertGreaterThan(narrow.height, wide.height)
        XCTAssertGreaterThan(wide.height, 0)
    }

    @MainActor
    func testNativeTableWrapsWithinChatWidth() async throws {
        let view = AgentSelectableTextView(frame: .zero)
        view.update(
            text: "| Name | Description |\n| --- | --- |\n| 中文😀 | \(String(repeating: "long description ", count: 20)) |",
            markdown: true, style: .body
        )
        let wide = view.contentSize(for: 600)
        let narrow = view.contentSize(for: 240)
        XCTAssertGreaterThan(narrow.height, wide.height)
        let container = try XCTUnwrap(view.textContainer)
        let layout = try XCTUnwrap(view.layoutManager)
        XCTAssertLessThanOrEqual(layout.usedRect(for: container).width, 241)
    }

    @MainActor
    func testSwiftUIHostSizesAndUpdatesTheSameNativeTextView() async throws {
        let host = NSHostingView(rootView: AgentMarkdownView(text: "- first\n- second").frame(width: 280))
        host.setFrameSize(host.fittingSize)
        host.layoutSubtreeIfNeeded()
        func textView(in view: NSView) -> AgentSelectableTextView? {
            if let text = view as? AgentSelectableTextView { return text }
            return view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        let native = try XCTUnwrap(textView(in: host))
        XCTAssertFalse(native.isEditable)
        XCTAssertTrue(native.isSelectable)
        XCTAssertGreaterThan(native.frame.height, 0)
        XCTAssertEqual(native.textContainer?.containerSize.width, 280)
        let selected = (native.string as NSString).range(of: "first\n•\tsecond")
        native.setSelectedRange(selected)
        host.rootView = AgentMarkdownView(text: "- first\n- second\n- third").frame(width: 280)
        host.setFrameSize(host.fittingSize)
        host.layoutSubtreeIfNeeded()
        XCTAssertTrue(textView(in: host) === native)
        XCTAssertEqual(native.string, "•\tfirst\n•\tsecond\n•\tthird")
        XCTAssertEqual(native.selectedRange(), selected)
    }

    @MainActor
    func testUnicodeReplacementDoesNotSplitSurrogatesOrCombiningCharacters() async {
        let view = AgentSelectableTextView(frame: .zero)
        view.update(text: "😀 e\u{301}\nselected", markdown: false, style: .body)
        view.setSelectedRange((view.string as NSString).range(of: "selected"))
        view.update(text: "😁 e\u{300}\nselected", markdown: false, style: .body)
        XCTAssertEqual(view.string, "😁 e\u{300}\nselected")
        XCTAssertEqual((view.string as NSString).substring(with: view.selectedRange()), "selected")
    }
}
