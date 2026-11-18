import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mboxrdQuote, toMboxEntry } from '../src/export/mbox.js';
import type { MailMessage } from '../src/model.js';

const base: MailMessage = { messageClass: 'IPM.Note', subject: 'S', to: [], cc: [], bcc: [], attachments: [] };

test('mboxrd quoting adds one ">" to From lines, including already quoted ones', () => {
  assert.equal(mboxrdQuote('From me\n>From you\nnot From here\n>>From x'), '>From me\n>>From you\nnot From here\n>>>From x');
});

test('an mbox entry starts with a From separator and ends with a blank line', () => {
  const entry = toMboxEntry({ ...base, from: { email: 'a@example.com' }, date: new Date('2024-03-05T14:03:09Z'), bodyText: 'x' }).toString('latin1');
  assert.ok(entry.startsWith('From a@example.com Tue Mar  5 14:03:09 2024\n'));
  assert.ok(entry.endsWith('\n\n'));
  assert.ok(!entry.includes('\r'));
});

test('body lines starting with "From " are escaped inside the entry', () => {
  // Quoted-printable leaves "From " literal, so the mbox writer itself must escape it.
  const entry = toMboxEntry({ ...base, bodyText: 'hello\nFrom the archive\nbye' }).toString('latin1');
  const lines = entry.split('\n');
  assert.equal(lines.filter((l) => l.startsWith('From ')).length, 1, 'only the separator may start with "From "');
  assert.ok(lines.includes('>From the archive'));
});

test('uses MAILER-DAEMON and the epoch when sender or date are missing', () => {
  const entry = toMboxEntry({ ...base, from: { name: 'No Address' } }).toString('latin1');
  assert.ok(entry.startsWith('From MAILER-DAEMON Thu Jan  1 00:00:00 1970\n'));
});
