import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEml,
  encodeDisplayName,
  encodeQuotedPrintable,
  encodeUnstructured,
  encodeWords,
  fileNameParam,
  formatAddress,
  formatAsctime,
  formatRfc5322Date,
} from '../src/export/mime.js';
import type { Attachment, MailMessage } from '../src/model.js';
import { decodeEncodedWords, decodeQuotedPrintable, headerValue } from './helpers/mime-decode.js';

function att(filename: string, data: Buffer, extra: Partial<Attachment> = {}): Attachment {
  return { filename, mimeType: 'application/octet-stream', size: data.length, inline: false, getData: () => data, getEmbedded: () => undefined, ...extra };
}

function msg(extra: Partial<MailMessage> = {}): MailMessage {
  return { messageClass: 'IPM.Note', subject: 'Hello', to: [], cc: [], bcc: [], attachments: [], ...extra };
}

test('encoded words stay within 75 characters and never split a character', () => {
  const s = '日本語のテキストと絵文字🌍を含む長い件名'.repeat(3);
  const words = encodeWords(s);
  assert.ok(words.length > 1);
  for (const w of words) assert.ok(w.length <= 75, w);
  assert.equal(decodeEncodedWords(words.join(' ')), s);
});

test('ASCII subjects are kept readable and folded', () => {
  const subject = 'word '.repeat(40).trim();
  const enc = encodeUnstructured(subject);
  for (const line of enc.split('\r\n')) assert.ok(line.length <= 78);
  assert.equal(enc.replace(/\r\n /g, ' '), subject);
});

test('non-ASCII subjects use RFC 2047 and decode back', () => {
  const s = 'Réunion 🌍 été';
  const enc = encodeUnstructured(s);
  assert.match(enc, /^=\?UTF-8\?B\?/);
  assert.equal(decodeEncodedWords(enc), s);
});

test('header values cannot inject new header lines', () => {
  const enc = encodeUnstructured('Hi\r\nBcc: victim@example.com');
  assert.ok(!/\r\nBcc:/.test(enc));
});

test('display names are quoted or encoded as needed', () => {
  assert.equal(encodeDisplayName('Ana Test'), 'Ana Test');
  assert.equal(encodeDisplayName('Test, Ana'), '"Test, Ana"');
  assert.equal(encodeDisplayName('Bob "B" Test'), '"Bob \\"B\\" Test"');
  assert.equal(decodeEncodedWords(encodeDisplayName('Zoë')), 'Zoë');
});

test('addresses without an SMTP address keep only the display name', () => {
  assert.equal(formatAddress({ name: 'Ana', email: 'ana@example.com' }), 'Ana <ana@example.com>');
  assert.equal(formatAddress({ email: 'ana@example.com' }), 'ana@example.com');
  assert.equal(formatAddress({ name: 'Internal Person' }), 'Internal Person <>');
});

test('dates use RFC 5322 and asctime formats in UTC', () => {
  const d = new Date('2024-03-05T14:03:09Z');
  assert.equal(formatRfc5322Date(d), 'Tue, 05 Mar 2024 14:03:09 +0000');
  assert.equal(formatAsctime(d), 'Tue Mar  5 14:03:09 2024');
});

test('quoted-printable keeps lines short, protects trailing spaces and round-trips', () => {
  const text = `${'x'.repeat(200)}\nline with trailing space \nCafé = 100% ✓\n\tTab`;
  const qp = encodeQuotedPrintable(text);
  for (const line of qp.split('\r\n')) assert.ok(line.length <= 76, line);
  assert.match(qp, /space=20\r\n/);
  assert.equal(decodeQuotedPrintable(qp), text.replace(/\n/g, '\r\n'));
});

test('file name parameters use RFC 2231 for non-ASCII and long names', () => {
  assert.deepEqual(fileNameParam('filename', 'report.pdf'), ['filename="report.pdf"']);
  assert.deepEqual(fileNameParam('filename', 'été.txt'), ["filename*=UTF-8''%C3%A9t%C3%A9.txt"]);
  const long = fileNameParam('filename', `${'é'.repeat(40)}.txt`);
  assert.ok(long.length > 1);
  assert.match(long[0]!, /^filename\*0\*=UTF-8''/);
  assert.match(long[1]!, /^filename\*1\*=/);
  const joined = long.map((p) => p.replace(/^filename\*\d+\*=(UTF-8'')?/, '')).join('');
  assert.equal(decodeURIComponent(joined), `${'é'.repeat(40)}.txt`);
});

test('a text-only message is a single quoted-printable part', () => {
  const eml = buildEml(msg({ bodyText: 'Hi there', from: { name: 'A', email: 'a@example.com' }, date: new Date(0) })).toString('latin1');
  assert.equal(headerValue(eml, 'Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(headerValue(eml, 'From'), 'A <a@example.com>');
  assert.equal(headerValue(eml, 'MIME-Version'), '1.0');
  assert.ok(eml.endsWith('Hi there'));
});

test('EML output is 7-bit ASCII with CRLF line endings only', () => {
  const eml = buildEml(
    msg({ subject: 'Ünïcödé 🌍', bodyText: 'çà\nnext', bodyHtml: '<p>é</p>', attachments: [att('naïve.bin', Buffer.from([0, 1, 2, 255]))] }),
  );
  for (const b of eml) assert.ok(b < 128);
  const s = eml.toString('latin1');
  assert.ok(!/[^\r]\n/.test(s), 'bare LF found');
});

test('text + html + attachments produce mixed/alternative structure', () => {
  const data = Buffer.from('attachment bytes');
  const eml = buildEml(
    msg({ bodyText: 'plain', bodyHtml: '<p>html</p>', attachments: [att('été.txt', data, { mimeType: 'text/plain' })] }),
  ).toString('latin1');
  assert.match(headerValue(eml, 'Content-Type')!, /^multipart\/mixed; boundary="/);
  assert.match(eml, /Content-Type: multipart\/alternative/);
  assert.match(eml, /Content-Type: text\/html; charset=utf-8/);
  assert.match(eml, /filename\*=UTF-8''%C3%A9t%C3%A9\.txt/);
  assert.ok(eml.includes(data.toString('base64')));
  // Every boundary that is opened is closed.
  const boundaries = [...eml.matchAll(/boundary="([^"]+)"/g)].map((m) => m[1]!);
  for (const b of boundaries) assert.ok(eml.includes(`--${b}--`), b);
});

test('inline images referenced by cid go into multipart/related', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const eml = buildEml(
    msg({ bodyHtml: '<img src="cid:logo@x">', attachments: [att('logo.png', png, { mimeType: 'image/png', contentId: 'logo@x', inline: true })] }),
  ).toString('latin1');
  assert.match(headerValue(eml, 'Content-Type')!, /^multipart\/related/);
  assert.match(eml, /Content-ID: <logo@x>/);
  assert.match(eml, /Content-Disposition: inline/);
});

test('embedded messages become message/rfc822 parts', () => {
  const inner = msg({ subject: 'Inner', bodyText: 'inside' });
  const eml = buildEml(
    msg({ bodyText: 'outer', attachments: [att('Inner.eml', Buffer.alloc(0), { mimeType: 'message/rfc822', getEmbedded: () => inner })] }),
  ).toString('latin1');
  assert.match(eml, /Content-Type: message\/rfc822/);
  assert.match(eml, /Subject: Inner/);
});

test('message ids are wrapped in angle brackets', () => {
  const eml = buildEml(msg({ messageId: 'abc@example.com', inReplyTo: '<prev@example.com>' })).toString('latin1');
  assert.equal(headerValue(eml, 'Message-ID'), '<abc@example.com>');
  assert.equal(headerValue(eml, 'In-Reply-To'), '<prev@example.com>');
});
