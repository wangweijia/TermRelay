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
}
