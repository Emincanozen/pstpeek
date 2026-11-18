export type { Address, Attachment, Folder, MailArchive, MailMessage, MessageEntry, MessageError } from './model.js';
export { openArchive, findFolder, walkFolders, folderPathString, splitFolderPath } from './open.js';
export { PstArchive } from './pst/pst.js';
export { MsgArchive, parseMsg } from './msg/msg.js';
export { buildEml } from './export/mime.js';
export { toMboxEntry } from './export/mbox.js';
export { exportArchive, type ExportFormat, type ExportOptions, type ExportResult } from './export/exporter.js';
export { searchArchive, htmlToText, type SearchHit, type SearchOptions } from './search.js';
export { safeFileName } from './export/filenames.js';
