import type { PaletteInfo, DCInfo } from './types';
import { makeFont, type GdiFont, FW_NORMAL } from '../../../gdi';
import type { Emulator } from '../../emulator';

/** Check if a COLORREF uses PALETTEINDEX encoding (0x01000000 | index) */
export function isPaletteIndex(color: number): boolean {
  return (color & 0xFF000000) === 0x01000000;
}

/** Extract the palette index from a PALETTEINDEX COLORREF */
export function getPaletteIdx(color: number): number {
  return color & 0xFFFF;
}

/** Resolve a COLORREF to actual RGB, looking up PALETTEINDEX from the palette if needed */
export function resolveColor(color: number, pal: PaletteInfo | undefined): [number, number, number] {
  if (isPaletteIndex(color) && pal) {
    const idx = getPaletteIdx(color);
    if (idx < pal.count) {
      return [pal.entries[idx * 4], pal.entries[idx * 4 + 1], pal.entries[idx * 4 + 2]];
    }
    return [0, 0, 0];
  }
  return [color & 0xFF, (color >> 8) & 0xFF, (color >> 16) & 0xFF];
}

export function colorToCSS(bgr: number): string {
  const r = bgr & 0xFF;
  const g = (bgr >> 8) & 0xFF;
  const b = (bgr >> 16) & 0xFF;
  return `rgb(${r},${g},${b})`;
}

export function colorToRGB(bgr: number): [number, number, number] {
  return [bgr & 0xFF, (bgr >> 8) & 0xFF, (bgr >> 16) & 0xFF];
}

/** Ensure DC has a palette index buffer allocated, matching the canvas size */
export function ensurePalIndexBuf(dc: DCInfo): Uint8Array {
  const w = dc.canvas.width || 1;
  const h = dc.canvas.height || 1;
  const size = w * h;
  if (!dc.palIndexBuf || dc.palIndexBuf.length !== size) {
    dc.palIndexBuf = new Uint8Array(size);
  }
  return dc.palIndexBuf;
}

/** Re-render all palette-indexed pixels on a DC using the current palette colors */
export function refreshPalettePixels(dc: DCInfo, pal: PaletteInfo): void {
  const buf = dc.palIndexBuf;
  if (!buf) return;
  const w = dc.canvas.width || 1;
  const h = dc.canvas.height || 1;
  if (buf.length !== w * h) return;

  const imgData = dc.ctx.getImageData(0, 0, w, h);
  const px = imgData.data;
  let changed = false;
  for (let i = 0; i < buf.length; i++) {
    const idx = buf[i];
    if (idx === 0) continue; // 0 means not palette-indexed (or index 0 - see below)
    // We store index+1 so that 0 means "no palette pixel"
    const palIdx = idx - 1;
    if (palIdx < pal.count) {
      const off = i * 4;
      const r = pal.entries[palIdx * 4];
      const g = pal.entries[palIdx * 4 + 1];
      const b = pal.entries[palIdx * 4 + 2];
      if (px[off] !== r || px[off + 1] !== g || px[off + 2] !== b) {
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
        changed = true;
      }
    }
  }
  if (changed) dc.ctx.putImageData(imgData, 0, 0);
}

// Stock object handles (fixed IDs)
export const STOCK_BASE = 0x80000000;

/** Disable anti-aliasing on a 2D context for pixel-perfect GDI rendering */
export function disableSmoothing(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): void {
  ctx.imageSmoothingEnabled = false;
}

/** Pull the GdiFont currently selected into the supplied HDC. Falls back to
 *  the GDI default (Tahoma 13 px) when no font is selected or the handle
 *  has no recognisable LOGFONT-shaped fields. Shared between the x86 GDI
 *  emulation and any other consumer that wants identical font behaviour. */
export function getDCFont(emu: Emulator, hdc: number): GdiFont {
  const dc = emu.getDC(hdc);
  if (!dc) return makeFont();
  const stored = emu.handles.get<{
    height?: number; weight?: number; italic?: boolean;
    underline?: boolean; strikeout?: boolean; faceName?: string;
  }>(dc.selectedFont);
  if (!stored) return makeFont();
  const height = stored.height ?? -13;
  return makeFont({
    height,
    weight: stored.weight ?? FW_NORMAL,
    italic: !!stored.italic,
    underline: !!stored.underline,
    strikeout: !!stored.strikeout,
    faceName: stored.faceName || 'Tahoma',
  });
}

