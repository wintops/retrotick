// |KWBTREE / |KWDATA / |KWMAP — keyword index lookup.
//
// |KWBTREE always uses asciiZ keyword-text keys, even when the BTree
// header declares an "i24" structure. The 'i' in that structure string
// means "indexed by string", not a signed integer; the value half ("24"
// = u16 count + u32 offset) is the same. We always parse the keys as
// strings here.
import { btreeEntries, btreeLookup, makeValueDecoder, readBTreeHeader, type BTreeKeyDecoder } from './btree';

export interface Keyword {
  keyword: string;
  count: number;
  offset: number;          // byte offset into |KWDATA
  topicOffsets: number[];  // resolved
}

const ASCIIZ_KEY: BTreeKeyDecoder = {
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
};

/** Read the posting list for a (count, offset) pair. */
export function readPostings(kwData: Uint8Array, count: number, offset: number): number[] {
  const out: number[] = [];
  const dv = new DataView(kwData.buffer, kwData.byteOffset, kwData.byteLength);
  for (let i = 0; i < count; i++) {
    const p = offset + i * 4;
    if (p + 4 > kwData.length) break;
    out.push(dv.getUint32(p, true));
  }
  return out;
}

/** Walk all keywords in the namespace and resolve their topic offsets. */
export function* allKeywords(kwBtree: Uint8Array, kwData: Uint8Array): Generator<Keyword> {
  const tree = readBTreeHeader(kwBtree, 0);
  const v = makeValueDecoder(valueSpec(tree.structure));
  for (const e of btreeEntries(kwBtree, tree, ASCIIZ_KEY, v)) {
    const arr = Array.isArray(e.value) ? e.value : [e.value];
    const count = arr[0] as number;
    const offset = arr[1] as number;
    yield {
      keyword: e.key as string,
      count, offset,
      topicOffsets: readPostings(kwData, count, offset),
    };
  }
}

export function lookupKeyword(kwBtree: Uint8Array, kwData: Uint8Array, keyword: string): Keyword | undefined {
  const tree = readBTreeHeader(kwBtree, 0);
  const v = makeValueDecoder(valueSpec(tree.structure));
  const got = btreeLookup(kwBtree, tree, keyword, ASCIIZ_KEY, v);
  if (got === undefined) return undefined;
  const arr = Array.isArray(got) ? got : [got];
  const count = arr[0] as number;
  const offset = arr[1] as number;
  return { keyword, count, offset, topicOffsets: readPostings(kwData, count, offset) };
}

/** Strip the structure string's first character (which is the key code,
 *  always treated as asciiZ for keyword btrees) to get just the value
 *  half — typically "24" (u16 + u32). */
function valueSpec(structure: string): string {
  return structure.length > 0 ? structure.slice(1) : '24';
}
