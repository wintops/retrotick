// Compressed-int decoders used in TopicLink ParaInfo / format streams.

/** Bit-stream-style cursor over a Uint8Array, used by paragraph metadata
 *  parsing. Tracks the current byte position; readers advance it. */
export class Cursor {
  pos = 0;
  constructor(public readonly buf: Uint8Array) {}
  get eof() { return this.pos >= this.buf.length; }
  get remaining() { return this.buf.length - this.pos; }
  u8(): number { return this.buf[this.pos++]; }
  u16(): number {
    const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8) |
              (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0;
    this.pos += 4;
    return v;
  }
  /** Compressed unsigned word.
   *    bit 0 SET   → 2-byte form, value = ((b2 << 8) | b) >> 1
   *    bit 0 CLEAR → 1-byte form, value = b >> 1
   */
  cuint(): number {
    const b = this.buf[this.pos];
    if (b & 1) {
      const b2 = this.buf[this.pos + 1];
      this.pos += 2;
      return ((b2 << 8) | b) >>> 1;
    }
    this.pos += 1;
    return b >> 1;
  }
  /** Compressed signed int. Same byte layout as `cuint` but biased:
   *    bit 0 SET   → 2-byte form, value = (u16 >> 1) - 0x4000
   *    bit 0 CLEAR → 1-byte form, value = (b   >> 1) - 0x40
   *
   *  Reference (sub_4286C9) uses this for ParaInfo indents, spacings and
   *  tab-stop positions — they can be negative (hanging indent, etc.). */
  cint(): number {
    const b = this.buf[this.pos];
    if (b & 1) {
      const b2 = this.buf[this.pos + 1];
      this.pos += 2;
      return (((b2 << 8) | b) >> 1) - 0x4000;
    }
    this.pos += 1;
    return (b >> 1) - 0x40;
  }
  /** Compressed long, UNSIGNED form (used for picture sizes / hotspot payload
   *  sizes / picture dimensions).
   *    bit 0 SET   → 4-byte form, value = u32 >> 1
   *    bit 0 CLEAR → 2-byte form, value = u16 >> 1
   */
  clong(): number {
    const b1 = this.buf[this.pos];
    if (b1 & 1) {
      const v = ((this.buf[this.pos] | (this.buf[this.pos + 1] << 8) |
                  (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0);
      this.pos += 4;
      return v >>> 1;
    }
    const v = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8));
    this.pos += 2;
    return v >>> 1;
  }

  /** Compressed long, SIGNED with bias. Used for TopicLink TopicSize /
   *  TopicLength / indents in ParaInfo.
   *    bit 0 SET   → 4-byte form, value = (u32 >> 1) - 0x40000000
   *    bit 0 CLEAR → 2-byte form, value = (u16 >> 1) - 0x4000
   */
  clongBiased(): number {
    const b1 = this.buf[this.pos];
    if (b1 & 1) {
      const v = ((this.buf[this.pos] | (this.buf[this.pos + 1] << 8) |
                  (this.buf[this.pos + 2] << 16) | (this.buf[this.pos + 3] << 24)) >>> 0);
      this.pos += 4;
      return ((v >>> 1) - 0x40000000) | 0;
    }
    const v = (this.buf[this.pos] | (this.buf[this.pos + 1] << 8));
    this.pos += 2;
    return (v >> 1) - 0x4000;
  }
  asciiZ(): string {
    let s = '';
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  bytes(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}
