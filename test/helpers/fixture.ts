/** Synthetic sample archive used by the integration tests. All data is invented. */
import { PR, PT } from '../../src/mapi/props.js';
import { buildCfb, msgStorage } from './cfb-builder.js';
import { buildPC, buildTC, prop, PstBuilder, type BuildOptions, type NodeContent } from './pst-builder.js';

export const NID = {
  STORE: 0x21,
  ROOT: 0x122,
  TOP: (0x400 << 5) | 0x02,
  INBOX: (0x401 << 5) | 0x02,
  SUMMER: (0x402 << 5) | 0x02,
  DELETED: (0x403 << 5) | 0x02,
  SEARCH: (0x404 << 5) | 0x03,
  MSG_A: (0x10000 << 5) | 0x04,
  MSG_B: (0x10001 << 5) | 0x04,
  MSG_C: (0x10002 << 5) | 0x04,
};

const table = (type: number, nid: number): number => ((nid & ~0x1f) | type) >>> 0;
const HIER = (nid: number): number => table(0x0d, nid);
const CONT = (nid: number): number => table(0x0e, nid);

export const DATE_A = new Date('2024-03-05T14:03:09Z');
export const DATE_B = new Date('2024-03-06T08:00:00Z');
export const DATE_C = new Date('2024-07-14T21:30:00Z');

export const SUBJECT_A = 'Réunion 🌍 été – planning';
export const ATTACHMENT_TEXT = 'Contenu du rapport, ligne 1\nFrom the start of a line\n';
export const LONG_BODY = 'Long body line with the needle-xyz marker.\n'.repeat(500) + 'END';

function folderPC(name: string, count: number, subfolders: boolean): NodeContent {
  return buildPC([
    prop.str(PR.DISPLAY_NAME, name),
    prop.int(PR.CONTENT_COUNT, count),
    prop.int(PR.CONTENT_UNREAD_COUNT, 0),
    prop.bool(PR.SUBFOLDERS, subfolders),
    prop.str(PR.CONTAINER_CLASS, 'IPF.Note'),
  ]);
}

function hierarchyTC(children: number[]): NodeContent {
  return buildTC([{ id: PR.DISPLAY_NAME, type: PT.UNICODE }], children.map((rowId) => ({ rowId, props: [] })));
}

function contentsTC(messages: number[]): NodeContent {
  return buildTC([{ id: PR.SUBJECT, type: PT.UNICODE }], messages.map((rowId) => ({ rowId, props: [] })));
}

const RECIP_COLS = [
  { id: PR.DISPLAY_NAME, type: PT.UNICODE },
  { id: PR.EMAIL_ADDRESS, type: PT.UNICODE },
  { id: PR.ADDRTYPE, type: PT.UNICODE },
  { id: PR.SMTP_ADDRESS, type: PT.UNICODE },
  { id: PR.RECIPIENT_TYPE, type: PT.INT32 },
];

function recipients(list: { name: string; email: string; type: number; exchange?: boolean }[]): NodeContent {
  return buildTC(
    RECIP_COLS,
    list.map((r, i) => ({
      rowId: i,
      props: [
        prop.str(PR.DISPLAY_NAME, r.name),
        prop.str(PR.EMAIL_ADDRESS, r.exchange ? `/O=EXAMPLE/OU=FIRST/CN=RECIPIENTS/CN=${r.name.toUpperCase()}` : r.email),
        prop.str(PR.ADDRTYPE, r.exchange ? 'EX' : 'SMTP'),
        ...(r.exchange ? [] : [prop.str(PR.SMTP_ADDRESS, r.email)]),
        prop.int(PR.RECIPIENT_TYPE, r.type),
      ],
    })),
  );
}

function attachmentTable(nids: number[]): NodeContent {
  return buildTC([{ id: PR.ATTACH_METHOD, type: PT.INT32 }], nids.map((rowId) => ({ rowId, props: [prop.int(PR.ATTACH_METHOD, 1)] })));
}

const ATT_1 = (1 << 5) | 0x05;
const ATT_2 = (2 << 5) | 0x05;
const EMBEDDED_NID = (0x50 << 5) | 0x04;
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(5000, 7)]);

function messageA(): NodeContent {
  const html = `<html><body><p>Bonjour Zoë,</p><p>Voir <img src="cid:logo@example.com"></p></body></html>`;
  const att1 = buildPC([
    prop.str(PR.ATTACH_LONG_FILENAME, 'rapport été.txt'),
    prop.str(PR.ATTACH_FILENAME, 'RAPPOR~1.TXT'),
    prop.int(PR.ATTACH_METHOD, 1),
    prop.str(PR.ATTACH_MIME_TAG, 'text/plain'),
    prop.int(PR.ATTACH_SIZE, Buffer.byteLength(ATTACHMENT_TEXT)),
    prop.bin(PR.ATTACH_DATA, Buffer.from(ATTACHMENT_TEXT, 'utf8')),
  ]);
  const att2 = buildPC([
    prop.str(PR.ATTACH_LONG_FILENAME, 'logo.png'),
    prop.int(PR.ATTACH_METHOD, 1),
    prop.str(PR.ATTACH_CONTENT_ID, 'logo@example.com'),
    prop.int(PR.ATTACH_SIZE, PNG_BYTES.length),
    prop.bin(PR.ATTACH_DATA, PNG_BYTES), // > 3500 bytes: stored in a nested subnode
  ]);
  return buildPC(
    [
      prop.str(PR.MESSAGE_CLASS, 'IPM.Note'),
      prop.str(PR.SUBJECT, SUBJECT_A),
      prop.str(PR.SENT_REPRESENTING_NAME, 'Zoë Example'),
      prop.str(PR.SENT_REPRESENTING_EMAIL, 'zoe@example.com'),
      prop.str(PR.SENT_REPRESENTING_ADDRTYPE, 'SMTP'),
      prop.str(PR.SENDER_NAME, 'Zoë Example'),
      prop.str(PR.SENDER_EMAIL, 'zoe@example.com'),
      prop.str(PR.SENDER_ADDRTYPE, 'SMTP'),
      prop.time(PR.CLIENT_SUBMIT_TIME, DATE_A),
      prop.time(PR.MESSAGE_DELIVERY_TIME, DATE_A),
      prop.str(PR.BODY, 'Bonjour Zoë,\r\nVoir le rapport.\r\n'),
      prop.bin(PR.HTML, Buffer.from(html, 'utf8')),
      prop.int(PR.INTERNET_CODEPAGE, 65001),
      prop.str(PR.INTERNET_MESSAGE_ID, '<a1@example.com>'),
      prop.int(PR.IMPORTANCE, 2),
    ],
    [
      { nid: 0x692, content: recipients([
        { name: 'Ana Test', email: 'ana@example.com', type: 1 },
        { name: 'Bob "B" Test', email: 'bob@example.com', type: 1 },
        { name: 'Chloé Copy', email: 'chloe@example.org', type: 2 },
        { name: 'Internal Person', email: '', type: 3, exchange: true },
      ]) },
      { nid: 0x671, content: attachmentTable([ATT_1, ATT_2]) },
      { nid: ATT_1, content: att1 },
      { nid: ATT_2, content: att2 },
    ],
  );
}

function messageB(): NodeContent {
  return buildPC([
    prop.str(PR.MESSAGE_CLASS, 'IPM.Note'),
    prop.str(PR.SUBJECT, 'Plain ASCII subject: weekly report'),
    prop.str(PR.SENDER_NAME, 'Dan Sender'),
    prop.str(PR.SENDER_EMAIL, 'dan@example.net'),
    prop.str(PR.SENDER_ADDRTYPE, 'SMTP'),
    prop.time(PR.MESSAGE_DELIVERY_TIME, DATE_B),
    prop.str(PR.BODY, LONG_BODY), // ~44 KB of UTF-16: subnode with an XBLOCK data tree
    prop.str(PR.DISPLAY_TO, 'Ana Test; Bob Test'),
  ]);
}

function messageC(): NodeContent {
  const inner = buildPC([
    prop.str(PR.MESSAGE_CLASS, 'IPM.Note'),
    prop.str(PR.SUBJECT, 'Inner forwarded message'),
    prop.str(PR.SENDER_NAME, 'Eve Inner'),
    prop.str(PR.SENDER_EMAIL, 'eve@example.com'),
    prop.str(PR.SENDER_ADDRTYPE, 'SMTP'),
    prop.time(PR.CLIENT_SUBMIT_TIME, DATE_B),
    prop.str(PR.BODY, 'This is the inner message.'),
  ]);
  const att = buildPC(
    [
      prop.str(PR.DISPLAY_NAME, 'Inner forwarded message'),
      prop.int(PR.ATTACH_METHOD, 5),
      prop.object(PR.ATTACH_DATA, EMBEDDED_NID, 100),
    ],
    [{ nid: EMBEDDED_NID, content: inner }],
  );
  return buildPC(
    [
      prop.str(PR.MESSAGE_CLASS, 'IPM.Note'),
      prop.str(PR.SUBJECT, 'Fwd: with an attached item'),
      prop.str(PR.SENDER_NAME, 'Zoë Example'),
      prop.str(PR.SENDER_SMTP_ADDRESS, 'zoe@example.com'),
      prop.str(PR.SENDER_EMAIL, '/O=EXAMPLE/CN=ZOE'),
      prop.str(PR.SENDER_ADDRTYPE, 'EX'),
      prop.time(PR.CLIENT_SUBMIT_TIME, DATE_C),
      prop.str(PR.BODY, 'See attached.'),
    ],
    [
      // No attachment table here: the reader must fall back to scanning subnodes.
      { nid: ATT_1, content: att },
    ],
  );
}

/**
 * Root ("Sample Archive")
 *   Top of Personal Folders
 *     Inbox (2)
 *       Été 2024 (1)  <- no contents table: found through NBT parent links
 *     Deleted Items (0)
 *     [search folder, must be ignored]
 */
export function buildSamplePst(opts: BuildOptions = {}): Buffer {
  const b = new PstBuilder(opts);
  b.addNode(NID.STORE, 0, buildPC([prop.str(PR.DISPLAY_NAME, 'Sample Archive')]));
  b.addNode(NID.ROOT, NID.ROOT, folderPC('', 0, true));
  b.addNode(HIER(NID.ROOT), 0, hierarchyTC([NID.TOP]));
  b.addNode(CONT(NID.ROOT), 0, contentsTC([]));
  b.addNode(NID.TOP, NID.ROOT, folderPC('Top of Personal Folders', 0, true));
  b.addNode(HIER(NID.TOP), 0, hierarchyTC([NID.INBOX, NID.DELETED, NID.SEARCH]));
  b.addNode(CONT(NID.TOP), 0, contentsTC([]));
  b.addNode(NID.INBOX, NID.TOP, folderPC('Inbox', 2, true));
  b.addNode(HIER(NID.INBOX), 0, hierarchyTC([NID.SUMMER]));
  b.addNode(CONT(NID.INBOX), 0, contentsTC([NID.MSG_A, NID.MSG_B]));
  b.addNode(NID.SUMMER, NID.INBOX, folderPC('Été 2024', 1, false));
  b.addNode(NID.DELETED, NID.TOP, folderPC('Deleted Items', 0, false));
  b.addNode(NID.SEARCH, NID.TOP, folderPC('Search results', 0, false));
  b.addNode(NID.MSG_A, NID.INBOX, messageA());
  b.addNode(NID.MSG_B, NID.INBOX, messageB());
  b.addNode(NID.MSG_C, NID.SUMMER, messageC());
  return b.build();
}

/** A small .msg file with one recipient and one attachment. */
export function buildSampleMsg(): Buffer {
  const recip = msgStorage('__recip_version1.0_#00000000', [
    prop.str(PR.DISPLAY_NAME, 'Ana Test'),
    prop.str(PR.EMAIL_ADDRESS, 'ana@example.com'),
    prop.str(PR.ADDRTYPE, 'SMTP'),
    prop.int(PR.RECIPIENT_TYPE, 1),
  ], 8);
  const attach = msgStorage('__attach_version1.0_#00000000', [
    prop.str(PR.ATTACH_LONG_FILENAME, 'notes.txt'),
    prop.int(PR.ATTACH_METHOD, 1),
    prop.bin(PR.ATTACH_DATA, Buffer.from('hello from msg', 'utf8')),
  ], 8);
  const big = msgStorage('__attach_version1.0_#00000001', [
    prop.str(PR.ATTACH_LONG_FILENAME, 'big.bin'),
    prop.int(PR.ATTACH_METHOD, 1),
    prop.bin(PR.ATTACH_DATA, Buffer.alloc(10000, 0x41)), // >= 4096: regular sectors
  ], 8);
  const top = msgStorage(
    'Root Entry',
    [
      prop.str(PR.MESSAGE_CLASS, 'IPM.Note'),
      prop.str(PR.SUBJECT, 'Message from a .msg file ✓'),
      prop.str(PR.SENDER_NAME, 'Mia Msg'),
      prop.str(PR.SENDER_EMAIL, 'mia@example.com'),
      prop.str(PR.SENDER_ADDRTYPE, 'SMTP'),
      prop.time(PR.CLIENT_SUBMIT_TIME, DATE_A),
      prop.str(PR.BODY, 'Body of the msg file.'),
    ],
    32,
    [recip, attach, big],
  );
  return buildCfb(top);
}
