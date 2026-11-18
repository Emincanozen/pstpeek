/** Builds the format-independent MailMessage from MAPI properties (PST or MSG). */
import type { Address, Attachment, MailMessage } from '../model.js';
import { ansiCodepageFor, decodeCodepage, PR, PT, type PropertyBag } from './props.js';
import { decompressRtf, rtfToBody } from './rtf.js';

export interface MapiAttachmentSource {
  props: PropertyBag;
  /** Bytes of a by-value attachment. */
  data(): Buffer | undefined;
  /** Embedded Outlook item (attach method 5). */
  embedded(): MapiMessageSource | undefined;
}

export interface MapiMessageSource {
  props: PropertyBag;
  recipients(): PropertyBag[];
  attachments(): MapiAttachmentSource[];
}

const ATTACH_EMBEDDED_MSG = 5;

const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  xml: 'application/xml',
  json: 'application/json',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  eml: 'message/rfc822',
  msg: 'application/vnd.ms-outlook',
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  zip: 'application/zip',
  gz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function guessMimeType(filename: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename);
  return (m && MIME_BY_EXT[m[1]!.toLowerCase()]) || 'application/octet-stream';
}

function smtpOf(email: string | undefined, addrType: string | undefined, smtp: string | undefined): string | undefined {
  if (smtp && smtp.includes('@')) return smtp.trim();
  if (email && email.includes('@') && !email.startsWith('/') && (!addrType || addrType.toUpperCase() === 'SMTP')) {
    return email.trim();
  }
  return undefined;
}

function address(name: string | undefined, email: string | undefined): Address | undefined {
  const n = name?.trim() || undefined;
  if (!n && !email) return undefined;
  const a: Address = {};
  if (n && n !== email) a.name = n;
  if (email) a.email = email;
  return a;
}

function sameAddress(a: Address | undefined, b: Address | undefined): boolean {
  if (!a || !b) return false;
  if (a.email && b.email) return a.email.toLowerCase() === b.email.toLowerCase();
  return a.name === b.name;
}

function stripAngle(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  return t.replace(/^<|>$/g, '');
}

function readHtml(p: PropertyBag): string | undefined {
  const raw = p.raw(PR.HTML);
  if (!raw || raw.data.length === 0) return undefined;
  if (raw.type === PT.UNICODE) return p.string(PR.HTML);
  const cp = p.int(PR.INTERNET_CODEPAGE) ?? 65001;
  return decodeCodepage(raw.data, cp).replace(/\u0000+$/, '');
}

function namesFromDisplay(s: string | undefined): Address[] {
  if (!s) return [];
  return s
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
}

export function buildMessage(src: MapiMessageSource): MailMessage {
  const p = src.props;
  // PT_STRING8 is stored in the client's ANSI code page; the internet code page only hints at it.
  p.codepage = p.int(PR.MESSAGE_CODEPAGE) ?? ansiCodepageFor(p.int(PR.INTERNET_CODEPAGE)) ?? p.codepage;

  const from = address(
    p.string(PR.SENT_REPRESENTING_NAME) ?? p.string(PR.SENDER_NAME),
    smtpOf(p.string(PR.SENT_REPRESENTING_EMAIL), p.string(PR.SENT_REPRESENTING_ADDRTYPE), p.string(PR.SENT_REPRESENTING_SMTP_ADDRESS)) ??
      smtpOf(p.string(PR.SENDER_EMAIL), p.string(PR.SENDER_ADDRTYPE), p.string(PR.SENDER_SMTP_ADDRESS)),
  );
  const senderAddr = address(
    p.string(PR.SENDER_NAME),
    smtpOf(p.string(PR.SENDER_EMAIL), p.string(PR.SENDER_ADDRTYPE), p.string(PR.SENDER_SMTP_ADDRESS)),
  );

  const to: Address[] = [];
  const cc: Address[] = [];
  const bcc: Address[] = [];
  let recipients: PropertyBag[] = [];
  try {
    recipients = src.recipients();
  } catch {
    recipients = [];
  }
  for (const r of recipients) {
    if (r.codepage === undefined) r.codepage = p.codepage;
    const a = address(r.string(PR.DISPLAY_NAME), smtpOf(r.string(PR.EMAIL_ADDRESS), r.string(PR.ADDRTYPE), r.string(PR.SMTP_ADDRESS)));
    if (!a) continue;
    const type = (r.int(PR.RECIPIENT_TYPE) ?? 1) & 0x0f;
    (type === 2 ? cc : type === 3 ? bcc : to).push(a);
  }
  if (recipients.length === 0) {
    to.push(...namesFromDisplay(p.string(PR.DISPLAY_TO)));
    cc.push(...namesFromDisplay(p.string(PR.DISPLAY_CC)));
    bcc.push(...namesFromDisplay(p.string(PR.DISPLAY_BCC)));
  }

  let bodyText = p.string(PR.BODY);
  let bodyHtml = readHtml(p);
  if (!bodyHtml || !bodyText) {
    const rtf = p.binary(PR.RTF_COMPRESSED);
    if (rtf && rtf.length > 16) {
      try {
        const body = rtfToBody(decompressRtf(rtf));
        if (!bodyHtml && body.html) bodyHtml = body.html;
        if (!bodyText && body.text) bodyText = body.text;
      } catch {
        // keep what we have
      }
    }
  }

  const imp = p.int(PR.IMPORTANCE);
  const msg: MailMessage = {
    messageClass: p.string(PR.MESSAGE_CLASS) ?? 'IPM.Note',
    subject: p.string(PR.SUBJECT) ?? '',
    to,
    cc,
    bcc,
    attachments: [],
  };
  if (from) msg.from = from;
  if (senderAddr && from && !sameAddress(senderAddr, from)) msg.sender = senderAddr;
  const date = p.date(PR.CLIENT_SUBMIT_TIME) ?? p.date(PR.MESSAGE_DELIVERY_TIME) ?? p.date(PR.CREATION_TIME);
  if (date) msg.date = date;
  const mid = stripAngle(p.string(PR.INTERNET_MESSAGE_ID));
  if (mid) msg.messageId = mid;
  const irt = stripAngle(p.string(PR.IN_REPLY_TO_ID));
  if (irt) msg.inReplyTo = irt;
  const refs = p.string(PR.INTERNET_REFERENCES)?.trim();
  if (refs) msg.references = refs;
  if (imp !== undefined) msg.importance = imp === 0 ? 'low' : imp === 2 ? 'high' : 'normal';
  if (bodyText) msg.bodyText = bodyText;
  if (bodyHtml) msg.bodyHtml = bodyHtml;
  const headers = p.string(PR.TRANSPORT_MESSAGE_HEADERS);
  if (headers) msg.transportHeaders = headers;

  let atts: MapiAttachmentSource[] = [];
  try {
    atts = src.attachments();
  } catch {
    atts = [];
  }
  for (const a of atts) msg.attachments.push(buildAttachment(a, msg));
  return msg;
}

function buildAttachment(a: MapiAttachmentSource, parent: MailMessage): Attachment {
  const p = a.props;
  const method = p.int(PR.ATTACH_METHOD) ?? 1;
  const embedded = method === ATTACH_EMBEDDED_MSG;
  let filename =
    p.string(PR.ATTACH_LONG_FILENAME) ?? p.string(PR.ATTACH_FILENAME) ?? p.string(PR.DISPLAY_NAME) ?? '';
  filename = filename.trim();
  if (embedded) {
    filename = (filename || p.string(PR.DISPLAY_NAME) || 'attached message').replace(/\.msg$/i, '') + '.eml';
  }
  if (!filename) filename = 'attachment';
  const mimeTag = p.string(PR.ATTACH_MIME_TAG)?.trim().toLowerCase();
  const mimeType = embedded ? 'message/rfc822' : mimeTag && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeTag) ? mimeTag : guessMimeType(filename);
  const contentId = stripAngle(p.string(PR.ATTACH_CONTENT_ID));
  const inline = !!contentId && !!parent.bodyHtml && parent.bodyHtml.includes(`cid:${contentId}`);

  let embeddedCache: MailMessage | null | undefined;
  const att: Attachment = {
    filename,
    mimeType,
    size: p.int(PR.ATTACH_SIZE) ?? 0,
    inline,
    getData: () => a.data() ?? Buffer.alloc(0),
    getEmbedded: () => {
      if (!embedded) return undefined;
      if (embeddedCache === undefined) {
        const src = a.embedded();
        embeddedCache = src ? buildMessage(src) : null;
      }
      return embeddedCache ?? undefined;
    },
  };
  if (contentId) att.contentId = contentId;
  return att;
}
