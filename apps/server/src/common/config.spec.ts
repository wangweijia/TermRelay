import assert from 'node:assert/strict';
import test from 'node:test';
import { readPositiveInteger } from './config';

test('positive integer configuration preserves parsing and fallback behavior', (t) => {
  const name = 'TERMRELAY_TEST_POSITIVE_INTEGER';
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  for (const [raw, expected] of [
    [undefined, 100], ['', 100], ['0', 100], ['-1', 100], ['invalid', 100],
    ['9007199254740992', 100], ['42', 42], ['42ms', 42], ['1.5', 1],
  ] as const) {
    if (raw === undefined) delete process.env[name];
    else process.env[name] = raw;
    assert.equal(readPositiveInteger(name, 100), expected, `raw=${raw}`);
  }
});
