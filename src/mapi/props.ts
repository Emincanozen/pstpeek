/** MAPI property types, tags and a typed property bag shared by PST and MSG readers. */

export const PT = {
  INT16: 0x0002,
  INT32: 0x0003,
  FLOAT: 0x0004,
  DOUBLE: 0x0005,
  CURRENCY: 0x0006,
  APPTIME: 0x0007,
  ERROR: 0x000a,
  BOOLEAN: 0x000b,
  OBJECT: 0x000d,
  INT64: 0x0014,
  STRING8: 0x001e,
  UNICODE: 0x001f,
  SYSTIME: 0x0040,
  CLSID: 0x0048,
  BINARY: 0x0102,
} as const;

const FIXED_SIZES = new Map<number, number>([
  [PT.INT16, 2],
  [PT.INT32, 4],
  [PT.FLOAT, 4],
  [PT.DOUBLE, 8],
  [PT.CURRENCY, 8],
  [PT.APPTIME, 8],
  [PT.ERROR, 4],
  [PT.BOOLEAN, 1],
  [PT.INT64, 8],
  [PT.SYSTIME, 8],
]);

/** Size in bytes of a fixed-size type, or undefined for variable-size types. */
export function fixedSize(type: number): number | undefined {
  return FIXED_SIZES.get(type);
}

export const PR = {
  IMPORTANCE: 0x0017,
  MESSAGE_CLASS: 0x001a,
  SUBJECT: 0x0037,
  CLIENT_SUBMIT_TIME: 0x0039,
  SENT_REPRESENTING_NAME: 0x0042,
  SENT_REPRESENTING_ADDRTYPE: 0x0064,
  SENT_REPRESENTING_EMAIL: 0x0065,
  TRANSPORT_MESSAGE_HEADERS: 0x007d,
  SENDER_NAME: 0x0c1a,
  SENDER_ADDRTYPE: 0x0c1e,
  SENDER_EMAIL: 0x0c1f,
  RECIPIENT_TYPE: 0x0c15,
  DISPLAY_BCC: 0x0e02,
  DISPLAY_CC: 0x0e03,
  DISPLAY_TO: 0x0e04,
  MESSAGE_DELIVERY_TIME: 0x0e06,
  MESSAGE_FLAGS: 0x0e07,
  MESSAGE_SIZE: 0x0e08,
  ATTACH_SIZE: 0x0e20,
  BODY: 0x1000,
  RTF_COMPRESSED: 0x1009,
  HTML: 0x1013,
  INTERNET_MESSAGE_ID: 0x1035,
  INTERNET_REFERENCES: 0x1039,
  IN_REPLY_TO_ID: 0x1042,
  DISPLAY_NAME: 0x3001,
  ADDRTYPE: 0x3002,
  EMAIL_ADDRESS: 0x3003,
  CREATION_TIME: 0x3007,
  LAST_MODIFICATION_TIME: 0x3008,
  CONTENT_COUNT: 0x3602,
  CONTENT_UNREAD_COUNT: 0x3603,
  SUBFOLDERS: 0x360a,
  CONTAINER_CLASS: 0x3613,
  ATTACH_DATA: 0x3701,
  ATTACH_FILENAME: 0x3704,
  ATTACH_METHOD: 0x3705,
  ATTACH_LONG_FILENAME: 0x3707,
  ATTACH_MIME_TAG: 0x370e,
  ATTACH_CONTENT_ID: 0x3712,
  ATTACH_CONTENT_LOCATION: 0x3713,
  ATTACH_FLAGS: 0x3714,
  SMTP_ADDRESS: 0x39fe,
  INTERNET_CODEPAGE: 0x3fde,
  MESSAGE_CODEPAGE: 0x3ffd,
  SENDER_SMTP_ADDRESS: 0x5d01,
  SENT_REPRESENTING_SMTP_ADDRESS: 0x5d02,
  LTP_ROW_ID: 0x67f2,
  ATTACHMENT_HIDDEN: 0x7ffe,
} as const;

export interface RawProp {
  id: number;
  type: number;
  /** Little-endian value bytes for fixed types; raw content for variable types. */
  data: Buffer;
  /**
   * Multi-valued variable-size properties from .msg files: one buffer per value.
   * When absent, `data` holds the PST layout (count, offsets, then values).
   */
  values?: Buffer[];
}

export const MV_FLAG = 0x1000;
export type MultiValue = number | bigint | boolean | string | Date | Buffer;

/** Splits PST-encoded multi-valued variable data: ulCount, rgulDataOffsets[ulCount], values. */
export function splitPstMultiValue(data: Buffer): Buffer[] {
  if (data.length < 4) return [];
  const count = data.readUInt32LE(0);
  if (count > (data.length - 4) / 4) throw new RangeError('Corrupt multi-valued property');
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(data.readUInt32LE(4 + i * 4));
  return offsets.map((start, i) => {
    const end = i + 1 < count ? offsets[i + 1]! : data.length;
    if (start > end || end > data.length) throw new RangeError('Corrupt multi-valued property');
    return data.subarray(start, end);
  });
}

const CODEPAGE_LABELS = new Map<number, string>([
  [866, 'ibm866'],
  [874, 'windows-874'],
  [932, 'shift_jis'],
  [936, 'gbk'],
  [949, 'euc-kr'],
  [950, 'big5'],
  [1200, 'utf-16le'],
  [1201, 'utf-16be'],
  [1250, 'windows-1250'],
  [1251, 'windows-1251'],
  [1252, 'windows-1252'],
  [1253, 'windows-1253'],
  [1254, 'windows-1254'],
  [1255, 'windows-1255'],
  [1256, 'windows-1256'],
  [1257, 'windows-1257'],
  [1258, 'windows-1258'],
  [10000, 'macintosh'],
  [20127, 'us-ascii'],
  [20866, 'koi8-r'],
  [21866, 'koi8-u'],
  [28591, 'iso-8859-1'],
  [28592, 'iso-8859-2'],
  [28593, 'iso-8859-3'],
  [28594, 'iso-8859-4'],
  [28595, 'iso-8859-5'],
  [28596, 'iso-8859-6'],
  [28597, 'iso-8859-7'],
  [28598, 'iso-8859-8'],
  [28599, 'iso-8859-9'],
  [28603, 'iso-8859-13'],
  [28605, 'iso-8859-15'],
  [50220, 'iso-2022-jp'],
  [50221, 'iso-2022-jp'],
  [50222, 'iso-2022-jp'],
  [51932, 'euc-jp'],
  [51936, 'gbk'],
  [51949, 'euc-kr'],
  [52936, 'hz-gb-2312'],
  [54936, 'gb18030'],
  [65000, 'utf-7'],
  [65001, 'utf-8'],
]);

const ANSI_FOR_INTERNET = new Map<number, number>([
  [50220, 932], [50221, 932], [50222, 932], [51932, 932], [20932, 932],
  [52936, 936], [51936, 936], [54936, 936], [20936, 936],
  [50225, 949], [51949, 949],
  [51950, 950],
  [20866, 1251], [21866, 1251], [28595, 1251],
  [28591, 1252], [28605, 1252], [20127, 1252],
  [28592, 1250], [28597, 1253], [28599, 1254], [28598, 1255], [38598, 1255], [28596, 1256], [28594, 1257], [28603, 1257],
]);

/**
 * Windows ANSI code page that matches an internet code page, used to decode
 * PT_STRING8 values when PidTagMessageCodepage is absent. Windows code pages
 * map to themselves; Unicode code pages give undefined.
 */
export function ansiCodepageFor(cp: number | undefined): number | undefined {
  if (cp === undefined) return undefined;
  if ((cp >= 1250 && cp <= 1258) || cp === 874 || cp === 932 || cp === 936 || cp === 949 || cp === 950) return cp;
  return ANSI_FOR_INTERNET.get(cp);
}

/** Decodes 8-bit text using a Windows code page, falling back to windows-1252. */
export function decodeCodepage(data: Uint8Array, codepage: number | undefined): string {
  const label = (codepage !== undefined && CODEPAGE_LABELS.get(codepage)) || 'windows-1252';
  try {
    return new TextDecoder(label).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Converts a Windows FILETIME (100 ns ticks since 1601-01-01 UTC) to a Date. */
export function filetimeToDate(ticks: bigint): Date | undefined {
  if (ticks <= 0n) return undefined;
  const ms = Number(ticks / 10000n) - 11644473600000;
  if (!Number.isFinite(ms) || ms < -62135596800000 || ms > 253402300799000) return undefined;
  return new Date(ms);
}

export function dateToFiletime(d: Date): bigint {
  return (BigInt(d.getTime()) + 11644473600000n) * 10000n;
}

function stripNul(s: string): string {
  const i = s.indexOf('\u0000');
  return i >= 0 ? s.slice(0, i) : s;
}

export class PropertyBag {
  constructor(
    readonly props: Map<number, RawProp>,
    /** Code page for PT_STRING8 values. */
    public codepage: number | undefined = undefined,
  ) {}

  static fromList(list: RawProp[], codepage?: number): PropertyBag {
    const m = new Map<number, RawProp>();
    for (const p of list) {
      // Prefer the Unicode variant when both exist.
      const prev = m.get(p.id);
      if (prev && prev.type === PT.UNICODE && p.type === PT.STRING8) continue;
      m.set(p.id, p);
    }
    return new PropertyBag(m, codepage);
  }

  has(id: number): boolean {
    return this.props.has(id);
  }

  raw(id: number): RawProp | undefined {
    return this.props.get(id);
  }

  string(id: number): string | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (p.type === PT.UNICODE) return stripNul(p.data.toString('utf16le'));
    if (p.type === PT.STRING8) return stripNul(decodeCodepage(p.data, this.codepage));
    return undefined;
  }

  int(id: number): number | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    switch (p.type) {
      case PT.INT16:
        return p.data.length >= 2 ? p.data.readInt16LE(0) : undefined;
      case PT.INT32:
      case PT.ERROR:
        return p.data.length >= 4 ? p.data.readInt32LE(0) : undefined;
      case PT.INT64:
        return p.data.length >= 8 ? Number(p.data.readBigInt64LE(0)) : undefined;
      case PT.BOOLEAN:
        return p.data.length >= 1 ? (p.data[0] ? 1 : 0) : undefined;
      default:
        return undefined;
    }
  }

  bool(id: number): boolean | undefined {
    const v = this.int(id);
    return v === undefined ? undefined : v !== 0;
  }

  date(id: number): Date | undefined {
    const p = this.props.get(id);
    if (!p || p.type !== PT.SYSTIME || p.data.length < 8) return undefined;
    return filetimeToDate(p.data.readBigUInt64LE(0));
  }

  /** Decodes a multi-valued (PT_MV_*) property, or returns undefined if absent or not multi-valued. */
  multi(id: number): MultiValue[] | undefined {
    const p = this.props.get(id);
    if (!p || (p.type & MV_FLAG) === 0) return undefined;
    const base = p.type & ~MV_FLAG;
    const size = base === PT.CLSID ? 16 : fixedSize(base);
    try {
      if (size !== undefined) {
        const out: MultiValue[] = [];
        for (let off = 0; off + size <= p.data.length; off += size) {
          const v = p.data.subarray(off, off + size);
          const single = new PropertyBag(new Map([[0, { id: 0, type: base, data: v }]]), this.codepage);
          if (base === PT.SYSTIME) out.push(single.date(0) ?? v.readBigUInt64LE(0));
          else if (base === PT.DOUBLE || base === PT.APPTIME) out.push(v.readDoubleLE(0));
          else if (base === PT.FLOAT) out.push(v.readFloatLE(0));
          else if (base === PT.BOOLEAN) out.push(v[0] !== 0);
          else if (base === PT.INT64 || base === PT.CURRENCY) out.push(v.readBigInt64LE(0));
          else if (base === PT.CLSID) out.push(Buffer.from(v));
          else out.push(single.int(0) ?? 0);
        }
        return out;
      }
      const values = p.values ?? splitPstMultiValue(p.data);
      return values.map((v) => {
        if (base === PT.UNICODE) return stripNul(v.toString('utf16le'));
        if (base === PT.STRING8) return stripNul(decodeCodepage(v, this.codepage));
        return Buffer.from(v);
      });
    } catch {
      return undefined;
    }
  }

  binary(id: number): Buffer | undefined {
    const p = this.props.get(id);
    if (!p) return undefined;
    if (p.type === PT.BINARY || p.type === PT.OBJECT) return p.data;
    if (p.type === PT.STRING8) return p.data;
    if (p.type === PT.UNICODE) return Buffer.from(stripNul(p.data.toString('utf16le')), 'utf8');
    return undefined;
  }
}
