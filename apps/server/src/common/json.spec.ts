import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint } from '../ai/ai.validation';
import { canonicalJson } from './json';

test('canonical JSON sorts nested objects without reordering arrays or mutating input', () => {
  const input = Object.freeze({
    z: Object.freeze([Object.freeze({ b: 2, a: 1 }), null, 'text']),
    a: Object.freeze({ z: false, a: 0 }),
  });
  assert.equal(canonicalJson(input), '{"a":{"a":0,"z":false},"z":[{"a":1,"b":2},null,"text"]}');
  assert.deepEqual(Object.keys(input), ['z', 'a']);
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ absent: undefined, array: [undefined] }), '{"array":[null]}');
});

test('AI request fingerprints preserve their existing hash and ignore nested key order', () => {
  assert.equal(fingerprint({ b: 2, a: 1 }), '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777');
  assert.equal(fingerprint({ z: [{ b: 2, a: 1 }], a: null }), fingerprint({ a: null, z: [{ a: 1, b: 2 }] }));
  assert.notEqual(fingerprint({ values: [1, 2] }), fingerprint({ values: [2, 1] }));
});
