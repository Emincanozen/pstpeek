/**
 * Minimal read-only Compound File Binary ([MS-CFB]) reader, enough for Outlook .msg files.
 */

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

export class CfbError extends Error {
  override name = 'CfbError';
}

export interface CfbEntry {
  name: string;
  type: 'storage' | 'stream' | 'root';
  size: number;
  /** Children by upper-cased name (storages only). */
  children: Map<string, CfbEntry>;
  read(): Buffer;
}

interface RawDirEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

export function isCfb(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

export function readCfb(file: Buffer): CfbEntry {
  if (file.length < 512 || !isCfb(file)) throw new CfbError('Not a compound file (bad signature)');
  const sectorShift = file.readUInt16LE(30);
  const miniShift = file.readUInt16LE(32);
  if (sectorShift !== 9 && sectorShift !== 12) throw new CfbError('Unsupported sector size');
  const sectorSize = 1 << sectorShift;
  const miniSize = 1 << miniShift;
  const numFat = file.readUInt32LE(44);
  const firstDir = file.readUInt32LE(48);
  const cutoff = file.readUInt32LE(56);
  const firstMiniFat = file.readUInt32LE(60);
  let difatSector = file.readUInt32LE(68);
  const numDifat = file.readUInt32LE(72);

  const sectorOffset = (sid: number): number => (sid + 1) * sectorSize;
  const sector = (sid: number): Buffer => {
    const off = sectorOffset(sid);
    if (off + sectorSize > file.length) {
      // Tolerate a truncated final sector.
      if (off < file.length) return Buffer.concat([file.subarray(off), Buffer.alloc(off + sectorSize - file.length)]);
      throw new CfbError(`Sector ${sid} outside file`);
    }
    return file.subarray(off, off + sectorSize);
  };

  // FAT sector list from the header DIFAT and DIFAT chain.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = file.readUInt32LE(76 + i * 4);
    if (s === FREESECT || s === ENDOFCHAIN) break;
    fatSectors.push(s);
  }
  const maxSectors = Math.floor(file.length / sectorSize);
  if (numFat > maxSectors || numDifat > maxSectors) throw new CfbError('Corrupt header: more FAT/DIFAT sectors than the file holds');
  const seenDifat = new Set<number>();
  for (let d = 0; d < numDifat && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; d++) {
    if (seenDifat.has(difatSector)) throw new CfbError('DIFAT chain loop');
    seenDifat.add(difatSector);
    const s = sector(difatSector);
    const per = sectorSize / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) {
      const v = s.readUInt32LE(i * 4);
      if (v !== FREESECT) fatSectors.push(v);
    }
    difatSector = s.readUInt32LE(per * 4);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const s = sector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }

  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let sid = start;
    while (sid !== ENDOFCHAIN && sid !== FREESECT && sid < table.length) {
      if (out.length > table.length) throw new CfbError('Sector chain loop');
      out.push(sid);
      sid = table[sid]!;
    }
    return out;
  };
  const readChain = (start: number, size?: number): Buffer => {
    if (size !== undefined && size > file.length) throw new CfbError(`Corrupt stream: declared size ${size} exceeds the file`);
    const data = Buffer.concat(chain(start, fat).map(sector));
    if (size === undefined) return data;
    if (data.length < size) throw new CfbError(`Corrupt stream: ${data.length} bytes available, ${size} declared`);
    return data.subarray(0, size);
  };

  // Directory
  const dirData = readChain(firstDir);
  const dir: RawDirEntry[] = [];
  for (let off = 0; off + 128 <= dirData.length; off += 128) {
    const nameLen = dirData.readUInt16LE(off + 64);
    const name = dirData.toString('utf16le', off, off + Math.max(0, Math.min(64, nameLen) - 2));
    dir.push({
      name,
      type: dirData[off + 66]!,
      left: dirData.readUInt32LE(off + 68),
      right: dirData.readUInt32LE(off + 72),
      child: dirData.readUInt32LE(off + 76),
      start: dirData.readUInt32LE(off + 116),
      size: dirData.readUInt32LE(off + 120),
    });
  }
  const rootRaw = dir[0];
  if (!rootRaw || rootRaw.type !== 5) throw new CfbError('Missing root entry');

  const miniStream = readChain(rootRaw.start, rootRaw.size);
  const miniFat: number[] = [];
  if (firstMiniFat !== ENDOFCHAIN && firstMiniFat !== FREESECT) {
    const mf = readChain(firstMiniFat);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  }
  const readMini = (start: number, size: number): Buffer => {
    const parts = chain(start, miniFat).map((sid) => {
      if (sid * miniSize >= miniStream.length) throw new CfbError(`Corrupt stream: mini sector ${sid} outside the mini stream`);
      return miniStream.subarray(sid * miniSize, (sid + 1) * miniSize);
    });
    const data = Buffer.concat(parts);
    if (data.length < size) throw new CfbError(`Corrupt stream: ${data.length} bytes available, ${size} declared`);
    return data.subarray(0, size);
  };

  const build = (index: number, visited: Set<number>): CfbEntry => {
    const raw = dir[index]!;
    const type = raw.type === 5 ? 'root' : raw.type === 1 ? 'storage' : 'stream';
    const children = new Map<string, CfbEntry>();
    const entry: CfbEntry = {
      name: raw.name,
      type,
      size: raw.size,
      children,
      read: () => {
        if (type !== 'stream') throw new CfbError(`${raw.name} is not a stream`);
        if (raw.size === 0) return Buffer.alloc(0);
        return raw.size < cutoff ? readMini(raw.start, raw.size) : readChain(raw.start, raw.size);
      },
    };
    if (type !== 'stream' && raw.child !== NOSTREAM) {
      const stack = [raw.child];
      while (stack.length) {
        const i = stack.pop()!;
        if (i === NOSTREAM || i >= dir.length || visited.has(i)) continue;
        visited.add(i);
        const d = dir[i]!;
        stack.push(d.left, d.right);
        if (d.type === 1 || d.type === 2) children.set(d.name.toUpperCase(), build(i, visited));
      }
    }
    return entry;
  };
  return build(0, new Set([0]));
}
