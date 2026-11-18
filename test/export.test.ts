import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { exportArchive } from '../src/export/exporter.js';
import { findFolder, splitFolderPath } from '../src/open.js';
import { PstArchive } from '../src/pst/pst.js';
import { searchArchive, htmlToText } from '../src/search.js';
import { BufferSource } from '../src/source.js';
import { ATTACHMENT_TEXT, buildSamplePst, PNG_BYTES, SUBJECT_A } from './helpers/fixture.js';
import { decodeEncodedWords, headerValue } from './helpers/mime-decode.js';

const archive = (): PstArchive => new PstArchive(new BufferSource(buildSamplePst()));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pstpeek-test-'));
}

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

test('exports EML files into a folder hierarchy', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = exportArchive(archive(), { format: 'eml', outDir: dir });
  assert.deepEqual(res, { folders: 5, messages: 3, attachments: 3, errors: 0 });
  const list = files(dir);
  assert.deepEqual(list, [
    'Sample Archive/Top of Personal Folders/Inbox/00001 Réunion 🌍 été – planning.eml',
    'Sample Archive/Top of Personal Folders/Inbox/00002 Plain ASCII subject_ weekly report.eml',
    'Sample Archive/Top of Personal Folders/Inbox/Été 2024/00001 Fwd_ with an attached item.eml',
  ]);
  const eml = readFileSync(join(dir, list[0]!), 'latin1');
  assert.equal(decodeEncodedWords(headerValue(eml, 'Subject')!), SUBJECT_A);
  assert.equal(decodeEncodedWords(headerValue(eml, 'From')!), 'Zoë Example <zoe@example.com>');
  assert.match(headerValue(eml, 'To')!, /^Ana Test <ana@example.com>, "Bob \\"B\\" Test" <bob@example.com>$/);
  assert.equal(headerValue(eml, 'Date'), 'Tue, 05 Mar 2024 14:03:09 +0000');
  assert.equal(headerValue(eml, 'Importance'), 'high');
  assert.ok(eml.includes(Buffer.from(ATTACHMENT_TEXT).toString('base64')));
  assert.ok(eml.includes(PNG_BYTES.toString('base64').slice(0, 76)));
  assert.match(eml, /multipart\/related/);
  const fwd = readFileSync(join(dir, list[2]!), 'latin1');
  assert.match(fwd, /Content-Type: message\/rfc822/);
  assert.match(fwd, /Subject: Inner forwarded message/);
});

test('never overwrites existing files', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  exportArchive(archive(), { format: 'eml', outDir: dir });
  const first = files(dir);
  const target = join(dir, first[0]!);
  writeFileSync(target, 'user data');
  exportArchive(archive(), { format: 'eml', outDir: dir });
  assert.equal(readFileSync(target, 'utf8'), 'user data');
  assert.equal(files(dir).length, first.length * 2);
});

test('exports one mbox file per folder', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  exportArchive(archive(), { format: 'mbox', outDir: dir });
  assert.deepEqual(files(dir), [
    'Sample Archive/Top of Personal Folders/Inbox.mbox',
    'Sample Archive/Top of Personal Folders/Inbox/Été 2024.mbox',
  ]);
  const mbox = readFileSync(join(dir, 'Sample Archive/Top of Personal Folders/Inbox.mbox'), 'latin1');
  const separators = mbox.split('\n').filter((l) => l.startsWith('From '));
  assert.deepEqual(separators, ['From zoe@example.com Tue Mar  5 14:03:09 2024', 'From dan@example.net Wed Mar  6 08:00:00 2024']);
  assert.ok(!mbox.includes('\r'));
});

test('exports JSON with attachments written next to it', (t) => {
  const dir = tmp();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const a = archive();
  exportArchive(a, { format: 'json', outDir: dir, folder: findFolder(a.root, 'Inbox')! });
  const list = files(dir);
  assert.ok(list.includes('Inbox/00001 Réunion 🌍 été – planning files/rapport été.txt'));
  assert.ok(list.includes('Inbox/00001 Réunion 🌍 été – planning files/logo.png'));
  const json = JSON.parse(readFileSync(join(dir, 'Inbox/00001 Réunion 🌍 été – planning.json'), 'utf8')) as {
    subject: string;
    date: string;
    to: { name: string; email: string }[];
    attachments: { filename: string; path: string; size: number; inline: boolean }[];
  };
  assert.equal(json.subject, SUBJECT_A);
  assert.equal(json.date, '2024-03-05T14:03:09.000Z');
  assert.equal(json.to.length, 2);
  assert.deepEqual(json.attachments.map((x) => [x.filename, x.path, x.inline]), [
    ['rapport été.txt', '00001 Réunion 🌍 été – planning files/rapport été.txt', false],
    ['logo.png', '00001 Réunion 🌍 été – planning files/logo.png', true],
  ]);
  const png = readFileSync(join(dir, 'Inbox', json.attachments[1]!.path));
  assert.deepEqual(png, PNG_BYTES);
  assert.ok(statSync(join(dir, 'Inbox/Été 2024/00001 Fwd_ with an attached item files/Inner forwarded message.eml')).size > 0);
});

test('folder paths resolve case-insensitively from any level', () => {
  const a = archive();
  assert.equal(findFolder(a.root, 'inbox')?.name, 'Inbox');
  assert.equal(findFolder(a.root, 'Top of Personal Folders/Inbox/été 2024')?.name, 'Été 2024');
  assert.equal(findFolder(a.root, 'Sample Archive/Top of Personal Folders')?.name, 'Top of Personal Folders');
  assert.equal(findFolder(a.root, 'Inbox/Missing'), undefined);
  assert.deepEqual(splitFolderPath('A\\/B/C/'), ['A/B', 'C']);
});

test('search finds text in subjects, bodies and attachment names', () => {
  const a = archive();
  const hit = (q: string): string[] => [...searchArchive(a, q)].map((h) => `${h.message.subject}|${h.field}`);
  assert.deepEqual(hit('weekly'), ['Plain ASCII subject: weekly report|subject']);
  assert.deepEqual(hit('NEEDLE-XYZ'), ['Plain ASCII subject: weekly report|body']);
  assert.deepEqual(hit('chloe@example'), [`${SUBJECT_A}|to`]);
  assert.deepEqual(hit('logo.png'), [`${SUBJECT_A}|attachment`]);
  assert.deepEqual(hit('no such text anywhere'), []);
  assert.deepEqual([...searchArchive(a, 'NEEDLE-XYZ', { caseSensitive: true })], []);
  const [h] = searchArchive(a, 'needle');
  assert.ok(h && h.snippet.length < 200 && h.snippet.includes('needle-xyz'));
});

test('htmlToText strips markup and decodes entities', () => {
  assert.equal(htmlToText('<style>p{}</style><p>Caf&eacute; &amp; &#233;&#x41;</p><br>x'), 'Caf&eacute; & éA\nx');
});
