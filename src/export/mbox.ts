/** mboxrd writer: "From " separator lines and >From quoting, LF line endings. */
import type { MailMessage } from '../model.js';
import { buildEml, formatAsctime } from './mime.js';

function envelopeSender(msg: MailMessage): string {
  const e = msg.from?.email ?? msg.sender?.email;
  return e && /^[^\s]+@[^\s]+$/.test(e) ? e : 'MAILER-DAEMON';
}

/** Quotes body lines per mboxrd: any line matching /^>*From / gets one more '>'. */
export function mboxrdQuote(text: string): string {
  return text.replace(/^(>*From )/gm, '>$1');
}

/** Returns one mbox entry (separator line, quoted message, trailing blank line). */
export function toMboxEntry(msg: MailMessage): Buffer {
  const date = msg.date ?? new Date(0);
  const eml = buildEml(msg).toString('latin1').replace(/\r\n/g, '\n');
  const body = mboxrdQuote(eml);
  const sep = `From ${envelopeSender(msg)} ${formatAsctime(date)}\n`;
  return Buffer.from(`${sep}${body}${body.endsWith('\n') ? '' : '\n'}\n`, 'latin1');
}
