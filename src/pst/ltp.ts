/**
 * Lists, Tables and Properties (LTP) layer of the PST format ([MS-PST] 2.3):
 * heap-on-node, BTree-on-heap, property contexts and table contexts.
 */
import { fixedSize, PT, PropertyBag, type RawProp } from '../mapi/props.js';
import { PstFormatError, type PstNode } from './ndb.js';

const HN_SIG = 0xec;
export const CLIENT_SIG_PC = 0xbc;
export const CLIENT_SIG_TC = 0x7c;
const BTH_SIG = 0xb5;
/** A heap holds at most a few thousand items, so real BTHs are shallow. */
const MAX_BTH_LEVELS = 8;

export class HeapOnNode {
  readonly clientSig: number;
  readonly userRoot: number;

  constructor(private readonly blocks: Buffer[]) {
    const first = blocks[0];
    if (!first || first.length < 12 || first[2] !== HN_SIG) throw new PstFormatError('Invalid heap-on-node');
    this.clientSig = first[3]!;
    this.userRoot = first.readUInt32LE(4);
  }

  item(hid: number): Buffer {
    if (hid === 0) return Buffer.alloc(0);
    if ((hid & 0x1f) !== 0) throw new PstFormatError(`Value 0x${hid.toString(16)} is not a heap id`);
    const index = (hid >>> 5) & 0x7ff;
    const blockIndex = hid >>> 16;
    const block = this.blocks[blockIndex];
    if (!block || index === 0) throw new PstFormatError(`Heap id 0x${hid.toString(16)} out of range`);
    const ibHnpm = block.readUInt16LE(0);
    if (ibHnpm + 4 > block.length) throw new PstFormatError('Corrupt heap page map');
    const cAlloc = block.readUInt16LE(ibHnpm);
    if (index > cAlloc) throw new PstFormatError(`Heap id 0x${hid.toString(16)} out of range`);
    const base = ibHnpm + 4;
    if (base + index * 2 + 2 > block.length) throw new PstFormatError('Corrupt heap page map');
    const start = block.readUInt16LE(base + (index - 1) * 2);
    const end = block.readUInt16LE(base + index * 2);
    if (end < start || end > block.length) throw new PstFormatError('Corrupt heap allocation');
    return block.subarray(start, end);
  }
}

export interface BthRecord {
  key: Buffer;
  data: Buffer;
}

export function readBth(hn: HeapOnNode, hidHeader: number): BthRecord[] {
  const h = hn.item(hidHeader);
  if (h.length < 8 || h[0] !== BTH_SIG) throw new PstFormatError('Invalid BTree-on-heap header');
  const cbKey = h[1]!;
  const cbEnt = h[2]!;
  const levels = h[3]!;
  const root = h.readUInt32LE(4);
  if (levels > MAX_BTH_LEVELS) throw new PstFormatError(`Implausible BTree-on-heap depth ${levels}`);
  if (cbKey === 0 || cbEnt === 0) throw new PstFormatError('Invalid BTree-on-heap record size');
  const out: BthRecord[] = [];
  const visited = new Set<number>([hidHeader]);
  const walk = (hid: number, level: number): void => {
    if (hid === 0) return;
    // Each heap item may appear once in the tree: a repeat means a cycle or a shared subtree.
    if (visited.has(hid)) throw new PstFormatError(`BTree-on-heap item 0x${hid.toString(16)} is referenced twice`);
    visited.add(hid);
    const buf = hn.item(hid);
    if (level === 0) {
      const stride = cbKey + cbEnt;
      for (let off = 0; off + stride <= buf.length; off += stride) {
        out.push({ key: buf.subarray(off, off + cbKey), data: buf.subarray(off + cbKey, off + stride) });
      }
    } else {
      const stride = cbKey + 4;
      for (let off = 0; off + stride <= buf.length; off += stride) walk(buf.readUInt32LE(off + cbKey), level - 1);
    }
  };
  walk(root, levels);
  return out;
}

/** Resolves an HNID: either a heap item (HID) or the data of a subnode (NID). */
function resolveHnid(node: PstNode, hn: HeapOnNode, hnid: number): Buffer {
  if (hnid === 0) return Buffer.alloc(0);
  if ((hnid & 0x1f) === 0) return hn.item(hnid);
  const sub = node.subnode(hnid);
  if (!sub) throw new PstFormatError(`Missing subnode 0x${hnid.toString(16)}`);
  return sub.data();
}

function inlineValue(type: number, value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return type === PT.BOOLEAN ? b.subarray(0, 1) : type === PT.INT16 ? b.subarray(0, 2) : b;
}

/** Reads a property context (PC) into a property bag. Values are decoded eagerly but safely. */
export function readPropertyContext(node: PstNode, codepage?: number): PropertyBag {
  const hn = new HeapOnNode(node.dataBlocks());
  if (hn.clientSig !== CLIENT_SIG_PC) throw new PstFormatError('Node is not a property context');
  const list: RawProp[] = [];
  for (const rec of readBth(hn, hn.userRoot)) {
    if (rec.key.length < 2 || rec.data.length < 6) continue;
    const id = rec.key.readUInt16LE(0);
    const type = rec.data.readUInt16LE(0);
    const hnid = rec.data.readUInt32LE(2);
    const size = fixedSize(type);
    if (size !== undefined && size <= 4) {
      list.push({ id, type, data: inlineValue(type, hnid) });
    } else if (type === PT.OBJECT && (hnid & 0x1f) !== 0) {
      // Object stored directly as a subnode NID: keep the NID (4 bytes).
      list.push({ id, type, data: inlineValue(PT.INT32, hnid) });
    } else if ((hnid & 0x1f) === 0) {
      try {
        list.push({ id, type, data: hn.item(hnid) });
      } catch {
        // skip unreadable values rather than failing the whole item
      }
    } else {
      // Subnode-backed value (large bodies, attachment data): load on first access.
      list.push(lazyProp(id, type, () => resolveHnid(node, hn, hnid)));
    }
  }
  return PropertyBag.fromList(list, codepage);
}

function lazyProp(id: number, type: number, load: () => Buffer): RawProp {
  let cache: Buffer | undefined;
  return {
    id,
    type,
    get data(): Buffer {
      if (!cache) {
        try {
          cache = load();
        } catch {
          cache = Buffer.alloc(0);
        }
      }
      return cache;
    },
  };
}

/** Returns the row ids of a table context in row order, without reading the row matrix. */
export function readTableRowIds(node: PstNode): number[] {
  const hn = new HeapOnNode(node.dataBlocks());
  if (hn.clientSig !== CLIENT_SIG_TC) throw new PstFormatError('Node is not a table context');
  const info = hn.item(hn.userRoot);
  if (info.length < 22 || info[0] !== CLIENT_SIG_TC) throw new PstFormatError('Invalid table header');
  const hidRowIndex = info.readUInt32LE(10);
  return readBth(hn, hidRowIndex)
    .filter((r) => r.key.length >= 4)
    .map((r) => ({ id: r.key.readUInt32LE(0), index: r.data.length >= 4 ? r.data.readUInt32LE(0) : r.data.readUInt16LE(0) }))
    .sort((a, b) => a.index - b.index)
    .map((r) => r.id);
}

export interface TableColumn {
  tag: number;
  ibData: number;
  cbData: number;
  iBit: number;
}

/** Reads all rows of a table context (TC). */
export function readTableContext(node: PstNode, codepage?: number): PropertyBag[] {
  const hn = new HeapOnNode(node.dataBlocks());
  if (hn.clientSig !== CLIENT_SIG_TC) throw new PstFormatError('Node is not a table context');
  const info = hn.item(hn.userRoot);
  if (info.length < 22 || info[0] !== CLIENT_SIG_TC) throw new PstFormatError('Invalid table header');
  const cCols = info[1]!;
  const ceb = info.readUInt16LE(6);
  const rowSize = info.readUInt16LE(8);
  const hidRowIndex = info.readUInt32LE(10);
  const hnidRows = info.readUInt32LE(14);
  const cols: TableColumn[] = [];
  for (let i = 0; i < cCols; i++) {
    const off = 22 + i * 8;
    if (off + 8 > info.length) break;
    cols.push({
      tag: info.readUInt32LE(off),
      ibData: info.readUInt16LE(off + 4),
      cbData: info[off + 6]!,
      iBit: info[off + 7]!,
    });
  }
  if (hnidRows === 0 || rowSize === 0) return [];

  const rowBlocks = (hnidRows & 0x1f) === 0 ? [hn.item(hnidRows)] : (node.subnode(hnidRows)?.dataBlocks() ?? []);
  const rowsPerBlock = Math.max(1, Math.floor((rowBlocks[0]?.length ?? 0) / rowSize));
  const totalRows = rowBlocks.reduce((n, b) => n + Math.floor(b.length / rowSize), 0);

  // The row index gives the number of live rows and their positions.
  let indices: number[];
  try {
    indices = readBth(hn, hidRowIndex)
      .map((r) => (r.data.length >= 4 ? r.data.readUInt32LE(0) : r.data.readUInt16LE(0)))
      .filter((i) => i < totalRows)
      .sort((a, b) => a - b);
  } catch {
    indices = Array.from({ length: totalRows }, (_, i) => i);
  }

  const rows: PropertyBag[] = [];
  for (const index of indices) {
    const block = rowBlocks[Math.floor(index / rowsPerBlock)];
    if (!block) continue;
    const start = (index % rowsPerBlock) * rowSize;
    const row = block.subarray(start, start + rowSize);
    if (row.length < rowSize) continue;
    const list: RawProp[] = [];
    for (const col of cols) {
      const byte = row[ceb + (col.iBit >> 3)];
      if (byte === undefined || (byte & (0x80 >> (col.iBit & 7))) === 0) continue;
      const type = col.tag & 0xffff;
      const id = col.tag >>> 16;
      const cell = row.subarray(col.ibData, col.ibData + col.cbData);
      let data: Buffer;
      if (fixedSize(type) !== undefined) {
        data = Buffer.from(cell);
      } else {
        if (cell.length < 4) continue;
        try {
          data = resolveHnid(node, hn, cell.readUInt32LE(0));
        } catch {
          continue;
        }
      }
      list.push({ id, type, data });
    }
    rows.push(PropertyBag.fromList(list, codepage));
  }
  return rows;
}
