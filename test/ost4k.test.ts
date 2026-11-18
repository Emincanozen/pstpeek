/**
 * Outlook 2013+ OST layout (wVer 36, 4096-byte pages, optionally zlib-compressed blocks).
 * The page layout used by the synthetic writer was taken from a public Outlook 2013 OST
 * sample (see README); the fixtures themselves are generated, not copied.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PstArchive } from '../src/pst/pst.js';
import { BufferSource } from '../src/source.js';
import { walkFolders, findFolder } from '../src/open.js';
import { buildSamplePst, LONG_BODY, PNG_BYTES, SUBJECT_A } from './helpers/fixture.js';

for (const [label, opts] of [
  ['uncompressed', { format: 'unicode4k' as const }],
  ['compressed blocks', { format: 'unicode4k' as const, compress: true }],
  ['compressed + permute + multi-level', { format: 'unicode4k' as const, compress: true, cryptMethod: 1 as const, maxPageEntries: 3 }],
] as const) {
  test(`reads a 4K-page OST (${label})`, () => {
    const a = new PstArchive(new BufferSource(buildSamplePst(opts)));
    assert.equal(a.kind, 'ost');
    assert.equal(a.db.format, 'unicode4k');
    assert.deepEqual([...walkFolders(a.root)].map((f) => f.messageCount), [0, 0, 2, 1, 0]);
    const inbox = [...a.messages(findFolder(a.root, 'Inbox')!)].map((e) => e.message);
    assert.equal(inbox[0]?.subject, SUBJECT_A);
    assert.deepEqual(inbox[0]?.attachments[1]?.getData(), PNG_BYTES);
    assert.equal(inbox[1]?.bodyText, LONG_BODY);
  });
}
