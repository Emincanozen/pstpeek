/**
 * Test-only writer for small, synthetic Unicode PST files, following [MS-PST].
 * It produces just enough structure for the reader: header, multi-level NBT/BBT,
 * data trees (with XBLOCKs), subnode trees, heap-on-node, BTH, PC and TC.
 * Everything it writes is generated here, so the fixtures are freely redistributable.
 */
import { deflateSync } from 'node:zlib';
import { cyclic, permuteEncode } from '../../src/pst/crypt.js';
import { dateToFiletime, fixedSize, PT } from '../../src/mapi/props.js';

export interface Prop {
  id: number;
  type: number;
  value: Buffer;
}

export const prop = {
  str: (id: number, s: string): Prop => ({ id, type: PT.UNICODE, value: Buffer.from(s, 'utf16le') }),
  str8: (id: number, s: string, enc: BufferEncoding = 'latin1'): Prop => ({ id, type: PT.STRING8, value: Buffer.from(s, enc) }),
  int: (id: number, n: number): Prop => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    return { id, type: PT.INT32, value: b };
  },
  bool: (id: number, v: boolean): Prop => ({ id, type: PT.BOOLEAN, value: Buffer.from([v ? 1 : 0]) }),
  time: (id: number, d: Date): Prop => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(dateToFiletime(d));
    return { id, type: PT.SYSTIME, value: b };
  },
  bin: (id: number, data: Buffer): Prop => ({ id, type: PT.BINARY, value: data }),
  object: (id: number, nid: number, size: number): Prop => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(nid, 0);
    b.writeUInt32LE(size, 4);
    return { id, type: PT.OBJECT, value: b };
  },
};

/** A node's content: one HN block plus nested subnodes. */
export interface NodeContent {
  data: Buffer;
  subnodes: { nid: number; content: NodeContent }[];
}

const SUBNODE_THRESHOLD = 3500;
let ltpCounter = 0x100;
const nextLtpNid = (): number => ((ltpCounter++ << 5) | 0x1f) >>> 0;

class HeapBuilder {
  private items: Buffer[] = [];
  add(buf: Buffer): number {
    this.items.push(buf);
    return this.items.length << 5;
  }
  build(clientSig: number, userRoot: number): Buffer {
    const parts: Buffer[] = [];
    const offsets: number[] = [];
    let off = 12;
    for (const it of this.items) {
      offsets.push(off);
      parts.push(it);
      off += it.length;
    }
    offsets.push(off);
    if (off % 2) {
      parts.push(Buffer.alloc(1));
      off++;
    }
    const ibHnpm = off;
    const map = Buffer.alloc(4 + offsets.length * 2);
    map.writeUInt16LE(this.items.length, 0);
    map.writeUInt16LE(0, 2);
    offsets.forEach((o, i) => map.writeUInt16LE(o, 4 + i * 2));
    const hdr = Buffer.alloc(12);
    hdr.writeUInt16LE(ibHnpm, 0);
    hdr[2] = 0xec;
    hdr[3] = clientSig;
    hdr.writeUInt32LE(userRoot, 4);
    const block = Buffer.concat([hdr, ...parts, map]);
    if (block.length > 8176) throw new Error('Test heap exceeds one block');
    return block;
  }
}

function addBth(heap: HeapBuilder, cbKey: number, cbEnt: number, records: Buffer[]): number {
  const root = records.length ? heap.add(Buffer.concat(records)) : 0;
  const h = Buffer.alloc(8);
  h[0] = 0xb5;
  h[1] = cbKey;
  h[2] = cbEnt;
  h[3] = 0;
  h.writeUInt32LE(root, 4);
  return heap.add(h);
}

/** Stores a variable value as a heap item or a subnode, returning the HNID. */
function storeValue(heap: HeapBuilder, subs: NodeContent['subnodes'], value: Buffer): number {
  if (value.length === 0) return 0;
  if (value.length > SUBNODE_THRESHOLD) {
    const nid = nextLtpNid();
    subs.push({ nid, content: { data: value, subnodes: [] } });
    return nid;
  }
  return heap.add(value);
}

export function buildPC(props: Prop[], extraSubnodes: NodeContent['subnodes'] = []): NodeContent {
  const heap = new HeapBuilder();
  const subs: NodeContent['subnodes'] = [...extraSubnodes];
  const recs: Buffer[] = [];
  for (const p of [...props].sort((a, b) => a.id - b.id)) {
    const r = Buffer.alloc(8);
    r.writeUInt16LE(p.id, 0);
    r.writeUInt16LE(p.type, 2);
    const size = fixedSize(p.type);
    let hnid: number;
    if (size !== undefined && size <= 4) {
      const v = Buffer.alloc(4);
      p.value.copy(v);
      hnid = v.readUInt32LE(0);
    } else if (p.type === PT.OBJECT) {
      hnid = heap.add(p.value);
    } else {
      hnid = storeValue(heap, subs, p.value);
    }
    r.writeUInt32LE(hnid >>> 0, 4);
    recs.push(r);
  }
  const hid = addBth(heap, 2, 6, recs);
  return { data: heap.build(0xbc, hid), subnodes: subs };
}

export interface Column {
  id: number;
  type: number;
}

/** Builds a table context. Each row is a list of props; rowIds give dwRowID values. */
export function buildTC(columns: Column[], rows: { rowId: number; props: Prop[] }[]): NodeContent {
  const heap = new HeapBuilder();
  const subs: NodeContent['subnodes'] = [];
  const all: Column[] = [{ id: 0x67f2, type: PT.INT32 }, { id: 0x67f3, type: PT.INT32 }, ...columns];
  const width = (c: Column): number => {
    const s = fixedSize(c.type);
    return s === undefined ? 4 : s;
  };
  // Layout: 8- and 4-byte cells first, then 2-byte, then 1-byte, then the CEB.
  const ordered = [
    ...all.slice(0, 2),
    ...all.slice(2).filter((c) => width(c) >= 4).sort((a, b) => width(b) - width(a)),
    ...all.slice(2).filter((c) => width(c) === 2),
    ...all.slice(2).filter((c) => width(c) === 1),
  ];
  const layout = new Map<number, { ib: number; cb: number; iBit: number }>();
  let ib = 0;
  let end4 = 0;
  let end2 = 0;
  ordered.forEach((c, iBit) => {
    const cb = width(c);
    layout.set(c.id, { ib, cb, iBit });
    ib += cb;
    if (cb >= 4) end4 = ib;
    if (cb >= 2) end2 = ib;
  });
  const end1 = ib;
  const cebSize = Math.ceil(all.length / 8);
  const rowSize = end1 + cebSize;

  const rowBufs: Buffer[] = [];
  const indexRecs: Buffer[] = [];
  rows.forEach((row, i) => {
    const r = Buffer.alloc(rowSize);
    const setBit = (iBit: number): void => {
      r[end1 + (iBit >> 3)]! |= 0x80 >> (iBit & 7);
    };
    r.writeUInt32LE(row.rowId >>> 0, 0);
    setBit(0);
    for (const p of row.props) {
      const l = layout.get(p.id);
      if (!l) throw new Error(`No column for 0x${p.id.toString(16)}`);
      if (fixedSize(p.type) !== undefined) p.value.copy(r, l.ib, 0, l.cb);
      else r.writeUInt32LE(storeValue(heap, subs, p.value) >>> 0, l.ib);
      setBit(l.iBit);
    }
    rowBufs.push(r);
    const rec = Buffer.alloc(8);
    rec.writeUInt32LE(row.rowId >>> 0, 0);
    rec.writeUInt32LE(i, 4);
    indexRecs.push(rec);
  });
  indexRecs.sort((a, b) => a.readUInt32LE(0) - b.readUInt32LE(0));
  const hidRowIndex = addBth(heap, 4, 4, indexRecs);
  const hnidRows = rowBufs.length ? heap.add(Buffer.concat(rowBufs)) : 0;

  const tagOf = (c: Column): number => ((c.id << 16) >>> 0) + c.type;
  const cols = [...all].sort((a, b) => tagOf(a) - tagOf(b));
  const info = Buffer.alloc(22 + cols.length * 8);
  info[0] = 0x7c;
  info[1] = cols.length;
  info.writeUInt16LE(end4, 2);
  info.writeUInt16LE(end2, 4);
  info.writeUInt16LE(end1, 6);
  info.writeUInt16LE(rowSize, 8);
  info.writeUInt32LE(hidRowIndex, 10);
  info.writeUInt32LE(hnidRows, 14);
  info.writeUInt32LE(0, 18);
  cols.forEach((c, i) => {
    const l = layout.get(c.id)!;
    const off = 22 + i * 8;
    info.writeUInt32LE((((c.id << 16) >>> 0) | c.type) >>> 0, off);
    info.writeUInt16LE(l.ib, off + 4);
    info[off + 6] = l.cb;
    info[off + 7] = l.iBit;
  });
  const hid = heap.add(info);
  return { data: heap.build(0x7c, hid), subnodes: subs };
}

export interface BuildOptions {
  cryptMethod?: 0 | 1 | 2;
  /** Max entries per B-tree leaf/intermediate page, to force multi-level trees. */
  maxPageEntries?: number;
  /** 'unicode4k' writes the Outlook 2013+ OST layout (wVer 36, 4096-byte pages). */
  format?: 'unicode' | 'unicode4k';
  /** 4K format only: zlib-compress data blocks (cb < cbInflated). */
  compress?: boolean;
}

interface NodeRec {
  nid: number;
  parent: number;
  content: NodeContent;
}

export class PstBuilder {
  private nodes: NodeRec[] = [];
  private blocks: { bid: bigint; data: Buffer }[] = [];
  private nextBid = 1;
  constructor(private readonly opts: BuildOptions = {}) {}

  addNode(nid: number, parent: number, content: NodeContent): this {
    this.nodes.push({ nid, parent, content });
    return this;
  }

  private addBlock(data: Buffer, internal: boolean): bigint {
    const bid = (BigInt(this.nextBid++) << 2n) | (internal ? 2n : 0n);
    const d = Buffer.from(data);
    if (!internal) {
      if (this.opts.cryptMethod === 1) permuteEncode(d);
      else if (this.opts.cryptMethod === 2) cyclic(d, Number(bid & 0xffffffffn));
    }
    this.blocks.push({ bid, data: d });
    return bid;
  }

  private writeData(buf: Buffer): bigint {
    if (buf.length <= 8176) return this.addBlock(buf, false);
    const bids: bigint[] = [];
    for (let i = 0; i < buf.length; i += 8176) bids.push(this.addBlock(buf.subarray(i, i + 8176), false));
    const x = Buffer.alloc(8 + bids.length * 8);
    x[0] = 0x01;
    x[1] = 0x01;
    x.writeUInt16LE(bids.length, 2);
    x.writeUInt32LE(buf.length, 4);
    bids.forEach((b, i) => x.writeBigUInt64LE(b, 8 + i * 8));
    return this.addBlock(x, true);
  }

  private writeContent(c: NodeContent): { bidData: bigint; bidSub: bigint } {
    const bidData = this.writeData(c.data);
    if (!c.subnodes.length) return { bidData, bidSub: 0n };
    const entries = [...c.subnodes].sort((a, b) => a.nid - b.nid).map((s) => ({ nid: s.nid, ...this.writeContent(s.content) }));
    const sl = Buffer.alloc(8 + entries.length * 24);
    sl[0] = 0x02;
    sl[1] = 0x00;
    sl.writeUInt16LE(entries.length, 2);
    entries.forEach((e, i) => {
      const off = 8 + i * 24;
      sl.writeBigUInt64LE(BigInt(e.nid), off);
      sl.writeBigUInt64LE(e.bidData, off + 8);
      sl.writeBigUInt64LE(e.bidSub, off + 16);
    });
    return { bidData, bidSub: this.addBlock(sl, true) };
  }

  build(): Buffer {
    const nbt = this.nodes
      .map((n) => ({ nid: n.nid, parent: n.parent, ...this.writeContent(n.content) }))
      .sort((a, b) => a.nid - b.nid);

    const parts: Buffer[] = [Buffer.alloc(1024)];
    let pos = 1024;
    const k4 = this.opts.format === 'unicode4k';
    const PAGE = k4 ? 4096 : 512;
    const blockIb = new Map<bigint, { ib: number; cb: number; cbInflated: number }>();
    for (const b of this.blocks) {
      const stored = k4 && this.opts.compress ? deflateSync(b.data) : b.data;
      const size = Math.ceil((stored.length + 16) / 64) * 64;
      const buf = Buffer.alloc(size);
      stored.copy(buf);
      const t = size - 16;
      buf.writeUInt16LE(stored.length, t);
      buf.writeBigUInt64LE(b.bid, t + 8);
      blockIb.set(b.bid, { ib: pos, cb: stored.length, cbInflated: b.data.length });
      parts.push(buf);
      pos += size;
    }
    // Align pages to 512 bytes.
    const padTo512 = (): void => {
      const pad = (PAGE - (pos % PAGE)) % PAGE;
      if (pad) {
        parts.push(Buffer.alloc(pad));
        pos += pad;
      }
    };
    padTo512();

    let pageBid = 0x10000n;
    const writePage = (ptype: number, level: number, cbEnt: number, cEntMax: number, entries: Buffer[]): { bid: bigint; ib: number } => {
      const p = Buffer.alloc(PAGE);
      entries.forEach((e, i) => e.copy(p, i * cbEnt));
      const bid = (pageBid += 4n);
      if (k4) {
        // Observed in an Outlook 2013 OST: u16 cEnt, u16 cEntMax, u8 cbEnt, u8 cLevel at 4056; 24-byte trailer at 4072.
        p.writeUInt16LE(entries.length, 4056);
        p.writeUInt16LE(cEntMax, 4058);
        p[4060] = cbEnt;
        p[4061] = level;
        p[4072] = ptype;
        p[4073] = ptype;
        p.writeBigUInt64LE(bid, 4080);
      } else {
        p[488] = entries.length;
        p[489] = cEntMax;
        p[490] = cbEnt;
        p[491] = level;
        p[496] = ptype;
        p[497] = ptype;
        p.writeBigUInt64LE(bid, 504);
      }
      const ib = pos;
      parts.push(p);
      pos += PAGE;
      return { bid, ib };
    };

    const buildTree = (ptype: number, leafCbEnt: number, leafMax: number, leaves: { key: bigint; buf: Buffer }[]): { bid: bigint; ib: number } => {
      const cap = Math.min(this.opts.maxPageEntries ?? leafMax, leafMax);
      let level = 0;
      let items: { key: bigint; buf: Buffer }[] = leaves;
      let cbEnt = leafCbEnt;
      let max = leafMax;
      for (;;) {
        const pages: { key: bigint; ref: { bid: bigint; ib: number } }[] = [];
        for (let i = 0; i < Math.max(items.length, 1); i += cap) {
          const chunk = items.slice(i, i + cap);
          pages.push({ key: chunk[0]?.key ?? 0n, ref: writePage(ptype, level, cbEnt, max, chunk.map((c) => c.buf)) });
        }
        if (pages.length === 1) return pages[0]!.ref;
        items = pages.map((p) => {
          const e = Buffer.alloc(24);
          e.writeBigUInt64LE(p.key, 0);
          e.writeBigUInt64LE(p.ref.bid, 8);
          e.writeBigUInt64LE(BigInt(p.ref.ib), 16);
          return { key: p.key, buf: e };
        });
        level++;
        cbEnt = 24;
        max = k4 ? 169 : 20;
      }
    };

    const bbtLeaves = [...blockIb.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([bid, { ib, cb, cbInflated }]) => {
        const e = Buffer.alloc(24);
        e.writeBigUInt64LE(bid, 0);
        e.writeBigUInt64LE(BigInt(ib), 8);
        e.writeUInt16LE(cb, 16);
        if (k4) {
          e.writeUInt16LE(cbInflated, 18);
          e.writeUInt32LE(2, 20);
        } else e.writeUInt16LE(2, 18);
        return { key: bid, buf: e };
      });
    const bbtRoot = buildTree(0x80, 24, k4 ? 169 : 20, bbtLeaves);

    const nbtLeaves = nbt.map((n) => {
      const e = Buffer.alloc(32);
      e.writeBigUInt64LE(BigInt(n.nid), 0);
      e.writeBigUInt64LE(n.bidData, 8);
      e.writeBigUInt64LE(n.bidSub, 16);
      e.writeUInt32LE(n.parent >>> 0, 24);
      return { key: BigInt(n.nid), buf: e };
    });
    const nbtRoot = buildTree(0x81, 32, k4 ? 126 : 15, nbtLeaves);

    const file = Buffer.concat(parts);
    const h = file;
    h.write('!BDN', 0, 'latin1');
    h.writeUInt16LE(k4 ? 0x4f53 : 0x4d53, 8); // "SO" (OST) or "SM" (PST)
    h.writeUInt16LE(k4 ? 36 : 23, 10);
    h.writeUInt16LE(19, 12);
    h[14] = 1;
    h[15] = 1;
    h.writeBigUInt64LE(pageBid + 4n, 32);
    h.writeBigUInt64LE(BigInt(file.length), 184);
    h.writeBigUInt64LE(nbtRoot.bid, 216);
    h.writeBigUInt64LE(BigInt(nbtRoot.ib), 224);
    h.writeBigUInt64LE(bbtRoot.bid, 232);
    h.writeBigUInt64LE(BigInt(bbtRoot.ib), 240);
    h[512] = 0x80;
    h[513] = this.opts.cryptMethod ?? 0;
    return file;
  }
}
