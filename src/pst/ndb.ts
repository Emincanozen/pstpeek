/**
 * Node Database (NDB) layer of the PST/OST format, implemented from the
 * [MS-PST] open specification: header, node and block B-trees, data trees
 * (XBLOCK/XXBLOCK) and subnode trees (SLBLOCK/SIBLOCK).
 */
import { inflateSync } from 'node:zlib';
import type { ByteSource } from '../source.js';
import { CRYPT_CYCLIC, CRYPT_NONE, CRYPT_PERMUTE, cyclic, permuteDecode } from './crypt.js';

export type PstFormat = 'ansi' | 'unicode' | 'unicode4k';

export class PstFormatError extends Error {
  override name = 'PstFormatError';
}

export interface NodeEntry {
  nid: number;
  bidData: bigint;
  bidSub: bigint;
  nidParent: number;
}

interface BlockEntry {
  bid: bigint;
  ib: number;
  cb: number;
  cbInflated: number;
}

interface BTPage {
  level: number;
  cbEnt: number;
  entries: Buffer[];
}

export const NID_TYPE = {
  HID: 0x00,
  INTERNAL: 0x01,
  NORMAL_FOLDER: 0x02,
  SEARCH_FOLDER: 0x03,
  NORMAL_MESSAGE: 0x04,
  ATTACHMENT: 0x05,
  ASSOC_MESSAGE: 0x08,
  HIERARCHY_TABLE: 0x0d,
  CONTENTS_TABLE: 0x0e,
  ASSOC_CONTENTS_TABLE: 0x0f,
  ATTACHMENT_TABLE: 0x11,
  RECIPIENT_TABLE: 0x12,
  LTP: 0x1f,
} as const;

export const NID_MESSAGE_STORE = 0x21;
export const NID_ROOT_FOLDER = 0x122;
export const NID_ATTACHMENT_TABLE = 0x671;
export const NID_RECIPIENT_TABLE = 0x692;

export const nidType = (nid: number): number => nid & 0x1f;
export const withNidType = (nid: number, type: number): number => ((nid & ~0x1f) | type) >>> 0;

const BID_INTERNAL = 0x2n;
const MAX_TREE_DEPTH = 16;

const MAGIC = 0x4e444221; // "!BDN"

export class NodeDatabase {
  readonly format: PstFormat;
  readonly cryptMethod: number;
  readonly isOst: boolean;
  private readonly pageSize: number;
  private readonly nbtRoot: number;
  private readonly bbtRoot: number;
  private nodes: Map<number, NodeEntry> | undefined;
  private childIndex: Map<number, number[]> | undefined;
  private readonly pageCache = new Map<number, BTPage>();

  constructor(private readonly src: ByteSource) {
    if (src.size < 564) throw new PstFormatError('File is too small to be a PST/OST file');
    const h = src.read(0, Math.min(src.size, 1024));
    if (h.readUInt32LE(0) !== MAGIC) throw new PstFormatError('Not a PST/OST file (missing !BDN signature)');
    const client = h.readUInt16LE(8);
    this.isOst = client === 0x4f53; // "SO"
    const ver = h.readUInt16LE(10);
    if (ver === 14 || ver === 15) {
      this.format = 'ansi';
      this.pageSize = 512;
      this.nbtRoot = h.readUInt32LE(188);
      this.bbtRoot = h.readUInt32LE(196);
      this.cryptMethod = h.readUInt8(461);
    } else if (ver === 23 || ver === 36) {
      this.format = ver === 23 ? 'unicode' : 'unicode4k';
      this.pageSize = ver === 23 ? 512 : 4096;
      this.nbtRoot = Number(h.readBigUInt64LE(224));
      this.bbtRoot = Number(h.readBigUInt64LE(240));
      this.cryptMethod = h.readUInt8(513);
    } else {
      throw new PstFormatError(`Unsupported PST/OST version ${ver}`);
    }
    if (![CRYPT_NONE, CRYPT_PERMUTE, CRYPT_CYCLIC].includes(this.cryptMethod)) {
      throw new PstFormatError(`Unsupported encryption method 0x${this.cryptMethod.toString(16)}`);
    }
  }

  get isAnsi(): boolean {
    return this.format === 'ansi';
  }

  close(): void {
    this.src.close();
  }

  // ---------------------------------------------------------------- B-trees

  private readPage(ib: number, expectedType: number): BTPage {
    const cached = this.pageCache.get(ib);
    if (cached) return cached;
    const p = this.src.read(ib, this.pageSize);
    let cEnt: number, cbEnt: number, level: number, ptype: number;
    if (this.format === 'ansi') {
      cEnt = p[496]!; cbEnt = p[498]!; level = p[499]!; ptype = p[500]!;
    } else if (this.format === 'unicode') {
      cEnt = p[488]!; cbEnt = p[490]!; level = p[491]!; ptype = p[496]!;
    } else {
      // 4K pages: u16 cEnt, u16 cEntMax, u8 cbEnt, u8 cLevel at 4056, then a 24-byte trailer at 4072
      // (layout confirmed on a public Outlook 2013 OST sample).
      cEnt = p.readUInt16LE(4056); cbEnt = p[4060]!; level = p[4061]!; ptype = p[4072]!;
    }
    if (ptype !== expectedType) {
      throw new PstFormatError(`Corrupt B-tree page at offset ${ib} (type 0x${ptype.toString(16)})`);
    }
    if (cbEnt === 0 || cEnt * cbEnt > this.pageSize) {
      throw new PstFormatError(`Corrupt B-tree page at offset ${ib}`);
    }
    const entries: Buffer[] = [];
    for (let i = 0; i < cEnt; i++) entries.push(p.subarray(i * cbEnt, (i + 1) * cbEnt));
    const page = { level, cbEnt, entries };
    if (this.pageCache.size > 4096) this.pageCache.clear();
    this.pageCache.set(ib, page);
    return page;
  }

  /** Reads key and child offset of an intermediate (BTENTRY) record. */
  private btEntry(e: Buffer): { key: bigint; ib: number } {
    if (this.format === 'ansi') return { key: BigInt(e.readUInt32LE(0)), ib: e.readUInt32LE(8) };
    return { key: e.readBigUInt64LE(0), ib: Number(e.readBigUInt64LE(16)) };
  }

  private parseNbtLeaf(e: Buffer): NodeEntry {
    if (this.format === 'ansi') {
      return {
        nid: e.readUInt32LE(0),
        bidData: BigInt(e.readUInt32LE(4)),
        bidSub: BigInt(e.readUInt32LE(8)),
        nidParent: e.readUInt32LE(12),
      };
    }
    return {
      nid: e.readUInt32LE(0),
      bidData: e.readBigUInt64LE(8),
      bidSub: e.readBigUInt64LE(16),
      nidParent: e.readUInt32LE(24),
    };
  }

  private parseBbtLeaf(e: Buffer): BlockEntry {
    if (this.format === 'ansi') {
      const cb = e.readUInt16LE(8);
      return { bid: BigInt(e.readUInt32LE(0)), ib: e.readUInt32LE(4), cb, cbInflated: cb };
    }
    const cb = e.readUInt16LE(16);
    let cbInflated = cb;
    if (this.format === 'unicode4k') {
      const v = e.readUInt16LE(18);
      if (v > 0) cbInflated = v;
    }
    return { bid: e.readBigUInt64LE(0), ib: Number(e.readBigUInt64LE(8)), cb, cbInflated };
  }

  /** Loads the whole node B-tree (NBT). Node counts are modest even for large archives. */
  private loadNodes(): Map<number, NodeEntry> {
    if (this.nodes) return this.nodes;
    const nodes = new Map<number, NodeEntry>();
    const visited = new Set<number>();
    const walk = (ib: number, depth: number): void => {
      if (depth > MAX_TREE_DEPTH || visited.has(ib)) return;
      visited.add(ib);
      const page = this.readPage(ib, 0x81);
      for (const e of page.entries) {
        if (page.level === 0) {
          const n = this.parseNbtLeaf(e);
          nodes.set(n.nid, n);
        } else {
          walk(this.btEntry(e).ib, depth + 1);
        }
      }
    };
    walk(this.nbtRoot, 0);
    this.nodes = nodes;
    return nodes;
  }

  getNode(nid: number): NodeEntry | undefined {
    return this.loadNodes().get(nid);
  }

  /** Node ids whose NBT parent is `nid` (used as a fallback when tables are missing). */
  childrenOf(nid: number): number[] {
    if (!this.childIndex) {
      const idx = new Map<number, number[]>();
      for (const n of this.loadNodes().values()) {
        if (n.nidParent === n.nid) continue;
        let list = idx.get(n.nidParent);
        if (!list) idx.set(n.nidParent, (list = []));
        list.push(n.nid);
      }
      for (const list of idx.values()) list.sort((a, b) => a - b);
      this.childIndex = idx;
    }
    return this.childIndex.get(nid) ?? [];
  }

  private findBlock(bid: bigint): BlockEntry {
    const target = bid & ~1n;
    let ib = this.bbtRoot;
    for (let depth = 0; depth <= MAX_TREE_DEPTH; depth++) {
      const page = this.readPage(ib, 0x80);
      if (page.level === 0) {
        for (const e of page.entries) {
          const b = this.parseBbtLeaf(e);
          if ((b.bid & ~1n) === target) return b;
        }
        break;
      }
      let next: number | undefined;
      for (const e of page.entries) {
        const { key, ib: child } = this.btEntry(e);
        if ((key & ~1n) <= target) next = child;
        else break;
      }
      if (next === undefined) break;
      ib = next;
    }
    throw new PstFormatError(`Block 0x${bid.toString(16)} not found`);
  }

  // ----------------------------------------------------------------- blocks

  /** Reads one block, decompressed (OST 4K format) and decoded. */
  readBlock(bid: bigint): Buffer {
    const entry = this.findBlock(bid);
    let data = this.src.read(entry.ib, entry.cb);
    if (entry.cbInflated > entry.cb) {
      try {
        data = inflateSync(data);
      } catch {
        throw new PstFormatError(`Cannot decompress block 0x${bid.toString(16)}`);
      }
    }
    if ((bid & BID_INTERNAL) === 0n) {
      if (this.cryptMethod === CRYPT_PERMUTE) permuteDecode(data);
      else if (this.cryptMethod === CRYPT_CYCLIC) cyclic(data, Number(bid & 0xffffffffn));
    }
    return data;
  }

  private bidSize(): number {
    return this.format === 'ansi' ? 4 : 8;
  }

  private readBid(buf: Buffer, off: number): bigint {
    return this.format === 'ansi' ? BigInt(buf.readUInt32LE(off)) : buf.readBigUInt64LE(off);
  }

  /** Returns the data blocks of a data tree (one entry per external block). */
  readDataBlocks(bid: bigint): Buffer[] {
    if (bid === 0n) return [];
    if ((bid & BID_INTERNAL) === 0n) return [this.readBlock(bid)];
    const out: Buffer[] = [];
    let total = 0;
    const visited = new Set<bigint>();
    // XBLOCK (level 1) lists data blocks, XXBLOCK (level 2) lists XBLOCKs; nothing deeper exists.
    const walk = (xbid: bigint, expectedLevel: number | undefined, budget: number): void => {
      const key = xbid & ~1n;
      if (visited.has(key)) throw new PstFormatError(`Data tree block 0x${xbid.toString(16)} is referenced twice`);
      visited.add(key);
      if ((xbid & BID_INTERNAL) === 0n) throw new PstFormatError('Data tree references a data block where an XBLOCK is expected');
      const block = this.readBlock(xbid);
      if (block.length < 8 || block[0] !== 0x01) {
        throw new PstFormatError(`Unexpected internal block type 0x${(block[0] ?? 0).toString(16)}`);
      }
      const level = block[1]!;
      if (level !== 1 && level !== 2) throw new PstFormatError(`Invalid data tree level ${level}`);
      if (expectedLevel !== undefined && level !== expectedLevel) throw new PstFormatError('Inconsistent data tree levels');
      const count = block.readUInt16LE(2);
      const lcbTotal = block.readUInt32LE(4);
      const size = this.bidSize();
      if (8 + count * size > block.length) throw new PstFormatError('XBLOCK entry count exceeds the block size');
      if (lcbTotal > budget) throw new PstFormatError('XBLOCK total size exceeds its parent');
      const startTotal = total;
      for (let i = 0; i < count; i++) {
        const child = this.readBid(block, 8 + i * size);
        if (level === 1) {
          if ((child & BID_INTERNAL) !== 0n) throw new PstFormatError('XBLOCK references an internal block');
          // Leaf blocks may legitimately repeat; the declared total size bounds the work.
          const data = this.readBlock(child);
          total += data.length;
          if (total - startTotal > lcbTotal) throw new PstFormatError('Data tree is larger than its declared size');
          out.push(data);
        } else {
          walk(child, 1, lcbTotal - (total - startTotal));
        }
      }
    };
    walk(bid, undefined, 0xffffffff);
    return out;
  }

  readData(bid: bigint): Buffer {
    const blocks = this.readDataBlocks(bid);
    return blocks.length === 1 ? blocks[0]! : Buffer.concat(blocks);
  }

  /** Parses a subnode tree into a map nid -> (bidData, bidSub). */
  readSubnodes(bidSub: bigint, depth = 0, visited = new Set<bigint>()): Map<number, NodeEntry> {
    const out = new Map<number, NodeEntry>();
    if (bidSub === 0n) return out;
    // SIBLOCK (level 1) -> SLBLOCK (level 0); allow one extra level of slack, no more.
    if (depth > 2) throw new PstFormatError('Subnode tree is too deep');
    const key = bidSub & ~1n;
    if (visited.has(key)) throw new PstFormatError(`Subnode block 0x${bidSub.toString(16)} is referenced twice`);
    visited.add(key);
    const block = this.readBlock(bidSub);
    if (block.length < 4 || block[0] !== 0x02) throw new PstFormatError('Corrupt subnode block');
    const level = block[1];
    const count = block.readUInt16LE(2);
    const ansi = this.format === 'ansi';
    const header = ansi ? 4 : 8;
    const s = this.bidSize();
    if (header + count * (level === 0 ? 3 : 2) * s > block.length) {
      throw new PstFormatError('Subnode block entry count exceeds the block size');
    }
    if (level === 0) {
      const stride = 3 * s;
      for (let i = 0; i < count; i++) {
        const off = header + i * stride;
        const nid = block.readUInt32LE(off);
        out.set(nid, {
          nid,
          bidData: this.readBid(block, off + s),
          bidSub: this.readBid(block, off + 2 * s),
          nidParent: 0,
        });
      }
    } else {
      const stride = 2 * s;
      for (let i = 0; i < count; i++) {
        const off = header + i * stride;
        for (const [k, v] of this.readSubnodes(this.readBid(block, off + s), depth + 1, visited)) out.set(k, v);
      }
    }
    return out;
  }
}

/** A node (top-level or subnode) with lazily loaded subnodes. */
export class PstNode {
  private subs: Map<number, NodeEntry> | undefined;
  constructor(
    readonly db: NodeDatabase,
    readonly entry: NodeEntry,
  ) {}

  get nid(): number {
    return this.entry.nid;
  }

  dataBlocks(): Buffer[] {
    return this.db.readDataBlocks(this.entry.bidData);
  }

  data(): Buffer {
    return this.db.readData(this.entry.bidData);
  }

  subnodeIds(): number[] {
    return [...this.subnodes().keys()];
  }

  private subnodes(): Map<number, NodeEntry> {
    if (!this.subs) this.subs = this.db.readSubnodes(this.entry.bidSub);
    return this.subs;
  }

  subnode(nid: number): PstNode | undefined {
    const e = this.subnodes().get(nid);
    return e ? new PstNode(this.db, e) : undefined;
  }
}
