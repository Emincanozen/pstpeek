import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decompressRtf, RTF_PREBUF_LENGTH, rtfToBody } from '../src/mapi/rtf.js';

test('LZFu dictionary pre-buffer is 207 bytes', () => {
  assert.equal(RTF_PREBUF_LENGTH, 207);
});

test('decompresses a compressed RTF stream with dictionary references', () => {
  // Widely used test vector ("simple compressed RTF"): literals plus references
  // into the pre-loaded dictionary ("\ansi", "\pard").
  const data = Buffer.from(
    '2d0000002b0000004c5a4675f1c5c7a703000a007263706731323542320af32068656c09002062770' +
      '5b06c647d0a800fa0',
    'hex',
  );
  assert.equal(decompressRtf(data).toString('latin1'), '{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n');
});

test('returns stored (MELA) RTF unchanged', () => {
  const body = Buffer.from('{\\rtf1 plain}', 'latin1');
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(body.length + 12, 0);
  hdr.writeUInt32LE(body.length, 4);
  hdr.writeUInt32LE(0x414c454d, 8);
  assert.equal(decompressRtf(Buffer.concat([hdr, body])).toString('latin1'), '{\\rtf1 plain}');
});

test('rejects unknown compression types', () => {
  assert.throws(() => decompressRtf(Buffer.alloc(16)));
});

test('extracts encapsulated HTML from RTF', () => {
  const rtf =
    '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1 \\deff0{\\fonttbl{\\f0\\fswiss Arial;}}' +
    '{\\*\\htmltag19 <html>}{\\*\\htmltag34 <body>}\\htmlrtf {\\htmlrtf0 Caf\\\'e9 \\{ok\\}' +
    '\\htmlrtf }\\htmlrtf0 {\\*\\htmltag64 </body>}{\\*\\htmltag27 </html>}}';
  const out = rtfToBody(Buffer.from(rtf, 'latin1'));
  assert.equal(out.html, '<html><body>Café {ok}</body></html>');
});

test('extracts plain text from ordinary RTF', () => {
  const rtf = '{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Hello\\par World \\u8364?}';
  assert.equal(rtfToBody(Buffer.from(rtf, 'latin1')).text, 'Hello\nWorld €');
});
