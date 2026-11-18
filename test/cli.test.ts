/** End-to-end tests: run the compiled CLI against synthetic fixture files. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSampleMsg, buildSamplePst } from './helpers/fixture.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bin.js');
let dir = '';
let pst = '';
let msg = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pstpeek-cli-'));
  pst = join(dir, 'sample.pst');
  msg = join(dir, 'sample.msg');
  writeFileSync(pst, buildSamplePst({ cryptMethod: 1 }));
  writeFileSync(msg, buildSampleMsg());
});
after(() => rmSync(dir, { recursive: true, force: true }));

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

test('tree prints folders with counts', () => {
  const r = run('tree', pst);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Sample Archive \(0\)/);
  assert.match(r.stdout, /\|-- Inbox \(2\)/);
  assert.match(r.stdout, /`-- Été 2024 \(1\)/);
  assert.match(r.stdout, /3 item\(s\) in 5 folder\(s\)/);
  const json = JSON.parse(run('tree', pst, '--json').stdout) as { name: string; children: unknown[] };
  assert.equal(json.name, 'Sample Archive');
});

test('list shows messages of a folder', () => {
  const r = run('list', pst, '--folder', 'inbox');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 {2}2024-03-05 14:03 {2}Zoë Example <zoe@example\.com>/);
  assert.match(r.stdout, /\[2 att\]/);
  const json = JSON.parse(run('list', pst, '--folder', 'Inbox', '--json').stdout) as { subject: string }[];
  assert.equal(json.length, 2);
  assert.equal(run('list', pst, '--limit', '1', '--json').stdout.includes('weekly'), false);
});

test('show prints one message', () => {
  const r = run('show', pst, '--folder', 'Inbox', '--index', '2');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Subject: Plain ASCII subject: weekly report/);
  assert.match(r.stdout, /needle-xyz/);
});

test('search prints matches', () => {
  const r = run('search', pst, 'inner message');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /0 match\(es\)/, 'embedded items are not searched');
  const r2 = run('search', pst, 'rapport', '--json');
  const hits = JSON.parse(r2.stdout) as { field: string }[];
  assert.deepEqual(hits.map((h) => h.field), ['body']);
});

test('export writes files and leaves the source untouched', () => {
  const before = sha(pst);
  const out = join(dir, 'out-eml');
  const r = run('export', pst, '-o', out, '--format', 'eml');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Exported 3 item\(s\) with 3 attachment\(s\)/);
  assert.ok(existsSync(join(out, 'Sample Archive', 'Top of Personal Folders', 'Inbox')));
  assert.equal(sha(pst), before);
  const r2 = run('export', pst, '-o', join(dir, 'out-mbox'), '-f', 'mbox', '--folder', 'Inbox');
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(existsSync(join(dir, 'out-mbox', 'Inbox.mbox')));
});

test('works with .msg files', () => {
  const r = run('list', msg);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Message from a \.msg file/);
  const s = run('show', msg);
  assert.match(s.stdout, /Attach: {2}notes\.txt/);
});

test('reports usage errors with exit code 2', () => {
  assert.equal(run().code, 2);
  assert.equal(run('frobnicate', pst).code, 2);
  assert.equal(run('export', pst).code, 2);
  const r = run('list', pst, '--folder', 'Nope');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Folder not found: Nope/);
  assert.equal(run('--help').code, 0);
  assert.match(run('--version').stdout, /^\d+\.\d+\.\d+/);
});

test('fails cleanly on unreadable input', () => {
  const junk = join(dir, 'junk.pst');
  writeFileSync(junk, Buffer.alloc(2048, 1));
  const r = run('tree', junk);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Unrecognized file format/);
  assert.equal(run('tree', join(dir, 'missing.pst')).code, 1);
});
