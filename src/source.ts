import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Random-access, read-only view over a file or an in-memory buffer. */
export interface ByteSource {
  readonly size: number;
  /** Reads exactly `length` bytes at `position`; throws on short reads. */
  read(position: number, length: number): Buffer;
  close(): void;
}

/**
 * Opens a file strictly read-only (flag 'r'). pstpeek never opens the source
 * archive with any write flag.
 */
export class FileSource implements ByteSource {
  readonly size: number;
  private fd: number | undefined;

  constructor(path: string) {
    this.fd = openSync(path, 'r');
    this.size = fstatSync(this.fd).size;
  }

  read(position: number, length: number): Buffer {
    if (this.fd === undefined) throw new Error('Source is closed');
    if (position < 0 || length < 0 || position + length > this.size) {
      throw new RangeError(`Read outside file bounds (offset ${position}, length ${length}, size ${this.size})`);
    }
    const buf = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, buf, done, length - done, position + done);
      if (n === 0) throw new RangeError(`Unexpected end of file at offset ${position + done}`);
      done += n;
    }
    return buf;
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
  }
}

export class BufferSource implements ByteSource {
  readonly size: number;
  constructor(private readonly data: Buffer) {
    this.size = data.length;
  }
  read(position: number, length: number): Buffer {
    if (position < 0 || length < 0 || position + length > this.size) {
      throw new RangeError(`Read outside buffer bounds (offset ${position}, length ${length}, size ${this.size})`);
    }
    // Copy so callers may decode in place without touching the source.
    return Buffer.from(this.data.subarray(position, position + length));
  }
  close(): void {}
}
