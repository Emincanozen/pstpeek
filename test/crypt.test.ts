import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _tables, cyclic, permuteDecode, permuteEncode } from '../src/pst/crypt.js';

test('substitution tables are permutations and I is the inverse of R', () => {
  for (const t of [_tables.R, _tables.S, _tables.I]) assert.equal(new Set(t).size, 256);
  for (let i = 0; i < 256; i++) assert.equal(_tables.I[_tables.R[i]!], i);
});

test('permute encoding round-trips', () => {
  const original = Buffer.from('The quick brown fox jumps over the lazy dog é', 'utf8');
  const buf = Buffer.from(original);
  permuteEncode(buf);
  assert.notDeepEqual(buf, original);
  permuteDecode(buf);
  assert.deepEqual(buf, original);
});

test('cyclic encoding is its own inverse and depends on the key', () => {
  const original = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 0xff));
  const a = Buffer.from(original);
  cyclic(a, 0x12345678);
  const b = Buffer.from(original);
  cyclic(b, 0x12345679);
  assert.notDeepEqual(a, b);
  cyclic(a, 0x12345678);
  assert.deepEqual(a, original);
});
