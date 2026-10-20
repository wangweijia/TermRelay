import AppKit
import SwiftUI

enum AgentMarkdown {
    static func containsMarkup(_ text: String) -> Bool {
        let block = #"^ {0,3}(#{1,6}\s+\S|[`~]{3,}|>\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|([-*_]\s*){3,}$)"#
        let inline = #"\[[^\]\n]+\]\((https?://|/)[^)\n]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<!\w)\*[^*\n]+\*(?!\w)|(?<!\w)_{1,2}[^_\n]+_{1,2}(?!\w)"#
        let lines = text.components(separatedBy: "\n")
        return lines.contains { $0.range(of: block, options: .regularExpression) != nil }
            || text.range(of: inline, options: .regularExpression) != nil
            || lines.indices.dropLast().contains { index in
                (lines[index].contains("|") &&
                lines[index + 1].range(
                    of: #"^ {0,3}\|? *:?-{3,}:? *(\| *:?-{3,}:? *)+\|?$"#,
                    options: .regularExpression
                ) != nil) ||
                (!lines[index].isEmpty &&
                 lines[index + 1].range(of: #"^ {0,3}={3,}\s*$"#, options: .regularExpression) != nil)
            }
    }
}

private enum MarkdownBlock {
    case paragraph(String)
    case heading(Int, String)
    case quote(String)
    case list(String, String)
    case code(String)
    case table([[String]])
    case rule

    static func parse(_ text: String) -> [MarkdownBlock] {
        let lines = text.components(separatedBy: "\n")
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var code: [String] = []
        var fence: Character?

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        var index = 0
        while index < lines.count {
            let line = lines[index]
            index += 1
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let marker = fence {
                if trimmed.hasPrefix(String(repeating: marker, count: 3)) {
                    blocks.append(.code(code.joined(separator: "\n")))
                    code.removeAll()
                    fence = nil
                } else {
                    code.append(line)
                }
                continue
            }
            if let marker = trimmed.first, (marker == "`" || marker == "~"),
               trimmed.hasPrefix(String(repeating: marker, count: 3)) {
                flushParagraph()
                fence = marker
            } else if line.contains("|"), index < lines.count,
                      lines[index].range(
                        of: #"^ {0,3}\|? *:?-{3,}:? *(\| *:?-{3,}:? *)+\|?$"#,
                        options: .regularExpression
                      ) != nil {
                flushParagraph()
                var rows = [tableCells(line)]
                index += 1
                while index < lines.count, lines[index].contains("|"),
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                    rows.append(tableCells(lines[index]))
                    index += 1
                }
                blocks.append(.table(rows))
            } else if !trimmed.isEmpty, index < lines.count,
                      lines[index].range(of: #"^ {0,3}(={3,}|-{3,})\s*$"#, options: .regularExpression) != nil {
                flushParagraph()
                blocks.append(.heading(lines[index].contains("=") ? 1 : 2, trimmed))
                index += 1
            } else if trimmed.range(of: #"^([-*_]\s*){3,}$"#, options: .regularExpression) != nil {
                flushParagraph()
                blocks.append(.rule)
            } else if trimmed.isEmpty {
                flushParagraph()
            } else if let match = line.range(of: #"^ {0,3}#{1,6} "#, options: .regularExpression) {
                flushParagraph()
                blocks.append(.heading(line[match].filter { $0 == "#" }.count, String(line[match.upperBound...])))
            } else if let match = line.range(of: #"^ {0,3}> ?"#, options: .regularExpression) {
                flushParagraph()
                blocks.append(.quote(String(line[match.upperBound...])))
            } else if let match = line.range(of: #"^ {0,3}([-*+]|\d+[.)]) "#, options: .regularExpression) {
                flushParagraph()
                let marker = line[match].trimmingCharacters(in: .whitespaces)
                blocks.append(.list(marker.first?.isNumber == true ? marker : "•", String(line[match.upperBound...])))
            } else {
                paragraph.append(line)
            }
        }
        if fence != nil { blocks.append(.code(code.joined(separator: "\n"))) }
        flushParagraph()
        return blocks
    }

    private static func tableCells(_ line: String) -> [String] {
        line.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "|"))
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }
}

enum AgentTextStyle {
    case body, reasoning, command, output

    var font: NSFont {
        switch self {
        case .body: .systemFont(ofSize: NSFont.systemFontSize)
        case .reasoning: .systemFont(ofSize: 12)
        case .command: .monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        case .output: .monospacedSystemFont(ofSize: 11, weight: .regular)
        }
    }

    var color: NSColor { self == .reasoning ? .secondaryLabelColor : .labelColor }
}

@MainActor
enum AgentRichText {
    static func render(_ text: String, markdown: Bool = true, style: AgentTextStyle = .body) -> NSAttributedString {
        guard markdown, AgentMarkdown.containsMarkup(text) else {
            return NSAttributedString(string: text, attributes: [.font: style.font, .foregroundColor: style.color])
        }
        let result = NSMutableAttributedString(string: "")
        for block in MarkdownBlock.parse(text) {
            if result.length > 0, !result.string.hasSuffix("\n") {
                result.append(NSAttributedString(string: "\n"))
            }
            let paragraph = NSMutableParagraphStyle()
            paragraph.paragraphSpacing = 8
            let content: NSMutableAttributedString
            switch block {
            case .paragraph(let value):
                content = inline(value, style: style)
            case .heading(let level, let value):
                content = inline(value, style: style, font: .systemFont(
                    ofSize: level == 1 ? 22 : level == 2 ? 18 : 15, weight: .bold
                ))
            case .quote(let value):
                content = inline(value, style: style)
                content.addAttribute(.foregroundColor, value: NSColor.secondaryLabelColor,
                                     range: NSRange(location: 0, length: content.length))
                paragraph.firstLineHeadIndent = 10
                paragraph.headIndent = 10
            case .list(let marker, let value):
                content = inline(value, style: style)
                content.insert(NSAttributedString(string: "\(marker)\t", attributes: [
                    .font: style.font, .foregroundColor: style.color
                ]), at: 0)
                let indent = max(20, (marker as NSString).size(withAttributes: [.font: style.font]).width + 8)
                paragraph.tabStops = [NSTextTab(textAlignment: .left, location: indent)]
                paragraph.headIndent = indent
                paragraph.paragraphSpacing = 4
            case .code(let value):
                content = NSMutableAttributedString(string: value, attributes: [
                    .font: NSFont.monospacedSystemFont(ofSize: style.font.pointSize, weight: .regular),
                    .foregroundColor: style.color, .backgroundColor: NSColor.textBackgroundColor
                ])
                paragraph.firstLineHeadIndent = 10
                paragraph.headIndent = 10
            case .table(let rows):
                appendTable(rows, to: result, style: style)
                continue
            case .rule:
                content = NSMutableAttributedString(string: "────────", attributes: [
                    .font: style.font, .foregroundColor: NSColor.separatorColor
                ])
            }
            content.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: content.length))
            result.append(content)
        }
        return result
    }

    private static func inline(_ text: String, style: AgentTextStyle, font: NSFont? = nil) -> NSMutableAttributedString {
        let baseFont = font ?? style.font
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        do {
            let parsed = try AttributedString(markdown: text, options: options)
            let result = NSMutableAttributedString(string: "")
            for run in parsed.runs {
                let intent = run.inlinePresentationIntent ?? []
                var runFont = intent.contains(.code)
                    ? NSFont.monospacedSystemFont(ofSize: baseFont.pointSize, weight: .regular) : baseFont
                if intent.contains(.stronglyEmphasized) {
                    runFont = NSFontManager.shared.convert(runFont, toHaveTrait: .boldFontMask)
                }
                if intent.contains(.emphasized) {
                    runFont = NSFontManager.shared.convert(runFont, toHaveTrait: .italicFontMask)
                }
                var attributes: [NSAttributedString.Key: Any] = [.font: runFont, .foregroundColor: style.color]
                if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
                if intent.contains(.code) { attributes[.backgroundColor] = NSColor.textBackgroundColor }
                if let link = run.link { attributes[.link] = link }
                result.append(NSAttributedString(string: String(parsed[run.range].characters), attributes: attributes))
            }
            return result
        } catch {
            NSLog("[TermRelay] Inline Markdown parsing failed: %@", error.localizedDescription)
            return NSMutableAttributedString(string: text, attributes: [.font: baseFont, .foregroundColor: style.color])
        }
    }

    private static func appendTable(_ rows: [[String]], to result: NSMutableAttributedString, style: AgentTextStyle) {
        let table = NSTextTable()
        table.numberOfColumns = rows.map(\.count).max() ?? 1
        table.layoutAlgorithm = .fixedLayoutAlgorithm
        table.collapsesBorders = true
        table.setValue(100, type: .percentageValueType, for: .width)
        for (rowIndex, row) in rows.enumerated() {
            for column in 0..<table.numberOfColumns {
                let cell = NSTextTableBlock(table: table, startingRow: rowIndex, rowSpan: 1,
                                            startingColumn: column, columnSpan: 1)
                cell.setValue(100 / CGFloat(table.numberOfColumns), type: .percentageValueType, for: .width)
                cell.setWidth(6, type: .absoluteValueType, for: .padding)
                cell.setWidth(0.5, type: .absoluteValueType, for: .border)
                cell.setBorderColor(.separatorColor)
                cell.backgroundColor = rowIndex == 0 ? .controlBackgroundColor : .textBackgroundColor
                let paragraph = NSMutableParagraphStyle()
                paragraph.textBlocks = [cell]
                let value = column < row.count ? row[column] : ""
                let content = inline(value, style: style, font: rowIndex == 0
                    ? NSFontManager.shared.convert(style.font, toHaveTrait: .boldFontMask) : style.font)
                content.append(NSAttributedString(string: "\n"))
                content.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: content.length))
                result.append(content)
            }
        }
    }
}

@MainActor
final class AgentTextInteraction {
    weak var owner: AgentSelectableTextView?

    var preventsAutomaticScroll: Bool {
        guard let owner else { return false }
        return owner.isSelecting || owner.selectedRange().length > 0
    }
}

private struct AgentTextInteractionKey: EnvironmentKey {
    static let defaultValue: AgentTextInteraction? = nil
}

extension EnvironmentValues {
    var agentTextInteraction: AgentTextInteraction? {
        get { self[AgentTextInteractionKey.self] }
        set { self[AgentTextInteractionKey.self] = newValue }
    }
}

struct AgentMarkdownView: NSViewRepresentable {
    let text: String
    var markdown = true
    var style: AgentTextStyle = .body
    @Environment(\.agentTextInteraction) private var interaction

    func makeNSView(context: Context) -> AgentSelectableTextView {
        AgentSelectableTextView(frame: .zero)
    }

    func updateNSView(_ view: AgentSelectableTextView, context: Context) {
        view.interaction = interaction
        view.update(text: text, markdown: markdown, style: style)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: AgentSelectableTextView, context: Context) -> CGSize? {
        nsView.contentSize(for: proposal.width ?? 400)
    }
}

@MainActor
final class AgentSelectableTextView: NSTextView {
    weak var interaction: AgentTextInteraction?
    private(set) var isSelecting = false
    private var source: String?
    private var markdown = true
    private var style: AgentTextStyle = .body
    private var ownedStorage: NSTextStorage?

    override init(frame frameRect: NSRect, textContainer container: NSTextContainer? = nil) {
        let textContainer: NSTextContainer
        if let container {
            textContainer = container
        } else {
            // TextKit 1 provides native table layout and predictable width-based measurement.
            let storage = NSTextStorage()
            let layout = NSLayoutManager()
            textContainer = NSTextContainer(size: CGSize(width: 400, height: CGFloat.greatestFiniteMagnitude))
            storage.addLayoutManager(layout)
            layout.addTextContainer(textContainer)
            ownedStorage = storage
        }
        super.init(frame: frameRect, textContainer: textContainer)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = false
        textContainer?.heightTracksTextView = false
        isHorizontallyResizable = false
        isVerticallyResizable = true
        minSize = .zero
        maxSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    }

    override func mouseDown(with event: NSEvent) {
        interaction?.owner = self
        isSelecting = true
        defer { isSelecting = false }
        super.mouseDown(with: event)
    }

    override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
        super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
        if selectedRange().length > 0 || isSelecting || stillSelecting {
            interaction?.owner = self
        } else if interaction?.owner === self {
            interaction?.owner = nil
        }
    }

    func update(text: String, markdown: Bool, style: AgentTextStyle) {
        guard source != text || self.markdown != markdown || self.style != style else { return }
        source = text
        self.markdown = markdown
        self.style = style
        replaceContent(with: AgentRichText.render(text, markdown: markdown, style: style))
    }

    func replaceContent(with content: NSAttributedString) {
        guard let storage = textStorage, !storage.isEqual(to: content) else { return }
        let selection = selectedRange()
        let old = storage.string as NSString
        let new = content.string as NSString
        var prefix = 0
        while prefix < min(old.length, new.length), old.character(at: prefix) == new.character(at: prefix) {
            prefix += 1
        }
        var suffix = 0
        while suffix < min(old.length, new.length) - prefix,
              old.character(at: old.length - suffix - 1) == new.character(at: new.length - suffix - 1) {
            suffix += 1
        }
        let replaced = NSRange(location: prefix, length: old.length - prefix - suffix)
        let inserted = NSRange(location: prefix, length: new.length - prefix - suffix)
        storage.beginEditing()
        storage.replaceCharacters(in: replaced, with: content.attributedSubstring(from: inserted))
        content.enumerateAttributes(in: NSRange(location: 0, length: content.length)) { attributes, range, _ in
            storage.setAttributes(attributes, range: range)
        }
        storage.endEditing()
        let preserved = Self.preservedSelection(selection, replacing: replaced, insertedLength: inserted.length)
        setSelectedRange(NSRange(location: min(preserved.location, new.length),
                                 length: min(preserved.length, max(0, new.length - preserved.location))))
        invalidateIntrinsicContentSize()
    }

    static func preservedSelection(_ selection: NSRange, replacing range: NSRange, insertedLength: Int) -> NSRange {
        if NSMaxRange(selection) <= range.location { return selection }
        if selection.location >= NSMaxRange(range) {
            return NSRange(location: selection.location + insertedLength - range.length, length: selection.length)
        }
        // A rewritten selection must not silently start pointing at different text.
        return NSRange(location: range.location, length: 0)
    }

    func contentSize(for width: CGFloat) -> CGSize {
        let width = max(1, width)
        guard let textContainer, let layoutManager else { return CGSize(width: width, height: 0) }
        textContainer.containerSize = CGSize(width: width, height: .greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: textContainer)
        return CGSize(width: width, height: ceil(layoutManager.usedRect(for: textContainer).height))
    }
}
