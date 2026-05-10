// |TOPIC walker.
//
// File layout: each block is `baseBlockBytes` (4096 for HCW3.1+, 2048 for
// HC30). The first 12 bytes are an uncompressed block header
// { LastTopicLink, FirstTopicLink, LastTopicHeader }. The remaining bytes
// are LZ77-compressed (when the SYSFLAG_LZ77 flag is set) and decompress
// to up to 16384 bytes per block.
//
// Topic offset addressing (TOPICOFFSET, used by TTLBTREE/CONTEXT):
//   - block_number  = topic_offset >> 15  (high 17 bits)
//   - char_in_block = topic_offset & 0x7FFF  (low 15 bits, max 32767)
//   - data position in the concatenated stream = block_number * blockStride
//     + char_in_block, where blockStride = 0x4000.
//
// Internal addressing (NextBlock, FirstTopicLink fields in link headers):
//   - block_number  = field >> 14
//   - char_in_block = field & 0x3FFF  (max 16383)
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
/** Stride between blocks in the concatenated decompressed stream. Each
 *  decompressed block can be at most 16384 bytes (14-bit char count), so
 *  internal NextBlock fields use this stride. We pad/concatenate at
 *  16384-byte boundaries so internal pointers resolve directly. */
const BLOCK_STRIDE = 0x4000;
/** TOPICOFFSET (TTLBTREE/CONTEXT keys) uses 0x8000 stride. We translate
 *  these into internal positions via offsetToInternal(). */
const TOPICOFFSET_STRIDE = 0x8000;

/**
 * Decompress the whole |TOPIC stream into a single concatenated buffer.
 * Returns the decompressed bytes plus the per-block header info we need to
 * locate TopicLink records.
 */
export class TopicReader {
  readonly stream: Uint8Array;
  /** Number of decompressed blocks in the stream. */
  readonly blockCount: number;
  /** Per-block decompressed body length (excluding block header bytes). */
  private readonly blockBodyLen: number[] = [];
  /** topic header parsed lazily, keyed by virtual offset of its link. */
  private headerCache = new Map<number, TopicHeader>();
  private linkCache = new Map<number, TopicLinkRaw>();

  constructor(
    rawTopic: Uint8Array,
    private readonly systemFlags: number,
    private readonly systemMinor: number,
    private readonly phraseTable: PhraseTable,
  ) {
    // Determine compressed file-block size. HCW 4 (>=27) uses 4096;
    // HC30/HCW31 uses 2048.
    const fileBlockBytes = systemMinor >= 27 ? 4096 : 2048;
    // Decompressed block size: up to 16384 bytes (max addressable by 14-bit
    // internal char count).
    const decompCap = 16384;
    const isCompressed = (systemFlags & 0x04) !== 0; // SYSFLAG_LZ77
    // Walk blocks: each is `fileBlockBytes` of file data, 12-byte header
    // followed by raw or LZ77-compressed body.
    const blocks: Uint8Array[] = [];
    let p = 0;
    while (p < rawTopic.length) {
      const blockEnd = Math.min(p + fileBlockBytes, rawTopic.length);
      if (p + HDR_BYTES > blockEnd) break;
      const decomp = new Uint8Array(BLOCK_STRIDE);
      // Copy block header (uncompressed) verbatim.
      for (let i = 0; i < HDR_BYTES; i++) decomp[i] = rawTopic[p + i];
      const body = rawTopic.subarray(p + HDR_BYTES, blockEnd);
      let bodyLen: number;
      if (isCompressed) {
        const decompBody = lz77Decompress(body, decompCap);
        bodyLen = decompBody.length;
        decomp.set(decompBody, HDR_BYTES);
      } else {
        bodyLen = body.length;
        decomp.set(body, HDR_BYTES);
      }
      blocks.push(decomp);
      this.blockBodyLen.push(HDR_BYTES + bodyLen);
      p = blockEnd;
    }
    this.blockCount = blocks.length;
    const total = new Uint8Array(blocks.length * BLOCK_STRIDE);
    for (let i = 0; i < blocks.length; i++) total.set(blocks[i], i * BLOCK_STRIDE);
    this.stream = total;
  }

  /** Convert a TOPICOFFSET (15-bit char count of the body) to an internal
   *  stream position. The +12 accounts for the per-block header that lives
   *  at the start of each decompressed block in our concatenated stream. */
  topicOffsetToInternal(topicOffset: number): number {
    const block = (topicOffset >>> 15) >>> 0;
    const char = topicOffset & 0x7FFF;
    return block * BLOCK_STRIDE + HDR_BYTES + char;
  }

  /** Convert an internal pointer (FirstTopicLink/NextBlock/PrevBlock — 14-bit
   *  char count, INCLUDING the 12-byte block header) to a stream position. */
  internalPtrToPos(ptr: number): number {
    const block = (ptr >>> 14) >>> 0;
    const char = ptr & 0x3FFF;
    return block * BLOCK_STRIDE + char;
  }

  /** Convert an internal stream position back to a TOPICOFFSET, walking
   *  forward from the start of the same block and accumulating
   *  topicCharCount per link. */
  posToTopicOffset(pos: number): number {
    const block = (pos / BLOCK_STRIDE) | 0;
    const blockStart = block * BLOCK_STRIDE;
    if (blockStart + HDR_BYTES > this.stream.length) return block * TOPICOFFSET_STRIDE;
    const dv = new DataView(this.stream.buffer, this.stream.byteOffset + blockStart, HDR_BYTES);
    const firstTopicLink = dv.getUint32(4, true);
    let v = this.internalPtrToPos(firstTopicLink);
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
      if (link.nextBlock === 0xFFFFFFFF) break;
      v = this.internalPtrToPos(link.nextBlock);
    }
    return block * TOPICOFFSET_STRIDE + charSoFar;
  }

  /** Read raw bytes from the decompressed stream, possibly spanning blocks. */
  readBytes(vOffset: number, length: number): Uint8Array {
    if (vOffset < 0 || vOffset + length > this.stream.length) {
      // Allow truncated reads — just return what we have.
      const safeLen = Math.max(0, Math.min(length, this.stream.length - vOffset));
      return this.stream.subarray(vOffset, vOffset + safeLen);
    }
    return this.stream.subarray(vOffset, vOffset + length);
  }

  /** Decode the TopicLink at the given internal stream position (NOT a
   *  TOPICOFFSET — call topicOffsetToInternal() first if you have one). */
  readLink(vOffset: number): TopicLinkRaw | null {
    if (vOffset === 0xFFFFFFFF || vOffset < 0) return null;
    const cached = this.linkCache.get(vOffset);
    if (cached) return cached;
    if (vOffset + 21 > this.stream.length) return null;
    const dv = new DataView(this.stream.buffer, this.stream.byteOffset + vOffset, Math.min(21, this.stream.length - vOffset));
    const blockSize = dv.getUint32(0, true);
    const dataLen2 = dv.getUint32(4, true);
    const prevBlock = dv.getUint32(8, true);
    const nextBlock = dv.getUint32(12, true);
    const dataLen1 = dv.getUint32(16, true);
    const recordType = dv.getUint8(20);

    // dataLen1 = byte length of LinkData1 INCLUDING the 21-byte header.
    // On-disk linkData2 length = blockSize - dataLen1 (compressed bytes).
    // dataLen2 = DECOMPRESSED LinkData2 length (text).
    const linkData1End = vOffset + dataLen1;
    const onDiskLD2 = Math.max(0, blockSize - dataLen1);
    const linkData2RawEnd = vOffset + dataLen1 + onDiskLD2;
    const linkData1 = this.stream.subarray(vOffset + 21, Math.min(linkData1End, this.stream.length));
    const linkData2Raw = this.stream.subarray(linkData1End, Math.min(linkData2RawEnd, this.stream.length));
    // Decompress phrase compression on LinkData2.
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

  /** Walk all TopicLinks via the linked list of NextBlock pointers. The
   *  first link is located via the FirstTopicLink field of block 0's header. */
  *links(): Generator<TopicLinkRaw> {
    if (this.stream.length < HDR_BYTES) return;
    const dv = new DataView(this.stream.buffer, this.stream.byteOffset, HDR_BYTES);
    const firstTopicLink = dv.getUint32(4, true);
    let v = this.internalPtrToPos(firstTopicLink);
    const seen = new Set<number>();
    let safety = 0;
    while (v < this.stream.length && safety++ < 1_000_000) {
      if (seen.has(v)) break;
      seen.add(v);
      const l = this.readLink(v);
      if (!l) break;
      if (l.blockSize === 0 || l.dataLen1 === 0) break;
      yield l;
      if (l.nextBlock === 0xFFFFFFFF) break;
      v = this.internalPtrToPos(l.nextBlock);
    }
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
   *  Walks the link chain accumulating per-link character counts until we
   *  reach the requested offset. */
  topicByOffset(topicOffset: number): TopicHeader | null {
    if (topicOffset === 0xFFFFFFFF) return null;
    const targetBlock = (topicOffset >>> 15) >>> 0;
    const targetChar = topicOffset & 0x7FFF;
    const link = this.findLinkAtTopicOffset(targetBlock, targetChar);
    if (!link || link.recordType !== 2) return null;
    return this.parseHeader(link);
  }

  /** Walk the link chain in the requested block accumulating char counts.
   *  Returns the link whose char-range contains the target. */
  private findLinkAtTopicOffset(targetBlock: number, targetChar: number): TopicLinkRaw | null {
    if (targetBlock >= this.blockCount) return null;
    // Read FirstTopicLink from the block's header.
    const blockStart = targetBlock * BLOCK_STRIDE;
    if (blockStart + HDR_BYTES > this.stream.length) return null;
    const dv = new DataView(this.stream.buffer, this.stream.byteOffset + blockStart, HDR_BYTES);
    const firstTopicLink = dv.getUint32(4, true);
    let v = this.internalPtrToPos(firstTopicLink);
    let charSoFar = 0;
    const seen = new Set<number>();
    let last: TopicLinkRaw | null = null;
    let safety = 0;
    while (v < this.stream.length && safety++ < 100000) {
      if (seen.has(v)) break;
      seen.add(v);
      const link = this.readLink(v);
      if (!link) return last;
      // Did we walk past our block?
      const linkBlock = (v / BLOCK_STRIDE) | 0;
      if (linkBlock !== targetBlock) return last;
      const next = charSoFar + link.topicCharCount;
      if (targetChar < next) return link;
      // Special case: if targetChar == charSoFar and this is a topic header,
      // it's the topic at this offset.
      if (targetChar === charSoFar && link.recordType === 2) return link;
      charSoFar = next;
      last = link;
      if (link.nextBlock === 0xFFFFFFFF) return last;
      v = this.internalPtrToPos(link.nextBlock);
    }
    return last;
  }

  /** Like topicByOffset but accepts a raw internal stream position. */
  topicByInternalPos(internalPos: number): TopicHeader | null {
    if (internalPos === 0xFFFFFFFF) return null;
    const cached = this.headerCache.get(internalPos);
    if (cached) return cached;
    const link = this.readLink(internalPos);
    if (!link || link.recordType !== 2) return null;
    return this.parseHeader(link);
  }

  /** Walk topic content starting just after the given header link, yielding
   *  subsequent display links until the next type-2 (or EOF). Uses the
   *  NextBlock pointer chain. */
  *paragraphs(headerLink: TopicLinkRaw): Generator<TopicLinkRaw> {
    if (headerLink.nextBlock === 0xFFFFFFFF) return;
    let v = this.internalPtrToPos(headerLink.nextBlock);
    const seen = new Set<number>([headerLink.vOffset]);
    let safety = 0;
    while (v < this.stream.length && safety++ < 100000) {
      if (seen.has(v)) return;
      seen.add(v);
      const l = this.readLink(v);
      if (!l) return;
      if (l.blockSize === 0 || l.dataLen1 === 0) return;
      if (l.recordType === 2) return; // next topic
      yield l;
      if (l.nextBlock === 0xFFFFFFFF) return;
      v = this.internalPtrToPos(l.nextBlock);
    }
  }

  private parseHeader(link: TopicLinkRaw): TopicHeader {
    const dv = new DataView(link.linkData1.buffer, link.linkData1.byteOffset, link.linkData1.byteLength);
    const blockSize = dv.getUint32(0, true);
    const browseBack = dv.getUint32(4, true);
    const browseForward = dv.getUint32(8, true);
    const topicNumber = dv.getUint32(12, true);
    const nonScroll = dv.getUint32(16, true);
    const scroll = dv.getUint32(20, true);
    const nextTopic = dv.getUint32(24, true);
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
