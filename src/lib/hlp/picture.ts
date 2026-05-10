// SHG / MRB / |bm picture loader.
// Outputs a ready-to-display PNG/BMP-style image plus a hotspot list.
import { lz77Decompress } from './lz77';
import { Cursor } from './cint';

export interface HlpHotspot {
  type: number;          // 0xC8 popup, 0xCC jump, 0xE0..0xE3 macro variants
  showBorder: boolean;
  left: number; top: number; width: number; height: number;
  hash: number;
  name?: string;
  context?: string;      // resolved name when name table present
  macro?: string;        // for macro hotspots
}

export interface HlpPicture {
  width: number;
  height: number;
  /** RGBA bytes for canvas use. */
  rgba: Uint8ClampedArray;
  hotspots: HlpHotspot[];
  /** Source data type label. */
  pictureType: number;   // 5=DDB, 6=DIB, 8=WMF
}

export function parsePictureContainer(body: Uint8Array): HlpPicture[] {
  if (body.length < 4) throw new Error('picture container truncated');
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const magic = dv.getUint16(0, true);
  if (magic !== 0x506C && magic !== 0x706C) {
    throw new Error(`picture magic mismatch 0x${magic.toString(16)}`);
  }
  const num = dv.getUint16(2, true);
  const offsets: number[] = [];
  for (let i = 0; i < num; i++) offsets.push(dv.getUint32(4 + i * 4, true));
  const pics: HlpPicture[] = [];
  for (const off of offsets) {
    try { pics.push(parsePicture(body, off)); }
    catch (e) { console.warn('[hlp] picture parse failed:', e); }
  }
  return pics;
}

function parsePicture(body: Uint8Array, off: number): HlpPicture {
  // Field layout:
  //   u8   byType (5=DDB, 6=DIB, 8=WMF)
  //   u8   byPacked (0=raw, 1=RLE, 2=LZ77, 3=both)
  //   clong xPels, yPels (unsigned compressed long)
  //   cuint biPlanes, biBitCount (compressed word)
  //   clong biWidth, biHeight, biClrUsed, biClrImportant
  //   clong dwDataSize, dwHotspotSize
  //   u32   dwPictureOffset (raw)
  //   u32   dwHotspotOffset (raw)
  // Then optional palette + pixel data + hotspot table.
  const c = new Cursor(body.subarray(off));
  const pictureType = c.u8();
  const packing = c.u8();
  const xdpi = c.clong();
  const ydpi = c.clong();
  void xdpi; void ydpi;
  if (pictureType === 8) {
    // WMF
    const mapMode = c.cuint();
    const widthMM = c.u16();
    const heightMM = c.u16();
    const rawSize = c.clong();
    const dataSize = c.clong();
    const hotspotSize = c.clong();
    const compOff = c.u32();
    const hotOff = c.u32();
    void mapMode; void widthMM; void heightMM; void rawSize; void compOff; void hotOff; void dataSize; void hotspotSize;
    return { width: 0, height: 0, rgba: new Uint8ClampedArray(), hotspots: [], pictureType };
  }
  // DDB/DIB
  const planes = c.cuint();
  const bitcount = c.cuint();
  const width = c.clong();
  const height = c.clong();
  const colorsUsed = c.clong();
  const colorsImportant = c.clong();
  void planes; void colorsImportant;
  const dataSize = c.clong();
  const hotspotSize = c.clong();
  const compOff = c.u32();
  const hotOff = c.u32();
  void compOff;

  // Palette for DIB with bitcount<=8
  let palette: Uint8Array | undefined;
  let paletteEntries = 0;
  if (pictureType === 6 && bitcount <= 8) {
    paletteEntries = colorsUsed > 0 ? colorsUsed : (1 << bitcount);
    // Each palette entry is 4 bytes — stored as BGRX.
    const palLen = paletteEntries * 4;
    palette = c.bytes(palLen);
  }

  let pixelData = c.bytes(dataSize);

  // Apply packing transformations.
  const expectedRawBytes = computeRawSize(width, height, bitcount);
  if (packing === 2 || packing === 3) {
    pixelData = lz77Decompress(pixelData, expectedRawBytes);
  }
  if (packing === 1 || packing === 3) {
    pixelData = unrleDib(pixelData, width, height, bitcount, expectedRawBytes);
  }

  const rgba = renderDib(pixelData, width, height, bitcount, palette);

  // Hotspots
  const hotspots: HlpHotspot[] = [];
  if (hotspotSize > 0) {
    // c.pos may not equal hotOff exactly because of accumulated cuint sizes;
    // trust hotOff if it's within bounds.
    const hsStart = hotOff < body.length - off ? hotOff : c.pos;
    try {
      parseHotspotTable(body.subarray(off + hsStart, off + hsStart + hotspotSize), hotspots);
    } catch (e) { console.warn('[hlp] hotspot parse failed:', e); }
  }

  return { width, height, rgba, hotspots, pictureType };
}

function computeRowStride(width: number, bitcount: number): number {
  const pixelBytes = Math.ceil((width * bitcount) / 8);
  return (pixelBytes + 3) & ~3;
}

function computeRawSize(width: number, height: number, bitcount: number): number {
  return computeRowStride(width, bitcount) * height;
}

function unrleDib(rle: Uint8Array, width: number, height: number, bitcount: number, expected: number): Uint8Array {
  // WinHelp byte-level RLE:
  //   cmd & 0x80 == 0x80: copy (cmd & 0x7F) literal bytes
  //   cmd & 0x80 == 0x00: emit next byte cmd times (cmd=0 reads value but emits 0)
  void width; void height; void bitcount;
  const out = new Uint8Array(expected);
  let outP = 0, inP = 0;
  while (inP < rle.length && outP < expected) {
    const cmd = rle[inP++];
    if ((cmd & 0x80) !== 0) {
      const n = cmd & 0x7F;
      for (let i = 0; i < n && inP < rle.length && outP < expected; i++) {
        out[outP++] = rle[inP++];
      }
    } else {
      if (inP >= rle.length) break;
      const v = rle[inP++];
      for (let i = 0; i < cmd && outP < expected; i++) out[outP++] = v;
    }
  }
  return out;
}

function renderDib(pixels: Uint8Array, width: number, height: number, bitcount: number, palette?: Uint8Array): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowBytes = computeRowStride(width, bitcount);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowBytes;
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      if (bitcount === 24) {
        const p = srcRow + x * 3;
        b = pixels[p] | 0;
        g = pixels[p + 1] | 0;
        r = pixels[p + 2] | 0;
      } else if (bitcount === 8) {
        const idx = pixels[srcRow + x] | 0;
        if (palette && idx * 4 + 2 < palette.length) {
          b = palette[idx * 4]; g = palette[idx * 4 + 1]; r = palette[idx * 4 + 2];
        } else { r = g = b = idx; }
      } else if (bitcount === 4) {
        const byte = pixels[srcRow + (x >> 1)] | 0;
        const idx = (x & 1) ? (byte & 0x0F) : (byte >> 4);
        if (palette && idx * 4 + 2 < palette.length) {
          b = palette[idx * 4]; g = palette[idx * 4 + 1]; r = palette[idx * 4 + 2];
        }
      } else if (bitcount === 1) {
        const byte = pixels[srcRow + (x >> 3)] | 0;
        const idx = (byte >> (7 - (x & 7))) & 1;
        if (palette && idx * 4 + 2 < palette.length) {
          b = palette[idx * 4]; g = palette[idx * 4 + 1]; r = palette[idx * 4 + 2];
        } else { r = g = b = idx ? 0xFF : 0; }
      }
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 0xFF;
    }
  }
  return rgba;
}

function parseHotspotTable(body: Uint8Array, out: HlpHotspot[]): void {
  if (body.length < 8) return;
  const c = new Cursor(body);
  /* magic */ c.u8();
  /* unknown */ c.u8();
  const num = c.u16();
  const macroDataSize = c.u32();
  const start: HlpHotspot[] = [];
  for (let i = 0; i < num; i++) {
    if (c.remaining < 15) break;
    const t = c.u8();
    const left = c.u16();
    const top = c.u16();
    const width = c.u16();
    const height = c.u16();
    const hash = c.u32();
    start.push({
      type: t & 0x7F,
      showBorder: (t & 0x80) === 0,
      left, top, width, height, hash,
    });
  }
  // Macro data block, then name table
  const macroDataEnd = c.pos + macroDataSize;
  void macroDataEnd;
  // Read name table: array of 2 NUL-terminated strings per hotspot.
  for (let i = 0; i < start.length && !c.eof; i++) {
    start[i].name = c.asciiZ();
    start[i].context = c.asciiZ();
  }
  out.push(...start);
}

/** Encode the rendered RGBA into a PNG blob via OffscreenCanvas (or HTMLCanvasElement fallback). */
export function rgbaToBlob(p: HlpPicture): Promise<Blob | null> {
  if (!p.width || !p.height || !p.rgba.length) return Promise.resolve(null);
  // Prefer OffscreenCanvas (works in workers); fall back to a regular canvas.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(p.width, p.height);
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new ImageData(p.rgba, p.width, p.height);
        ctx.putImageData(img, 0, 0);
        return canvas.convertToBlob({ type: 'image/png' });
      }
    } catch (e) { console.warn('[hlp] OffscreenCanvas failed, falling back:', e); }
  }
  if (typeof document !== 'undefined') {
    return new Promise((resolve) => {
      const canvas = document.createElement('canvas');
      canvas.width = p.width;
      canvas.height = p.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      const img = new ImageData(new Uint8ClampedArray(p.rgba), p.width, p.height);
      ctx.putImageData(img, 0, 0);
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  }
  return Promise.resolve(null);
}
