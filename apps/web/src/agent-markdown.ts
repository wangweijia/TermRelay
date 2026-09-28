import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]!.content);
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return self.renderToken(tokens, index, options);
};

export function isAgentMarkdown(text: string): boolean {
  return /^ {0,3}(?:#{1,6}\s+\S|[`~]{3,}|>\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|(?:[-*_]\s*){3,}$)/m.test(text)
    || /^\|?.+\|.+\n {0,3}\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|?$/m.test(text)
    || /^.+\n {0,3}={3,}\s*$/m.test(text)
    || /(?:\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\n]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<!\w)\*[^*\n]+\*(?!\w)|(?<!\w)_{1,2}[^_\n]+_{1,2}(?!\w))/.test(text);
}

export function renderAgentMarkdown(text: string): string {
  return markdown.render(text);
}
