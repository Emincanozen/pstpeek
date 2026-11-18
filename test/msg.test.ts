import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCfb } from '../src/msg/cfb.js';
import { MsgArchive, parseMsg } from '../src/msg/msg.js';
import { buildCfb } from './helpers/cfb-builder.js';
import { buildSampleMsg, DATE_A } from './helpers/fixture.js';

test('reads a compound file with mini-stream and regular-sector streams', () => {
  const small = Buffer.from('small stream');
  const large = Buffer.alloc(9000, 0x5a);
  const root = readCfb(
    buildCfb({ name: 'Root Entry', children: [{ name: 'small', data: small }, { name: 'dir', children: [{ name: 'large', data: large }] }] }),
  );
  assert.deepEqual(root.children.get('SMALL')?.read(), small);
  assert.deepEqual(root.children.get('DIR')?.children.get('LARGE')?.read(), large);
});

test('rejects non-CFB data', () => {
  assert.throws(() => readCfb(Buffer.alloc(1024)), /Not a compound file/);
});

test('parses an Outlook .msg file', () => {
  const m = parseMsg(buildSampleMsg());
  assert.equal(m.subject, 'Message from a .msg file ✓');
  assert.deepEqual(m.from, { name: 'Mia Msg', email: 'mia@example.com' });
  assert.deepEqual(m.to, [{ name: 'Ana Test', email: 'ana@example.com' }]);
  assert.equal(m.date?.toISOString(), DATE_A.toISOString());
  assert.equal(m.bodyText, 'Body of the msg file.');
  assert.deepEqual(m.attachments.map((a) => a.filename), ['notes.txt', 'big.bin']);
  assert.equal(m.attachments[0]?.getData().toString(), 'hello from msg');
  assert.equal(m.attachments[1]?.getData().length, 10000);
});

test('presents a .msg file as a one-folder archive', () => {
  const a = new MsgArchive(buildSampleMsg(), 'sample.msg');
  assert.equal(a.root.messageCount, 1);
  const entries = [...a.messages(a.root)];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.index, 1);
});
