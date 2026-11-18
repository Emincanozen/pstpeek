/** Outlook .msg ([MS-OXMSG]) reader built on the CFB reader. */
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { buildMessage, type MapiAttachmentSource, type MapiMessageSource } from '../mapi/message.js';
import { fixedSize, MV_FLAG, PR, PropertyBag, PT, type RawProp } from '../mapi/props.js';
import type { Folder, MailArchive, MailMessage, MessageEntry, MessageError } from '../model.js';
import { readCfb, type CfbEntry } from './cfb.js';

const PROPS_STREAM = '__PROPERTIES_VERSION1.0';
const SUBSTG = '__SUBSTG1.0_';
const RECIP_PREFIX = '__RECIP_VERSION1.0_#';
const ATTACH_PREFIX = '__ATTACH_VERSION1.0_#';

type StorageKind = 'top' | 'embedded' | 'child';

function readProps(storage: CfbEntry, kind: StorageKind): PropertyBag {
  const props = new Map<number, RawProp>();
  const headerSize = kind === 'top' ? 32 : kind === 'embedded' ? 24 : 8;
  const ps = storage.children.get(PROPS_STREAM);
  if (ps && ps.type === 'stream') {
    const buf = ps.read();
    for (let off = headerSize; off + 16 <= buf.length; off += 16) {
      const tag = buf.readUInt32LE(off);
      const type = tag & 0xffff;
      const id = tag >>> 16;
      const size = fixedSize(type);
      if (size !== undefined) props.set(id, { id, type, data: Buffer.from(buf.subarray(off + 8, off + 8 + size)) });
    }
  }
  // Variable-size properties live in their own streams: __substg1.0_IIIITTTT
  for (const [name, child] of storage.children) {
    if (!name.startsWith(SUBSTG) || name.length !== SUBSTG.length + 8) continue;
    const tag = parseInt(name.slice(SUBSTG.length), 16);
    if (!Number.isFinite(tag)) continue;
    const type = tag & 0xffff;
    const id = tag >>> 16;
    if (child.type !== 'stream') continue; // PT_OBJECT storages are handled separately
    if (type & MV_FLAG) {
      const mv = readMultiValued(storage, name, child, type);
      if (mv) props.set(id, { id, ...mv });
      continue;
    }
    if (type !== PT.STRING8 && type !== PT.UNICODE && type !== PT.BINARY && type !== PT.CLSID) continue;
    const existing = props.get(id);
    if (existing && existing.type === PT.UNICODE && type === PT.STRING8) continue;
    let cache: Buffer | undefined;
    props.set(id, {
      id,
      type,
      get data(): Buffer {
        return (cache ??= child.read());
      },
    });
  }
  return new PropertyBag(props);
}

const MAX_MV_VALUES = 65536;

/**
 * Multi-valued properties ([MS-OXMSG] 2.1.4.1.3): fixed-size values are concatenated
 * in one stream; variable-size values have a length stream (4-byte entries for
 * strings, 8-byte entries for binary) plus one stream per value named "<name>-NNNNNNNN".
 */
function readMultiValued(storage: CfbEntry, name: string, stream: CfbEntry, type: number): { type: number; data: Buffer; values?: Buffer[] } | undefined {
  const base = type & ~MV_FLAG;
  if (base === PT.CLSID || fixedSize(base) !== undefined) return { type, data: stream.read() };
  const entry = base === PT.BINARY ? 8 : base === PT.UNICODE || base === PT.STRING8 ? 4 : undefined;
  if (entry === undefined) return undefined;
  const count = Math.floor(stream.size / entry);
  if (count > MAX_MV_VALUES) return undefined;
  const values: Buffer[] = [];
  for (let i = 0; i < count; i++) {
    const v = storage.children.get(`${name}-${i.toString(16).toUpperCase().padStart(8, '0')}`);
    values.push(v && v.type === 'stream' ? v.read() : Buffer.alloc(0));
  }
  return { type, data: Buffer.alloc(0), values };
}

function childStorages(storage: CfbEntry, prefix: string): CfbEntry[] {
  return [...storage.children.entries()]
    .filter(([name, e]) => name.startsWith(prefix) && e.type === 'storage')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, e]) => e);
}

function messageSource(storage: CfbEntry, kind: StorageKind): MapiMessageSource {
  const props = readProps(storage, kind);
  return {
    props,
    recipients: () => childStorages(storage, RECIP_PREFIX).map((s) => readProps(s, 'child')),
    attachments: () =>
      childStorages(storage, ATTACH_PREFIX).map((s): MapiAttachmentSource => {
        const ap = readProps(s, 'child');
        return {
          props: ap,
          data: () => {
            const raw = ap.raw(PR.ATTACH_DATA);
            return raw && raw.type === PT.BINARY ? raw.data : undefined;
          },
          embedded: () => {
            const sub = s.children.get(`${SUBSTG}3701000D`);
            return sub && sub.type === 'storage' ? messageSource(sub, 'embedded') : undefined;
          },
        };
      }),
  };
}

export function parseMsg(data: Buffer): MailMessage {
  return buildMessage(messageSource(readCfb(data), 'top'));
}

/** Top-level MAPI properties of a .msg file (for callers needing more than MailMessage). */
export function msgPropertyBag(data: Buffer): PropertyBag {
  return readProps(readCfb(data), 'top');
}

/**
 * .msg files are parsed in memory. Outlook items are normally far below this
 * limit; larger inputs are refused instead of exhausting memory.
 */
export const DEFAULT_MAX_MSG_BYTES = 256 * 1024 * 1024;

export function readMsgFile(path: string, maxBytes = DEFAULT_MAX_MSG_BYTES): Buffer {
  const size = statSync(path).size;
  if (size > maxBytes) {
    throw new Error(`.msg file is too large to load (${size} bytes, limit ${maxBytes}); pstpeek reads .msg files in memory`);
  }
  return readFileSync(path, { flag: 'r' });
}

/** Presents a single .msg file as an archive with one folder holding one message. */
export class MsgArchive implements MailArchive {
  readonly kind = 'msg' as const;
  readonly root: Folder;
  private readonly message: MailMessage;

  constructor(data: Buffer, name: string) {
    this.message = parseMsg(data);
    this.root = { name, path: [name], messageCount: 1, children: [] };
  }

  static open(path: string, maxBytes = DEFAULT_MAX_MSG_BYTES): MsgArchive {
    return new MsgArchive(readMsgFile(path, maxBytes), basename(path));
  }

  *messages(folder: Folder, _onError?: (e: MessageError) => void): Generator<MessageEntry> {
    if (folder === this.root) yield { folder, index: 1, message: this.message };
  }

  close(): void {}
}
