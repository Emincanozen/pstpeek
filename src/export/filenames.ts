/** Cross-platform safe file names (Windows is the strictest target). */

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export interface SafeNameOptions {
  /** Maximum length in UTF-8 bytes (default 120). */
  maxBytes?: number;
  fallback?: string;
}

/**
 * Turns arbitrary text (a subject, an attachment name) into a single safe path
 * component: no separators, no control or reserved characters, no traversal,
 * no Windows device names, no trailing dots or spaces. Extensions are kept
 * when truncating.
 */
export function safeFileName(input: string, opts: SafeNameOptions = {}): string {
  const maxBytes = opts.maxBytes ?? 120;
  const fallback = opts.fallback ?? 'untitled';
  let s = input.normalize('NFC').replace(/[\t\r\n]+/g, ' ').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, (m) => '_'.repeat(m.length));
  s = s.replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `_${s}`;
  if (Buffer.byteLength(s, 'utf8') > maxBytes) {
    const m = /(\.[A-Za-z0-9]{1,10})$/.exec(s);
    const ext = m ? m[1]! : '';
    s = truncateUtf8(s.slice(0, s.length - ext.length), maxBytes - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return s || fallback;
}

/** Hands out unique names within one directory (case-insensitive, like Windows/macOS). */
export class NameAllocator {
  private readonly used = new Set<string>();

  allocate(name: string): string {
    let candidate = name;
    const m = /^(.*?)(\.[^.]{1,10})?$/.exec(name);
    const stem = m?.[1] ?? name;
    const ext = m?.[2] ?? '';
    for (let n = 2; this.used.has(candidate.toLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
    this.used.add(candidate.toLowerCase());
    return candidate;
  }
}
