import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAgentMarkdown, renderAgentMarkdown } from '../src/agent-markdown.ts';

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
