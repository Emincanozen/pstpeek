import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exportArchive, type ExportFormat } from './export/exporter.js';
import type { Address, Folder, MailArchive, MailMessage, MessageError } from './model.js';
import { findFolder, folderPathString, openArchive, walkFolders } from './open.js';
import { messageText, searchArchive } from './search.js';
import { PstArchive } from './pst/pst.js';

const HELP = `pstpeek - open Outlook .pst/.ost/.msg files without Outlook (read-only, offline)

Usage:
  pstpeek tree   <file> [--json]
  pstpeek list   <file> [--folder <path>] [--limit <n>] [--json]
  pstpeek show   <file> --folder <path> --index <n> [--json]
  pstpeek search <file> <text> [--folder <path>] [--limit <n>] [--case-sensitive] [--json]
  pstpeek export <file> -o <dir> [--format eml|mbox|json] [--folder <path>]

Folder paths use "/" between levels and match case-insensitively; the path may
start below the top level, e.g. --folder Inbox or --folder "Inbox/Projects".

Options:
  -o, --out <dir>      Output directory for export (created if missing; files are never overwritten)
  -f, --format <fmt>   Export format: eml (default), mbox (one file per folder) or json
      --folder <path>  Restrict to a folder (and its subfolders for export/search)
      --limit <n>      Maximum number of rows to print
      --json           Machine-readable output
  -h, --help           Show this help
  -v, --version        Show the version
`;

class UsageError extends Error {}

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const err = (s: string): void => {
  process.stderr.write(`${s}\n`);
};

function fmtDate(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '-';
}

function fmtAddr(a: Address | undefined): string {
  if (!a) return '';
  if (a.name && a.email) return `${a.name} <${a.email}>`;
  return a.name ?? a.email ?? '';
}

/** Truncates by code points and removes control characters for terminal output. */
function cell(s: string, width: number): string {
  const clean = s.replace(/[\x00-\x1f\x7f]+/g, ' ');
  const chars = [...clean];
  const t = chars.length > width ? `${chars.slice(0, width - 1).join('')}~` : clean;
  return t + ' '.repeat(Math.max(0, width - [...t].length));
}

function addrJson(a: Address | undefined): Address | null {
  return a ? { ...a } : null;
}

function summaryJson(folder: Folder, index: number, m: MailMessage): Record<string, unknown> {
  return {
    folder: folderPathString(folder),
    index,
    date: m.date?.toISOString() ?? null,
    from: addrJson(m.from),
    to: m.to,
    subject: m.subject,
    messageClass: m.messageClass,
    attachments: m.attachments.length,
  };
}

function requireFolder(archive: MailArchive, path: string | undefined): Folder {
  if (path === undefined) return archive.root;
  const f = findFolder(archive.root, path);
  if (!f) throw new UsageError(`Folder not found: ${path} (run "pstpeek tree" to see folder names)`);
  return f;
}

function parseLimit(v: string | undefined): number {
  if (v === undefined) return Infinity;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit must be a positive integer');
  return n;
}

function reportErrors(errors: MessageError[]): void {
  if (!errors.length) return;
  err(`warning: ${errors.length} item(s) could not be read`);
  for (const e of errors.slice(0, 5)) err(`  ${folderPathString(e.folder)} #${e.index}: ${e.error.message}`);
}

function cmdTree(archive: MailArchive, json: boolean): void {
  if (json) {
    const strip = (f: Folder): unknown => ({ name: f.name, path: folderPathString(f), messageCount: f.messageCount, children: f.children.map(strip) });
    out(JSON.stringify(strip(archive.root), null, 2));
    return;
  }
  let total = 0;
  const walk = (f: Folder, prefix: string, last: boolean, top: boolean): void => {
    total += f.messageCount;
    const line = top ? f.name : `${prefix}${last ? '`-- ' : '|-- '}${f.name}`;
    out(`${line} (${f.messageCount})`);
    const childPrefix = top ? '' : prefix + (last ? '    ' : '|   ');
    f.children.forEach((c, i) => walk(c, childPrefix, i === f.children.length - 1, false));
  };
  walk(archive.root, '', true, true);
  out(`\n${total} item(s) in ${[...walkFolders(archive.root)].length} folder(s)`);
}

function cmdList(archive: MailArchive, folderPath: string | undefined, limit: number, json: boolean): void {
  const errors: MessageError[] = [];
  const folders = folderPath === undefined ? [...walkFolders(archive.root)] : [requireFolder(archive, folderPath)];
  const rows: Record<string, unknown>[] = [];
  let printed = 0;
  for (const folder of folders) {
    if (printed >= limit) break;
    if (folder.messageCount === 0) continue;
    if (!json) out(`\n== ${folderPathString(folder)} (${folder.messageCount})`);
    for (const { index, message: m } of archive.messages(folder, (e) => errors.push(e))) {
      if (printed >= limit) break;
      printed++;
      if (json) rows.push(summaryJson(folder, index, m));
      else {
        const att = m.attachments.length ? ` [${m.attachments.length} att]` : '';
        out(`${String(index).padStart(5)}  ${fmtDate(m.date)}  ${cell(fmtAddr(m.from), 32)}  ${m.subject.replace(/[\x00-\x1f]+/g, ' ')}${att}`);
      }
    }
  }
  if (json) out(JSON.stringify(rows, null, 2));
  else if (printed === 0) out('No messages.');
  reportErrors(errors);
}

function cmdShow(archive: MailArchive, folderPath: string | undefined, indexStr: string | undefined, json: boolean): void {
  if (folderPath === undefined && archive.kind !== 'msg') throw new UsageError('show requires --folder');
  const folder = requireFolder(archive, folderPath);
  const index = indexStr === undefined && archive.kind === 'msg' ? 1 : Number(indexStr);
  if (!Number.isInteger(index) || index < 1) throw new UsageError('show requires --index <n> (see "pstpeek list")');
  for (const { index: i, message: m } of archive.messages(folder)) {
    if (i !== index) continue;
    if (json) {
      out(JSON.stringify({ ...summaryJson(folder, i, m), cc: m.cc, bcc: m.bcc, bodyText: messageText(m), attachments: m.attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size })) }, null, 2));
      return;
    }
    out(`Folder:  ${folderPathString(folder)} #${i}`);
    out(`Date:    ${m.date?.toISOString() ?? '-'}`);
    out(`From:    ${fmtAddr(m.from)}`);
    if (m.to.length) out(`To:      ${m.to.map(fmtAddr).join(', ')}`);
    if (m.cc.length) out(`Cc:      ${m.cc.map(fmtAddr).join(', ')}`);
    out(`Subject: ${m.subject}`);
    for (const a of m.attachments) out(`Attach:  ${a.filename} (${a.mimeType}, ${a.size} bytes)`);
    out('');
    out(messageText(m));
    return;
  }
  throw new UsageError(`No message #${index} in ${folderPathString(folder)}`);
}

function cmdSearch(archive: MailArchive, query: string, folderPath: string | undefined, limit: number, caseSensitive: boolean, json: boolean): void {
  const errors: MessageError[] = [];
  const folder = requireFolder(archive, folderPath);
  const rows: Record<string, unknown>[] = [];
  let n = 0;
  for (const hit of searchArchive(archive, query, { folder, caseSensitive, onError: (e) => errors.push(e) })) {
    n++;
    if (json) rows.push({ ...summaryJson(hit.folder, hit.index, hit.message), field: hit.field, snippet: hit.snippet });
    else {
      out(`${folderPathString(hit.folder)} #${hit.index}  ${fmtDate(hit.message.date)}  ${fmtAddr(hit.message.from)}`);
      out(`  Subject: ${hit.message.subject}`);
      out(`  ${hit.field}: ${hit.snippet}`);
    }
    if (n >= limit) break;
  }
  if (json) out(JSON.stringify(rows, null, 2));
  else out(`\n${n} match(es)`);
  reportErrors(errors);
}

function cmdExport(archive: MailArchive, file: string, outDir: string | undefined, format: string, folderPath: string | undefined): void {
  if (!outDir) throw new UsageError('export requires -o <dir>');
  if (!['eml', 'mbox', 'json'].includes(format)) throw new UsageError('--format must be eml, mbox or json');
  const target = resolve(outDir);
  if (target === resolve(file)) throw new UsageError('Output directory cannot be the input file');
  const folder = requireFolder(archive, folderPath);
  const errors: MessageError[] = [];
  let count = 0;
  const res = exportArchive(archive, {
    format: format as ExportFormat,
    outDir: target,
    folder,
    onError: (e) => errors.push(e),
    onMessage: () => {
      count++;
      if (process.stderr.isTTY && count % 100 === 0) process.stderr.write(`\r${count} item(s)...`);
    },
  });
  if (process.stderr.isTTY && count >= 100) process.stderr.write('\r');
  out(`Exported ${res.messages} item(s) with ${res.attachments} attachment(s) from ${res.folders} folder(s) to ${target} (${format})`);
  reportErrors(errors);
}

export function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string', short: 'o' },
        format: { type: 'string', short: 'f', default: 'eml' },
        folder: { type: 'string' },
        index: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean', default: false },
        'case-sensitive': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    err('Run "pstpeek --help" for usage.');
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    out(version());
    return 0;
  }
  const [command, file, ...rest] = positionals;
  if (v.help || !command) {
    out(HELP);
    return v.help ? 0 : 2;
  }
  if (!['tree', 'list', 'show', 'search', 'export'].includes(command)) {
    err(`error: unknown command "${command}"`);
    err('Run "pstpeek --help" for usage.');
    return 2;
  }
  if (!file) {
    err(`error: ${command} needs an input file`);
    return 2;
  }
  let archive: MailArchive | undefined;
  try {
    archive = openArchive(file);
    if (archive instanceof PstArchive && archive.db.format === 'unicode4k') {
      err('warning: Outlook 2013+ OST (4K pages) support is experimental (checked on a single public sample file only); verify the output');
    }
    switch (command) {
      case 'tree':
        cmdTree(archive, v.json);
        break;
      case 'list':
        cmdList(archive, v.folder, parseLimit(v.limit), v.json);
        break;
      case 'show':
        cmdShow(archive, v.folder, v.index, v.json);
        break;
      case 'search': {
        const query = rest.join(' ');
        if (!query) throw new UsageError('search needs a text to look for');
        cmdSearch(archive, query, v.folder, parseLimit(v.limit), v['case-sensitive'], v.json);
        break;
      }
      case 'export':
        cmdExport(archive, file, v.out, v.format, v.folder);
        break;
    }
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    archive?.close();
  }
}
