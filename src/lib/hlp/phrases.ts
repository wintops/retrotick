// Phrase compression (|Phrases / |PhrIndex+|PhrImage).
// Two variants:
//   "old" |Phrases (HC30: 4-byte hdr / HCW31: 8-byte hdr + LZ77 body)
//   "new" Hall: |PhrIndex + |PhrImage (bitstream offsets, optional LZ77)
import { lz77Decompress } from './lz77';

export interface PhraseTable {
  /** Decompress phrase-encoded text (e.g. TopicLink LinkData2). */
  decode(input: Uint8Array): Uint8Array;
}

class NullPhraseTable implements PhraseTable {
  decode(input: Uint8Array): Uint8Array { return input; }
}

class OldPhraseTable implements PhraseTable {
  constructor(private blob: Uint8Array, private offsets: Uint16Array) {}
  decode(input: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 0;
    while (i < input.length) {
      const b = input[i++];
      if (b >= 1 && b <= 0x0F && i < input.length) {
        const c = input[i++];
        const idx = ((b - 1) * 256 + c) >> 1;
        const trailingSpace = c & 1;
        if (idx < this.offsets.length - 1) {
          const start = this.offsets[idx];
          const end = this.offsets[idx + 1];
          for (let p = start; p < end; p++) out.push(this.blob[p]);
          if (trailingSpace) out.push(0x20);
        }
      } else {
        out.push(b);
      }
    }
    return new Uint8Array(out);
  }
}

class HallPhraseTable implements PhraseTable {
  constructor(private blob: Uint8Array, private offsets: Uint32Array) {}
  /** Hall phrase ref decoding:
   *    even byte (LSB=0):       phrase[byte/2]
   *    LSB 2 bits = 01:         2-byte ref, phrase[((byte/2)*64) + 64 + next]
   *    LSB 3 bits = 011:        copy next (byte/8 + 1) bytes literally
   *    LSB 4 bits = 0111:       emit (byte/16 + 1) spaces
   *    LSB 4 bits = 1111:       emit (byte/16 + 1) NULs
   */
  decode(input: Uint8Array): Uint8Array {
    const out: number[] = [];
    let i = 0;
    const emit = (idx: number) => {
      if (idx < 0 || idx >= this.offsets.length - 1) return;
      const start = this.offsets[idx];
      const end = this.offsets[idx + 1];
      for (let p = start; p < end; p++) out.push(this.blob[p]);
    };
    while (i < input.length) {
      const b = input[i++];
      if ((b & 1) === 0) {
        emit(b >> 1);
      } else if ((b & 0x03) === 0x01) {
        // 2-byte phrase ref: phrase[byte * 64 + 64 + next]
        if (i >= input.length) break;
        const c = input[i++];
        emit(b * 64 + 64 + c);
      } else if ((b & 0x07) === 0x03) {
        const n = (b >> 3) + 1;
        for (let k = 0; k < n && i < input.length; k++) out.push(input[i++]);
      } else if ((b & 0x0F) === 0x07) {
        const n = (b >> 4) + 1;
        for (let k = 0; k < n; k++) out.push(0x20);
      } else if ((b & 0x0F) === 0x0F) {
        const n = (b >> 4) + 1;
        for (let k = 0; k < n; k++) out.push(0x00);
      } else {
        // unknown control — emit literally
        out.push(b);
      }
    }
    return new Uint8Array(out);
  }
}

export function makePhraseTable(
  systemMinor: number,
  systemFlags: number,
  phrases: Uint8Array | undefined,
  phrIndex: Uint8Array | undefined,
  phrImage: Uint8Array | undefined,
): PhraseTable {
  // The spec says bits 0x08 / 0x10 explicitly mark phrase / Hall, but real
  // HCW4 files often leave the flag clear and rely on the presence of the
  // streams. So: if PhrIndex+PhrImage exist, use Hall; else if Phrases
  // exists, use the old layout.
  if (phrIndex && phrImage) {
    try { return parseHall(phrIndex, phrImage); }
    catch (e) { console.warn('[hlp] Hall phrase parse failed:', e); }
  }
  if (phrases) {
    try { return parseOld(phrases, systemMinor); }
    catch (e) { console.warn('[hlp] old phrase parse failed:', e); }
  }
  // Suppress reference: callers may not need flags.
  void systemFlags;
  return new NullPhraseTable();
}

function parseOld(buf: Uint8Array, minor: number): PhraseTable {
  // Phrases layout (HCW3.0/3.1):
  //   u16 NumPhrases
  //   u16 OneHundred           (0x0064 in HC30, 0x0100 in HCW31)
  //   [u32 PhrasesSize]        only present when minor != 15 (HCW31)
  //   u16 Offsets[NumPhrases+1] — positions in the *uncompressed* image
  //                              that contains [offsets-table | phrase strings].
  //                              So offsets[0] = (NumPhrases+1)*2 (right after
  //                              the offsets table) and the actual position of
  //                              phrase i within the phrase-strings blob is
  //                              offsets[i] - (NumPhrases+1)*2.
  //   phrase-strings blob       LZ77-compressed when SYSFLAG_LZ77 is set
  //                              (which is the typical HCW31 case).
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numPhrases = dv.getUint16(0, true);
  const headerBytes = minor === 15 ? 4 : 8;
  // PhrasesSize (decompressed size of the phrase-strings blob, NOT including
  // the offsets table).
  const decompSize = minor === 15 ? 0 : dv.getUint32(4, true);
  const offsets = new Uint16Array(numPhrases + 1);
  for (let i = 0; i <= numPhrases; i++) offsets[i] = dv.getUint16(headerBytes + i * 2, true);
  const blobOffset = headerBytes + (numPhrases + 1) * 2;
  const bias = (numPhrases + 1) * 2;
  let blob: Uint8Array;
  if (minor === 15) {
    blob = buf.subarray(blobOffset);
  } else {
    blob = lz77Decompress(buf.subarray(blobOffset), decompSize);
  }
  // Bias the stored offsets to point into the phrase-strings blob.
  for (let i = 0; i <= numPhrases; i++) {
    const v = offsets[i] - bias;
    offsets[i] = v < 0 ? 0 : v > blob.length ? blob.length : v;
  }
  return new OldPhraseTable(blob, offsets);
}

function parseHall(phrIndex: Uint8Array, phrImage: Uint8Array): PhraseTable {
  // PhrIndex header layout:
  //  +0  u16 magic (1)
  //  +2  u16 skip
  //  +4  u32 NumEntries
  //  +8  u32 PhrIndexCompSize
  //  +12 u32 PhrImageSize
  //  +16 u32 PhrImageCompSize
  //  +20 u32 skip
  //  +24 u8  BitCount (low 4 bits)
  //  +25 u8  skip
  //  +26 u16 PhrasesOffset (we don't use)
  //  +28 bitstream of NumEntries deltas
  if (phrIndex.length < 28) throw new Error('|PhrIndex truncated');
  const dv = new DataView(phrIndex.buffer, phrIndex.byteOffset, phrIndex.byteLength);
  const magic = dv.getUint16(0, true);
  void magic;
  const entriesCount = dv.getUint32(4, true);
  const phrImageSize = dv.getUint32(12, true);
  const phrImageCompSize = dv.getUint32(16, true);
  const bitcount = phrIndex[24] & 0x0F || 4;

  // Bit reader: reads little-endian 32-bit words starting at offset 28
  // with a bitmask that doubles each call. Bit 0 of each long is read
  // first.
  let wordIdx = 28;
  let bitMask = 0;
  let curWord = 0;
  const readLongLE = (off: number): number => {
    if (off + 3 < phrIndex.length) {
      return ((phrIndex[off]) | (phrIndex[off + 1] << 8) |
              (phrIndex[off + 2] << 16) | (phrIndex[off + 3] << 24)) >>> 0;
    }
    let v = 0;
    for (let i = 0; i < 4 && off + i < phrIndex.length; i++) v |= phrIndex[off + i] << (i * 8);
    return v >>> 0;
  };
  curWord = readLongLE(wordIdx);
  const getBit = (): number => {
    // If mask is negative (sign bit set), advance ptr by one long.
    // mask = mask*2 + (mask <= 0); — if mask was 0 or negative, the +1 sets
    // bit 0; if mask was positive, just shift left.
    if ((bitMask & 0x80000000) !== 0) {
      wordIdx += 4;
      curWord = readLongLE(wordIdx);
    }
    bitMask = ((bitMask << 1) | (bitMask <= 0 ? 1 : 0)) >>> 0;
    // Convert to signed for the next iteration's <=0 test
    if (bitMask & 0x80000000) bitMask = bitMask | 0;
    return (curWord & bitMask) !== 0 ? 1 : 0;
  };

  const offsets = new Uint32Array(entriesCount + 1);
  let prev = 0;
  offsets[0] = 0;
  for (let i = 0; i < entriesCount; i++) {
    let n = 1;
    while (getBit()) n += (1 << bitcount);
    if (getBit()) n += 1;
    if (bitcount > 1 && getBit()) n += 2;
    if (bitcount > 2 && getBit()) n += 4;
    if (bitcount > 3 && getBit()) n += 8;
    if (bitcount > 4 && getBit()) n += 16;
    prev += n;
    offsets[i + 1] = prev;
  }

  let blob: Uint8Array;
  if (phrImageCompSize < phrImageSize) {
    blob = lz77Decompress(phrImage.subarray(0, phrImageCompSize), phrImageSize);
  } else {
    blob = phrImage.subarray(0, phrImageSize);
  }
  return new HallPhraseTable(blob, offsets);
}
