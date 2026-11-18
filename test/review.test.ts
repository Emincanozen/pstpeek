/**
 * Regression tests for the findings of an independent code review. Each test
 * was written before the corresponding fix and failed on the previous code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeapOnNode, readBth } from '../src/pst/ltp.js';
import { NodeDatabase, PstFormatError } from '../src/pst/ndb.js';
import { BufferSource } from '../src/source.js';
import { readCfb } from '../src/msg/cfb.js';
import { parseMsg } from '../src/msg/msg.js';
import { decompressRtf } from '../src/mapi/rtf.js';
import { buildEml } from '../src/export/mime.js';
import { exportArchive } from '../src/export/exporter.js';
import { PstArchive } from '../src/pst/pst.js';
import { openArchive } from '../src/open.js';
import { PT } from '../src/mapi/props.js';
import type { Attachment, MailMessage } from '../src/model.js';
import { buildCfb, msgStorage } from './helpers/cfb-builder.js';
import { buildSampleMsg, buildSamplePst } from './helpers/fixture.js';
import { prop } from './helpers/pst-builder.js';
import { unfold } from './helpers/mime-decode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ------------------------------------------------------------------ BTH

/** A heap whose BTH intermediate item lists itself twice as a child. */
function cyclicBthHeap(levels: number): HeapOnNode {
  const item1 = Buffer.from([0xb5, 2, 6, levels, 0x40, 0, 0, 0]);
  const item2 = Buffer.alloc(12);
  item2.writeUInt16LE(1, 0);
  item2.writeUInt32LE(0x40, 2);
  item2.writeUInt16LE(2, 6);
  item2.writeUInt32LE(0x40, 8);
  const map = Buffer.alloc(10);
  map.writeUInt16LE(2, 0);
  map.writeUInt16LE(12, 4);
  map.writeUInt16LE(20, 6);
  map.writeUInt16LE(32, 8);
  const hdr = Buffer.alloc(12);
  hdr.writeUInt16LE(32, 0);
  hdr[2] = 0xec;
  hdr[3] = 0xbc;
  hdr.writeUInt32LE(0x20, 4);
  return new HeapOnNode([Buffer.concat([hdr, item1, item2, map])]);
}

test('review: a cyclic BTH is rejected instead of being walked repeatedly', () => {
  assert.throws(() => readBth(cyclicBthHeap(3), 0x20), PstFormatError);
});

test('review: an implausible BTH depth is rejected, not silently clamped', () => {
  assert.throws(() => readBth(cyclicBthHeap(9), 0x20), PstFormatError);
});

// ------------------------------------------------------- data/subnode trees

function patchedDb(blocks: Map<bigint, Buffer>): NodeDatabase {
  const db = new NodeDatabase(new BufferSource(buildSamplePst()));
  (db as unknown as { readBlock: (bid: bigint) => Buffer }).readBlock = (bid: bigint) => {
    const b = blocks.get(bid);
    if (!b) throw new PstFormatError('missing');
    return Buffer.from(b);
  };
  return db;
}

function xblock(level: number, lcbTotal: number, bids: bigint[]): Buffer {
  const b = Buffer.alloc(8 + bids.length * 8);
  b[0] = 1;
  b[1] = level;
  b.writeUInt16LE(bids.length, 2);
  b.writeUInt32LE(lcbTotal, 4);
  bids.forEach((x, i) => b.writeBigUInt64LE(x, 8 + i * 8));
  return b;
}

test('review: a data tree that reuses the same XBLOCK is rejected', () => {
  const db = patchedDb(
    new Map([
      [0x6n, xblock(2, 16, [0xan, 0xan, 0xan])],
      [0xan, xblock(1, 16, [0x8n, 0x8n])],
      [0x8n, Buffer.alloc(8, 1)],
    ]),
  );
  assert.throws(() => db.readDataBlocks(0x6n), PstFormatError);
});

test('review: a data tree larger than its declared size is rejected', () => {
  const db = patchedDb(new Map([[0x6n, xblock(1, 8, [0x8n, 0xcn])], [0x8n, Buffer.alloc(8)], [0xcn, Buffer.alloc(8)]]));
  assert.throws(() => db.readDataBlocks(0x6n), PstFormatError);
});

test('review: an XBLOCK whose entry count exceeds the block is a clean format error', () => {
  const x = xblock(1, 8, [0x8n]);
  x.writeUInt16LE(500, 2);
  const db = patchedDb(new Map([[0x6n, x], [0x8n, Buffer.alloc(8)]]));
  assert.throws(() => db.readDataBlocks(0x6n), PstFormatError);
});

test('review: a subnode tree that reuses the same SLBLOCK is rejected', () => {
  const sl = Buffer.alloc(8 + 24);
  sl[0] = 2;
  sl.writeUInt16LE(1, 2);
  sl.writeBigUInt64LE(0x1fn, 8);
  const si = Buffer.alloc(8 + 3 * 16);
  si[0] = 2;
  si[1] = 1;
  si.writeUInt16LE(3, 2);
  for (let i = 0; i < 3; i++) si.writeBigUInt64LE(0xen, 8 + i * 16 + 8);
  const db = patchedDb(new Map([[0x12n, si], [0xen, sl]]));
  assert.throws(() => db.readSubnodes(0x12n), PstFormatError);
});

// ------------------------------------------------------------------ CFB

test('review: a DIFAT chain that loops is reported as corrupt', () => {
  const base = buildCfb({ name: 'Root Entry', children: [{ name: 's', data: Buffer.from('x') }] });
  const extra = Buffer.alloc(512, 0xff);
  const selfSector = base.length / 512 - 1; // index of the appended sector
  extra.writeUInt32LE(selfSector, 508);
  const file = Buffer.concat([base, extra]);
  file.writeUInt32LE(selfSector, 68);
  file.writeUInt32LE(50000, 72);
  assert.throws(() => readCfb(file), /loop|cycle|DIFAT/i);
});

test('review: a stream shorter than its declared size is reported, not truncated silently', () => {
  const file = buildCfb({ name: 'Root Entry', children: [{ name: 's', data: Buffer.alloc(40, 1) }] });
  // header (512) + one FAT sector (512) + directory entry #1, size field at +120
  file.writeUInt32LE(200, 512 + 512 + 128 + 120);
  const root = readCfb(file);
  assert.throws(() => root.children.get('S')!.read(), /corrupt|short|truncat/i);
});

// ------------------------------------------------------------------ RTF

const RTF_VECTOR = Buffer.from(
  '2d0000002b0000004c5a4675f1c5c7a703000a007263706731323542320af32068656c090020627705b06c647d0a800fa0',
  'hex',
);

test('review: compressed RTF with a wrong CRC is rejected', () => {
  const bad = Buffer.from(RTF_VECTOR);
  bad[12] = bad[12]! ^ 0xff;
  assert.throws(() => decompressRtf(bad), /crc/i);
});

test('review: compressed RTF with an implausible RAWSIZE is rejected before allocating', () => {
  const bad = Buffer.from(RTF_VECTOR);
  bad.writeUInt32LE(64 * 1024 * 1024, 4);
  assert.throws(() => decompressRtf(bad), /size/i);
});

test('review: uncompressed (MELA) RTF is read to the end of the stream', () => {
  const body = Buffer.from('{\\rtf1 full body}', 'latin1');
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(body.length + 12, 0);
  hdr.writeUInt32LE(3, 4); // RAWSIZE smaller than the content
  hdr.writeUInt32LE(0x414c454d, 8);
  assert.equal(decompressRtf(Buffer.concat([hdr, body])).toString('latin1'), '{\\rtf1 full body}');
});

// ------------------------------------------------------------------ MIME

function withAttachment(filename: string): string {
  const a: Attachment = {
    filename,
    mimeType: 'application/x-test',
    size: 1,
    inline: false,
    getData: () => Buffer.from('x'),
    getEmbedded: () => undefined,
  };
  const m: MailMessage = { messageClass: 'IPM.Note', subject: 's', to: [], cc: [], bcc: [], attachments: [a], bodyText: 'b' };
  return unfold(buildEml(m).toString('latin1'));
}

test('review: long ASCII attachment names are complete in Content-Type', () => {
  const name = `${'a'.repeat(70)}.txt`;
  const ct = /Content-Type: application\/x-test;[^\r\n]*/.exec(withAttachment(name))![0];
  const value = ct.includes('name="')
    ? /name="([^"]*)"/.exec(ct)![1]
    : decodeURIComponent([...ct.matchAll(/name\*\d+\*?=([^;]*)/g)].map((m) => m[1]!.trim()).join('').replace(/^UTF-8''/, ''));
  assert.equal(value, name);
});

test('review: non-ASCII attachment names use RFC 2231 in Content-Type, not encoded words', () => {
  const ct = /Content-Type: application\/x-test;[^\r\n]*/.exec(withAttachment('rapport été.txt'))![0];
  assert.ok(!ct.includes('=?'), ct);
  assert.match(ct, /name\*=UTF-8''rapport%20%C3%A9t%C3%A9\.txt/);
});

// ------------------------------------------------------------- symlinks

test('review: export never writes through a directory symlink inside the output tree', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pstpeek-review-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const out = join(base, 'out');
  const outside = join(base, 'outside');
  mkdirSync(out);
  mkdirSync(outside);
  symlinkSync(outside, join(out, 'Sample Archive'), 'junction');
  const archive = new PstArchive(new BufferSource(buildSamplePst()));
  try {
    exportArchive(archive, { format: 'eml', outDir: out });
  } catch {
    // refusing is acceptable
  }
  assert.deepEqual(readdirSync(outside), []);
});

// ------------------------------------------------------- multi-valued

test('review: multi-valued properties of .msg files are kept', async () => {
  const lengths = Buffer.alloc(8);
  lengths.writeUInt32LE(Buffer.byteLength('alpha\0', 'utf16le'), 0);
  lengths.writeUInt32LE(Buffer.byteLength('béta\0', 'utf16le'), 4);
  const top = msgStorage('Root Entry', [prop.str(0x0037, 'mv')], 32, [
    { name: '__substg1.0_8001101F', data: lengths },
    { name: '__substg1.0_8001101F-00000000', data: Buffer.from('alpha\0', 'utf16le') },
    { name: '__substg1.0_8001101F-00000001', data: Buffer.from('béta\0', 'utf16le') },
    { name: '__substg1.0_80021003', data: Buffer.from([1, 0, 0, 0, 2, 0, 0, 0]) },
  ]);
  const mod = (await import('../src/msg/msg.js')) as Record<string, unknown>;
  assert.equal(typeof mod['msgPropertyBag'], 'function', 'no access to .msg properties');
  const bag = (mod['msgPropertyBag'] as (b: Buffer) => { multi(id: number): unknown[] | undefined })(buildCfb(top));
  assert.deepEqual(bag.multi(0x8001), ['alpha', 'béta']);
  assert.deepEqual(bag.multi(0x8002), [1, 2]);
  assert.equal(parseMsg(buildCfb(top)).subject, 'mv');
});

// ----------------------------------------------------------- memory cap

test('review: .msg files above the size cap are refused with a clear message', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'pstpeek-review-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const p = join(base, 'x.msg');
  writeFileSync(p, buildSampleMsg());
  const open = openArchive as unknown as (path: string, opts?: { maxMsgBytes?: number }) => { close(): void };
  assert.throws(() => open(p, { maxMsgBytes: 100 }).close(), /too large/i);
});

// ------------------------------------------------------- packaging / docs

test('review: the package builds dist/ before packing', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.ok(pkg.scripts['prepack'] || pkg.scripts['prepare'], 'no prepack/prepare script');
});

test('review: the README does not claim "Supported" for unvalidated formats and warns up front', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(!/\|\s*Supported/.test(readme), 'a table cell still says Supported');
  const head = readme.slice(0, 1200);
  assert.match(head, /alpha|experimental/i);
  assert.match(head, /only 22 small public sample files/i);
  assert.match(head, /not validated/i);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.match(pkg.version, /^0\./);
});

void PT;
