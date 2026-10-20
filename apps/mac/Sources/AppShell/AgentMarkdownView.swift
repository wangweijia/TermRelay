import AppKit
import SwiftUI

enum AgentMarkdown {
    static func containsMarkup(_ text: String) -> Bool {
        let block = #"^ {0,3}(#{1,6}\s+\S|[`~]{3,}|>\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|([-*_]\s*){3,}$)"#
        let inline = #"\[[^\]\n]+\]\([^)\n]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<!\w)\*[^*\n]+\*(?!\w)|(?<!\w)_{1,2}[^_\n]+_{1,2}(?!\w)"#
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

enum AgentLink {
    enum OpenError: LocalizedError {
        case unsupported, missingDirectory, invalidFile, missingFile, openFailed

        var errorDescription: String? {
            switch self {
            case .unsupported: "仅支持打开 HTTP / HTTPS 网页和本地文件。"
            case .missingDirectory: "无法解析相对路径：当前会话的工作目录未知。"
            case .invalidFile: "本地文件链接无效。"
            case .missingFile: "文件不存在或无法访问。"
            case .openFailed: "系统无法打开此链接，请检查默认浏览器或文件关联应用。"
            }
        }
    }

    static func resolve(_ link: URL, directory: URL?) throws -> URL {
        if let scheme = link.scheme?.lowercased(), scheme == "http" || scheme == "https" {
            guard let host = link.host, !host.isEmpty else { throw OpenError.unsupported }
            return link
        }
        guard link.scheme == nil || link.isFileURL else { throw OpenError.unsupported }
        guard let components = URLComponents(url: link, resolvingAgainstBaseURL: false),
              components.host == nil || components.host == "" || components.host?.lowercased() == "localhost",
              components.user == nil, components.password == nil, components.port == nil,
              components.query == nil else { throw OpenError.invalidFile }
        guard link.isFileURL || components.host == nil else { throw OpenError.invalidFile }
        let path = components.path
        guard !path.isEmpty, !path.contains("\0") else { throw OpenError.invalidFile }
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path).standardizedFileURL
        }
        guard !link.isFileURL else { throw OpenError.invalidFile }
        guard let directory else { throw OpenError.missingDirectory }
        return directory.appendingPathComponent(path).standardizedFileURL
    }

    @MainActor
    static func open(_ link: URL, directory: URL?, using opener: (URL) -> Bool) throws {
        let url = try resolve(link, directory: directory)
        if url.isFileURL, !FileManager.default.fileExists(atPath: url.path) {
            throw OpenError.missingFile
        }
        guard opener(url) else { throw OpenError.openFailed }
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
    weak var outputBeingRead: AgentCommandOutputScrollView?
    weak var timelineEnd: NSView?

    var preventsAutomaticScroll: Bool {
        let selecting = owner.map { $0.isSelecting || $0.selectedRange().length > 0 } ?? false
        return selecting || outputBeingRead?.isReadingEarlierOutput == true
    }
}

private struct AgentTextInteractionKey: EnvironmentKey {
    static let defaultValue: AgentTextInteraction? = nil
}

private struct AgentLinkDirectoryKey: EnvironmentKey {
    static let defaultValue: URL? = nil
}

extension EnvironmentValues {
    var agentLinkDirectory: URL? {
        get { self[AgentLinkDirectoryKey.self] }
        set { self[AgentLinkDirectoryKey.self] = newValue }
    }

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
    @Environment(\.agentLinkDirectory) private var linkDirectory

    func makeNSView(context: Context) -> AgentSelectableTextView {
        AgentSelectableTextView(frame: .zero)
    }

    func updateNSView(_ view: AgentSelectableTextView, context: Context) {
        view.interaction = interaction
        view.linkDirectory = linkDirectory
        view.update(text: text, markdown: markdown, style: style)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: AgentSelectableTextView, context: Context) -> CGSize? {
        nsView.contentSize(for: proposal.width ?? 400)
    }
}

@MainActor
final class AgentSelectableTextView: NSTextView, NSTextViewDelegate {
    weak var interaction: AgentTextInteraction?
    var linkDirectory: URL?
    private(set) var isSelecting = false
    private var source: String?
    private var markdown = true
    private var style: AgentTextStyle = .body
    private var ownedStorage: NSTextStorage?
    private let measurementLayout = NSLayoutManager()
    private let measurementContainer = NSTextContainer()
    private var cachedMeasurement: (width: CGFloat, limit: CGFloat, size: CGSize)?

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
        delegate = self
        isEditable = false
        isSelectable = true
        isRichText = true
        drawsBackground = false
        textContainerInset = .zero
        textContainer?.lineFragmentPadding = 0
        textContainer?.widthTracksTextView = true
        textContainer?.heightTracksTextView = false
        isHorizontallyResizable = false
        isVerticallyResizable = false
        minSize = .zero
        maxSize = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        measurementContainer.lineFragmentPadding = 0
        measurementContainer.widthTracksTextView = false
        measurementContainer.heightTracksTextView = false
        measurementLayout.addTextContainer(measurementContainer)
        textStorage?.addLayoutManager(measurementLayout)
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        do {
            let url: URL
            if let value = link as? URL {
                url = value
            } else if let value = link as? String, let parsed = URL(string: value) {
                url = parsed
            } else {
                throw AgentLink.OpenError.unsupported
            }
            try AgentLink.open(url, directory: linkDirectory, using: { NSWorkspace.shared.open($0) })
        } catch {
            let alert = NSAlert()
            alert.messageText = "无法打开链接"
            alert.informativeText = error.localizedDescription
            alert.alertStyle = .warning
            if let window {
                alert.beginSheetModal(for: window)
            } else {
                alert.runModal()
            }
        }
        return true
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
        if let source, !markdown, !self.markdown, self.style == style,
           text.utf16.starts(with: source.utf16), let storage = textStorage {
            let selection = selectedRange()
            let suffix = (text as NSString).substring(from: (source as NSString).length)
            storage.append(AgentRichText.render(suffix, markdown: false, style: style))
            self.source = text
            setSelectedRange(selection)
            cachedMeasurement = nil
            invalidateIntrinsicContentSize()
            return
        }
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
        cachedMeasurement = nil
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

    func contentSize(for proposedWidth: CGFloat, maximumHeight: CGFloat = .greatestFiniteMagnitude) -> CGSize {
        let width = proposedWidth.isFinite ? max(0, proposedWidth) : (bounds.width > 0 ? bounds.width : 400)
        guard width > 0 else { return .zero }
        if let cachedMeasurement, cachedMeasurement.width == width, cachedMeasurement.limit == maximumHeight {
            return cachedMeasurement.size
        }
        // SwiftUI probes multiple sizes. Measuring must not resize the live text view or its container.
        measurementContainer.containerSize = CGSize(width: width, height: maximumHeight)
        measurementLayout.ensureLayout(for: measurementContainer)
        let glyphs = measurementLayout.glyphRange(for: measurementContainer)
        let characters = measurementLayout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let overflows = NSMaxRange(characters) < (textStorage?.length ?? 0)
        let height = overflows ? maximumHeight : min(maximumHeight, ceil(measurementLayout.usedRect(for: measurementContainer).height))
        let size = CGSize(width: width, height: height)
        cachedMeasurement = (width, maximumHeight, size)
        return size
    }
}
