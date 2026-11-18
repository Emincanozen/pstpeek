/** Test-only writer for compound files ([MS-CFB] version 3) and .msg property streams. */
import { fixedSize, PT } from '../../src/mapi/props.js';
import type { Prop } from './pst-builder.js';

export interface CfbStream {
  name: string;
  data: Buffer;
}
export interface CfbStorage {
  name: string;
  children: (CfbStream | CfbStorage)[];
}

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const FATSECT = 0xfffffffd;
const NOSTREAM = 0xffffffff;
const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;

const isStorage = (e: CfbStream | CfbStorage): e is CfbStorage => 'children' in e;

export function buildCfb(root: CfbStorage): Buffer {
  interface Flat {
    name: string;
    type: number;
    data?: Buffer;
    child: number;
    right: number;
    start: number;
    size: number;
  }
  const flat: Flat[] = [];
  const add = (e: CfbStream | CfbStorage, type?: number): number => {
    const idx = flat.length;
    flat.push({ name: e.name, type: type ?? (isStorage(e) ? 1 : 2), child: NOSTREAM, right: NOSTREAM, start: ENDOFCHAIN, size: 0, ...(isStorage(e) ? {} : { data: e.data }) });
    if (isStorage(e)) {
      let prev = -1;
      for (const c of e.children) {
        const ci = add(c);
        if (prev < 0) flat[idx]!.child = ci;
        else flat[prev]!.right = ci;
        prev = ci;
      }
    }
    return idx;
  };
  add(root, 5);

  // Mini stream for small streams.
  const miniParts: Buffer[] = [];
  const miniFat: number[] = [];
  const bigStreams: Flat[] = [];
  for (const f of flat) {
    if (f.type !== 2 || !f.data) continue;
    f.size = f.data.length;
    if (f.size === 0) continue;
    if (f.size < CUTOFF) {
      const first = miniFat.length;
      const n = Math.ceil(f.size / MINI);
      for (let i = 0; i < n; i++) miniFat.push(i === n - 1 ? ENDOFCHAIN : first + i + 1);
      const padded = Buffer.alloc(n * MINI);
      f.data.copy(padded);
      miniParts.push(padded);
      f.start = first;
    } else bigStreams.push(f);
  }
  const miniStream = Buffer.concat(miniParts);

  const dirSectors = Math.ceil((flat.length * 128) / SECTOR);
  const miniFatSectors = Math.ceil((miniFat.length * 4) / SECTOR);
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR);
  const bigSectors = bigStreams.reduce((n, s) => n + Math.ceil(s.size / SECTOR), 0);
  const others = dirSectors + miniFatSectors + miniStreamSectors + bigSectors;
  let fatSectors = 1;
  while (fatSectors * 128 < others + fatSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('Test CFB too large');

  const fat: number[] = [];
  const chain = (count: number): number => {
    const first = fat.length;
    for (let i = 0; i < count; i++) fat.push(i === count - 1 ? ENDOFCHAIN : first + i + 1);
    return first;
  };
  for (let i = 0; i < fatSectors; i++) fat.push(FATSECT);
  const firstDir = chain(dirSectors);
  const firstMiniFat = miniFatSectors ? chain(miniFatSectors) : ENDOFCHAIN;
  const miniStart = miniStreamSectors ? chain(miniStreamSectors) : ENDOFCHAIN;
  for (const s of bigStreams) s.start = chain(Math.ceil(s.size / SECTOR));
  while (fat.length < fatSectors * 128) fat.push(FREESECT);
  flat[0]!.start = miniStart;
  flat[0]!.size = miniStream.length;

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(firstDir, 48);
  header.writeUInt32LE(CUTOFF, 56);
  header.writeUInt32LE(firstMiniFat, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(ENDOFCHAIN, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i < fatSectors ? i : FREESECT, 76 + i * 4);

  const fatBuf = Buffer.alloc(fatSectors * SECTOR);
  fat.forEach((v, i) => fatBuf.writeUInt32LE(v >>> 0, i * 4));

  const dir = Buffer.alloc(dirSectors * SECTOR);
  flat.forEach((f, i) => {
    const off = i * 128;
    const name = Buffer.from(f.name, 'utf16le');
    name.copy(dir, off, 0, Math.min(62, name.length));
    dir.writeUInt16LE(Math.min(62, name.length) + 2, off + 64);
    dir[off + 66] = f.type;
    dir[off + 67] = 1;
    dir.writeUInt32LE(NOSTREAM, off + 68);
    dir.writeUInt32LE(f.right >>> 0, off + 72);
    dir.writeUInt32LE(f.child >>> 0, off + 76);
    dir.writeUInt32LE(f.start >>> 0, off + 116);
    dir.writeUInt32LE(f.size, off + 120);
  });
  for (let i = flat.length; i < dirSectors * 4; i++) {
    const off = i * 128;
    dir.writeUInt32LE(NOSTREAM, off + 68);
    dir.writeUInt32LE(NOSTREAM, off + 72);
    dir.writeUInt32LE(NOSTREAM, off + 76);
  }

  const miniFatBuf = Buffer.alloc(miniFatSectors * SECTOR, 0xff);
  miniFat.forEach((v, i) => miniFatBuf.writeUInt32LE(v >>> 0, i * 4));
  const miniBuf = Buffer.alloc(miniStreamSectors * SECTOR);
  miniStream.copy(miniBuf);
  const big = bigStreams.map((s) => {
    const b = Buffer.alloc(Math.ceil(s.size / SECTOR) * SECTOR);
    s.data!.copy(b);
    return b;
  });
  return Buffer.concat([header, fatBuf, dir, miniFatBuf, miniBuf, ...big]);
}

const hex = (n: number): string => n.toString(16).toUpperCase().padStart(4, '0');

/** Builds the property stream + substg streams of one .msg storage. */
export function msgStorage(name: string, props: Prop[], headerSize: number, extra: (CfbStream | CfbStorage)[] = []): CfbStorage {
  const children: (CfbStream | CfbStorage)[] = [];
  const entries: Buffer[] = [Buffer.alloc(headerSize)];
  for (const p of props) {
    const e = Buffer.alloc(16);
    e.writeUInt32LE((((p.id << 16) >>> 0) + p.type) >>> 0, 0);
    e.writeUInt32LE(6, 4);
    const size = fixedSize(p.type);
    if (size !== undefined) p.value.copy(e, 8, 0, size);
    else {
      const data = p.type === PT.UNICODE ? Buffer.concat([p.value, Buffer.alloc(2)]) : p.value;
      e.writeUInt32LE(data.length, 8);
      children.push({ name: `__substg1.0_${hex(p.id)}${hex(p.type)}`, data });
    }
    entries.push(e);
  }
  children.unshift({ name: '__properties_version1.0', data: Buffer.concat(entries) });
  return { name, children: [...children, ...extra] };
}
