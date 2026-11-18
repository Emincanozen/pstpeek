import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NameAllocator, safeFileName, truncateUtf8 } from '../src/export/filenames.js';

test('replaces path separators and reserved characters', () => {
  assert.equal(safeFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(safeFileName('tab\there\u0000x'), 'tab here_x');
});

test('blocks path traversal and hidden-file tricks', () => {
  assert.equal(safeFileName('..'), '__');
  assert.equal(safeFileName('../../etc/passwd'), '___.._etc_passwd');
  assert.ok(!safeFileName('../x').includes('/'));
  assert.ok(!safeFileName('.bashrc').startsWith('.'));
});

test('avoids Windows device names and trailing dots or spaces', () => {
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('nul.txt'), '_nul.txt');
  assert.equal(safeFileName('COM1'), '_COM1');
  assert.equal(safeFileName('report. . '), 'report');
  assert.equal(safeFileName('CONSOLE'), 'CONSOLE');
});

test('uses a fallback for empty names', () => {
  assert.equal(safeFileName(''), 'untitled');
  assert.equal(safeFileName('   ', { fallback: 'no subject' }), 'no subject');
});

test('truncates by UTF-8 bytes, keeps the extension and whole characters', () => {
  const name = `${'é'.repeat(100)}.pdf`;
  const s = safeFileName(name, { maxBytes: 50 });
  assert.ok(Buffer.byteLength(s) <= 50);
  assert.ok(s.endsWith('.pdf'));
  assert.ok(!s.includes('�'));
  assert.equal(truncateUtf8('a🌍b', 3), 'a');
});

test('allocates unique names case-insensitively', () => {
  const a = new NameAllocator();
  assert.equal(a.allocate('Report.txt'), 'Report.txt');
  assert.equal(a.allocate('report.txt'), 'report (2).txt');
  assert.equal(a.allocate('Report.txt'), 'Report (3).txt');
  assert.equal(a.allocate('noext'), 'noext');
  assert.equal(a.allocate('noext'), 'noext (2)');
});
