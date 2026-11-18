/** Format-independent model of mail folders and messages. */

export interface Address {
  name?: string;
  /** SMTP address when known. */
  email?: string;
}

export interface Attachment {
  filename: string;
  mimeType: string;
  /** Size reported by the archive (may be approximate). */
  size: number;
  contentId?: string;
  inline: boolean;
  /** Loads the attachment bytes (lazy, may read from disk). */
  getData(): Buffer;
  /** For attached Outlook items (attach method 5): the embedded message. */
  getEmbedded(): MailMessage | undefined;
}

export interface MailMessage {
  messageClass: string;
  subject: string;
  from?: Address;
  /** Actual sender when different from `from` (sent on behalf of). */
  sender?: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  date?: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  importance?: 'low' | 'normal' | 'high';
  bodyText?: string;
  bodyHtml?: string;
  /** Original internet headers when the archive kept them. */
  transportHeaders?: string;
  attachments: Attachment[];
}

export interface Folder {
  name: string;
  /** Names from the top-level folder down to this one. */
  path: string[];
  messageCount: number;
  children: Folder[];
}

export interface MessageEntry {
  folder: Folder;
  /** 1-based position inside the folder. */
  index: number;
  message: MailMessage;
}

export interface MessageError {
  folder: Folder;
  index: number;
  error: Error;
}

/** A read-only mail archive (PST, OST or a single MSG file). */
export interface MailArchive {
  readonly kind: 'pst' | 'ost' | 'msg';
  readonly root: Folder;
  /** Iterates messages of one folder (not recursive). Corrupt items are reported via onError. */
  messages(folder: Folder, onError?: (e: MessageError) => void): Generator<MessageEntry>;
  close(): void;
}
