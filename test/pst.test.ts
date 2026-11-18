/**
 * Integration tests of the PST reader against synthetic files produced by
 * test/helpers/pst-builder.ts (no third-party or real mailbox data involved).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PstArchive } from '../src/pst/pst.js';
import { BufferSource } from '../src/source.js';
import { findFolder, walkFolders } from '../src/open.js';
import type { MailArchive, MailMessage } from '../src/model.js';
import { ATTACHMENT_TEXT, buildSamplePst, DATE_A, DATE_C, LONG_BODY, PNG_BYTES, SUBJECT_A } from './helpers/fixture.js';

function open(opts: Parameters<typeof buildSamplePst>[0] = {}): PstArchive {
  return new PstArchive(new BufferSource(buildSamplePst(opts)));
}

function all(archive: MailArchive, path: string): MailMessage[] {
  const f = findFolder(archive.root, path);
  assert.ok(f, `folder ${path}`);
  return [...archive.messages(f)].map((e) => e.message);
}

test('reads the folder tree with message counts', () => {
  const a = open();
  assert.equal(a.kind, 'pst');
  assert.equal(a.root.name, 'Sample Archive');
  const names = [...walkFolders(a.root)].map((f) => `${f.path.join('/')}:${f.messageCount}`);
  assert.deepEqual(names, [
    'Sample Archive:0',
    'Sample Archive/Top of Personal Folders:0',
    'Sample Archive/Top of Personal Folders/Inbox:2',
    'Sample Archive/Top of Personal Folders/Inbox/Été 2024:1',
    'Sample Archive/Top of Personal Folders/Deleted Items:0',
  ]);
});

test('decodes a rich message: Unicode subject, addresses, dates, bodies', () => {
  const [m] = all(open(), 'Inbox');
  assert.ok(m);
  assert.equal(m.subject, SUBJECT_A);
  assert.deepEqual(m.from, { name: 'Zoë Example', email: 'zoe@example.com' });
  assert.equal(m.sender, undefined);
  assert.deepEqual(m.to, [
    { name: 'Ana Test', email: 'ana@example.com' },
    { name: 'Bob "B" Test', email: 'bob@example.com' },
  ]);
  assert.deepEqual(m.cc, [{ name: 'Chloé Copy', email: 'chloe@example.org' }]);
  assert.deepEqual(m.bcc, [{ name: 'Internal Person' }], 'Exchange-only address is not presented as SMTP');
  assert.equal(m.date?.toISOString(), DATE_A.toISOString());
  assert.equal(m.messageId, 'a1@example.com');
  assert.equal(m.importance, 'high');
  assert.match(m.bodyText ?? '', /Voir le rapport/);
  assert.match(m.bodyHtml ?? '', /Bonjour Zoë/);
});

test('reads attachments, including data stored in nested subnodes', () => {
  const [m] = all(open(), 'Inbox');
  assert.ok(m);
  assert.equal(m.attachments.length, 2);
  const [txt, png] = m.attachments;
  assert.equal(txt?.filename, 'rapport été.txt');
  assert.equal(txt?.mimeType, 'text/plain');
  assert.equal(txt?.inline, false);
  assert.equal(txt?.getData().toString('utf8'), ATTACHMENT_TEXT);
  assert.equal(png?.filename, 'logo.png');
  assert.equal(png?.mimeType, 'image/png');
  assert.equal(png?.contentId, 'logo@example.com');
  assert.equal(png?.inline, true);
  assert.deepEqual(png?.getData(), PNG_BYTES);
});

test('reads a large body spread over an XBLOCK data tree', () => {
  const [, m] = all(open(), 'Inbox');
  assert.equal(m?.bodyText, LONG_BODY);
  assert.deepEqual(m?.to, [{ name: 'Ana Test' }, { name: 'Bob Test' }], 'falls back to display names');
  assert.deepEqual(m?.from, { name: 'Dan Sender', email: 'dan@example.net' });
});

test('finds messages without a contents table and attachments without an attachment table', () => {
  const [m] = all(open(), 'Inbox/Été 2024');
  assert.ok(m);
  assert.equal(m.subject, 'Fwd: with an attached item');
  assert.equal(m.date?.toISOString(), DATE_C.toISOString());
  assert.deepEqual(m.from, { name: 'Zoë Example', email: 'zoe@example.com' }, 'SMTP address preferred over EX address');
  assert.equal(m.attachments.length, 1);
  const a = m.attachments[0]!;
  assert.equal(a.mimeType, 'message/rfc822');
  assert.equal(a.filename, 'Inner forwarded message.eml');
  const inner = a.getEmbedded();
  assert.equal(inner?.subject, 'Inner forwarded message');
  assert.equal(inner?.bodyText, 'This is the inner message.');
});

for (const [label, opts] of [
  ['permute-encoded', { cryptMethod: 1 as const }],
  ['cyclic-encoded', { cryptMethod: 2 as const }],
  ['multi-level B-trees', { maxPageEntries: 3 }],
  ['permute + two-level B-trees', { cryptMethod: 1 as const, maxPageEntries: 2 }],
] as const) {
  test(`reads ${label} files identically`, () => {
    const a = open(opts);
    const subjects = [...walkFolders(a.root)].flatMap((f) => [...a.messages(f)].map((e) => e.message.subject));
    assert.deepEqual(subjects, [SUBJECT_A, 'Plain ASCII subject: weekly report', 'Fwd: with an attached item']);
    const [m] = all(a, 'Inbox');
    assert.deepEqual(m?.attachments[1]?.getData(), PNG_BYTES);
    assert.equal(all(a, 'Inbox')[1]?.bodyText, LONG_BODY);
  });
}

test('rejects files that are not PSTs', () => {
  assert.throws(() => new PstArchive(new BufferSource(Buffer.alloc(1024))), /Not a PST\/OST file/);
  const bad = buildSamplePst();
  bad.writeUInt16LE(99, 10);
  assert.throws(() => new PstArchive(new BufferSource(bad)), /Unsupported PST\/OST version 99/);
});

test('reports corrupt items instead of crashing', () => {
  const data = buildSamplePst();
  const a = new PstArchive(new BufferSource(data));
  // Corrupt the heap signature of every block that carries a message property context.
  const sig = Buffer.from([0xec, 0xbc]);
  const original = buildSamplePst();
  let pos = original.indexOf(sig, 1024);
  let corrupted = 0;
  while (pos >= 0) {
    // Only touch heaps that contain the subject of the long-body message.
    const window = original.subarray(pos, pos + 2000);
    if (window.includes(Buffer.from('Plain ASCII subject', 'utf16le'))) {
      data[pos] = 0x00;
      corrupted++;
    }
    pos = original.indexOf(sig, pos + 1);
  }
  assert.ok(corrupted > 0);
  const inbox = findFolder(a.root, 'Inbox')!;
  const errors: unknown[] = [];
  const msgs = [...a.messages(inbox, (e) => errors.push(e))];
  assert.equal(msgs.length, 1);
  assert.equal(errors.length, 1);
});
