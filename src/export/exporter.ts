/** Writes folders and messages to disk as .eml files, mbox files or JSON. */
import { closeSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Attachment, Folder, MailArchive, MailMessage, MessageError } from '../model.js';
import { walkFolders } from '../open.js';
import { NameAllocator, safeFileName } from './filenames.js';
import { toMboxEntry } from './mbox.js';
import { buildEml } from './mime.js';

export type ExportFormat = 'eml' | 'json' | 'mbox';

export interface ExportOptions {
  format: ExportFormat;
  outDir: string;
  /** Export only this folder and its subfolders (default: everything). */
  folder?: Folder;
  /** Called after each message. */
  onMessage?: (folder: Folder, index: number) => void;
  onError?: (e: MessageError) => void;
}

export interface ExportResult {
  folders: number;
  messages: number;
  attachments: number;
  errors: number;
}

/** Tracks used names per directory and creates files without ever overwriting. */
class OutputTree {
  private readonly allocators = new Map<string, NameAllocator>();
  private readonly checked = new Set<string>();

  constructor(private readonly root: string) {}

  /**
   * Creates `dir` below the output root one component at a time, refusing to
   * traverse any existing symbolic link or junction, so that a link planted in
   * the output tree cannot redirect writes elsewhere.
   */
  private ensureDir(dir: string): void {
    if (this.checked.has(dir)) return;
    const rel = relative(this.root, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Refusing to write outside the output directory: ${dir}`);
    let cur = this.root;
    for (const part of rel.split(sep).filter(Boolean)) {
      cur = join(cur, part);
      let st;
      try {
        st = lstatSync(cur);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        mkdirSync(cur);
        continue;
      }
      if (st.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${cur}`);
      if (!st.isDirectory()) throw new Error(`Not a directory: ${cur}`);
    }
    this.checked.add(dir);
  }

  private allocator(dir: string): NameAllocator {
    let a = this.allocators.get(dir);
    if (!a) this.allocators.set(dir, (a = new NameAllocator()));
    return a;
  }

  /** Reserves a unique sub-directory name (does not create it). */
  dirName(parent: string, name: string): string {
    return join(parent, this.allocator(parent).allocate(name));
  }

  /** Opens a new file exclusively ('wx'); on collision with an existing file picks another name. */
  openNew(dir: string, name: string): { fd: number; path: string } {
    this.ensureDir(dir);
    for (let attempt = 0; attempt < 1000; attempt++) {
      const path = join(dir, this.allocator(dir).allocate(name));
      try {
        return { fd: openSync(path, 'wx'), path };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    throw new Error(`Cannot find a free file name for ${name} in ${dir}`);
  }

  writeNew(dir: string, name: string, data: Buffer | string): string {
    const { fd, path } = this.openNew(dir, name);
    try {
      writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    } finally {
      closeSync(fd);
    }
    return path;
  }
}

function messageBaseName(index: number, msg: MailMessage): string {
  const subject = safeFileName(msg.subject, { maxBytes: 80, fallback: 'no subject' });
  return `${String(index).padStart(5, '0')} ${subject}`;
}

function addressJson(a: { name?: string; email?: string } | undefined): { name?: string; email?: string } | null {
  return a ? { ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email } : {}) } : null;
}

function messageJson(folder: Folder, msg: MailMessage, attachments: unknown[]): unknown {
  return {
    folder: folder.path,
    messageClass: msg.messageClass,
    subject: msg.subject,
    date: msg.date?.toISOString() ?? null,
    from: addressJson(msg.from),
    sender: addressJson(msg.sender),
    to: msg.to.map(addressJson),
    cc: msg.cc.map(addressJson),
    bcc: msg.bcc.map(addressJson),
    messageId: msg.messageId ?? null,
    inReplyTo: msg.inReplyTo ?? null,
    references: msg.references ?? null,
    importance: msg.importance ?? null,
    bodyText: msg.bodyText ?? null,
    bodyHtml: msg.bodyHtml ?? null,
    transportHeaders: msg.transportHeaders ?? null,
    attachments,
  };
}

export function exportArchive(archive: MailArchive, opts: ExportOptions): ExportResult {
  const root = resolve(opts.outDir);
  mkdirSync(root, { recursive: true });
  const out = new OutputTree(root);
  const result: ExportResult = { folders: 0, messages: 0, attachments: 0, errors: 0 };
  const start = opts.folder ?? archive.root;

  // Map every folder to a unique, safe directory path.
  const dirs = new Map<Folder, string>();
  const assign = (f: Folder, parentDir: string): void => {
    const dir = out.dirName(parentDir, safeFileName(f.name, { maxBytes: 100, fallback: 'folder' }));
    dirs.set(f, dir);
    for (const c of f.children) assign(c, dir);
  };
  assign(start, root);

  const onError = (e: MessageError): void => {
    result.errors++;
    opts.onError?.(e);
  };

  for (const folder of walkFolders(start)) {
    result.folders++;
    if (folder.messageCount === 0) continue;
    const dir = dirs.get(folder)!;
    let mbox: { fd: number; path: string } | undefined;
    try {
      for (const { index, message } of archive.messages(folder, onError)) {
        try {
          if (opts.format === 'eml') {
            out.writeNew(dir, `${messageBaseName(index, message)}.eml`, buildEml(message));
            result.attachments += message.attachments.length;
          } else if (opts.format === 'mbox') {
            mbox ??= out.openNew(dirname(dir), `${basename(dir)}.mbox`);
            writeSync(mbox.fd, toMboxEntry(message));
            result.attachments += message.attachments.length;
          } else {
            result.attachments += writeJson(out, dir, folder, index, message);
          }
          result.messages++;
        } catch (err) {
          onError({ folder, index, error: err instanceof Error ? err : new Error(String(err)) });
        }
        opts.onMessage?.(folder, index);
      }
    } finally {
      if (mbox) closeSync(mbox.fd);
    }
  }
  return result;
}

function writeJson(out: OutputTree, dir: string, folder: Folder, index: number, msg: MailMessage): number {
  const base = messageBaseName(index, msg);
  const attDir = join(dir, `${base} files`);
  const atts: unknown[] = [];
  for (const a of msg.attachments) atts.push(writeAttachment(out, attDir, dir, a));
  out.writeNew(dir, `${base}.json`, JSON.stringify(messageJson(folder, msg, atts), null, 2) + '\n');
  return msg.attachments.length;
}

function writeAttachment(out: OutputTree, attDir: string, relativeTo: string, a: Attachment): unknown {
  const embedded = a.getEmbedded();
  const data = embedded ? buildEml(embedded) : a.getData();
  const path = out.writeNew(attDir, safeFileName(a.filename, { fallback: 'attachment' }), data);
  return {
    filename: a.filename,
    mimeType: a.mimeType,
    size: data.length,
    contentId: a.contentId ?? null,
    inline: a.inline,
    embeddedMessage: !!embedded,
    path: relative(relativeTo, path).split('\\').join('/'),
  };
}
