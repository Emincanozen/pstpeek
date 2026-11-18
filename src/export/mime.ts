/**
 * Minimal RFC 5322 / MIME writer. Output is 7-bit ASCII with CRLF line endings:
 * non-ASCII header text uses RFC 2047 encoded words, file names use RFC 2231,
 * text bodies are quoted-printable and binary parts are base64.
 */
import { createHash } from 'node:crypto';
import type { Address, Attachment, MailMessage } from '../model.js';

const CRLF = '\r\n';
const MAX_DEPTH = 8;

export function isPrintableAscii(s: string): boolean {
  return /^[\x20-\x7e]*$/.test(s);
}

/** Splits text into RFC 2047 "B" encoded words of at most 75 characters each. */
export function encodeWords(s: string): string[] {
  const words: string[] = [];
  let chunk = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > 45 && chunk) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
      bytes = 0;
    }
    chunk += ch;
    bytes += b;
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  return words;
}

function cleanHeaderText(s: string): string {
  // Header values are single-line; drop control characters (prevents header injection).
  return s.replace(/[\r\n\t]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** Encodes an unstructured header value (e.g. Subject), folded to keep lines short. */
export function encodeUnstructured(value: string, headerNameLength = 9): string {
  const v = cleanHeaderText(value);
  if (isPrintableAscii(v)) {
    const words = v.split(' ');
    const lines: string[] = [];
    let line = '';
    let limit = 78 - headerNameLength - 2;
    for (const w of words) {
      if (line && line.length + 1 + w.length > limit) {
        lines.push(line);
        line = w;
        limit = 77;
      } else {
        line = line ? `${line} ${w}` : w;
      }
    }
    lines.push(line);
    return lines.join(`${CRLF} `);
  }
  return encodeWords(v).join(`${CRLF} `);
}

const ATOM_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;

export function encodeDisplayName(name: string): string {
  const n = cleanHeaderText(name);
  if (!isPrintableAscii(n)) return encodeWords(n).join(' ');
  if (ATOM_PHRASE.test(n)) return n;
  return `"${n.replace(/(["\\])/g, '\\$1')}"`;
}

function cleanEmail(email: string): string | undefined {
  const e = cleanHeaderText(email).replace(/^<|>$/g, '');
  return /^[^\s<>()",;]+@[^\s<>()",;]+$/.test(e) && isPrintableAscii(e) ? e : undefined;
}

export function formatAddress(a: Address): string {
  const email = a.email ? cleanEmail(a.email) : undefined;
  const name = a.name ? encodeDisplayName(a.name) : '';
  if (email) return name ? `${name} <${email}>` : email;
  // No usable SMTP address (e.g. Exchange-internal): keep the display name only.
  return `${name || '"unknown"'} <>`;
}

export function formatAddressList(list: Address[]): string {
  return list.map(formatAddress).join(`,${CRLF} `);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** RFC 5322 date in UTC, e.g. "Tue, 05 Mar 2024 14:03:09 +0000". */
export function formatRfc5322Date(d: Date): string {
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** asctime()-style date used on mbox "From " lines, in UTC. */
export function formatAsctime(d: Date): string {
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** Quoted-printable encoding (RFC 2045) of UTF-8 text with CRLF hard line breaks. */
export function encodeQuotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n|\r/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const tok = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cur.length + tok.length > 75) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += tok;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

export function encodeBase64Lines(data: Buffer): string {
  const b64 = data.toString('base64');
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join(CRLF);
}

const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function percentEncode(s: string): string[] {
  const tokens: string[] = [];
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    tokens.push(b < 128 && ATTR_CHAR.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, '0')}`);
  }
  return tokens;
}

/**
 * Builds a file name parameter: a quoted ASCII value when possible, otherwise
 * RFC 2231 extended notation with continuations for long values.
 */
export function fileNameParam(param: string, filename: string): string[] {
  const f = cleanHeaderText(filename);
  if (isPrintableAscii(f) && f.length <= 60) return [`${param}="${f.replace(/(["\\])/g, '\\$1')}"`];
  const tokens = percentEncode(f);
  const joined = tokens.join('');
  if (joined.length <= 60) return [`${param}*=UTF-8''${joined}`];
  const parts: string[] = [];
  let cur = '';
  for (const t of tokens) {
    if (cur.length + t.length > 60) {
      parts.push(cur);
      cur = '';
    }
    cur += t;
  }
  if (cur) parts.push(cur);
  return parts.map((p, i) => (i === 0 ? `${param}*0*=UTF-8''${p}` : `${param}*${i}*=${p}`));
}

interface Part {
  headers: string[];
  body: string;
}

function serialize(p: Part): string {
  return `${p.headers.join(CRLF)}${CRLF}${CRLF}${p.body}`;
}

class BoundaryFactory {
  private n = 0;
  constructor(private readonly seed: string) {}
  next(): string {
    this.n++;
    const h = createHash('sha256').update(`${this.seed}:${this.n}`).digest('hex').slice(0, 16);
    return `=_pstpeek_${this.n}_${h}`;
  }
}

function multipart(subtype: string, parts: Part[], b: BoundaryFactory): Part {
  const boundary = b.next();
  const body = parts.map((p) => `--${boundary}${CRLF}${serialize(p)}${CRLF}`).join('') + `--${boundary}--${CRLF}`;
  return { headers: [`Content-Type: multipart/${subtype};${CRLF} boundary="${boundary}"`], body };
}

function textPart(subtype: 'plain' | 'html', text: string): Part {
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable'],
    body: encodeQuotedPrintable(text.replace(/\u0000/g, '')),
  };
}

function safeMimeType(t: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(t) ? t.toLowerCase() : 'application/octet-stream';
}

function attachmentPart(a: Attachment, depth: number, seed: string): Part {
  const disposition = a.inline ? 'inline' : 'attachment';
  const dispParams = fileNameParam('filename', a.filename);
  const headers: string[] = [];
  const embedded = depth < MAX_DEPTH ? a.getEmbedded() : undefined;
  if (embedded) {
    headers.push('Content-Type: message/rfc822', 'Content-Transfer-Encoding: 7bit');
    headers.push(`Content-Disposition: ${disposition};${CRLF} ${dispParams.join(`;${CRLF} `)}`);
    return { headers, body: buildEmlString(embedded, depth + 1, `${seed}/e`) };
  }
  const type = safeMimeType(a.mimeType);
  // RFC 2231 for both parameters (RFC 2047 encoded words are not allowed inside parameters).
  headers.push(`Content-Type: ${type};${CRLF} ${fileNameParam('name', a.filename).join(`;${CRLF} `)}`);
  headers.push('Content-Transfer-Encoding: base64');
  headers.push(`Content-Disposition: ${disposition};${CRLF} ${dispParams.join(`;${CRLF} `)}`);
  if (a.contentId && isPrintableAscii(a.contentId) && !/[<>\s]/.test(a.contentId)) headers.push(`Content-ID: <${a.contentId}>`);
  return { headers, body: encodeBase64Lines(a.getData()) };
}

function msgIdHeader(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const v = cleanHeaderText(id).replace(/^<|>$/g, '');
  return v && isPrintableAscii(v) && !/\s/.test(v) ? `<${v}>` : undefined;
}

function buildEmlString(msg: MailMessage, depth: number, seed: string): string {
  const b = new BoundaryFactory(`${seed}|${msg.subject}|${msg.date?.toISOString() ?? ''}|${msg.messageId ?? ''}`);
  const headers: string[] = [];
  if (msg.date) headers.push(`Date: ${formatRfc5322Date(msg.date)}`);
  if (msg.from) headers.push(`From: ${formatAddress(msg.from)}`);
  if (msg.sender) headers.push(`Sender: ${formatAddress(msg.sender)}`);
  headers.push(`Subject: ${encodeUnstructured(msg.subject)}`);
  if (msg.to.length) headers.push(`To: ${formatAddressList(msg.to)}`);
  if (msg.cc.length) headers.push(`Cc: ${formatAddressList(msg.cc)}`);
  if (msg.bcc.length) headers.push(`Bcc: ${formatAddressList(msg.bcc)}`);
  const mid = msgIdHeader(msg.messageId);
  if (mid) headers.push(`Message-ID: ${mid}`);
  const irt = msgIdHeader(msg.inReplyTo);
  if (irt) headers.push(`In-Reply-To: ${irt}`);
  if (msg.references) {
    const refs = cleanHeaderText(msg.references);
    if (isPrintableAscii(refs)) headers.push(`References: ${refs.split(/\s+/).join(`${CRLF} `)}`);
  }
  if (msg.importance && msg.importance !== 'normal') headers.push(`Importance: ${msg.importance}`);
  headers.push('MIME-Version: 1.0');

  const text = msg.bodyText !== undefined ? textPart('plain', msg.bodyText) : undefined;
  const html = msg.bodyHtml !== undefined ? textPart('html', msg.bodyHtml) : undefined;
  let body: Part;
  if (text && html) body = multipart('alternative', [text, html], b);
  else body = html ?? text ?? textPart('plain', '');

  const inline = html ? msg.attachments.filter((a) => a.inline) : [];
  const regular = msg.attachments.filter((a) => !inline.includes(a));
  if (inline.length) body = multipart('related', [body, ...inline.map((a) => attachmentPart(a, depth, seed))], b);
  if (regular.length) {
    body = multipart(
      'mixed',
      [body, ...regular.map((a, i) => attachmentPart(a, depth, `${seed}/${i}`))],
      b,
    );
  }
  return `${headers.join(CRLF)}${CRLF}${serialize(body)}`;
}

/** Serializes a message as an RFC 5322 .eml document (7-bit ASCII, CRLF). */
export function buildEml(msg: MailMessage): Buffer {
  return Buffer.from(buildEmlString(msg, 0, 'm'), 'latin1');
}
