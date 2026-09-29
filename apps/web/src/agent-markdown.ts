import MarkdownIt from 'markdown-it';

export function localPreviewPath(href: string, origin: string): string | undefined {
  if (!origin) return undefined;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.search || !/^\/(?:Users|Volumes)\//u.test(url.pathname)) return undefined;
    const path = decodeURIComponent(url.pathname);
    return path.includes('\0') || path.length > 4096 ? undefined : path;
  } catch {
    return undefined;
  }
}

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: true });
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]!.content);
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const path = localPreviewPath(tokens[index]!.attrGet('href') ?? '', env.origin ?? '');
  if (path) {
    tokens[index]!.attrSet('data-termrelay-file-link', path);
  } else {
    tokens[index]!.attrSet('target', '_blank');
    tokens[index]!.attrSet('rel', 'noopener noreferrer');
  }
  return self.renderToken(tokens, index, options);
};

export function isAgentMarkdown(text: string): boolean {
  return /^ {0,3}(?:#{1,6}\s+\S|[`~]{3,}|>\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|(?:[-*_]\s*){3,}$)/m.test(text)
    || /^\|?.+\|.+\n {0,3}\|? *:?-{3,}:? *(?:\| *:?-{3,}:? *)+\|?$/m.test(text)
    || /^.+\n {0,3}={3,}\s*$/m.test(text)
    || /(?:https?:\/\/[^\s/]+)?\/(?:Users|Volumes)\/[^\s]+/u.test(text)
    || /(?:\[[^\]\n]+\]\((?:https?:\/\/|\/)[^)\n]+\)|\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|(?<!\w)\*[^*\n]+\*(?!\w)|(?<!\w)_{1,2}[^_\n]+_{1,2}(?!\w))/.test(text);
}

export function renderAgentMarkdown(text: string, origin = globalThis.location?.origin ?? ''): string {
  return markdown.render(text, { origin });
}
