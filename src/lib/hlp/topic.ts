// |TOPIC walker.
//
// File layout: each compressed file-block is `topicBlockSize` bytes.
//   - Pre-3.1 (HC30):                   topicBlockSize=2048, decompSize=2048
//   - HCW3.1 with SystemFlags & 8:      topicBlockSize=2048, decompSize=4096
//   - Otherwise (HCW3.1 or HCW4):       topicBlockSize=4096, decompSize=16384
// The first 12 bytes of every file-block are an uncompressed block header
// { LastTopicLink, FirstTopicLink, LastTopicHeader }. The remaining bytes
// are LZ77-compressed (when SYSFLAG_LZ77 is set in SystemFlags) and
// decompress to up to `decompSize` bytes per block.
//
// CRITICAL: each block is decompressed INDEPENDENTLY — the LZ77 sliding
// window does not cross block boundaries. Each compressed file-block is
// its own LZ77 stream.
//
// TopicPos addressing (NextBlock / PrevBlock / FirstTopicLink fields):
//   - block_number = (TopicPos - 12) / decompSize
//   - offset_in_payload = (TopicPos - 12) % decompSize  (offset into the
//     post-decompression buffer; the 12-byte header has been stripped)
// HC30 ("before31") differs: NextBlock is a *delta* in bytes including
// crossed headers; HCW3.1+ ("after31") NextBlock is an absolute TopicPos.
//
// TopicOffset addressing (TTLBTREE / CONTEXT keys, used by hyperlinks):
//   - block_number = TopicOffset / 0x8000     (FIXED stride, regardless of
//                                              decompSize)
//   - char_in_block = TopicOffset % 0x8000    (count of chars + hotspots
//                                              from FirstTopicLink in block)
import { lz77Decompress } from './lz77';
import type { PhraseTable } from './phrases';

export interface TopicBlockHeader {
  lastTopicLink: number;
  firstTopicLink: number;
  lastTopicHeader: number;
}

export interface TopicLinkRaw {
  vOffset: number;       // virtual offset where the link starts
  blockSize: number;
  dataLen2: number;
  prevBlock: number;
  nextBlock: number;
  dataLen1: number;
  recordType: number;
  linkData1: Uint8Array; // structure/formatting bytes, length = dataLen1 - 21
  linkData2: Uint8Array; // text bytes (possibly phrase-compressed), length = dataLen2
  /** "Topic character count" contributed by this link to the TOPICOFFSET
   *  walk. 0 for type-2; for type-32 it's the cuint TopicLength field at
   *  the start of LinkData1 (after TopicSize). */
  topicCharCount: number;
}

export interface TopicHeader {
  vOffset: number;          // virtual offset of the type-2 link
  blockSize: number;
  browseBack: number;
  browseForward: number;
  topicNumber: number;
  nonScroll: number;
  scroll: number;
  nextTopic: number;
  title: string;            // from LinkData2
}

const HDR_BYTES = 12;
/** TOPICOFFSET (TTLBTREE/CONTEXT keys) stride: fixed 0x8000 regardless of
 *  decompSize. */
const TOPICOFFSET_STRIDE = 0x8000;

/**
 * Decompress |TOPIC into per-block payload buffers (one per compressed
 * file-block, headers stripped). Provides TopicPos↔stream addressing.
 */
export class TopicReader {
  /** Each entry is one compressed file-block's decompressed payload (header
   *  stripped). Indexed by block number. */
  private readonly blockPayload: Uint8Array[] = [];
  /** Each entry is the raw 12-byte block header for block N. */
  private readonly blockHeader: TopicBlockHeader[] = [];
  /** Cumulative starting offset of block N's payload in the public `stream`
   *  (which is the concatenation of all payloads, no headers). */
  private readonly blockPayloadStart: number[] = [];
  /** Concatenation of all block payloads (no headers). Provided for callers
   *  that need a flat byte view; addressing uses TopicPos-to-pos translation. */
  readonly stream: Uint8Array;
  /** Number of compressed file-blocks. */
  readonly blockCount: number;
  /** Per-block decompressed payload length (excluding the 12-byte header). */
  readonly blockBodyLen: number[] = [];
  /** TopicBlockSize (compressed file-block size) and DecompressSize,
   *  derived from systemMinor and systemFlags. */
  readonly topicBlockSize: number;
  readonly decompSize: number;
  /** True for HC30 — `NextBlock` is a delta, not absolute. */
  private readonly before31: boolean;
  private headerCache = new Map<number, TopicHeader>();
  private linkCache = new Map<number, TopicLinkRaw>();

  constructor(
    rawTopic: Uint8Array,
    private readonly systemFlags: number,
    private readonly systemMinor: number,
    private readonly phraseTable: PhraseTable,
  ) {
    // Block-size rules: HC30 (minor < 16) uses TopicBlockSize=
    // DecompressSize=2048. HCW3.1 (minor 16..26) with Flags&8 uses
    // 2048/4096. Anything else (HCW3.1 without flag 8, or HCW4 minor>=27)
    // uses 4096/16384.
    this.before31 = systemMinor < 16;
    if (this.before31) {
      this.topicBlockSize = 2048; this.decompSize = 2048;
    } else if (systemMinor < 27 && (systemFlags & 0x08) !== 0) {
      this.topicBlockSize = 2048; this.decompSize = 4096;
    } else {
      this.topicBlockSize = 4096; this.decompSize = 16384;
    }
    const isCompressed = (systemFlags & 0x04) !== 0;
    let p = 0;
    while (p + HDR_BYTES <= rawTopic.length) {
      const blockEnd = Math.min(p + this.topicBlockSize, rawTopic.length);
      const dv = new DataView(rawTopic.buffer, rawTopic.byteOffset + p, HDR_BYTES);
      this.blockHeader.push({
        lastTopicLink: dv.getInt32(0, true),
        firstTopicLink: dv.getInt32(4, true),
        lastTopicHeader: dv.getInt32(8, true),
      });
      const compressed = rawTopic.subarray(p + HDR_BYTES, blockEnd);
      // Each block decompresses INDEPENDENTLY: a fresh LZ77 stream capped
      // at decompSize bytes. Back-references that would point before the
      // start of the current block are impossible — we let the decoder
      // bail (returning what it has).
      const payload = isCompressed
        ? lz77Decompress(compressed, this.decompSize)
        : compressed.slice(0, this.decompSize);
      this.blockPayload.push(payload);
      this.blockBodyLen.push(payload.length);
      p = blockEnd;
    }
    this.blockCount = this.blockPayload.length;
    // Build flat stream (concatenation of payloads, no headers).
    let total = 0;
    for (const b of this.blockPayload) total += b.length;
    const flat = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < this.blockCount; i++) {
      this.blockPayloadStart.push(off);
      flat.set(this.blockPayload[i], off);
      off += this.blockPayload[i].length;
    }
    this.stream = flat;
  }

  /** Find the block index that owns flat-stream position `pos`. */
  private blockOf(pos: number): number {
    for (let i = this.blockPayloadStart.length - 1; i >= 0; i--) {
      if (this.blockPayloadStart[i] <= pos) return i;
    }
    return 0;
  }

  /** Translate a TopicPos (NextBlock/PrevBlock/FirstTopicLink/LastTopicLink/
   *  LastTopicHeader) into a flat-stream byte position. */
  internalPtrToPos(topicPos: number): number {
    if (topicPos === -1 || topicPos === 0xFFFFFFFF) return this.stream.length;
    if (topicPos < HDR_BYTES) return this.stream.length;
    const adj = topicPos - HDR_BYTES;
    const block = Math.floor(adj / this.decompSize);
    const offset = adj - block * this.decompSize;
    if (block < 0 || block >= this.blockCount) return this.stream.length;
    if (offset >= this.blockPayload[block].length) return this.stream.length;
    return this.blockPayloadStart[block] + offset;
  }

  /** Inverse of internalPtrToPos: build a TopicPos from a flat-stream pos. */
  posToTopicPos(pos: number): number {
    const block = this.blockOf(pos);
    const offset = pos - this.blockPayloadStart[block];
    return block * this.decompSize + HDR_BYTES + offset;
  }

  /** Convert a TOPICOFFSET (block * 0x8000 + char) to the flat-stream byte
   *  position of the FIRST link in that block. The `char` field is a count
   *  of TopicLength contributions, so callers must walk from there to find
   *  the link covering the requested char count. */
  topicOffsetToInternal(topicOffset: number): number {
    const block = (topicOffset >>> 15) >>> 0;
    if (block >= this.blockCount) return this.stream.length;
    return this.blockFirstLinkPos(block);
  }

  /** Flat-stream position of the first new topic link in block N
   *  (after any spillover from block N-1). Read from FirstTopicLink in the
   *  block's 12-byte header; that field is a TopicPos. */
  private blockFirstLinkPos(block: number): number {
    if (block >= this.blockCount) return this.stream.length;
    return this.internalPtrToPos(this.blockHeader[block].firstTopicLink);
  }

  /** Translate `pos` back to the equivalent TOPICOFFSET, walking the block's
   *  chain and accumulating topicCharCount per link until we reach `pos`.
   *  HC30 stores TopicPos values directly as TOPICOFFSETs. */
  posToTopicOffset(pos: number): number {
    if (this.before31) return this.posToTopicPos(pos);
    const block = this.blockOf(pos);
    let v = this.blockFirstLinkPos(block);
    let charSoFar = 0;
    const seen = new Set<number>();
    let safety = 0;
    while (v < this.stream.length && safety++ < 100000) {
      if (seen.has(v)) break;
      seen.add(v);
      const link = this.readLink(v);
      if (!link) break;
      if (v === pos) return block * TOPICOFFSET_STRIDE + charSoFar;
      charSoFar += link.topicCharCount;
      if (link.nextBlock === 0xFFFFFFFF || link.nextBlock === -1) break;
      v = this.advanceTopicPos(v, link);
    }
    return block * TOPICOFFSET_STRIDE + charSoFar;
  }

  /** Compute the next link's flat-stream position from `link`'s NextBlock
   *  field. HC30 uses delta encoding (relative to current TopicPos);
   *  HCW3.1+ uses absolute TopicPos. */
  private advanceTopicPos(currentPos: number, link: TopicLinkRaw): number {
    if (this.before31) {
      const cur = this.posToTopicPos(currentPos);
      return this.internalPtrToPos(cur + link.nextBlock);
    }
    return this.internalPtrToPos(link.nextBlock);
  }

  /** Read `length` link-data bytes starting at flat-stream position `vOff`.
   *  Block payloads are concatenated without their 12-byte uncompressed
   *  headers (those are kept separately in `blockHeader`), so a TopicLink
   *  that spans a compressed file-block boundary is just contiguous bytes
   *  in this flat view. */
  readBytes(vOffset: number, length: number): Uint8Array {
    if (length <= 0 || vOffset < 0 || vOffset >= this.stream.length) return new Uint8Array(0);
    const end = Math.min(vOffset + length, this.stream.length);
    return this.stream.subarray(vOffset, end);
  }

  /** Decode the TopicLink at the given flat-stream position. TopicLinks
   *  may extend past the end of one block's payload into the next; the
   *  flat-stream layout makes that contiguous, so a single `subarray`
   *  reads them. */
  readLink(vOffset: number): TopicLinkRaw | null {
    if (vOffset < 0 || vOffset + 21 > this.stream.length) return null;
    const cached = this.linkCache.get(vOffset);
    if (cached) return cached;
    const dv = new DataView(this.stream.buffer, this.stream.byteOffset + vOffset, 21);
    const blockSize = dv.getInt32(0, true);
    const dataLen2 = dv.getInt32(4, true);
    const prevBlock = dv.getInt32(8, true);
    const nextBlock = dv.getInt32(12, true);
    const dataLen1 = dv.getInt32(16, true);
    const recordType = dv.getUint8(20);

    // dataLen1 = byte length of LinkData1 INCLUDING the 21-byte header.
    // On-disk linkData2 length = blockSize - dataLen1 (phrase-compressed bytes).
    // dataLen2 = DECOMPRESSED LinkData2 length (text).
    const onDiskLD2 = Math.max(0, blockSize - dataLen1);
    const linkData1Len = Math.max(0, dataLen1 - 21);
    const linkData1 = this.readBytes(vOffset + 21, linkData1Len);
    const linkData2Raw = this.readBytes(vOffset + dataLen1, onDiskLD2);
    const linkData2 = this.phraseTable.decode(linkData2Raw);

    // Compute the topicCharCount: type-2 (or type-1): 0; type-33: u16 at
    // LinkData1+5; other types: first cuint (TopicLength) found AFTER the
    // TopicSize clong.
    let topicCharCount = 0;
    if (recordType !== 2 && recordType !== 1 && recordType !== 33 && linkData1.length > 0) {
      // Skip TopicSize clong (1st byte determines form).
      const b0 = linkData1[0];
      const cuintOffset = (b0 & 1) ? 4 : 2;
      if (cuintOffset < linkData1.length) {
        const b1 = linkData1[cuintOffset];
        if (b1 & 1) {
          // 2-byte form
          if (cuintOffset + 1 < linkData1.length) {
            topicCharCount = (linkData1[cuintOffset] | (linkData1[cuintOffset + 1] << 8)) >> 1;
          }
        } else {
          // 1-byte form
          topicCharCount = b1 >> 1;
        }
      }
    } else if (recordType === 33 && linkData1.length >= 7) {
      topicCharCount = (linkData1[5] | (linkData1[6] << 8));
    }

    const link: TopicLinkRaw = {
      vOffset, blockSize, dataLen2, prevBlock, nextBlock, dataLen1, recordType, linkData1, linkData2, topicCharCount,
    };
    this.linkCache.set(vOffset, link);
    return link;
  }

  /** Walk all TopicLinks via the NextBlock chain — a single linked list
   *  across all blocks for HCW3.1+, terminated by 0xFFFFFFFF. */
  *links(): Generator<TopicLinkRaw> {
    if (this.stream.length === 0) return;
    let v = this.internalPtrToPos(HDR_BYTES); // TopicPos == 12 = first byte of block 0's payload
    // Some files actually point the first link via block 0's FirstTopicLink;
    // honour that if it differs from the default.
    if (this.blockCount > 0) v = this.blockFirstLinkPos(0);
    const seen = new Set<number>();
    let safety = 0;
    let prev: TopicLinkRaw | null = null;
    while (v < this.stream.length && safety++ < 1_000_000) {
      if (seen.has(v)) break;
      seen.add(v);
      const l = this.readLink(v);
      if (!l) break;
      if (l.blockSize === 0 || l.dataLen1 === 0 || l.dataLen1 > l.blockSize) break;
      yield l;
      if (l.nextBlock === -1 || (l.nextBlock >>> 0) === 0xFFFFFFFF) break;
      v = this.advanceTopicPos(v, l);
      prev = l;
    }
    void prev;
  }

  /** Decode all topic headers in the file. */
  topics(): TopicHeader[] {
    const out: TopicHeader[] = [];
    for (const link of this.links()) {
      if (link.recordType === 2) {
        out.push(this.parseHeader(link));
      }
    }
    return out;
  }

  /** Find a topic header given a TOPICOFFSET (as stored in TTLBTREE/CONTEXT).
   *  CONTEXT entries can point to anchors *inside* a topic (not just to the
   *  topic-start offset), so we resolve to the most recent type-2 link
   *  whose char range covers the target. */
  topicByOffset(topicOffset: number): TopicHeader | null {
    if (topicOffset === 0xFFFFFFFF) return null;
    // HC30: TOPICOFFSET keys in |TTLBTREE / |CTXOMAP / |CONTEXT are full
    // TopicPos values, not the (block * 0x8000 + charCount) encoding HCW3.1+
    // uses. Resolve directly to the link at that position by walking the
    // entire link chain (which spans blocks via delta-encoded NextBlock
    // pointers in HC30) and tracking the most recent type-2 we've seen
    // with vOffset <= the target's continuous position.
    if (this.before31) {
      const pos = this.internalPtrToPos(topicOffset);
      if (pos >= this.stream.length) return null;
      let lastTopic: TopicLinkRaw | null = null;
      let exact: TopicLinkRaw | null = null;
      for (const link of this.links()) {
        if (link.vOffset > pos) break;
        if (link.recordType === 2) lastTopic = link;
        if (link.vOffset === pos && link.recordType === 2) { exact = link; break; }
      }
      const found = exact ?? lastTopic;
      return found ? this.parseHeader(found) : null;
    }
    const targetBlock = (topicOffset >>> 15) >>> 0;
    const targetChar = topicOffset & 0x7FFF;
    const link = this.findContainingTopicLink(targetBlock, targetChar);
    if (!link) return null;
    return this.parseHeader(link);
  }

  /** Walk the link chain in `targetBlock` accumulating per-link char counts;
   *  return the most recent type-2 (TopicHeader) link encountered before the
   *  walk passes `targetChar`. This means CONTEXT keys that point into the
   *  middle of a topic resolve to that topic's header. */
  private findContainingTopicLink(targetBlock: number, targetChar: number): TopicLinkRaw | null {
    if (targetBlock >= this.blockCount) return null;
    let v = this.blockFirstLinkPos(targetBlock);
    let charSoFar = 0;
    const seen = new Set<number>();
    let lastTopic: TopicLinkRaw | null = null;
    let safety = 0;
    while (v < this.stream.length && safety++ < 100000) {
      if (seen.has(v)) return lastTopic;
      seen.add(v);
      const link = this.readLink(v);
      if (!link) return lastTopic;
      const linkBlock = this.blockOf(v);
      if (linkBlock !== targetBlock) return lastTopic;
      if (link.recordType === 2) lastTopic = link;
      const next = charSoFar + link.topicCharCount;
      if (targetChar < next) return lastTopic;
      charSoFar = next;
      if (link.nextBlock === -1 || (link.nextBlock >>> 0) === 0xFFFFFFFF) return lastTopic;
      v = this.advanceTopicPos(v, link);
    }
    return lastTopic;
  }

  /** Like topicByOffset but accepts a raw flat-stream position. */
  topicByInternalPos(internalPos: number): TopicHeader | null {
    if (internalPos < 0 || internalPos >= this.stream.length) return null;
    const cached = this.headerCache.get(internalPos);
    if (cached) return cached;
    const link = this.readLink(internalPos);
    if (!link || link.recordType !== 2) return null;
    return this.parseHeader(link);
  }

  /** Walk topic content starting just after the given header link, yielding
   *  subsequent display links until the next type-2 (or EOF). */
  *paragraphs(headerLink: TopicLinkRaw): Generator<TopicLinkRaw> {
    if (headerLink.nextBlock === -1 || (headerLink.nextBlock >>> 0) === 0xFFFFFFFF) return;
    let v = this.advanceTopicPos(headerLink.vOffset, headerLink);
    const seen = new Set<number>([headerLink.vOffset]);
    let safety = 0;
    let cur = headerLink;
    while (v < this.stream.length && safety++ < 100000) {
      if (seen.has(v)) return;
      seen.add(v);
      const l = this.readLink(v);
      if (!l) return;
      if (l.blockSize === 0 || l.dataLen1 === 0) return;
      if (l.recordType === 2) return; // next topic
      yield l;
      if (l.nextBlock === -1 || (l.nextBlock >>> 0) === 0xFFFFFFFF) return;
      v = this.advanceTopicPos(v, l);
      cur = l;
    }
    void cur;
  }

  private parseHeader(link: TopicLinkRaw): TopicHeader {
    // HC30 topic headers are smaller than HCW3.1+: only u32 BlockSize +
    // u32 PrevTopicNum + u32 NextTopicNum (12 bytes) + the topic title.
    // HCW3.1+ headers are 28 bytes: BlockSize, BrowseBack, BrowseForward,
    // TopicNumber, NonScroll, Scroll, NextTopic. Read whichever fields fit.
    const buf = link.linkData1;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const u32 = (off: number) => (off + 4 <= buf.length) ? dv.getUint32(off, true) : 0xFFFFFFFF;
    const blockSize = u32(0);
    const browseBack = u32(4);
    const browseForward = u32(8);
    const topicNumber = u32(12);
    const nonScroll = u32(16);
    const scroll = u32(20);
    const nextTopic = u32(24);
    let title = '';
    for (let i = 0; i < link.linkData2.length; i++) {
      const c = link.linkData2[i];
      if (c === 0) break;
      title += String.fromCharCode(c);
    }
    const h: TopicHeader = {
      vOffset: link.vOffset, blockSize, browseBack, browseForward,
      topicNumber, nonScroll, scroll, nextTopic, title,
    };
    this.headerCache.set(link.vOffset, h);
    return h;
  }
}
