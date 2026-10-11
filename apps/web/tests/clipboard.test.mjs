import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyText, selectCopyText } from '../src/clipboard.ts';

const key = `trai_${'x'.repeat(43)}`;
function copyField() {
  return { value: '', focus() { this.focused = true; }, select() { this.selected = true; }, setSelectionRange(start, end) { this.range = [start, end]; } };
}

test('Clipboard API receives the complete key, not the management ID', async () => {
  let written;
  assert.equal(await copyText(key, copyField(), {
    clipboard: { async writeText(value) { written = value; } },
    copySelection() { assert.fail('fallback not needed'); },
  }), true);
  assert.equal(written, key);
  assert.equal(written.length, 48);
});

test('LAN HTTP without Clipboard API copies the entire visible selection', async () => {
  const field = copyField();
  assert.equal(await copyText(key, field, { copySelection() {
    assert.equal(field.value, key);
    assert.equal(field.focused, true);
    assert.equal(field.selected, true);
    assert.deepEqual(field.range, [0, 48]);
    return true;
  } }), true);
});

test('denied Clipboard API falls back to selection-based copying', async () => {
  const field = copyField();
  assert.equal(await copyText(key, field, {
    clipboard: { async writeText() { throw new Error('NotAllowedError'); } },
    copySelection() { return true; },
  }), true);
  assert.equal(field.value, key);
});

test('failed or throwing fallback reports failure and leaves full key selected', async () => {
  for (const copySelection of [() => false, () => { throw new Error('denied'); }]) {
    const field = copyField();
    assert.equal(await copyText(key, field, { copySelection }), false);
    assert.equal(field.value, key);
    assert.deepEqual(field.range, [0, 48]);
  }
});

test('missing field cannot report successful fallback', async () => {
  assert.equal(await copyText(key, undefined, { copySelection() { assert.fail('no selection'); } }), false);
});

test('manual selection replaces stale text and selects every character', () => {
  const field = copyField();
  field.value = 'old clipboard text';
  selectCopyText(key, field);
  assert.equal(field.value, key);
  assert.deepEqual(field.range, [0, 48]);
});
