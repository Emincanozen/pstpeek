import { statSync } from 'node:fs';
import type { Folder, MailArchive } from './model.js';
import { isCfb } from './msg/cfb.js';
import { MsgArchive } from './msg/msg.js';
import { PstArchive } from './pst/pst.js';
import { FileSource } from './source.js';

/** Opens a .pst, .ost or .msg file read-only, detecting the format from its content. */
export interface OpenOptions {
  /** Maximum size of a .msg file, which is parsed in memory (default 256 MiB). */
  maxMsgBytes?: number;
}

export function openArchive(path: string, opts: OpenOptions = {}): MailArchive {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`Not a file: ${path}`);
  const src = new FileSource(path);
  let head: Buffer;
  try {
    head = src.read(0, Math.min(8, src.size));
  } catch (err) {
    src.close();
    throw err;
  }
  if (head.subarray(0, 4).toString('latin1') === '!BDN') return new PstArchive(src);
  src.close();
  if (isCfb(head)) return MsgArchive.open(path, opts.maxMsgBytes);
  throw new Error('Unrecognized file format: expected an Outlook .pst, .ost or .msg file');
}

export function* walkFolders(folder: Folder): Generator<Folder> {
  yield folder;
  for (const c of folder.children) yield* walkFolders(c);
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Splits "A/B/C" into segments; "\/" escapes a slash inside a folder name. */
export function splitFolderPath(path: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (c === '\\' && path[i + 1] === '/') {
      cur += '/';
      i++;
    } else if (c === '/') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Resolves a folder path case-insensitively. The path may start at the root
 * name, at a top-level folder, or at any depth below (first match wins), so
 * "Inbox" works as well as "Top of Personal Folders/Inbox".
 */
export function findFolder(root: Folder, path: string): Folder | undefined {
  const segs = splitFolderPath(path).map(norm);
  if (segs.length === 0) return root;
  const descend = (start: Folder, rest: string[]): Folder | undefined => {
    let cur: Folder | undefined = start;
    for (const s of rest) {
      cur = cur.children.find((c: Folder) => norm(c.name) === s);
      if (!cur) return undefined;
    }
    return cur;
  };
  if (norm(root.name) === segs[0]) {
    const hit = descend(root, segs.slice(1));
    if (hit) return hit;
  }
  for (const f of walkFolders(root)) {
    const hit = descend(f, segs);
    if (hit) return hit;
  }
  return undefined;
}

export function folderPathString(folder: Folder): string {
  return folder.path.map((p) => p.replace(/\//g, '\\/')).join('/');
}
