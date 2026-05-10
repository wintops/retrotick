// |KWBTREE / |KWDATA / |KWMAP — keyword index lookup.
import { btreeEntries, btreeLookup, makeKeyDecoder, makeValueDecoder, readBTreeHeader } from './btree';

export interface Keyword {
  keyword: string;
  count: number;
  offset: number;          // byte offset into |KWDATA
  topicOffsets: number[];  // resolved
}

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
  const k = makeKeyDecoder(tree.structure);
  const v = makeValueDecoder(k.valueStart);
  for (const e of btreeEntries(kwBtree, tree, k.key, v)) {
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
  const k = makeKeyDecoder(tree.structure);
  const v = makeValueDecoder(k.valueStart);
  const got = btreeLookup(kwBtree, tree, keyword, k.key, v);
  if (got === undefined) return undefined;
  const arr = Array.isArray(got) ? got : [got];
  const count = arr[0] as number;
  const offset = arr[1] as number;
  return { keyword, count, offset, topicOffsets: readPostings(kwData, count, offset) };
}
