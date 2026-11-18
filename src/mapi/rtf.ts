/**
 * Compressed RTF ([MS-OXRTFCP]) decompression and a small RTF reader that
 * recovers encapsulated HTML ([MS-OXRTFEX]) or plain text.
 */
import { decodeCodepage } from './props.js';

const PREBUF =
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

export const RTF_PREBUF_LENGTH = PREBUF.length;

const COMP_LZFU = 0x75465a4c; // "LZFu"
const COMP_MELA = 0x414c454d; // "MELA" (stored uncompressed)

let CRC_TABLE: Uint32Array | undefined;

/** CRC-32 as specified by [MS-OXRTFCP] 2.1.3.2 (reflected 0xEDB88320, initial 0, no final XOR). */
export function rtfCrc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0;
  for (const b of data) crc = (CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return crc >>> 0;
}

/**
 * Decompresses PidTagRtfCompressed. Throws on a bad header, a CRC mismatch or
 * a RAWSIZE that the compressed data cannot possibly produce.
 */
export function decompressRtf(data: Buffer): Buffer {
  if (data.length < 16) throw new Error('Compressed RTF is too short');
  const compSize = data.readUInt32LE(0);
  const rawSize = data.readUInt32LE(4);
  const compType = data.readUInt32LE(8);
  // Uncompressed content: read to the end of the stream regardless of RAWSIZE.
  if (compType === COMP_MELA) return data.subarray(16);
  if (compType !== COMP_LZFU) throw new Error('Unknown compressed RTF type');
  if (compSize < 12 || compSize + 4 > data.length) throw new Error('Compressed RTF size field does not match the data');
  const payload = data.subarray(16, compSize + 4);
  if (rtfCrc32(payload) !== data.readUInt32LE(12)) throw new Error('Compressed RTF CRC mismatch (corrupt data)');
  // Each run is 1 control byte + up to 8 two-byte references of at most 17 bytes: output <= 8.5x input.
  if (rawSize > payload.length * 9 + 64) throw new Error('Compressed RTF declares an implausible uncompressed size');

  const dict = Buffer.alloc(4096);
  dict.write(PREBUF, 0, 'latin1');
  let wp = PREBUF.length;
  let out = Buffer.alloc(Math.max(Math.min(rawSize, payload.length * 4), 16));
  let o = 0;
  const push = (b: number): void => {
    if (o >= rawSize) throw new Error('Compressed RTF expands beyond its declared size');
    if (o >= out.length) {
      const bigger = Buffer.alloc(Math.min(out.length * 2, rawSize));
      out.copy(bigger);
      out = bigger;
    }
    out[o++] = b;
    dict[wp] = b;
    wp = (wp + 1) & 0xfff;
  };
  const end = Math.min(data.length, compSize + 4);
  let i = 16;
  while (i < end) {
    const control = data[i++]!;
    for (let bit = 0; bit < 8 && i < end; bit++) {
      if (control & (1 << bit)) {
        if (i + 1 >= end) return out.subarray(0, o);
        const word = (data[i]! << 8) | data[i + 1]!;
        i += 2;
        const offset = word >> 4;
        const length = (word & 0xf) + 2;
        if (offset === wp) return out.subarray(0, o);
        for (let k = 0; k < length; k++) push(dict[(offset + k) & 0xfff]!);
      } else {
        push(data[i++]!);
      }
    }
  }
  return out.subarray(0, o);
}

/** Destinations whose content is never body text. */
const SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer',
  'headerl', 'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable',
  'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles',
  'datastore', 'filetbl', 'revtbl', 'pgdsctbl', 'fldinst',
]);

interface GroupState {
  skip: boolean;
  htmltag: boolean;
  uc: number;
}

/**
 * Converts RTF to HTML when it encapsulates HTML (\fromhtml1), otherwise to plain text.
 * This is a pragmatic reader, not a full RTF renderer: formatting is dropped.
 */
export function rtfToBody(rtfBytes: Buffer): { html?: string; text?: string } {
  const rtf = rtfBytes.toString('latin1');
  const fromHtml = /\\fromhtml1/.test(rtf.slice(0, 2048));
  let codepage = 1252;

  const out: string[] = [];
  let pending: number[] = [];
  const flush = (): void => {
    if (pending.length) {
      out.push(decodeCodepage(Uint8Array.from(pending), codepage));
      pending = [];
    }
  };
  const emit = (s: string): void => {
    flush();
    out.push(s);
  };

  const stack: GroupState[] = [];
  let st: GroupState = { skip: false, htmltag: false, uc: 1 };
  let htmlrtf = false;
  let skipChars = 0;
  let starNext = false;
  let firstInGroup = false;

  const visible = (): boolean => !st.skip && (fromHtml ? st.htmltag || !htmlrtf : true);

  let i = 0;
  const n = rtf.length;
  while (i < n) {
    const c = rtf[i]!;
    if (c === '{') {
      stack.push(st);
      st = { ...st };
      firstInGroup = true;
      i++;
      continue;
    }
    if (c === '}') {
      st = stack.pop() ?? { skip: false, htmltag: false, uc: 1 };
      firstInGroup = false;
      starNext = false;
      i++;
      continue;
    }
    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === undefined) break;
      if (/[a-zA-Z]/.test(next)) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(rtf[j]!)) j++;
        const word = rtf.slice(i + 1, j);
        let param: number | undefined;
        const m = /^-?\d+/.exec(rtf.slice(j, j + 12));
        if (m) {
          param = Number(m[0]);
          j += m[0].length;
        }
        if (rtf[j] === ' ') j++;
        i = j;
        const wasFirst = firstInGroup;
        firstInGroup = false;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (wasFirst && (starNext || SKIP_DESTINATIONS.has(word))) {
          if (word === 'htmltag' && fromHtml) st.htmltag = true;
          else st.skip = true;
          starNext = false;
          continue;
        }
        starNext = false;
        switch (word) {
          case 'ansicpg':
            if (param !== undefined) codepage = param;
            break;
          case 'htmlrtf':
            htmlrtf = param !== 0;
            break;
          case 'par':
          case 'line':
            if (visible()) emit(fromHtml ? '\r\n' : '\n');
            break;
          case 'tab':
            if (visible()) emit('\t');
            break;
          case 'uc':
            if (param !== undefined) st.uc = param;
            break;
          case 'u':
            if (param !== undefined) {
              if (visible()) emit(String.fromCharCode(param < 0 ? param + 65536 : param));
              skipChars = st.uc;
            }
            break;
          default:
            break;
        }
        continue;
      }
      // Control symbols
      i += 2;
      if (next === '*') {
        starNext = true;
        continue;
      }
      firstInGroup = false;
      if (next === "'") {
        const hex = rtf.slice(i, i + 2);
        i += 2;
        if (skipChars > 0) {
          skipChars--;
          continue;
        }
        if (visible() && /^[0-9a-fA-F]{2}$/.test(hex)) pending.push(parseInt(hex, 16));
        continue;
      }
      if (skipChars > 0) {
        skipChars--;
        continue;
      }
      if (!visible()) continue;
      if (next === '\\' || next === '{' || next === '}') emit(next);
      else if (next === '~') emit(' ');
      else if (next === '\r' || next === '\n') emit(fromHtml ? '\r\n' : '\n');
      continue;
    }
    if (c === '\r' || c === '\n') {
      i++;
      continue;
    }
    firstInGroup = false;
    starNext = false;
    i++;
    if (skipChars > 0) {
      skipChars--;
      continue;
    }
    if (visible()) pending.push(c.charCodeAt(0) & 0xff);
  }
  flush();
  const result = out.join('');
  if (fromHtml) return { html: result };
  return { text: result.replace(/\n{3,}/g, '\n\n').trim() };
}
