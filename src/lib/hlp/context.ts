// |CONTEXT, |TTLBTREE, |CTXOMAP, |TOMAP lookups.
import { btreeEntries, btreeLookup, btreeLookupAll, makeKeyDecoder, makeValueDecoder, readBTreeHeader } from './btree';

/** Lookup up to all matching topic offsets for the given context hash. */
export function lookupContext(contextBody: Uint8Array, hash: number): number[] {
  const tree = readBTreeHeader(contextBody, 0);
  const k = makeKeyDecoder(tree.structure);
  const v = makeValueDecoder(k.valueStart);
  if (tree.flags & 0x0400) {
    const all = btreeLookupAll(contextBody, tree, hash >>> 0, k.key, v) as unknown[];
    return all.map(x => Array.isArray(x) ? (x[0] as number) : (x as number));
  }
  const got = btreeLookup(contextBody, tree, hash >>> 0, k.key, v);
  if (got === undefined) return [];
  return [Array.isArray(got) ? (got[0] as number) : (got as number)];
}

/** Lookup the title for a given topic offset via |TTLBTREE. */
export function lookupTitle(ttlBody: Uint8Array, vOffset: number): string | undefined {
  const tree = readBTreeHeader(ttlBody, 0);
  const k = makeKeyDecoder(tree.structure);
  const v = makeValueDecoder(k.valueStart);
  const got = btreeLookup(ttlBody, tree, vOffset >>> 0, k.key, v);
  if (got === undefined) return undefined;
  if (Array.isArray(got)) return got[0] as string;
  return got as string;
}

/** Walk all (offset, title) entries in |TTLBTREE. */
export function* allTitles(ttlBody: Uint8Array): Generator<{ vOffset: number; title: string }> {
  const tree = readBTreeHeader(ttlBody, 0);
  const k = makeKeyDecoder(tree.structure);
  const v = makeValueDecoder(k.valueStart);
  for (const e of btreeEntries(ttlBody, tree, k.key, v)) {
    const title = Array.isArray(e.value) ? e.value[0] as string : e.value as string;
    yield { vOffset: e.key as number, title };
  }
}

/** Lookup numeric context (HELP_CONTEXT) → topic offset via |CTXOMAP.
 *  HCW3.1+ layout: u32 numEntries + entries of (u32 ctxNum + u32 topicOffset).
 *  HC30 layout:   u16 numEntries + entries of (u16 ctxNum + u16 padding + u32
 *                 topicOffset).
 *  We detect HC30 by trial: if the u32-prefix layout overshoots the body
 *  size, fall back to the u16-prefix HC30 form. */
export function lookupCtxomap(ctxBody: Uint8Array, contextNumber: number): number | undefined {
  if (ctxBody.length < 4) return undefined;
  const dv = new DataView(ctxBody.buffer, ctxBody.byteOffset, ctxBody.byteLength);
  // Try HCW3.1+ form first.
  {
    const n = dv.getUint32(0, true);
    if (4 + n * 8 <= ctxBody.length) {
      for (let i = 0; i < n; i++) {
        const off = 4 + i * 8;
        if (dv.getUint32(off, true) === (contextNumber >>> 0)) {
          return dv.getUint32(off + 4, true);
        }
      }
      return undefined;
    }
  }
  // Fall back to HC30 form.
  const n = dv.getUint16(0, true);
  for (let i = 0; i < n; i++) {
    const off = 2 + i * 8;
    if (off + 8 > ctxBody.length) break;
    if (dv.getUint16(off, true) === (contextNumber & 0xFFFF)) {
      return dv.getUint32(off + 4, true);
    }
  }
  return undefined;
}

/** Numeric topic-number → topic offset via |TOMAP. The body is a flat
 *  array of u32 topic offsets indexed by topic number. */
export function lookupTomap(tomapBody: Uint8Array, topicNumber: number): number | undefined {
  if (topicNumber < 0) return undefined;
  const byteOff = topicNumber * 4;
  if (byteOff + 4 > tomapBody.length) return undefined;
  const dv = new DataView(tomapBody.buffer, tomapBody.byteOffset, tomapBody.byteLength);
  const v = dv.getUint32(byteOff, true);
  return v === 0 ? undefined : v;
}
