// B+ tree primitive used by |FILES, |CONTEXT, |TTLBTREE, |KWBTREE and
// similar internal files.

export interface BTreeHeader {
  magic: number;        // 0x293B
  flags: number;
  pageSize: number;     // 1024 or 2048
  structure: string;    // e.g. "Fz", "L4", "Lz", "z4"
  rootPage: number;
  totalPages: number;
  nLevels: number;
  totalEntries: number;
  bodyStart: number;    // file offset of the BTreeHeader (start of internal-file body)
}

export interface BTreeKeyDecoder {
  read(view: DataView, offset: number, end: number): { key: unknown; next: number };
  compare(a: unknown, b: unknown): number;
}

export interface BTreeValueDecoder {
  read(view: DataView, offset: number, end: number): { value: unknown; next: number };
  /** Fixed size in bytes of an interior-page child reference (always 2) */
  childRefSize: 2;
}

export function readBTreeHeader(buf: Uint8Array, bodyStart: number): BTreeHeader {
  const dv = new DataView(buf.buffer, buf.byteOffset + bodyStart, 38);
  const magic = dv.getUint16(0, true);
  if (magic !== 0x293B) throw new Error(`B+ tree magic mismatch: 0x${magic.toString(16)}`);
  const flags = dv.getUint16(2, true);
  const pageSize = dv.getUint16(4, true);
  let structure = '';
  for (let i = 0; i < 16; i++) {
    const c = dv.getUint8(6 + i);
    if (c === 0) break;
    structure += String.fromCharCode(c);
  }
  const rootPage = dv.getUint16(26, true);
  const totalPages = dv.getUint16(30, true);
  const nLevels = dv.getUint16(32, true);
  const totalEntries = dv.getUint32(34, true);
  return { magic, flags, pageSize, structure, rootPage, totalPages, nLevels, totalEntries, bodyStart };
}

function pageOffset(h: BTreeHeader, pageIndex: number): number {
  return h.bodyStart + 38 + pageIndex * h.pageSize;
}

// ----- Generic structure-string decoders ---------------------------------

export function makeKeyDecoder(structure: string): { key: BTreeKeyDecoder; valueStart: string } {
  const ch = structure[0];
  if (ch === 'F' || ch === 'z') {
    return {
      key: {
        read(view: DataView, offset: number, end: number) {
          let s = '';
          let i = offset;
          while (i < end) {
            const c = view.getUint8(i++);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return { key: s, next: i };
        },
        compare(a, b) {
          const sa = a as string, sb = b as string;
          return sa < sb ? -1 : sa > sb ? 1 : 0;
        },
      },
      valueStart: structure.slice(1),
    };
  }
  if (ch === 'L' || ch === 'i' || ch === '4') {
    return {
      key: {
        read(view: DataView, offset: number) {
          return { key: view.getUint32(offset, true) >>> 0, next: offset + 4 };
        },
        compare(a, b) {
          const na = a as number, nb = b as number;
          return na < nb ? -1 : na > nb ? 1 : 0;
        },
      },
      valueStart: structure.slice(1),
    };
  }
  if (ch === '2') {
    return {
      key: {
        read(view: DataView, offset: number) {
          return { key: view.getUint16(offset, true), next: offset + 2 };
        },
        compare(a, b) {
          const na = a as number, nb = b as number;
          return na < nb ? -1 : na > nb ? 1 : 0;
        },
      },
      valueStart: structure.slice(1),
    };
  }
  throw new Error(`Unsupported B+ tree key code: ${ch}`);
}

export function makeValueDecoder(spec: string): BTreeValueDecoder {
  // spec is the suffix after the key. Each character is a code:
  //   '2' = u16 (2 bytes),  '4'/'L'/'i' = u32 (4 bytes),  'z' = asciiZ string.
  // A digit-prefix BEFORE a LETTER is a repeat count, e.g. "3z" = three
  // strings. Bare digits are NOT counts — "24" means u16 + u32, not "two u32".
  return {
    childRefSize: 2,
    read(view: DataView, offset: number, end: number) {
      const out: unknown[] = [];
      let i = offset;
      let p = 0;
      while (p < spec.length && i < end) {
        const ch = spec[p];
        if (/[A-Za-z]/.test(ch)) {
          // letter code, no count prefix in this branch
          p += 1;
          readCode(ch);
        } else if (/\d/.test(ch)) {
          // either a digit-code (when next is non-letter) or a count prefix
          // followed by a letter.
          // If the next char is a letter, treat this digit as a repeat count.
          // Otherwise it's a digit-code itself.
          const next = spec[p + 1];
          if (next && /[A-Za-z]/.test(next)) {
            const count = parseInt(ch, 10);
            p += 2;
            for (let n = 0; n < count; n++) readCode(next);
          } else {
            p += 1;
            readCode(ch);
          }
        } else {
          p += 1; // skip unknown
        }
      }
      return { value: out.length === 1 ? out[0] : out, next: i };

      function readCode(code: string) {
        if (code === 'L' || code === '4' || code === 'i' || code === 'F') {
          out.push(view.getUint32(i, true) >>> 0);
          i += 4;
        } else if (code === '2') {
          out.push(view.getUint16(i, true));
          i += 2;
        } else if (code === 'z') {
          let str = '';
          while (i < end) {
            const c = view.getUint8(i++);
            if (c === 0) break;
            str += String.fromCharCode(c);
          }
          out.push(str);
        }
      }
    },
  };
}

// ----- Page iteration -----------------------------------------------------

interface IndexPageEntry { key: unknown; child: number; }
interface LeafPageEntry { key: unknown; value: unknown; }

interface IndexPage { kind: 'index'; nEntries: number; previousPage: number; entries: IndexPageEntry[]; }
interface LeafPage { kind: 'leaf'; nEntries: number; previousPage: number; nextPage: number; entries: LeafPageEntry[]; }

function readIndexPage(buf: Uint8Array, h: BTreeHeader, pageIdx: number, key: BTreeKeyDecoder): IndexPage {
  const off = pageOffset(h, pageIdx);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, h.pageSize);
  const nEntries = dv.getUint16(2, true);
  const previousPage = dv.getInt16(4, true);
  const entries: IndexPageEntry[] = [];
  let p = 6;
  for (let i = 0; i < nEntries; i++) {
    const r = key.read(dv, p, h.pageSize);
    const child = dv.getUint16(r.next, true);
    entries.push({ key: r.key, child });
    p = r.next + 2;
  }
  return { kind: 'index', nEntries, previousPage, entries };
}

function readLeafPage(buf: Uint8Array, h: BTreeHeader, pageIdx: number,
  key: BTreeKeyDecoder, val: BTreeValueDecoder): LeafPage {
  const off = pageOffset(h, pageIdx);
  const dv = new DataView(buf.buffer, buf.byteOffset + off, h.pageSize);
  const nEntries = dv.getUint16(2, true);
  const previousPage = dv.getInt16(4, true);
  const nextPage = dv.getInt16(6, true);
  const entries: LeafPageEntry[] = [];
  let p = 8;
  for (let i = 0; i < nEntries; i++) {
    const k = key.read(dv, p, h.pageSize);
    const v = val.read(dv, k.next, h.pageSize);
    entries.push({ key: k.key, value: v.value });
    p = v.next;
  }
  return { kind: 'leaf', nEntries, previousPage, nextPage, entries };
}

/** Find the first leaf page index for descent (used for full enumeration). */
function leftmostLeafPage(buf: Uint8Array, h: BTreeHeader, key: BTreeKeyDecoder): number {
  let p = h.rootPage;
  for (let level = 0; level < h.nLevels - 1; level++) {
    const page = readIndexPage(buf, h, p, key);
    p = page.previousPage;
  }
  return p;
}

/** Lookup a single key. Returns the value or undefined. */
export function btreeLookup(buf: Uint8Array, h: BTreeHeader, k: unknown,
  key: BTreeKeyDecoder, val: BTreeValueDecoder): unknown | undefined {
  let p = h.rootPage;
  for (let level = 0; level < h.nLevels - 1; level++) {
    const page = readIndexPage(buf, h, p, key);
    let next = page.previousPage;
    for (const e of page.entries) {
      if (key.compare(e.key, k) > 0) break;
      next = e.child;
    }
    p = next;
  }
  const leaf = readLeafPage(buf, h, p, key, val);
  for (const e of leaf.entries) {
    if (key.compare(e.key, k) === 0) return e.value;
  }
  return undefined;
}

/** Lookup all values for a duplicate-key tree. */
export function btreeLookupAll(buf: Uint8Array, h: BTreeHeader, k: unknown,
  key: BTreeKeyDecoder, val: BTreeValueDecoder): unknown[] {
  const out: unknown[] = [];
  let p = h.rootPage;
  for (let level = 0; level < h.nLevels - 1; level++) {
    const page = readIndexPage(buf, h, p, key);
    let next = page.previousPage;
    for (const e of page.entries) {
      if (key.compare(e.key, k) > 0) break;
      next = e.child;
    }
    p = next;
  }
  while (p >= 0) {
    const leaf = readLeafPage(buf, h, p, key, val);
    let stop = false;
    for (const e of leaf.entries) {
      const cmp = key.compare(e.key, k);
      if (cmp === 0) out.push(e.value);
      else if (cmp > 0) { stop = true; break; }
    }
    if (stop) break;
    p = leaf.nextPage;
    if (p === 0xFFFF || p === -1) break;
  }
  return out;
}

/** Walk all leaf entries in order. */
export function* btreeEntries(buf: Uint8Array, h: BTreeHeader,
  key: BTreeKeyDecoder, val: BTreeValueDecoder): Generator<{ key: unknown; value: unknown }> {
  if (h.totalEntries === 0) return;
  let p = h.nLevels === 1 ? h.rootPage : leftmostLeafPage(buf, h, key);
  let safety = 0;
  while (p >= 0 && safety++ < 1_000_000) {
    const leaf = readLeafPage(buf, h, p, key, val);
    for (const e of leaf.entries) yield e;
    p = leaf.nextPage;
    if (p === 0xFFFF || p === -1) break;
  }
}
