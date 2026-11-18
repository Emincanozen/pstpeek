/**
 * Optional integration test against public Outlook sample files that are NOT
 * part of this repository. Set PSTPEEK_SAMPLES to a directory containing them
 * (see README, "Validation on public sample files"); otherwise the test is skipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openArchive, walkFolders } from '../src/open.js';
import { buildEml } from '../src/export/mime.js';
import { toMboxEntry } from '../src/export/mbox.js';
import type { MessageError } from '../src/model.js';
import { PstArchive } from '../src/pst/pst.js';

const dir = process.env['PSTPEEK_SAMPLES'];
const skip = !dir ? 'PSTPEEK_SAMPLES is not set' : !existsSync(dir) ? `PSTPEEK_SAMPLES does not exist: ${dir}` : false;

/** Expected results observed with pstpeek and cross-checked against each file's own PidTagContentCount. */
const EXPECTED: Record<string, { format: string; folders: number; items: number }> = {
  '32-bit.pst': { format: 'ansi', folders: 5, items: 1 },
  'testPST.pst': { format: 'unicode', folders: 5, items: 7 },
  'testPST_variousBodyTypes.pst': { format: 'unicode', folders: 6, items: 4 },
  'example-2013.ost': { format: 'unicode4k', folders: 40, items: 3 },
};

test('public sample files open, iterate and export without errors', { skip }, () => {
  const files = readdirSync(dir!).filter((n) => /\.(pst|ost|msg)$/i.test(n)).sort();
  assert.ok(files.length > 0, 'no .pst/.ost/.msg files in PSTPEEK_SAMPLES');
  for (const name of files) {
    const archive = openArchive(join(dir!, name));
    try {
      const errors: MessageError[] = [];
      let folders = 0;
      let items = 0;
      for (const f of walkFolders(archive.root)) {
        folders++;
        for (const { message } of archive.messages(f, (e) => errors.push(e))) {
          items++;
          const eml = buildEml(message);
          assert.ok(eml.every((b) => b < 128), `${name}: EML is not 7-bit`);
          assert.ok(!/[^\r]\n/.test(eml.toString('latin1')), `${name}: bare LF in EML`);
          assert.ok(!/�/.test(message.subject), `${name}: undecodable subject`);
          toMboxEntry(message);
          for (const a of message.attachments) {
            if (!a.getEmbedded()) assert.ok(a.getData().length > 0, `${name}: empty attachment ${a.filename}`);
          }
        }
      }
      assert.deepEqual(errors.map((e) => e.error.message), [], `${name}: unreadable items`);
      const exp = EXPECTED[name];
      if (exp) {
        assert.ok(archive instanceof PstArchive);
        assert.deepEqual({ format: archive.db.format, folders, items }, exp, name);
      } else if (archive.kind === 'msg') {
        assert.equal(items, 1, name);
      }
    } finally {
      archive.close();
    }
  }
});
