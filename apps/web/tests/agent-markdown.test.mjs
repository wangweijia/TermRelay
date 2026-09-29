import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentMarkdown, localPreviewPath, renderAgentMarkdown } from '../src/agent-markdown.ts';

test('detects structured Markdown without changing ordinary ACP output', () => {
  for (const value of ['# Heading', 'Heading\n===', '- first\n- second', '```ts\nconst x = 1\n```', '| A | B |\n| --- | --- |', '**bold**', '*italic*', '_italic_', '[site](https://example.com)']) {
    assert.equal(isAgentMarkdown(value), true, value);
  }
  for (const value of ['普通回答', 'result: 42\nnext line', 'a * b = c', 'https://example.com']) {
    assert.equal(isAgentMarkdown(value), false, value);
  }
});

test('renders formatting and escapes unsafe HTML and URLs', () => {
  assert.match(renderAgentMarkdown('```js\nconst x = 1\n```'), /<pre><code class="language-js">/);
  assert.match(renderAgentMarkdown('**bold**'), /<strong>bold<\/strong>/);
  assert.match(renderAgentMarkdown('[site](https://example.com)'), /rel="noopener noreferrer"/);
  const unsafe = renderAgentMarkdown('<script>alert(1)</script>\n[bad](javascript:alert(1))\n![track](https://example.com/pixel)');
  assert.doesNotMatch(unsafe, /<script|<img|href="javascript:/);
});

test('marks only same-origin Mac file links and recognizes bare URLs', () => {
  const origin = 'https://termrelay.wqyhomes.com';
  const href = `${origin}/Users/weijiawang/project/docs/TECHNICAL_DESIGN.md`;
  assert.equal(isAgentMarkdown(href), true);
  assert.match(renderAgentMarkdown(href, origin), /data-termrelay-file-link="\/Users\/weijiawang\/project\/docs\/TECHNICAL_DESIGN.md"/);
  assert.match(renderAgentMarkdown(`[file](${href})`, origin), /data-termrelay-file-link=/);
  assert.equal(localPreviewPath('/Users/me/project/readme.md', origin), '/Users/me/project/readme.md');
  for (const value of [
    'https://example.com/Users/me/project/readme.md',
    `${origin}/api/sessions`,
    `${origin}/Users/me/project/a.md?download=true`,
    'javascript:alert(1)',
  ]) assert.equal(localPreviewPath(value, origin), undefined, value);
  assert.equal(localPreviewPath(`${origin}/Users/me/project/a%20b.md#section`, origin), '/Users/me/project/a b.md');
  assert.match(renderAgentMarkdown('[outside](https://example.com/a.md)', origin), /target="_blank"/);
});
