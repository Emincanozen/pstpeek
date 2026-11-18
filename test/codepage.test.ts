/**
 * PT_STRING8 values are stored in the client's Windows ANSI code page. When
 * PidTagMessageCodepage is missing, the internet code page (e.g. 50220,
 * ISO-2022-JP) must be mapped to its Windows ANSI equivalent (932), not used as is.
 * Found on a public sample .msg; reproduced here with synthetic bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMsg } from '../src/msg/msg.js';
import { PR, PT } from '../src/mapi/props.js';
import { buildCfb, msgStorage } from './helpers/cfb-builder.js';
import { prop } from './helpers/pst-builder.js';

// "日本テスト" in Shift_JIS (Windows code page 932)
const SJIS = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x83, 0x65, 0x83, 0x58, 0x83, 0x67]);

test('STRING8 subject uses the ANSI code page derived from an ISO-2022-JP internet code page', () => {
  const top = msgStorage('Root Entry', [{ id: PR.SUBJECT, type: PT.STRING8, value: SJIS }, prop.int(PR.INTERNET_CODEPAGE, 50220)], 32);
  assert.equal(parseMsg(buildCfb(top)).subject, '日本テスト');
});

test('PidTagMessageCodepage still wins when present', () => {
  const latin = Buffer.from('Caf\xe9', 'latin1');
  const top = msgStorage('Root Entry', [{ id: PR.SUBJECT, type: PT.STRING8, value: latin }, prop.int(PR.MESSAGE_CODEPAGE, 1252), prop.int(PR.INTERNET_CODEPAGE, 50220)], 32);
  assert.equal(parseMsg(buildCfb(top)).subject, 'Café');
});

test('maps internet code pages to Windows ANSI code pages', async () => {
  const { ansiCodepageFor } = (await import('../src/mapi/props.js')) as unknown as { ansiCodepageFor: (cp: number) => number | undefined };
  assert.equal(typeof ansiCodepageFor, 'function');
  assert.equal(ansiCodepageFor(50220), 932);
  assert.equal(ansiCodepageFor(51932), 932);
  assert.equal(ansiCodepageFor(28591), 1252);
  assert.equal(ansiCodepageFor(28592), 1250);
  assert.equal(ansiCodepageFor(20866), 1251);
  assert.equal(ansiCodepageFor(1252), 1252);
  assert.equal(ansiCodepageFor(65001), undefined);
});
