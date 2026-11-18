/** Small decoders used to check the MIME writer's output in tests. */

export function decodeEncodedWords(s: string): string {
  return s
    .replace(/\r\n[ \t]/g, ' ')
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, b64: string) => Buffer.from(b64, 'base64').toString('utf8'));
}

export function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = [];
  const text = s.replace(/=\r\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '=' && /^[0-9A-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(c.charCodeAt(0));
  }
  return Buffer.from(bytes).toString('utf8');
}

export function unfold(headers: string): string {
  return headers.replace(/\r\n[ \t]+/g, ' ');
}

export function headerValue(eml: string, name: string): string | undefined {
  const head = eml.split('\r\n\r\n')[0]!;
  const re = new RegExp(`^${name}: (.*)$`, 'im');
  return re.exec(unfold(head))?.[1];
}
