// HLP container layer. Reads the file header and walks the |FILES B+ tree
// to locate each named internal file.

import { btreeEntries, makeKeyDecoder, makeValueDecoder, readBTreeHeader } from './btree';

export const HLP_MAGIC = 0x00035F3F;

export interface FileHeader {
  reservedSpace: number;
  usedSpace: number;
  fileFlags: number;
  bodyOffset: number;   // file offset of the body (after the 9-byte FileHeader)
}

export interface InternalFile {
  name: string;
  fileHeader: FileHeader;
  /** Raw body bytes (length = usedSpace). Materialized lazily. */
  body(): Uint8Array;
}

export class HlpContainer {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  private readonly files = new Map<string, FileHeader>();

  constructor(buf: ArrayBuffer | Uint8Array) {
    this.bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    if (this.view.getUint32(0, true) !== HLP_MAGIC) {
      throw new Error('Not an HLP file: magic mismatch');
    }
    const directoryStart = this.view.getUint32(4, true);
    const entireFileSize = this.view.getUint32(12, true);
    if (directoryStart >= this.bytes.length) {
      throw new Error(`Directory offset 0x${directoryStart.toString(16)} past EOF`);
    }
    void entireFileSize;
    this.indexFiles(directoryStart);
  }

  private indexFiles(directoryStart: number): void {
    const dirHeader = this.readFileHeader(directoryStart);
    const tree = readBTreeHeader(this.bytes, dirHeader.bodyOffset);
    const { key, valueStart } = makeKeyDecoder(tree.structure || 'Fz'); // |FILES uses "Fz"
    void key;
    // |FILES uses "Fz": z=string key, F=4-byte file offset value (treated as "4")
    // Some HCW versions use "Fz" or "z4" here. Use whatever the structure says.
    const keyDec = makeKeyDecoder(tree.structure);
    const valDec = makeValueDecoder(valueStart || '4');
    for (const e of btreeEntries(this.bytes, tree, keyDec.key, valDec)) {
      const fileOff = (Array.isArray(e.value) ? e.value[0] : e.value) as number;
      const header = this.readFileHeader(fileOff);
      this.files.set(e.key as string, header);
    }
  }

  readFileHeader(offset: number): FileHeader {
    const reservedSpace = this.view.getUint32(offset, true);
    const usedSpace = this.view.getUint32(offset + 4, true);
    const fileFlags = this.view.getUint8(offset + 8);
    return { reservedSpace, usedSpace, fileFlags, bodyOffset: offset + 9 };
  }

  has(name: string): boolean { return this.files.has(name); }

  fileNames(): string[] { return [...this.files.keys()]; }

  /** Returns the raw body bytes of the named internal file, or undefined. */
  read(name: string): Uint8Array | undefined {
    const h = this.files.get(name);
    if (!h) return undefined;
    return this.bytes.subarray(h.bodyOffset, h.bodyOffset + h.usedSpace);
  }

  fileHeader(name: string): FileHeader | undefined {
    return this.files.get(name);
  }
}
