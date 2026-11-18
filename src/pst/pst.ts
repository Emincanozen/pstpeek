/** Messaging layer: folders, messages, recipients and attachments of a PST/OST file. */
import { buildMessage, type MapiAttachmentSource, type MapiMessageSource } from '../mapi/message.js';
import { PR, PT, type PropertyBag } from '../mapi/props.js';
import type { Folder, MailArchive, MessageEntry, MessageError } from '../model.js';
import { FileSource, type ByteSource } from '../source.js';
import { readPropertyContext, readTableContext, readTableRowIds } from './ltp.js';
import {
  NID_ATTACHMENT_TABLE,
  NID_MESSAGE_STORE,
  NID_RECIPIENT_TABLE,
  NID_ROOT_FOLDER,
  NID_TYPE,
  NodeDatabase,
  nidType,
  PstNode,
  withNidType,
} from './ndb.js';

export class PstArchive implements MailArchive {
  readonly kind: 'pst' | 'ost';
  readonly root: Folder;
  readonly db: NodeDatabase;
  private readonly folderNids = new WeakMap<Folder, number>();
  private readonly defaultCodepage: number | undefined;

  constructor(src: ByteSource) {
    this.db = new NodeDatabase(src);
    this.kind = this.db.isOst ? 'ost' : 'pst';
    this.defaultCodepage = this.db.isAnsi ? 1252 : undefined;
    let storeName: string | undefined;
    try {
      const store = this.node(NID_MESSAGE_STORE);
      if (store) storeName = readPropertyContext(store, this.defaultCodepage).string(PR.DISPLAY_NAME);
    } catch {
      storeName = undefined;
    }
    if (!this.db.getNode(NID_ROOT_FOLDER)) {
      this.db.close();
      throw new Error('Root folder not found: the file is damaged or not a mail archive');
    }
    this.root = this.buildFolder(NID_ROOT_FOLDER, [], new Set(), storeName?.trim() || 'Root');
  }

  static open(path: string): PstArchive {
    return new PstArchive(new FileSource(path));
  }

  close(): void {
    this.db.close();
  }

  private node(nid: number): PstNode | undefined {
    const e = this.db.getNode(nid);
    return e ? new PstNode(this.db, e) : undefined;
  }

  private tableRowIds(tableNid: number): number[] | undefined {
    const n = this.node(tableNid);
    if (!n) return undefined;
    try {
      return readTableRowIds(n);
    } catch {
      return undefined;
    }
  }

  private childFolderNids(nid: number): number[] {
    const ids = this.tableRowIds(withNidType(nid, NID_TYPE.HIERARCHY_TABLE)) ?? this.db.childrenOf(nid);
    return ids.filter((id) => id !== nid && nidType(id) === NID_TYPE.NORMAL_FOLDER && this.db.getNode(id) !== undefined);
  }

  private messageNids(nid: number): number[] {
    const ids = this.tableRowIds(withNidType(nid, NID_TYPE.CONTENTS_TABLE)) ?? this.db.childrenOf(nid);
    return ids.filter((id) => nidType(id) === NID_TYPE.NORMAL_MESSAGE && this.db.getNode(id) !== undefined);
  }

  private buildFolder(nid: number, parentPath: string[], visited: Set<number>, fallbackName: string): Folder {
    visited.add(nid);
    let name = '';
    const n = this.node(nid);
    if (n) {
      try {
        name = readPropertyContext(n, this.defaultCodepage).string(PR.DISPLAY_NAME)?.trim() ?? '';
      } catch {
        name = '';
      }
    }
    if (!name) name = fallbackName;
    const path = [...parentPath, name];
    const folder: Folder = { name, path, messageCount: this.messageNids(nid).length, children: [] };
    this.folderNids.set(folder, nid);
    for (const child of this.childFolderNids(nid)) {
      if (visited.has(child)) continue;
      folder.children.push(this.buildFolder(child, path, visited, `Folder ${child.toString(16)}`));
    }
    return folder;
  }

  *messages(folder: Folder, onError?: (e: MessageError) => void): Generator<MessageEntry> {
    const nid = this.folderNids.get(folder);
    if (nid === undefined) throw new Error('Folder does not belong to this archive');
    let index = 0;
    for (const mid of this.messageNids(nid)) {
      index++;
      const node = this.node(mid);
      if (!node) continue;
      let entry: MessageEntry;
      try {
        entry = { folder, index, message: buildMessage(this.messageSource(node)) };
      } catch (err) {
        onError?.({ folder, index, error: err instanceof Error ? err : new Error(String(err)) });
        continue;
      }
      yield entry;
    }
  }

  private messageSource(node: PstNode): MapiMessageSource {
    const props = readPropertyContext(node, this.defaultCodepage);
    return {
      props,
      recipients: () => {
        const t = node.subnode(NID_RECIPIENT_TABLE);
        return t ? readTableContext(t, props.codepage) : [];
      },
      attachments: () => {
        let ids: number[] | undefined;
        const table = node.subnode(NID_ATTACHMENT_TABLE);
        if (table) {
          try {
            ids = readTableRowIds(table);
          } catch {
            ids = undefined;
          }
        }
        ids ??= node.subnodeIds().filter((id) => nidType(id) === NID_TYPE.ATTACHMENT);
        const out: MapiAttachmentSource[] = [];
        for (const id of ids) {
          const a = node.subnode(id);
          if (a) out.push(this.attachmentSource(a, props));
        }
        return out;
      },
    };
  }

  private attachmentSource(node: PstNode, parent: PropertyBag): MapiAttachmentSource {
    const props = readPropertyContext(node, parent.codepage);
    return {
      props,
      data: () => {
        const raw = props.raw(PR.ATTACH_DATA);
        return raw && raw.type === PT.BINARY ? raw.data : undefined;
      },
      embedded: () => {
        const raw = props.raw(PR.ATTACH_DATA);
        if (!raw || raw.type !== PT.OBJECT || raw.data.length < 4) return undefined;
        const sub = node.subnode(raw.data.readUInt32LE(0));
        return sub ? this.messageSource(sub) : undefined;
      },
    };
  }
}
