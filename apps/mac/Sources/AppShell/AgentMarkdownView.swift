import Foundation
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

    static func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(text)
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

struct AgentMarkdownView: View {
    let text: String

    var body: some View {
        if AgentMarkdown.containsMarkup(text) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .paragraph(let value):
                        AgentMarkdown.inline(value).textSelection(.enabled)
                    case .heading(let level, let value):
                        AgentMarkdown.inline(value)
                            .font(.system(size: level == 1 ? 22 : level == 2 ? 18 : 15, weight: .bold))
                            .textSelection(.enabled)
                    case .quote(let value):
                        AgentMarkdown.inline(value)
                            .foregroundStyle(.secondary)
                            .padding(.leading, 10)
                            .overlay(alignment: .leading) { Rectangle().fill(.secondary).frame(width: 2) }
                            .textSelection(.enabled)
                    case .list(let marker, let value):
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(marker)
                            AgentMarkdown.inline(value).textSelection(.enabled)
                        }
                    case .code(let value):
                        ScrollView(.horizontal) {
                            Text(value)
                                .font(.system(.body, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10)
                        }
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    case .table(let rows):
                        ScrollView(.horizontal) {
                            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 6) {
                                ForEach(rows.indices, id: \.self) { row in
                                    GridRow {
                                        ForEach(rows[row].indices, id: \.self) { column in
                                            AgentMarkdown.inline(rows[row][column])
                                                .fontWeight(row == 0 ? .semibold : .regular)
                                                .textSelection(.enabled)
                                        }
                                    }
                                    if row == 0 { Divider() }
                                }
                            }
                            .padding(10)
                        }
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    case .rule:
                        Divider()
                    }
                }
            }
        } else {
            Text(text).textSelection(.enabled)
        }
    }
}
