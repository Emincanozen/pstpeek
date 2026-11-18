import type { Address, Folder, MailArchive, MailMessage, MessageError } from './model.js';
import { walkFolders } from './open.js';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Rough HTML to text conversion, good enough for searching and previews. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function messageText(msg: MailMessage): string {
  if (msg.bodyText) return msg.bodyText;
  if (msg.bodyHtml) return htmlToText(msg.bodyHtml);
  return '';
}

export type SearchField = 'subject' | 'from' | 'to' | 'body' | 'attachment';

export interface SearchHit {
  folder: Folder;
  index: number;
  message: MailMessage;
  field: SearchField;
  snippet: string;
}

export interface SearchOptions {
  folder?: Folder;
  caseSensitive?: boolean;
  onError?: (e: MessageError) => void;
}

const addrText = (a: Address): string => [a.name, a.email].filter(Boolean).join(' ');

export function snippetAround(text: string, pos: number, length: number, radius = 50): string {
  const start = Math.max(0, pos - radius);
  const end = Math.min(text.length, pos + length + radius);
  const s = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '...' : ''}${s}${end < text.length ? '...' : ''}`;
}

/** Plain substring search over subject, addresses, body and attachment names. */
export function* searchArchive(archive: MailArchive, query: string, opts: SearchOptions = {}): Generator<SearchHit> {
  const fold = (s: string): string => (opts.caseSensitive ? s : s.toLocaleLowerCase());
  const q = fold(query);
  if (!q) return;
  for (const folder of walkFolders(opts.folder ?? archive.root)) {
    if (folder.messageCount === 0) continue;
    for (const { index, message } of archive.messages(folder, opts.onError)) {
      const fields: [SearchField, string][] = [
        ['subject', message.subject],
        ['from', [message.from, message.sender].filter((a): a is Address => !!a).map(addrText).join(' ')],
        ['to', [...message.to, ...message.cc, ...message.bcc].map(addrText).join(' ')],
        ['body', messageText(message)],
        ['attachment', message.attachments.map((a) => a.filename).join(' ')],
      ];
      for (const [field, text] of fields) {
        const pos = fold(text).indexOf(q);
        if (pos >= 0) {
          yield { folder, index, message, field, snippet: snippetAround(text, pos, query.length) };
          break;
        }
      }
    }
  }
}
