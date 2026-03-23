// ANSI code page encoding name for TextDecoder
let _ansiEncoding = 'windows-1252';
let _ansiDecoder: TextDecoder | null = null;

/** Set the ANSI code page directly from a Windows codepage number (e.g. 936, 1252) */
export function setAnsiCodePageFromCP(codePage: number): void {
  const encoding = CP_TO_ENCODING[codePage];
  if (encoding && encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null;
  }
}

// Windows codepage number → TextDecoder encoding name
const CP_TO_ENCODING: Record<number, string> = {
  936: 'gbk', 950: 'big5', 932: 'shift-jis', 949: 'euc-kr',
  1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252',
  1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255',
  1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  874: 'windows-874', 1361: 'euc-kr',
};

/** Set the ANSI encoding directly by TextDecoder name */
export function setAnsiEncoding(encoding: string): void {
  if (encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null;
  }
}

/**
 * Guess MBCS encoding from raw bytes by looking at lead/trail byte patterns.
 * Returns a TextDecoder encoding name, or null if no CJK encoding detected.
 */
export function guessEncodingFromBytes(data: Uint8Array): string | null {
  let sjisScore = 0;
  let gbkScore = 0;
  for (let i = 0; i < data.length - 1; i++) {
    const b = data[i];
    if (b < 0x80) continue;
    const b2 = data[i + 1];
    // Shift-JIS lead byte ranges: 0x81-0x9F, 0xE0-0xEF
    // trail byte: 0x40-0x7E, 0x80-0xFC
    if ((b >= 0x81 && b <= 0x9F) || (b >= 0xE0 && b <= 0xEF)) {
      if ((b2 >= 0x40 && b2 <= 0x7E) || (b2 >= 0x80 && b2 <= 0xFC)) {
        sjisScore++;
        i++; // skip trail byte
        continue;
      }
    }
    // GBK lead byte: 0x81-0xFE, trail: 0x40-0xFE
    if (b >= 0x81 && b <= 0xFE && b2 >= 0x40 && b2 <= 0xFE) {
      gbkScore++;
      i++;
      continue;
    }
  }
  // Shift-JIS is more restrictive, so if sjisScore > 0 and accounts for most hits, pick it
  if (sjisScore > 0 && sjisScore >= gbkScore) return 'shift-jis';
  if (gbkScore > 0) return 'gbk';
  return null;
}

/** Set the ANSI code page based on PE resource language ID */
export function setAnsiCodePage(languageId: number): void {
  const primary = languageId & 0x3FF;
  const encoding = LANG_TO_ENCODING[primary] || 'windows-1252';
  if (encoding !== _ansiEncoding) {
    _ansiEncoding = encoding;
    _ansiDecoder = null; // reset cached decoder
  }
}

// Primary language ID → TextDecoder encoding name
const LANG_TO_ENCODING: Record<number, string> = {
  0x04: /* Chinese */   'gbk',
  0x11: /* Japanese */  'shift-jis',
  0x12: /* Korean */    'euc-kr',
  0x19: /* Russian */   'windows-1251',
  0x22: /* Ukrainian */ 'windows-1251',
  0x15: /* Polish */    'windows-1250',
  0x0E: /* Hungarian */ 'windows-1250',
  0x05: /* Czech */     'windows-1250',
  0x1F: /* Turkish */   'windows-1254',
  0x08: /* Greek */     'windows-1253',
  0x0D: /* Hebrew */    'windows-1255',
  0x01: /* Arabic */    'windows-1256',
  0x1E: /* Thai */      'windows-874',
  0x2A: /* Vietnamese */'windows-1258',
};

// Reverse lookup table: Unicode codepoint → MBCS byte(s)
let _reverseTable: Map<number, number[]> | null = null;
let _reverseEncoding = '';

function getReverseTable(): Map<number, number[]> {
  if (_reverseTable && _reverseEncoding === _ansiEncoding) return _reverseTable;
  _reverseTable = new Map();
  _reverseEncoding = _ansiEncoding;
  const decoder = new TextDecoder(_ansiEncoding);
  // Single-byte 0x80-0xFF
  for (let b = 0x80; b <= 0xFF; b++) {
    const ch = decoder.decode(new Uint8Array([b]));
    if (ch.length === 1 && ch !== '\uFFFD') {
      _reverseTable.set(ch.charCodeAt(0), [b]);
    }
  }
  // Double-byte for CJK encodings
  const isMBCS = ['shift-jis', 'gbk', 'big5', 'euc-kr'].includes(_ansiEncoding);
  if (isMBCS) {
    const leadMin = _ansiEncoding === 'euc-kr' ? 0xA1 : 0x81;
    const leadMax = _ansiEncoding === 'shift-jis' ? 0xEF : 0xFE;
    for (let b1 = leadMin; b1 <= leadMax; b1++) {
      // Skip Shift-JIS gap (0xA0-0xDF are single-byte katakana)
      if (_ansiEncoding === 'shift-jis' && b1 >= 0xA0 && b1 <= 0xDF) continue;
      for (let b2 = 0x40; b2 <= 0xFE; b2++) {
        const ch = decoder.decode(new Uint8Array([b1, b2]));
        if (ch.length === 1 && ch !== '\uFFFD') {
          _reverseTable.set(ch.charCodeAt(0), [b1, b2]);
        }
      }
    }
  }
  return _reverseTable;
}

/** Encode a Unicode string back to MBCS bytes using the active code page */
export function encodeMBCS(s: string): Uint8Array {
  const out: number[] = [];
  const rev = getReverseTable();
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else {
      const bytes = rev.get(cp);
      if (bytes) {
        for (const b of bytes) out.push(b);
      } else {
        out.push(0x3F); // '?'
      }
    }
  }
  return new Uint8Array(out);
}

/** Decode MBCS bytes using the detected ANSI code page */
export function decodeMBCS(bytes: Uint8Array): string {
  // Fast path: all ASCII
  let allAscii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] > 0x7F) { allAscii = false; break; }
  }
  if (allAscii) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
  try {
    if (!_ansiDecoder) _ansiDecoder = new TextDecoder(_ansiEncoding);
    return _ansiDecoder.decode(bytes);
  } catch (_) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }
}

// Sparse 32-bit memory using 64KB segments, lazily allocated
const SEG_BITS = 16;
const SEG_SIZE = 1 << SEG_BITS; // 65536
const SEG_MASK = SEG_SIZE - 1;

export class Memory {
  private segments = new Map<number, Uint8Array>();
  private dataViews = new Map<number, DataView>();

  // Hot segment cache — avoids Map lookup for consecutive accesses in the same 64KB segment
  private _cKey = -1;
  private _cSeg: Uint8Array = null!;
  private _cDV: DataView = null!;

  // Flat memory mode: when set, all reads/writes go directly to this buffer (no Map lookup)
  // Used for DOS mode to share the same ArrayBuffer with WASM JIT.
  private _flat: Uint8Array | null = null;
  private _flatDV: DataView | null = null;
  private _flatMax = 0; // max address accessible in flat mode

  /** Enable flat memory mode backed by a WebAssembly.Memory's buffer */
  enableFlatMode(buffer: ArrayBuffer, maxAddr: number): void {
    this._flat = new Uint8Array(buffer);
    this._flatDV = new DataView(buffer);
    this._flatMax = maxAddr;
    // Copy any existing sparse segments into the flat buffer
    for (const [key, seg] of this.segments) {
      const offset = key * SEG_SIZE;
      if (offset + SEG_SIZE <= maxAddr) {
        this._flat.set(seg, offset);
      }
    }
  }

  /** Check if flat mode is active */
  get isFlat(): boolean { return this._flat !== null; }

  // VGA planar memory hook: when set, intercepts reads/writes to A0000-AFFFF
  vgaPlanar: { planarWrite(offset: number, val: number): void; planarRead(offset: number): number } | null = null;

  private seg(addr: number): Uint8Array {
    const key = addr >>> SEG_BITS;
    if (key === this._cKey) return this._cSeg;
    let s = this.segments.get(key);
    if (!s) {
      s = new Uint8Array(SEG_SIZE);
      this.segments.set(key, s);
      this.dataViews.set(key, new DataView(s.buffer));
    }
    this._cKey = key;
    this._cSeg = s;
    this._cDV = this.dataViews.get(key)!;
    return s;
  }

  private dv(addr: number): DataView {
    const key = addr >>> SEG_BITS;
    if (key === this._cKey) return this._cDV;
    this.seg(addr);
    return this._cDV;
  }

  readU8(addr: number): number {
    if (this.vgaPlanar && (addr >>> 16) === 0xA) return this.vgaPlanar.planarRead(addr & 0xFFFF);
    if (this._flat && addr < this._flatMax) return this._flat[addr];
    return this.seg(addr)[addr & SEG_MASK];
  }

  readU16(addr: number): number {
    if (this.vgaPlanar && (addr >>> 16) === 0xA) {
      return this.readU8(addr) | (this.readU8(addr + 1) << 8);
    }
    if (this._flatDV && addr + 1 < this._flatMax) return this._flatDV.getUint16(addr, true);
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 1) {
      return this.dv(addr).getUint16(off, true);
    }
    return this.readU8(addr) | (this.readU8(addr + 1) << 8);
  }

  readU32(addr: number): number {
    if (this.vgaPlanar && (addr >>> 16) === 0xA) {
      return (this.readU8(addr) | (this.readU8(addr + 1) << 8) |
        (this.readU8(addr + 2) << 16) | (this.readU8(addr + 3) << 24)) >>> 0;
    }
    if (this._flatDV && addr + 3 < this._flatMax) return this._flatDV.getUint32(addr, true);
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 3) {
      return this.dv(addr).getUint32(off, true);
    }
    return (this.readU8(addr) | (this.readU8(addr + 1) << 8) |
      (this.readU8(addr + 2) << 16) | (this.readU8(addr + 3) << 24)) >>> 0;
  }

  readI8(addr: number): number {
    const v = this.readU8(addr);
    return v > 127 ? v - 256 : v;
  }

  readI16(addr: number): number {
    const v = this.readU16(addr);
    return v > 32767 ? v - 65536 : v;
  }

  readI32(addr: number): number {
    return this.readU32(addr) | 0;
  }

  /** Iterate over all allocated segment keys (for flat memory sync) */
  getSegmentKeys(): IterableIterator<number> { return this.segments.keys(); }
  /** Get raw segment data (for flat memory sync) */
  getSegment(key: number): Uint8Array | undefined { return this.segments.get(key); }
  /** Ensure a segment exists and return it */
  ensureSegment(key: number): Uint8Array {
    let s = this.segments.get(key);
    if (!s) { s = new Uint8Array(SEG_SIZE); this.segments.set(key, s); this.dataViews.set(key, new DataView(s.buffer)); }
    return s;
  }

  _watchAddr = 0; // temporary memory write watch
  writeU8(addr: number, val: number): void {
    if (this._watchAddr && addr === this._watchAddr) {
      console.log(`[MEM-WATCH] Write 0x${(val & 0xFF).toString(16)} to 0x${addr.toString(16)}`);
      console.trace();
    }
    if (this.vgaPlanar && (addr >>> 16) === 0xA) { this.vgaPlanar.planarWrite(addr & 0xFFFF, val & 0xFF); return; }
    if (this._flat && addr < this._flatMax) { this._flat[addr] = val & 0xFF; return; }
    this.seg(addr)[addr & SEG_MASK] = val & 0xFF;
  }

  writeU16(addr: number, val: number): void {
    if (this.vgaPlanar && (addr >>> 16) === 0xA) {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
      return;
    }
    if (this._flatDV && addr + 1 < this._flatMax) { this._flatDV.setUint16(addr, val, true); return; }
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 1) {
      this.dv(addr).setUint16(off, val, true);
    } else {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
    }
  }

  writeU32(addr: number, val: number): void {
    if (this.vgaPlanar && (addr >>> 16) === 0xA) {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
      this.writeU8(addr + 2, (val >> 16) & 0xFF);
      this.writeU8(addr + 3, (val >> 24) & 0xFF);
      return;
    }
    if (this._flatDV && addr + 3 < this._flatMax) { this._flatDV.setUint32(addr, val, true); return; }
    const off = addr & SEG_MASK;
    if (off < SEG_SIZE - 3) {
      this.dv(addr).setUint32(off, val, true);
    } else {
      this.writeU8(addr, val & 0xFF);
      this.writeU8(addr + 1, (val >> 8) & 0xFF);
      this.writeU8(addr + 2, (val >> 16) & 0xFF);
      this.writeU8(addr + 3, (val >> 24) & 0xFF);
    }
  }

  // Signed write aliases — identical bit pattern to unsigned writes
  writeI16(addr: number, val: number): void { this.writeU16(addr, val); }
  writeI32(addr: number, val: number): void { this.writeU32(addr, val); }

  fill(addr: number, len: number, val: number): void {
    if (this._flat && addr + len <= this._flatMax) {
      this._flat.fill(val, addr, addr + len);
      return;
    }
    let remaining = len;
    let cur = addr;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      seg.fill(val, off, off + chunk);
      cur += chunk;
      remaining -= chunk;
    }
  }

  copyFrom(addr: number, data: Uint8Array): void {
    if (this._flat && addr + data.length <= this._flatMax) {
      this._flat.set(data, addr);
      return;
    }
    let remaining = data.length;
    let cur = addr;
    let srcOff = 0;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      seg.set(data.subarray(srcOff, srcOff + chunk), off);
      cur += chunk;
      srcOff += chunk;
      remaining -= chunk;
    }
  }

  slice(addr: number, len: number): Uint8Array {
    if (this._flat && addr + len <= this._flatMax) {
      return this._flat.slice(addr, addr + len);
    }
    const result = new Uint8Array(len);
    let remaining = len;
    let cur = addr;
    let dstOff = 0;
    while (remaining > 0) {
      const seg = this.seg(cur);
      const off = cur & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - off);
      result.set(seg.subarray(off, off + chunk), dstOff);
      cur += chunk;
      dstOff += chunk;
      remaining -= chunk;
    }
    return result;
  }

  /** Bulk copy within memory — segment-level optimization */
  copyBlock(dst: number, src: number, len: number): void {
    let remaining = len;
    let s = src;
    let d = dst;
    while (remaining > 0) {
      const srcSeg = this.seg(s);
      const srcOff = s & SEG_MASK;
      const dstSeg = this.seg(d);
      const dstOff = d & SEG_MASK;
      const chunk = Math.min(remaining, SEG_SIZE - srcOff, SEG_SIZE - dstOff);
      if (srcSeg === dstSeg && srcOff < dstOff && srcOff + chunk > dstOff) {
        // Overlapping within same segment, copy backwards
        for (let i = chunk - 1; i >= 0; i--) dstSeg[dstOff + i] = srcSeg[srcOff + i];
      } else {
        dstSeg.set(srcSeg.subarray(srcOff, srcOff + chunk), dstOff);
      }
      s += chunk;
      d += chunk;
      remaining -= chunk;
    }
  }

  readCString(addr: number): string {
    const bytes: number[] = [];
    for (let i = 0; ; i++) {
      const ch = this.readU8(addr + i);
      if (ch === 0) break;
      bytes.push(ch);
    }
    return decodeMBCS(new Uint8Array(bytes));
  }

  /** Read `count` bytes as an MBCS string */
  readBytesMBCS(addr: number, count: number): string {
    const bytes = new Uint8Array(count);
    for (let i = 0; i < count; i++) bytes[i] = this.readU8(addr + i);
    return decodeMBCS(bytes);
  }

  writeCString(addr: number, s: string): void {
    const bytes = encodeMBCS(s);
    for (let i = 0; i < bytes.length; i++) {
      this.writeU8(addr + i, bytes[i]);
    }
    this.writeU8(addr + bytes.length, 0);
  }

  readUTF16String(addr: number): string {
    let s = '';
    for (let i = 0; ; i += 2) {
      const ch = this.readU16(addr + i);
      if (ch === 0) break;
      s += String.fromCharCode(ch);
    }
    return s;
  }

  writeUTF16String(addr: number, s: string): void {
    for (let i = 0; i < s.length; i++) {
      this.writeU16(addr + i * 2, s.charCodeAt(i));
    }
    this.writeU16(addr + s.length * 2, 0);
  }
}
