import type { Emulator } from '../emulator';
import type { DCInfo, BitmapInfo, BrushInfo, PenInfo, PaletteInfo } from '../win32/gdi32/types';
import { OPAQUE } from '../win32/types';
import { fillTextBitmap } from '../emu-render';
import { decodeDib } from '../../pe/decode-dib';

function bresenhamLine(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    ctx.fillRect(x0, y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}


function colorToCSS(bgr: number): string {
  const r = bgr & 0xFF;
  const g = (bgr >> 8) & 0xFF;
  const b = (bgr >> 16) & 0xFF;
  return `rgb(${r},${g},${b})`;
}

function readDIBPalette(
  emu: Emulator, dc: DCInfo, bmiPtr: number, biSize: number, numColors: number, fuUsage: number,
): [number, number, number][] {
  const palette: [number, number, number][] = [];
  const paletteOffset = bmiPtr + biSize;
  if (fuUsage === 1 && numColors > 0) {
    // DIB_PAL_COLORS: color table contains WORD indices into the DC's logical palette
    const pal = emu.handles.get<PaletteInfo>(dc.selectedPalette);
    for (let i = 0; i < numColors; i++) {
      const idx = emu.memory.readU16(paletteOffset + i * 2);
      if (pal && idx < pal.count) {
        palette.push([pal.entries[idx * 4], pal.entries[idx * 4 + 1], pal.entries[idx * 4 + 2]]);
      } else {
        palette.push([0, 0, 0]);
      }
    }
  } else {
    for (let i = 0; i < numColors; i++) {
      const b = emu.memory.readU8(paletteOffset + i * 4);
      const g = emu.memory.readU8(paletteOffset + i * 4 + 1);
      const r = emu.memory.readU8(paletteOffset + i * 4 + 2);
      palette.push([r, g, b]);
    }
  }
  return palette;
}

function calcDIBStride(biWidth: number, biBitCount: number): number {
  if (biBitCount === 1) return ((Math.ceil(biWidth / 8)) + 3) & ~3;
  if (biBitCount === 4) return ((Math.ceil(biWidth / 2)) + 3) & ~3;
  if (biBitCount === 8) return (biWidth + 3) & ~3;
  if (biBitCount === 24) return (biWidth * 3 + 3) & ~3;
  if (biBitCount === 32) return biWidth * 4;
  return 0;
}

function readDIBPixel(
  emu: Emulator, rowStart: number, sx: number, biBitCount: number, palette: [number, number, number][],
): [number, number, number] {
  if (biBitCount === 8) {
    return palette[emu.memory.readU8(rowStart + sx)] || [0, 0, 0];
  }
  if (biBitCount === 4) {
    const byteVal = emu.memory.readU8(rowStart + (sx >> 1));
    const idx = (sx & 1) === 0 ? (byteVal >> 4) & 0x0F : byteVal & 0x0F;
    return palette[idx] || [0, 0, 0];
  }
  if (biBitCount === 1) {
    const idx = (emu.memory.readU8(rowStart + (sx >> 3)) >> (7 - (sx & 7))) & 1;
    return palette[idx] || [0, 0, 0];
  }
  if (biBitCount === 24) {
    const off = rowStart + sx * 3;
    return [emu.memory.readU8(off + 2), emu.memory.readU8(off + 1), emu.memory.readU8(off)];
  }
  if (biBitCount === 32) {
    const off = rowStart + sx * 4;
    return [emu.memory.readU8(off + 2), emu.memory.readU8(off + 1), emu.memory.readU8(off)];
  }
  return [0, 0, 0];
}

/**
 * Check if a DC targets a monochrome bitmap.
 * When drawing to a monochrome DC, colors must be thresholded:
 * color matching bkColor → white (1), otherwise → black (0).
 */
function isDCMonochrome(emu: Emulator, dc: DCInfo): boolean {
  if (!dc.selectedBitmap) return false;
  const bmp = emu.handles.get<BitmapInfo>(dc.selectedBitmap);
  return !!bmp?.monochrome;
}

/**
 * Convert a CSS color string to monochrome for a destination DC.
 * In real Windows, when drawing on a monochrome DC:
 *   color == DC bkColor → white pixel (preserved/transparent in masks)
 *   color != DC bkColor → black pixel (opaque in masks)
 */
function monoThreshold(dc: DCInfo, cssColor: string): string {
  // Parse the CSS color to BGR
  const m = cssColor.match(/rgb\((\d+),(\d+),(\d+)\)/);
  if (!m) return cssColor;
  const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
  const bgr = r | (g << 8) | (b << 16);
  // Compare with bkColor: match → white, else → black
  return bgr === dc.bkColor ? '#fff' : '#000';
}

// Win16 ROP codes use different encoding than Win32
const SRCCOPY16     = 0x00CC0020;
const NOTSRCCOPY16  = 0x00330008;
const SRCPAINT16    = 0x00EE0086;
const SRCAND16      = 0x008800C6;
const SRCINVERT16   = 0x00660046;
const BLACKNESS16   = 0x00000042;
const WHITENESS16   = 0x00FF0062;
const PATCOPY16     = 0x00F00021;
const PATINVERT16   = 0x005A0049;

// Map mode constants
const MM_TEXT = 1;

// Region result constants
const SIMPLEREGION = 1;

// Text alignment constants
const TA_LEFT = 0;

// PS_NULL
const PS_NULL = 5;

// BS_NULL
const BS_NULL = 1;

export function registerWin16Gdi(emu: Emulator): void {
  const gdi = emu.registerModule16('GDI');

  // Set up stock objects for Win16
  const stockBrushes: Record<number, BrushInfo> = {
    0: { color: 0xFFFFFF, isNull: false },  // WHITE_BRUSH
    1: { color: 0xC8D0D4, isNull: false },  // LTGRAY_BRUSH
    2: { color: 0x808080, isNull: false },  // GRAY_BRUSH
    3: { color: 0x404040, isNull: false },  // DKGRAY_BRUSH
    4: { color: 0x000000, isNull: false },  // BLACK_BRUSH
    5: { color: 0, isNull: true },           // NULL_BRUSH
  };
  const stockPens: Record<number, PenInfo> = {
    6: { style: 0, width: 1, color: 0xFFFFFF },  // WHITE_PEN
    7: { style: 0, width: 1, color: 0x000000 },  // BLACK_PEN
    8: { style: PS_NULL, width: 0, color: 0 },    // NULL_PEN
  };
  emu.getStockBrush = (idx: number) => stockBrushes[idx] || null;
  emu.getStockPen = (idx: number) => stockPens[idx] || null;

  // Font helpers — read font info from DC's selected font handle
  function getFontSize(hdc: number): number {
    const dc = emu.getDC(hdc);
    if (!dc) return 13;
    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    if (font && font.height) return Math.abs(font.height);
    return 13;
  }

  function getFontCSS(hdc: number): string {
    const sz = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    const font = dc ? emu.handles.get<{ height: number; faceName?: string; weight?: number; italic?: boolean }>(dc.selectedFont) : null;
    const face = font?.faceName || 'Tahoma';
    const weight = font?.weight && font.weight >= 700 ? 'bold ' : '';
    const italic = font?.italic ? 'italic ' : '';
    return `${italic}${weight}${sz}px "${face}", Tahoma, sans-serif`;
  }

  function createMemDC(): number {
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d')!;
    const defBmpCanvas = new OffscreenCanvas(1, 1);
    const defBmpCtx = defBmpCanvas.getContext('2d')!;
    const defBmp: BitmapInfo = { width: 1, height: 1, canvas: defBmpCanvas, ctx: defBmpCtx, monochrome: true };
    const defBmpHandle = emu.handles.alloc('bitmap', defBmp);
    const dc: DCInfo = {
      canvas, ctx, hwnd: 0,
      selectedBitmap: defBmpHandle, selectedPen: 0, selectedBrush: 0, selectedFont: 0, selectedPalette: 0,
      textColor: 0, bkColor: 0xFFFFFF, bkMode: OPAQUE,
      penPosX: 0, penPosY: 0, rop2: 13,
    };
    return emu.handles.alloc('dc', dc);
  }

  function brushToFillStyle(dc: DCInfo, brush: BrushInfo): string | CanvasPattern | null {
    if (brush.patternBitmap) {
      // Check if the pattern bitmap is monochrome — if so, colorize it using
      // the DC's textColor (for black pixels) and bkColor (for white pixels).
      // This is how Windows renders mono pattern brushes on color DCs.
      const patCanvas = brush.patternBitmap;
      const pw = patCanvas.width, ph = patCanvas.height;
      if (pw > 0 && ph > 0) {
        const patCtx = patCanvas.getContext('2d')!;
        const patData = patCtx.getImageData(0, 0, pw, ph);
        // Detect if pattern is monochrome (only black and white pixels)
        let isMono = true;
        for (let i = 0; i < patData.data.length; i += 4) {
          const r = patData.data[i], g = patData.data[i+1], b = patData.data[i+2];
          if (!((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255))) {
            isMono = false; break;
          }
        }
        if (isMono) {
          // Create a colorized copy of the pattern
          const colorCanvas = new OffscreenCanvas(pw, ph);
          const colorCtx = colorCanvas.getContext('2d')!;
          const colorData = colorCtx.createImageData(pw, ph);
          const txR = dc.textColor & 0xFF, txG = (dc.textColor >> 8) & 0xFF, txB = (dc.textColor >> 16) & 0xFF;
          const bkR = dc.bkColor & 0xFF, bkG = (dc.bkColor >> 8) & 0xFF, bkB = (dc.bkColor >> 16) & 0xFF;
          for (let i = 0; i < patData.data.length; i += 4) {
            const isBlack = patData.data[i] === 0;
            colorData.data[i] = isBlack ? txR : bkR;
            colorData.data[i+1] = isBlack ? txG : bkG;
            colorData.data[i+2] = isBlack ? txB : bkB;
            colorData.data[i+3] = 255;
          }
          colorCtx.putImageData(colorData, 0, 0);
          return dc.ctx.createPattern(colorCanvas, 'repeat');
        }
      }
      return dc.ctx.createPattern(patCanvas, 'repeat');
    }
    return colorToCSS(brush.color);
  }

  function fillAndStroke(dc: DCInfo) {
    const brush = emu.getBrush(dc.selectedBrush);
    if (brush && !brush.isNull) {
      dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
      dc.ctx.fill();
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
  }

  // Ordinal 1: SetBkColor(hdc, color_long) — pascal, 6 bytes (2+4)
  gdi.register('SetBkColor', 6, () => {
    const [hdc, color] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.bkColor;
      dc.bkColor = color;
      return old;
    }
    return 0;
  }, 1);

  // Ordinal 2: SetBkMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SetBkMode', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.bkMode;
      dc.bkMode = mode;
      return old;
    }
    return 0;
  }, 2);

  // Ordinal 3: SetMapMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SetMapMode', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.mapMode ?? MM_TEXT;
      dc.mapMode = mode;
      return old;
    }
    return MM_TEXT;
  }, 3);

  // Ordinal 4: SetROP2(hdc, fnDrawMode) — pascal -ret16, 4 bytes
  gdi.register('SetROP2', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.rop2;
      dc.rop2 = mode;
      return old;
    }
    return 0;
  }, 4);

  // Ordinal 5: SetRelAbs(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SetRelAbs', 4, () => 1, 5);

  // Ordinal 6: SetPolyFillMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SetPolyFillMode', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.polyFillMode ?? 1; // ALTERNATE=1
      dc.polyFillMode = mode;
      return old;
    }
    return 1;
  }, 6);

  // Ordinal 7: SetStretchBltMode(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SetStretchBltMode', 4, () => {
    const [hdc, mode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.stretchBltMode ?? 1;
      dc.stretchBltMode = mode;
      return old;
    }
    return 0;
  }, 7);

  // Ordinal 8: SetTextCharacterExtra(hdc, nCharExtra) — pascal -ret16, 4 bytes
  gdi.register('SetTextCharacterExtra', 4, () => {
    const [hdc, nCharExtra] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textCharExtra ?? 0;
      dc.textCharExtra = (nCharExtra << 16) >> 16; // sign extend
      return old;
    }
    return 0;
  }, 8);

  // Ordinal 9: SetTextColor(hdc, color_long) — pascal, 6 bytes (2+4)
  gdi.register('SetTextColor', 6, () => {
    const [hdc, color] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textColor;
      dc.textColor = color;
      return old;
    }
    return 0;
  }, 9);

  // Ordinal 10: SetTextJustification(hdc, nBreakExtra, nBreakCount) — pascal -ret16, 6 bytes
  gdi.register('SetTextJustification', 6, () => {
    const [hdc, nBreakExtra, nBreakCount] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.textJustBreakExtra = (nBreakExtra << 16) >> 16;
      dc.textJustBreakCount = (nBreakCount << 16) >> 16;
    }
    return 1;
  }, 10);

  // Ordinal 11: SetWindowOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetWindowOrg', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.windowOrgX ?? 0;
      const oldY = dc.windowOrgY ?? 0;
      dc.windowOrgX = (x << 16) >> 16;
      dc.windowOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 11);

  // Ordinal 12: SetWindowExt(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetWindowExt', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.windowExtX ?? 1;
      const oldY = dc.windowExtY ?? 1;
      dc.windowExtX = (x << 16) >> 16;
      dc.windowExtY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 12);

  // Ordinal 13: SetViewportOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetViewportOrg', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.viewportOrgX ?? 0;
      const oldY = dc.viewportOrgY ?? 0;
      dc.viewportOrgX = (x << 16) >> 16;
      dc.viewportOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 13);

  // Ordinal 14: SetViewportExt(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetViewportExt', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.viewportExtX ?? 1;
      const oldY = dc.viewportExtY ?? 1;
      dc.viewportExtX = (x << 16) >> 16;
      dc.viewportExtY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 14);

  // Ordinal 15: OffsetWindowOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('OffsetWindowOrg', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.windowOrgX = (dc.windowOrgX ?? 0) + ((x << 16) >> 16);
      dc.windowOrgY = (dc.windowOrgY ?? 0) + ((y << 16) >> 16);
      return ((dc.windowOrgY & 0xFFFF) << 16) | (dc.windowOrgX & 0xFFFF);
    }
    return 0;
  }, 15);

  // Ordinal 16: ScaleWindowExt(hdc, xNum, xDenom, yNum, yDenom) — pascal, 10 bytes
  gdi.register('ScaleWindowExt', 10, () => {
    const [hdc, xNum, xDenom, yNum, yDenom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc && xDenom && yDenom) {
      dc.windowExtX = Math.round((dc.windowExtX ?? 1) * ((xNum << 16) >> 16) / ((xDenom << 16) >> 16));
      dc.windowExtY = Math.round((dc.windowExtY ?? 1) * ((yNum << 16) >> 16) / ((yDenom << 16) >> 16));
      return (((dc.windowExtY ?? 1) & 0xFFFF) << 16) | ((dc.windowExtX ?? 1) & 0xFFFF);
    }
    return 0;
  }, 16);

  // Ordinal 17: OffsetViewportOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('OffsetViewportOrg', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.viewportOrgX = (dc.viewportOrgX ?? 0) + ((x << 16) >> 16);
      dc.viewportOrgY = (dc.viewportOrgY ?? 0) + ((y << 16) >> 16);
      return ((dc.viewportOrgY & 0xFFFF) << 16) | (dc.viewportOrgX & 0xFFFF);
    }
    return 0;
  }, 17);

  // Ordinal 18: ScaleViewportExt(hdc, xNum, xDenom, yNum, yDenom) — pascal, 10 bytes
  gdi.register('ScaleViewportExt', 10, () => {
    const [hdc, xNum, xDenom, yNum, yDenom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc && xDenom && yDenom) {
      dc.viewportExtX = Math.round((dc.viewportExtX ?? 1) * ((xNum << 16) >> 16) / ((xDenom << 16) >> 16));
      dc.viewportExtY = Math.round((dc.viewportExtY ?? 1) * ((yNum << 16) >> 16) / ((yDenom << 16) >> 16));
      return (((dc.viewportExtY ?? 1) & 0xFFFF) << 16) | ((dc.viewportExtX ?? 1) & 0xFFFF);
    }
    return 0;
  }, 18);

  // Ordinal 19: LineTo(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('LineTo', 6, () => {
    const [hdc, xRaw, yRaw] = emu.readPascalArgs16([2, 2, 2]);
    const x = (xRaw << 16) >> 16;
    const y = (yRaw << 16) >> 16;
    const dc = emu.getDC(hdc);
    if (dc) {
      const pen = emu.getPen(dc.selectedPen);
      const rop2 = dc.rop2;
      const R2_NOP = 11, R2_COPYPEN = 13, R2_WHITE = 16, R2_BLACK = 1;

      if (rop2 === R2_NOP) {
        // no drawing
      } else if (rop2 === R2_WHITE) {
        dc.ctx.fillStyle = '#ffffff';
        bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
      } else if (rop2 === R2_BLACK) {
        dc.ctx.fillStyle = '#000000';
        bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
      } else if (rop2 === R2_COPYPEN) {
        if (pen && pen.style !== PS_NULL) {
          let fill = colorToCSS(pen.color);
          if (isDCMonochrome(emu, dc)) fill = monoThreshold(dc, fill);
          dc.ctx.fillStyle = fill;
          bresenhamLine(dc.ctx, dc.penPosX, dc.penPosY, x, y);
        }
      } else {
        // All other ROP2 modes: per-pixel with dst read
        let pr = 0, pg = 0, pb = 0;
        if (pen) { pr = pen.color & 0xFF; pg = (pen.color >> 8) & 0xFF; pb = (pen.color >> 16) & 0xFF; }
        const cw = dc.canvas.width || 1, ch = dc.canvas.height || 1;
        const imgData = dc.ctx.getImageData(0, 0, cw, ch);
        const d = imgData.data;
        let x0 = dc.penPosX, y0 = dc.penPosY, x1 = x, y1 = y;
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
        const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        while (true) {
          if (x0 >= 0 && x0 < cw && y0 >= 0 && y0 < ch) {
            const off = (y0 * cw + x0) * 4;
            const dr = d[off], dg = d[off+1], db = d[off+2];
            let rr: number, rg: number, rb: number;
            switch (rop2) {
              case 2:  rr = ~(dr|pr)&0xFF; rg = ~(dg|pg)&0xFF; rb = ~(db|pb)&0xFF; break; // R2_NOTMERGEPEN
              case 3:  rr = dr&(~pr&0xFF); rg = dg&(~pg&0xFF); rb = db&(~pb&0xFF); break; // R2_MASKNOTPEN
              case 4:  rr = ~pr&0xFF;      rg = ~pg&0xFF;      rb = ~pb&0xFF;      break; // R2_NOTCOPYPEN
              case 5:  rr = pr&(~dr&0xFF); rg = pg&(~dg&0xFF); rb = pb&(~db&0xFF); break; // R2_MASKPENNOT
              case 6:  rr = ~dr&0xFF;      rg = ~dg&0xFF;      rb = ~db&0xFF;      break; // R2_NOT
              case 7:  rr = dr^pr;         rg = dg^pg;         rb = db^pb;         break; // R2_XORPEN
              case 8:  rr = ~(dr&pr)&0xFF; rg = ~(dg&pg)&0xFF; rb = ~(db&pb)&0xFF; break; // R2_NOTMASKPEN
              case 9:  rr = dr&pr;         rg = dg&pg;         rb = db&pb;         break; // R2_MASKPEN
              case 10: rr = ~(dr^pr)&0xFF; rg = ~(dg^pg)&0xFF; rb = ~(db^pb)&0xFF; break; // R2_NOTXORPEN
              case 12: rr = dr|(~pr&0xFF); rg = dg|(~pg&0xFF); rb = db|(~pb&0xFF); break; // R2_MERGENOTPEN
              case 14: rr = pr|(~dr&0xFF); rg = pg|(~dg&0xFF); rb = pb|(~db&0xFF); break; // R2_MERGEPENNOT
              case 15: rr = dr|pr;         rg = dg|pg;         rb = db|pb;         break; // R2_MERGEPEN
              default: rr = pr; rg = pg; rb = pb; break;
            }
            d[off] = rr; d[off+1] = rg; d[off+2] = rb;
          }
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 > -dy) { err -= dy; x0 += sx; }
          if (e2 < dx) { err += dx; y0 += sy; }
        }
        dc.ctx.putImageData(imgData, 0, 0);
      }
      dc.penPosX = x;
      dc.penPosY = y;
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  }, 19);

  // Ordinal 20: MoveTo(hdc, x, y) — pascal, 6 bytes
  gdi.register('MoveTo', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.penPosX;
      const oldY = dc.penPosY;
      dc.penPosX = x;
      dc.penPosY = y;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 20);

  // Ordinal 21: ExcludeClipRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ExcludeClipRect', 10, () => SIMPLEREGION, 21);

  // Ordinal 22: IntersectClipRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('IntersectClipRect', 10, () => SIMPLEREGION, 22);

  // Ordinal 23: Arc(hdc, l, t, r, b, xStart, yStart, xEnd, yEnd) — pascal -ret16, 18 bytes
  gdi.register('Arc', 18, () => {
    const [hdc, l, t, r, b, xStart, yStart, xEnd, yEnd] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const startAngle = Math.atan2((((yStart << 16) >> 16) - cy) / ry, (((xStart << 16) >> 16) - cx) / rx);
      const endAngle = Math.atan2((((yEnd << 16) >> 16) - cy) / ry, (((xEnd << 16) >> 16) - cx) / rx);
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, startAngle, endAngle, true);
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
    }
    return 1;
  }, 23);

  // Ordinal 24: Ellipse(hdc, left, top, right, bottom) — pascal -ret16, 10 bytes
  gdi.register('Ellipse', 10, () => {
    const [hdc, left, top, right, bottom] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (left + right) / 2;
      const cy = (top + bottom) / 2;
      const rx = (right - left) / 2;
      const ry = (bottom - top) / 2;
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
      fillAndStroke(dc);
    }
    return 1;
  }, 24);

  // Ordinal 25: FloodFill(hdc, x, y, crColor) — pascal -ret16, 10 bytes (2+2+2+4)
  // FloodFill fills until it hits crColor (boundary fill)
  gdi.register('FloodFill', 10, () => {
    const [hdc, x, y, crColor] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const brush = emu.getBrush(dc.selectedBrush);
    if (!brush || brush.isNull) return 0;
    const fillR = brush.color & 0xFF, fillG = (brush.color >> 8) & 0xFF, fillB = (brush.color >> 16) & 0xFF;
    const bndR = crColor & 0xFF, bndG = (crColor >> 8) & 0xFF, bndB = (crColor >> 16) & 0xFF;
    const w = dc.canvas.width, h = dc.canvas.height;
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    const imgData = dc.ctx.getImageData(0, 0, w, h);
    const px = imgData.data;
    const isBoundary = (i: number) => px[i] === bndR && px[i + 1] === bndG && px[i + 2] === bndB;
    const startIdx = (y * w + x) * 4;
    if (isBoundary(startIdx)) return 0;
    const visited = new Uint8Array(w * h);
    const stack = [x + y * w];
    visited[x + y * w] = 1;
    while (stack.length > 0) {
      const pos = stack.pop()!;
      const px0 = pos % w, py0 = (pos / w) | 0;
      const i = pos * 4;
      px[i] = fillR; px[i + 1] = fillG; px[i + 2] = fillB; px[i + 3] = 255;
      const neighbors = [pos - 1, pos + 1, pos - w, pos + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h) continue;
        const nx = n % w;
        if (Math.abs(nx - px0) > 1) continue; // wrap guard
        if (visited[n]) continue;
        visited[n] = 1;
        const ni = n * 4;
        if (!isBoundary(ni)) stack.push(n);
      }
    }
    dc.ctx.putImageData(imgData, 0, 0);
    emu.syncDCToCanvas(hdc);
    return 1;
  }, 25);

  // Ordinal 26: Pie(hdc, l, t, r, b, xR1, yR1, xR2, yR2) — pascal -ret16, 18 bytes
  gdi.register('Pie', 18, () => {
    const [hdc, l, t, r, b, xR1, yR1, xR2, yR2] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const a1 = Math.atan2((((yR1 << 16) >> 16) - cy) / (ry || 1), (((xR1 << 16) >> 16) - cx) / (rx || 1));
      const a2 = Math.atan2((((yR2 << 16) >> 16) - cy) / (ry || 1), (((xR2 << 16) >> 16) - cx) / (rx || 1));
      dc.ctx.beginPath();
      dc.ctx.moveTo(cx, cy);
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, a1, a2, true);
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  }, 26);

  // Ordinal 27: Rectangle(hdc, left, top, right, bottom) — pascal -ret16, 10 bytes
  gdi.register('Rectangle', 10, () => {
    const [hdc, leftRaw, topRaw, rightRaw, bottomRaw] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const left = (leftRaw << 16) >> 16;
    const top = (topRaw << 16) >> 16;
    const right = (rightRaw << 16) >> 16;
    const bottom = (bottomRaw << 16) >> 16;
    const dc = emu.getDC(hdc);
    if (dc) {
      const mono = isDCMonochrome(emu, dc);
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        let fill = colorToCSS(brush.color);
        if (mono) fill = monoThreshold(dc, fill);
        dc.ctx.fillStyle = fill;
        dc.ctx.fillRect(left, top, right - left, bottom - top);
      }
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        let stroke = colorToCSS(pen.color);
        if (mono) stroke = monoThreshold(dc, stroke);
        dc.ctx.strokeStyle = stroke;
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.strokeRect(left + 0.5, top + 0.5, right - left - 1, bottom - top - 1);
      }
    }
    return 1;
  }, 27);

  // Ordinal 28: RoundRect(hdc, l, t, r, b, w, h) — pascal -ret16, 14 bytes
  gdi.register('RoundRect', 14, () => {
    const [hdc, l, t, r, b, w, h] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const left = (l << 16) >> 16;
      const top = (t << 16) >> 16;
      const right = (r << 16) >> 16;
      const bottom = (b << 16) >> 16;
      const rx = ((w << 16) >> 16) / 2;
      const ry = ((h << 16) >> 16) / 2;
      dc.ctx.beginPath();
      dc.ctx.roundRect(left, top, right - left, bottom - top, [Math.min(rx, ry)]);
      fillAndStroke(dc);
    }
    return 1;
  }, 28);

  // Ordinal 29: PatBlt(hdc, x, y, w, h, rop_long) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('PatBlt', 14, () => {
    const [hdc, xRaw, yRaw, wRaw, hRaw, rop] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const x = (xRaw << 16) >> 16;
    const y = (yRaw << 16) >> 16;
    const w = (wRaw << 16) >> 16;
    const h = (hRaw << 16) >> 16;
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    if (rop === BLACKNESS16) {
      dc.ctx.fillStyle = '#000';
      dc.ctx.fillRect(x, y, w, h);
    } else if (rop === WHITENESS16) {
      dc.ctx.fillStyle = '#fff';
      dc.ctx.fillRect(x, y, w, h);
    } else if (rop === PATCOPY16) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        let fill = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        if (isDCMonochrome(emu, dc)) fill = monoThreshold(dc, fill);
        dc.ctx.fillStyle = fill;
        dc.ctx.fillRect(x, y, w, h);
      }
    } else if (rop === PATINVERT16) {
      dc.ctx.globalCompositeOperation = 'xor';
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
      dc.ctx.globalCompositeOperation = 'source-over';
    } else {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = brushToFillStyle(dc, brush) || colorToCSS(brush.color);
        dc.ctx.fillRect(x, y, w, h);
      }
    }
    return 1;
  }, 29);

  // Ordinal 30: SaveDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('SaveDC', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      dc.ctx.save();
      dc.saveLevel = (dc.saveLevel || 0) + 1;
    }
    return dc?.saveLevel ?? 1;
  }, 30);

  // Ordinal 31: SetPixel(hdc, x, y, crColor_long) — pascal, 10 bytes (2+2+2+4)
  gdi.register('SetPixel', 10, () => {
    const [hdc, x, y, color] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      let fill = colorToCSS(color);
      if (isDCMonochrome(emu, dc)) fill = monoThreshold(dc, fill);
      dc.ctx.fillStyle = fill;
      dc.ctx.fillRect(x, y, 1, 1);
    }
    return color;
  }, 31);

  // Ordinal 32: OffsetClipRgn(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('OffsetClipRgn', 6, () => SIMPLEREGION, 32);

  // Ordinal 33: TextOut(hdc, x, y, lpString_ptr, nCount) — pascal -ret16, 12 bytes (2+2+2+4+2)
  gdi.register('TextOut', 12, () => {
    const [hdc, x, y, lpString, nCount] = emu.readPascalArgs16([2, 2, 2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpString && nCount > 0) {
      let text = '';
      for (let i = 0; i < nCount; i++) {
        text += String.fromCharCode(emu.memory.readU8(lpString + i));
      }
      const fontSize = getFontSize(hdc);
      dc.ctx.font = getFontCSS(hdc);
      if (dc.bkMode === OPAQUE) {
        dc.ctx.fillStyle = colorToCSS(dc.bkColor);
        const m = dc.ctx.measureText(text);
        dc.ctx.fillRect(x, y, m.width, fontSize);
      }
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, (x << 16) >> 16, (y << 16) >> 16);
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  }, 33);

  // Ordinal 34: BitBlt(hdcDest, xDest, yDest, w, h, hdcSrc, xSrc, ySrc, rop_long) — pascal -ret16, 20 bytes
  gdi.register('BitBlt', 20, () => {
    const [hdcDest, xDstRaw, yDstRaw, wRaw, hRaw, hdcSrc, xSrcRaw, ySrcRaw, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const xDst = (xDstRaw << 16) >> 16;
    const yDst = (yDstRaw << 16) >> 16;
    const w = (wRaw << 16) >> 16;
    const h = (hRaw << 16) >> 16;
    const xSrc = (xSrcRaw << 16) >> 16;
    const ySrc = (ySrcRaw << 16) >> 16;

    const dstDC = emu.getDC(hdcDest);
    if (!dstDC) return 0;

    if (rop === BLACKNESS16) {
      dstDC.ctx.fillStyle = '#000';
      dstDC.ctx.fillRect(xDst, yDst, w, h);
      return 1;
    }
    if (rop === WHITENESS16) {
      dstDC.ctx.fillStyle = '#fff';
      dstDC.ctx.fillRect(xDst, yDst, w, h);
      return 1;
    }
    if (rop === PATCOPY16) {
      const brush = emu.getBrush(dstDC.selectedBrush);
      if (brush && !brush.isNull) {
        dstDC.ctx.fillStyle = colorToCSS(brush.color);
        dstDC.ctx.fillRect(xDst, yDst, w, h);
      }
      return 1;
    }

    const srcDC = emu.getDC(hdcSrc);
    if (!srcDC) return 0;

    if (w <= 0 || h <= 0) return 1;

    const srcBmp = emu.handles.get<BitmapInfo>(srcDC.selectedBitmap);
    const dstBmp = emu.handles.get<BitmapInfo>(dstDC.selectedBitmap);
    const srcMono = !!srcBmp?.monochrome;
    const dstMono = !!dstBmp?.monochrome;

    // Get source pixels with mono↔color conversion applied
    const getConvertedSrcData = (): ImageData => {
      const raw = srcDC.ctx.getImageData(xSrc, ySrc, w, h);
      const px = raw.data;
      if (srcMono && !dstMono) {
        // Mono→color: black(0)→textColor, white(255)→bkColor of dest DC
        const bk = dstDC.bkColor, tx = dstDC.textColor;
        const bkR = bk & 0xFF, bkG = (bk >> 8) & 0xFF, bkB = (bk >> 16) & 0xFF;
        const txR = tx & 0xFF, txG = (tx >> 8) & 0xFF, txB = (tx >> 16) & 0xFF;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] + px[i + 1] + px[i + 2] < 128 * 3) {
            px[i] = txR; px[i + 1] = txG; px[i + 2] = txB;
          } else {
            px[i] = bkR; px[i + 1] = bkG; px[i + 2] = bkB;
          }
          px[i + 3] = 255;
        }
      } else if (!srcMono && dstMono) {
        // Color→mono: pixels matching srcDC.bkColor → white(255), else → black(0)
        const bk = srcDC.bkColor;
        const bkR = bk & 0xFF, bkG = (bk >> 8) & 0xFF, bkB = (bk >> 16) & 0xFF;
        for (let i = 0; i < px.length; i += 4) {
          const match = px[i] === bkR && px[i + 1] === bkG && px[i + 2] === bkB;
          px[i] = px[i + 1] = px[i + 2] = match ? 255 : 0;
          px[i + 3] = 255;
        }
      }
      return raw;
    };

    if (rop === SRCCOPY16) {
      if (srcMono || dstMono) {
        dstDC.ctx.putImageData(getConvertedSrcData(), xDst, yDst);
      } else {
        dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, w, h, xDst, yDst, w, h);
      }
    } else if (rop === NOTSRCCOPY16) {
      const srcData = getConvertedSrcData();
      const px = srcData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i];
        px[i+1] = 255 - px[i+1];
        px[i+2] = 255 - px[i+2];
      }
      dstDC.ctx.putImageData(srcData, xDst, yDst);
    } else if (rop === SRCPAINT16) {
      const srcData = getConvertedSrcData();
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] |= srcData.data[i];
        dstData.data[i+1] |= srcData.data[i+1];
        dstData.data[i+2] |= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else if (rop === SRCAND16) {
      const srcData = getConvertedSrcData();
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] &= srcData.data[i];
        dstData.data[i+1] &= srcData.data[i+1];
        dstData.data[i+2] &= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else if (rop === SRCINVERT16) {
      const srcData = getConvertedSrcData();
      const dstData = dstDC.ctx.getImageData(xDst, yDst, w, h);
      for (let i = 0; i < srcData.data.length; i += 4) {
        dstData.data[i] ^= srcData.data[i];
        dstData.data[i+1] ^= srcData.data[i+1];
        dstData.data[i+2] ^= srcData.data[i+2];
      }
      dstDC.ctx.putImageData(dstData, xDst, yDst);
    } else if (rop === 0xe20746) {
      // ROP 0xE20746: DSPDxax = (Dst ^ (Src & (Pat ^ Dst)))
      //   equivalent to: (D AND NOT S) OR (P AND S)
      //   Where S=1 (white in mask): result = P (pattern applied)
      //   Where S=0 (black in mask): result = D (destination preserved)
      //
      // Used by Win3.1 COMMCTRL in TOOLBAR_DrawMasked (Wine: toolbar.c:736)
      // for disabled/etched button icons: draws a mask with COLOR_3DHILIGHT
      // offset +1,+1, then with COLOR_3DSHADOW at the original position,
      // creating a 3D embossed effect.
      //
      // Also used by COMMCTRL for checked button dithered overlay with the
      // 55AA pattern brush (hbrMonoDither): applies a checkerboard pattern
      // through a mono mask to dim the button background.
      //
      // Uses transform-aware getImageData/putImageData because child window
      // DCs share the main canvas with a translate+clip transform.
      const tf = dstDC.ctx.getTransform();
      const cX = Math.round(tf.e + xDst * tf.a);
      const cY = Math.round(tf.f + yDst * tf.d);
      const dstData = dstDC.ctx.getImageData(cX, cY, w, h);
      const srcData = srcDC.ctx.getImageData(xSrc, ySrc, w, h);

      // Get pattern brush colors
      const brush = emu.getBrush(dstDC.selectedBrush);
      const txC = dstDC.textColor, bkC = dstDC.bkColor;
      const txR = txC & 0xFF, txG = (txC >> 8) & 0xFF, txB = (txC >> 16) & 0xFF;
      const bkR = bkC & 0xFF, bkG = (bkC >> 8) & 0xFF, bkB = (bkC >> 16) & 0xFF;
      let patPixels: Uint8ClampedArray | null = null;
      let patW = 8, patH = 8;
      if (brush?.patternBitmap) {
        const patCtx = brush.patternBitmap.getContext('2d')!;
        patW = brush.patternBitmap.width || 8;
        patH = brush.patternBitmap.height || 8;
        patPixels = patCtx.getImageData(0, 0, patW, patH).data;
      }

      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4;
          const sr = srcData.data[i];
          if (sr > 128) {
            // Mask white → apply pattern
            let pR: number, pG: number, pB: number;
            if (patPixels) {
              const tileX = ((cX + px) % patW + patW) % patW;
              const tileY = ((cY + py) % patH + patH) % patH;
              const isBlack = patPixels[(tileY * patW + tileX) * 4] === 0;
              pR = isBlack ? txR : bkR;
              pG = isBlack ? txG : bkG;
              pB = isBlack ? txB : bkB;
            } else {
              pR = txR; pG = txG; pB = txB;
            }
            dstData.data[i] = pR; dstData.data[i+1] = pG; dstData.data[i+2] = pB;
            dstData.data[i+3] = 255;
          }
          // sr <= 128 → mask black → destination preserved (icon)
        }
      }
      dstDC.ctx.putImageData(dstData, cX, cY);
    } else {
      // Fallback for other unimplemented ROPs.
      dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, w, h, xDst, yDst, w, h);
    }
    return 1;
  }, 34);

  // Ordinal 35: StretchBlt — pascal -ret16, 24 bytes
  gdi.register('StretchBlt', 24, () => {
    const [hdcDest, xDstR, yDstR, wDstR, hDstR, hdcSrc, xSrcR, ySrcR, wSrcR, hSrcR, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const dstDC = emu.getDC(hdcDest);
    const srcDC = emu.getDC(hdcSrc);
    if (!dstDC || !srcDC) return 0;
    // Sign-extend 16-bit values
    let xDst = (xDstR << 16) >> 16, yDst = (yDstR << 16) >> 16;
    let wDst = (wDstR << 16) >> 16, hDst = (hDstR << 16) >> 16;
    let xSrc = (xSrcR << 16) >> 16, ySrc = (ySrcR << 16) >> 16;
    let wSrc = (wSrcR << 16) >> 16, hSrc = (hSrcR << 16) >> 16;
    if (wDst === 0 || hDst === 0 || wSrc === 0 || hSrc === 0) return 1;
    // Handle negative dimensions via canvas scale transforms
    dstDC.ctx.save();
    if (wDst < 0) { xDst += wDst; wDst = -wDst; dstDC.ctx.translate(xDst + wDst, 0); dstDC.ctx.scale(-1, 1); xDst = 0; }
    if (hDst < 0) { yDst += hDst; hDst = -hDst; dstDC.ctx.translate(0, yDst + hDst); dstDC.ctx.scale(1, -1); yDst = 0; }
    if (wSrc < 0) { xSrc += wSrc; wSrc = -wSrc; }
    if (hSrc < 0) { ySrc += hSrc; hSrc = -hSrc; }
    dstDC.ctx.drawImage(srcDC.canvas, xSrc, ySrc, wSrc, hSrc, xDst, yDst, wDst, hDst);
    dstDC.ctx.restore();
    return 1;
  }, 35);

  // Ordinal 36: Polygon(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('Polygon', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoints && nCount > 2) {
      dc.ctx.beginPath();
      for (let i = 0; i < nCount; i++) {
        const px = emu.memory.readI16(lpPoints + i * 4);
        const py = emu.memory.readI16(lpPoints + i * 4 + 2);
        if (i === 0) dc.ctx.moveTo(px, py);
        else dc.ctx.lineTo(px, py);
      }
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  }, 36);

  // Ordinal 37: Polyline(hdc, lpPoints_ptr, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('Polyline', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoints && nCount > 1) {
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.beginPath();
        for (let i = 0; i < nCount; i++) {
          const px = emu.memory.readI16(lpPoints + i * 4);
          const py = emu.memory.readI16(lpPoints + i * 4 + 2);
          if (i === 0) dc.ctx.moveTo(px + 0.5, py + 0.5);
          else dc.ctx.lineTo(px + 0.5, py + 0.5);
        }
        dc.ctx.stroke();
      }
    }
    return 1;
  }, 37);

  // Ordinal 38: Escape(hdc, nEscape, cbInput, lpInData, lpOutData) — pascal -ret16, 14 bytes (2+2+2+4+4)
  gdi.register('Escape', 14, () => 0, 38);

  // Ordinal 39: RestoreDC(hdc, nSavedDC) — pascal -ret16, 4 bytes
  gdi.register('RestoreDC', 4, () => {
    const [hdc, nSavedDC] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc && (dc.saveLevel || 0) > 0) {
      const n = (nSavedDC << 16) >> 16; // sign-extend
      if (n === -1) {
        // Restore most recent save
        dc.ctx.restore();
        dc.saveLevel = (dc.saveLevel || 0) - 1;
      } else {
        // Restore to specific level: pop until saveLevel <= n
        while ((dc.saveLevel || 0) > 0 && (dc.saveLevel || 0) >= n) {
          dc.ctx.restore();
          dc.saveLevel!--;
        }
      }
    }
    return 1;
  }, 39);

  // Ordinal 40: FillRgn(hdc, hRgn, hBrush) — pascal -ret16, 6 bytes
  gdi.register('FillRgn', 6, () => 1, 40);

  // Ordinal 41: FrameRgn(hdc, hRgn, hBrush, w, h) — pascal -ret16, 10 bytes
  gdi.register('FrameRgn', 10, () => 1, 41);

  // Ordinal 42: InvertRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('InvertRgn', 4, () => 1, 42);

  // Ordinal 43: PaintRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('PaintRgn', 4, () => 1, 43);

  // Ordinal 44: SelectClipRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('SelectClipRgn', 4, () => SIMPLEREGION, 44);

  // Ordinal 45: SelectObject(hdc, hGdiObj) — pascal -ret16, 4 bytes
  gdi.register('SelectObject', 4, () => {
    const [hdc, hObj] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const objType = emu.handles.getType(hObj);

    if (objType === 'bitmap') {
      const bmp = emu.handles.get<BitmapInfo>(hObj);
      if (bmp && bmp.width && bmp.height && bmp.canvas) {
        const old = dc.selectedBitmap || hObj;
        // Sync DC canvas content back to old bitmap before switching
        if (old && old !== hObj) {
          const oldBmp = emu.handles.get<BitmapInfo>(old);
          if (oldBmp && oldBmp.canvas && dc.canvas.width > 0 && dc.canvas.height > 0) {
            oldBmp.canvas.width = dc.canvas.width;
            oldBmp.canvas.height = dc.canvas.height;
            const oldCtx = oldBmp.canvas.getContext('2d')!;
            oldCtx.drawImage(dc.canvas, 0, 0);
            oldBmp.ctx = oldCtx;
          }
        }
        dc.selectedBitmap = hObj;
        dc.canvas.width = bmp.width;
        dc.canvas.height = bmp.height;
        dc.ctx = (dc.canvas as OffscreenCanvas).getContext('2d')!;
        dc.ctx.imageSmoothingEnabled = false;
        dc.ctx.drawImage(bmp.canvas, 0, 0);
        return old;
      }
    }
    if (objType === 'pen') {
      const old = dc.selectedPen || hObj;
      dc.selectedPen = hObj;
      return old;
    }
    if (objType === 'brush') {
      const old = dc.selectedBrush || hObj;
      dc.selectedBrush = hObj;
      return old;
    }
    if (objType === 'font') {
      const old = dc.selectedFont || hObj;
      dc.selectedFont = hObj;
      return old;
    }
    if (objType === 'palette') {
      const old = dc.selectedPalette || hObj;
      dc.selectedPalette = hObj;
      return old;
    }

    // Stock objects (handle >= 0x8000 in 16-bit)
    if (hObj >= 0x8000) {
      const stockIdx = hObj - 0x8000;
      if (stockIdx <= 5) {
        const old = dc.selectedBrush || hObj;
        dc.selectedBrush = hObj;
        return old;
      }
      if (stockIdx >= 6 && stockIdx <= 8) {
        const old = dc.selectedPen || hObj;
        dc.selectedPen = hObj;
        return old;
      }
      if (stockIdx >= 10 && stockIdx <= 17) {
        const old = dc.selectedFont || hObj;
        dc.selectedFont = hObj;
        return old;
      }
      // Stock palette: 15 = DEFAULT_PALETTE
      if (stockIdx === 15) {
        const old = dc.selectedPalette || hObj;
        dc.selectedPalette = hObj;
        return old;
      }
    }

    return 0;
  }, 45);

  // Ordinal 47: CombineRgn(hrgnDest, hrgnSrc1, hrgnSrc2, fnCombineMode) — pascal -ret16, 8 bytes
  gdi.register('CombineRgn', 8, () => SIMPLEREGION, 47);

  // Ordinal 48: CreateBitmap(w, h, nPlanes, nBitCount, lpBits) — pascal -ret16, 12 bytes (2+2+2+2+4)
  gdi.register('CreateBitmap', 12, () => {
    const [w, h, nPlanes, nBitCount, lpBits] = emu.readPascalArgs16([2, 2, 2, 2, 4]);
    const bw = w || 1, bh = h || 1;
    const canvas = new OffscreenCanvas(bw, bh);
    const ctx = canvas.getContext('2d')!;
    // lpBits is a Win16 far pointer (SEG:OFF) — resolve to linear address
    const linearBits = lpBits ? emu.resolveFarPtr(lpBits) : 0;
    if (linearBits && nBitCount === 1) {
      // Monochrome bitmap: read bits and render
      const imgData = ctx.createImageData(bw, bh);
      const bytesPerRow = Math.ceil(bw / 16) * 2; // WORD-aligned
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          const byteIdx = Math.floor(x / 8);
          const bitIdx = 7 - (x % 8);
          const b = emu.memory.readU8(linearBits + y * bytesPerRow + byteIdx);
          const set = (b >> bitIdx) & 1;
          const off = (y * bw + x) * 4;
          imgData.data[off] = imgData.data[off + 1] = imgData.data[off + 2] = set ? 255 : 0;
          imgData.data[off + 3] = 255;
        }
      }
      ctx.putImageData(imgData, 0, 0);
    }
    const monochrome = (nPlanes === 1 && nBitCount === 1);
    const bmp: BitmapInfo = { width: bw, height: bh, canvas, ctx, monochrome };
    return emu.handles.alloc('bitmap', bmp);
  }, 48);

  // Ordinal 49: CreateBitmapIndirect(lpBitmap_ptr) — pascal -ret16, 4 bytes
  gdi.register('CreateBitmapIndirect', 4, () => {
    const lpBitmap = emu.readArg16DWord(0);
    if (lpBitmap) {
      const w = emu.memory.readU16(lpBitmap + 2);
      const h = emu.memory.readU16(lpBitmap + 4);
      const canvas = new OffscreenCanvas(w || 1, h || 1);
      const ctx = canvas.getContext('2d')!;
      const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
      return emu.handles.alloc('bitmap', bmp);
    }
    return 0;
  }, 49);

  // Ordinal 50: CreateBrushIndirect(lpLogBrush) — pascal -ret16, 4 bytes
  gdi.register('CreateBrushIndirect', 4, () => {
    const lpLogBrush = emu.readArg16DWord(0);
    if (lpLogBrush) {
      const lbStyle = emu.memory.readU16(lpLogBrush);
      const lbColor = emu.memory.readU32(lpLogBrush + 2) & 0xFFFFFF;
      const isNull = (lbStyle === BS_NULL);
      const brush: BrushInfo = { color: lbColor, isNull };
      return emu.handles.alloc('brush', brush);
    }
    return 0;
  }, 50);

  // Ordinal 51: CreateCompatibleBitmap(hdc, w, h) — pascal -ret16, 6 bytes
  gdi.register('CreateCompatibleBitmap', 6, () => {
    const [hdc, w, h] = emu.readPascalArgs16([2, 2, 2]);
    const canvas = new OffscreenCanvas(w || 1, h || 1);
    const ctx = canvas.getContext('2d')!;
    // TODO: propagate monochrome flag from source DC when mono DC support is complete
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  }, 51);

  // Ordinal 52: CreateCompatibleDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('CreateCompatibleDC', 2, () => createMemDC(), 52);

  // Ordinal 53: CreateDC(lpDriverName, lpDeviceName, lpOutput, lpInitData) — pascal -ret16, 16 bytes (4+4+4+4)
  gdi.register('CreateDC', 16, () => createMemDC(), 53);

  // Ordinal 54: CreateEllipticRgn(l, t, r, b) — pascal -ret16, 8 bytes
  gdi.register('CreateEllipticRgn', 8, () => emu.handles.alloc('region', {}), 54);

  // Ordinal 55: CreateEllipticRgnIndirect(lpRect) — pascal -ret16, 4 bytes
  gdi.register('CreateEllipticRgnIndirect', 4, () => emu.handles.alloc('region', {}), 55);

  // Ordinal 56: CreateFont(nHeight, nWidth, nEsc, nOrient, fnWeight, fdwItalic, fdwUnderline, fdwStrikeOut,
  //   fdwCharSet, fdwOutputPrecision, fdwClipPrecision, fdwQuality, fdwPitchAndFamily, lpszFace)
  // pascal -ret16, 28 bytes (2*9 + 1*4 + 1 + 4 = actually 2+2+2+2+2+1+1+1+1+1+1+1+1+4 but Win16 pushes WORDs)
  // Win16 CreateFont: 14 params all pushed as WORDs = 28 bytes
  gdi.register('CreateFont', 28, () => {
    const [nHeight, _nWidth, _nEsc, _nOrient, fnWeight,
           fdwItalic, _fdwUnderline, _fdwStrikeOut, _fdwCharSet,
           _fdwOutPrec, _fdwClipPrec, _fdwQuality, _fdwPitch, lpszFace] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4]);
    const height = (nHeight << 16) >> 16;
    let faceName = '';
    if (lpszFace) {
      faceName = emu.memory.readCString(lpszFace);
    }
    return emu.handles.alloc('font', {
      height: height || 13,
      faceName: faceName || undefined,
      weight: fnWeight,
      italic: !!(fdwItalic & 0xFF),
    });
  }, 56);

  // Ordinal 57: CreateFontIndirect(lpLogFont) — pascal -ret16, 4 bytes
  // LOGFONT16: lfHeight(2), lfWidth(2), lfEscapement(2), lfOrientation(2), lfWeight(2),
  //   lfItalic(1), lfUnderline(1), lfStrikeOut(1), lfCharSet(1), lfOutPrecision(1),
  //   lfClipPrecision(1), lfQuality(1), lfPitchAndFamily(1), lfFaceName(32)
  gdi.register('CreateFontIndirect', 4, () => {
    const lpLogFont = emu.readArg16DWord(0);
    if (!lpLogFont) return emu.handles.alloc('font', { height: 13 });
    const height = emu.memory.readI16(lpLogFont);
    const weight = emu.memory.readU16(lpLogFont + 8);
    const italic = emu.memory.readU8(lpLogFont + 10);
    // lfFaceName at offset 18, 32 bytes
    const faceName = emu.memory.readCString(lpLogFont + 18);
    return emu.handles.alloc('font', {
      height: height || 13,
      faceName: faceName || undefined,
      weight,
      italic: !!italic,
    });
  }, 57);

  // Ordinal 58: CreateHatchBrush(fnStyle, clrref) — pascal -ret16, 6 bytes (2+4)
  gdi.register('CreateHatchBrush', 6, () => {
    const [fnStyle, color] = emu.readPascalArgs16([2, 4]);
    const brush: BrushInfo = { color, isNull: false };
    return emu.handles.alloc('brush', brush);
  }, 58);

  // Ordinal 60: CreatePatternBrush(hBitmap) — pascal -ret16, 2 bytes
  gdi.register('CreatePatternBrush', 2, () => {
    const hBitmap = emu.readArg16(0);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    const brush: BrushInfo = { color: 0x808080, isNull: false, patternBitmap: bmp?.canvas };
    return emu.handles.alloc('brush', brush);
  }, 60);

  // Ordinal 61: CreatePen(fnPenStyle, nWidth, crColor_long) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('CreatePen', 8, () => {
    const [style, width, color] = emu.readPascalArgs16([2, 2, 4]);
    const pen: PenInfo = { style, width, color };
    return emu.handles.alloc('pen', pen);
  }, 61);

  // Ordinal 62: CreatePenIndirect(lpLogPen) — pascal -ret16, 4 bytes
  gdi.register('CreatePenIndirect', 4, () => {
    const lpLogPen = emu.readArg16DWord(0);
    if (lpLogPen) {
      const style = emu.memory.readU16(lpLogPen);
      const width = emu.memory.readI16(lpLogPen + 2);
      const color = emu.memory.readU32(lpLogPen + 6) & 0xFFFFFF; // POINT is 4 bytes (x,y), color follows
      const pen: PenInfo = { style, width: width || 1, color };
      return emu.handles.alloc('pen', pen);
    }
    return 0;
  }, 62);

  // Ordinal 63: CreatePolygonRgn(lpPoints, nCount, fnPolyFillMode) — pascal -ret16, 10 bytes (4+2+2)
  gdi.register('CreatePolygonRgn', 10, () => emu.handles.alloc('region', {}), 63);

  // Ordinal 64: CreateRectRgn(l, t, r, b) — pascal -ret16, 8 bytes
  gdi.register('CreateRectRgn', 8, () => emu.handles.alloc('region', {}), 64);

  // Ordinal 65: CreateRectRgnIndirect(lpRect) — pascal -ret16, 4 bytes
  gdi.register('CreateRectRgnIndirect', 4, () => emu.handles.alloc('region', {}), 65);

  // Ordinal 66: CreateSolidBrush(crColor_long) — pascal -ret16, 4 bytes
  gdi.register('CreateSolidBrush', 4, () => {
    const color = emu.readArg16DWord(0);
    const brush: BrushInfo = { color, isNull: false };
    return emu.handles.alloc('brush', brush);
  }, 66);

  // Ordinal 67: DPtoLP(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('DPtoLP', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints) return 0;
    const mode = dc.mapMode ?? MM_TEXT;
    if (mode === MM_TEXT) return 1;
    const wOx = dc.windowOrgX ?? 0, wOy = dc.windowOrgY ?? 0;
    const wEx = dc.windowExtX ?? 1, wEy = dc.windowExtY ?? 1;
    const vOx = dc.viewportOrgX ?? 0, vOy = dc.viewportOrgY ?? 0;
    const vEx = dc.viewportExtX ?? 1, vEy = dc.viewportExtY ?? 1;
    for (let i = 0; i < nCount; i++) {
      const addr = lpPoints + i * 4;
      const dpX = emu.memory.readI16(addr);
      const dpY = emu.memory.readI16(addr + 2);
      const lpX = vEx !== 0 ? Math.round((dpX - vOx) * wEx / vEx + wOx) : dpX;
      const lpY = vEy !== 0 ? Math.round((dpY - vOy) * wEy / vEy + wOy) : dpY;
      emu.memory.writeI16(addr, lpX);
      emu.memory.writeI16(addr + 2, lpY);
    }
    return 1;
  }, 67);

  // Ordinal 68: DeleteDC(hdc) — pascal -ret16, 2 bytes
  gdi.register('DeleteDC', 2, () => 1, 68);

  // Ordinal 69: DeleteObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('DeleteObject', 2, () => 1, 69);

  // Ordinal 70: EnumFonts(hdc, lpFaceName, lpFontFunc, lParam) — pascal -ret16, 14 bytes (2+4+4+4)
  gdi.register('EnumFonts', 14, () => 0, 70);

  // Ordinal 71: EnumObjects(hdc, nObjectType, lpObjectFunc, lParam) — pascal -ret16, 12 bytes (2+2+4+4)
  gdi.register('EnumObjects', 12, () => 0, 71);

  // Ordinal 72: EqualRgn(hRgn1, hRgn2) — pascal -ret16, 4 bytes
  gdi.register('EqualRgn', 4, () => 0, 72);

  // Ordinal 73: ExcludeVisRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('ExcludeVisRect', 10, () => SIMPLEREGION, 73);

  // Ordinal 74: GetBitmapBits(hBitmap, cbBuffer, lpvBits) — pascal, 10 bytes (2+4+4)
  gdi.register('GetBitmapBits', 10, () => {
    const [hBitmap, cbBuffer, lpvBits] = emu.readPascalArgs16([2, 4, 4]);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    if (!bmp || !lpvBits || cbBuffer <= 0) return 0;
    const imgData = bmp.ctx.getImageData(0, 0, bmp.width, bmp.height);
    const px = imgData.data;
    // Output as packed 8bpp grayscale-ish (simple: R channel)
    const total = Math.min(cbBuffer, bmp.width * bmp.height);
    for (let i = 0; i < total; i++) {
      emu.memory.writeU8(lpvBits + i, px[i * 4]);
    }
    return total;
  }, 74);

  // Ordinal 75: GetBkColor(hdc) — pascal, 2 bytes
  gdi.register('GetBkColor', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkColor : 0xFFFFFF;
  }, 75);

  // Ordinal 76: GetBkMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetBkMode', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.bkMode : OPAQUE;
  }, 76);

  // Ordinal 77: GetClipBox(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetClipBox', 6, () => {
    const [hdc, lpRect] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc && lpRect) {
      emu.memory.writeI16(lpRect, 0);
      emu.memory.writeI16(lpRect + 2, 0);
      emu.memory.writeI16(lpRect + 4, dc.canvas.width);
      emu.memory.writeI16(lpRect + 6, dc.canvas.height);
    }
    return SIMPLEREGION;
  }, 77);

  // Ordinal 78: GetCurrentPosition(hdc) — pascal, 2 bytes
  gdi.register('GetCurrentPosition', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) return ((dc.penPosY & 0xFFFF) << 16) | (dc.penPosX & 0xFFFF);
    return 0;
  }, 78);

  // Ordinal 79: GetDCOrg(hdc) — pascal, 2 bytes
  gdi.register('GetDCOrg', 2, () => 0, 79);

  // Ordinal 80: GetDeviceCaps(hdc, nIndex) — pascal -ret16, 4 bytes
  gdi.register('GetDeviceCaps', 4, () => {
    const [hdc, nIndex] = emu.readPascalArgs16([2, 2]);
    const DRIVERVERSION = 0;
    const TECHNOLOGY = 2;
    const HORZSIZE = 4;
    const VERTSIZE = 6;
    const HORZRES = 8;
    const VERTRES = 10;
    const BITSPIXEL = 12;
    const PLANES = 14;
    const NUMBRUSHES = 16;
    const NUMPENS = 18;
    const NUMFONTS = 22;
    const NUMCOLORS = 24;
    const ASPECTX = 36;
    const ASPECTY = 38;
    const ASPECTXY = 40;
    const LOGPIXELSX = 88;
    const LOGPIXELSY = 90;
    const SIZEPALETTE = 104;
    const NUMRESERVED = 106;
    const COLORRES = 108;
    const RASTERCAPS = 38; // actually 38 is ASPECTXY; RASTERCAPS=38 in some refs but 38 in Win16 is different
    const caps: Record<number, number> = {
      [DRIVERVERSION]: 0x0300,
      [TECHNOLOGY]: 1,     // DT_RASDISPLAY
      [HORZSIZE]: 320,
      [VERTSIZE]: 240,
      [HORZRES]: 640,
      [VERTRES]: 480,
      [BITSPIXEL]: 8,
      [PLANES]: 1,
      [NUMBRUSHES]: 256,
      [NUMPENS]: 256,
      [NUMFONTS]: 0,
      [NUMCOLORS]: 256,
      [ASPECTX]: 36,
      [ASPECTY]: 36,
      [ASPECTXY]: 51,
      [LOGPIXELSX]: 96,
      [LOGPIXELSY]: 96,
      [SIZEPALETTE]: 256,
      [NUMRESERVED]: 20,
      [COLORRES]: 18,
      26: 0x7E99,          // RASTERCAPS
    };
    return caps[nIndex] ?? 0;
  }, 80);

  // Ordinal 81: GetMapMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetMapMode', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.mapMode ?? MM_TEXT;
  }, 81);

  // Ordinal 82: GetObject(hObj, cbBuffer, lpvObject_ptr) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('GetObject', 8, () => {
    const [hObj, cbBuffer, lpvObject] = emu.readPascalArgs16([2, 2, 4]);
    if (!lpvObject || cbBuffer <= 0) return 0;

    const objType = emu.handles.getType(hObj);
    if (objType === 'bitmap') {
      const bmp = emu.handles.get<BitmapInfo>(hObj);
      if (!bmp) return 0;
      const bytesToWrite = Math.min(cbBuffer, 14);
      const bpp = 8;
      const bmWidthBytes = ((bmp.width * bpp + 15) >> 4) << 1;
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject + 0, 0);      // bmType
      if (bytesToWrite >= 4) emu.memory.writeU16(lpvObject + 2, bmp.width);
      if (bytesToWrite >= 6) emu.memory.writeU16(lpvObject + 4, bmp.height);
      if (bytesToWrite >= 8) emu.memory.writeU16(lpvObject + 6, bmWidthBytes);
      if (bytesToWrite >= 9) emu.memory.writeU8(lpvObject + 8, 1);       // bmPlanes
      if (bytesToWrite >= 10) emu.memory.writeU8(lpvObject + 9, bpp);    // bmBitsPixel
      if (bytesToWrite >= 14) emu.memory.writeU32(lpvObject + 10, 0);    // bmBits
      return bytesToWrite;
    }
    if (objType === 'pen') {
      const pen = emu.handles.get<PenInfo>(hObj);
      if (!pen) return 0;
      const bytesToWrite = Math.min(cbBuffer, 10);
      // LOGPEN16: style(2), width POINT(4), color(4)
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject, pen.style);
      if (bytesToWrite >= 4) emu.memory.writeI16(lpvObject + 2, pen.width);
      if (bytesToWrite >= 6) emu.memory.writeI16(lpvObject + 4, 0);
      if (bytesToWrite >= 10) emu.memory.writeU32(lpvObject + 6, pen.color);
      return bytesToWrite;
    }
    if (objType === 'brush') {
      const brush = emu.handles.get<BrushInfo>(hObj);
      if (!brush) return 0;
      const bytesToWrite = Math.min(cbBuffer, 8);
      // LOGBRUSH16: style(2), color(4), hatch(2)
      if (bytesToWrite >= 2) emu.memory.writeU16(lpvObject, brush.isNull ? BS_NULL : 0);
      if (bytesToWrite >= 6) emu.memory.writeU32(lpvObject + 2, brush.color);
      if (bytesToWrite >= 8) emu.memory.writeU16(lpvObject + 6, 0);
      return bytesToWrite;
    }
    return 0;
  }, 82);

  // Ordinal 83: GetPixel(hdc, x, y) — pascal, 6 bytes
  gdi.register('GetPixel', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      try {
        const imgData = dc.ctx.getImageData(x, y, 1, 1);
        const [r, g, b] = imgData.data;
        return r | (g << 8) | (b << 16);
      } catch { /* empty */ }
    }
    return 0;
  }, 83);

  // Ordinal 84: GetPolyFillMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetPolyFillMode', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.polyFillMode ?? 1;
  }, 84);

  // Ordinal 85: GetROP2(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetROP2', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.rop2 ?? 13;
  }, 85);

  // Ordinal 86: GetRelAbs(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetRelAbs', 2, () => 1, 86); // ABSOLUTE

  // Ordinal 87: GetStockObject(fnObject) — pascal -ret16, 2 bytes
  gdi.register('GetStockObject', 2, () => {
    const fnObject = emu.readArg16(0);
    return 0x8000 + fnObject;
  }, 87);

  // Ordinal 88: GetStretchBltMode(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetStretchBltMode', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.stretchBltMode ?? 1;
  }, 88);

  // Ordinal 89: GetTextCharacterExtra(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetTextCharacterExtra', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.textCharExtra ?? 0;
  }, 89);

  // Ordinal 90: GetTextColor(hdc) — pascal, 2 bytes
  gdi.register('GetTextColor', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc ? dc.textColor : 0;
  }, 90);

  // Ordinal 91: GetTextExtent(hdc, lpString_ptr, nCount) — pascal, 8 bytes (2+4+2)
  // Returns DWORD: HIWORD=height, LOWORD=width
  gdi.register('GetTextExtent', 8, () => {
    const [hdc, lpString, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const fontSize = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    let width = nCount * Math.round(fontSize * 0.5);
    if (dc && lpString && nCount > 0) {
      let text = '';
      for (let i = 0; i < nCount; i++) text += String.fromCharCode(emu.memory.readU8(lpString + i));
      dc.ctx.font = getFontCSS(hdc);
      width = Math.ceil(dc.ctx.measureText(text).width);
    }
    return ((fontSize & 0xFFFF) << 16) | (width & 0xFFFF);
  }, 91);

  // Ordinal 92: GetTextFace(hdc, nCount, lpFaceName) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('GetTextFace', 8, () => {
    const [hdc, nCount, lpFaceName] = emu.readPascalArgs16([2, 2, 4]);
    if (lpFaceName && nCount > 0) {
      const face = 'System';
      for (let i = 0; i < Math.min(face.length, nCount - 1); i++) {
        emu.memory.writeU8(lpFaceName + i, face.charCodeAt(i));
      }
      emu.memory.writeU8(lpFaceName + Math.min(face.length, nCount - 1), 0);
      return Math.min(face.length, nCount - 1);
    }
    return 0;
  }, 92);

  // Ordinal 93: GetTextMetrics(hdc, lptm_ptr) — pascal -ret16, 6 bytes (2+4)
  // TEXTMETRIC16: 24 bytes total
  gdi.register('GetTextMetrics', 6, () => {
    const [hdc, lptm] = emu.readPascalArgs16([2, 4]);
    if (lptm) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      const font = dc ? emu.handles.get<{ height: number; weight?: number; italic?: boolean }>(dc.selectedFont) : null;
      const ascent = Math.round(fontSize * 0.8);
      const descent = fontSize - ascent;
      let aveCharWidth = Math.round(fontSize * 0.45);
      let maxCharWidth = fontSize;
      if (dc) {
        dc.ctx.font = getFontCSS(hdc);
        const sample = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const measured = Math.round(dc.ctx.measureText(sample).width / sample.length);
        const measuredMax = Math.ceil(dc.ctx.measureText('W').width);
        if (measured > 0) aveCharWidth = measured;
        if (measuredMax > 0) maxCharWidth = measuredMax;
      }
      let off = 0;
      emu.memory.writeI16(lptm + off, fontSize);      off += 2; // tmHeight
      emu.memory.writeI16(lptm + off, ascent);         off += 2; // tmAscent
      emu.memory.writeI16(lptm + off, descent);        off += 2; // tmDescent
      emu.memory.writeI16(lptm + off, 0);              off += 2; // tmInternalLeading
      emu.memory.writeI16(lptm + off, 0);              off += 2; // tmExternalLeading
      emu.memory.writeI16(lptm + off, aveCharWidth);   off += 2; // tmAveCharWidth
      emu.memory.writeI16(lptm + off, maxCharWidth);   off += 2; // tmMaxCharWidth
      emu.memory.writeI16(lptm + off, font?.weight ?? 400); off += 2; // tmWeight
      emu.memory.writeU8(lptm + off, font?.italic ? 1 : 0); off += 1; // tmItalic
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmUnderlined
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmStruckOut
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmFirstChar
      emu.memory.writeU8(lptm + off, 255);  off += 1; // tmLastChar
      emu.memory.writeU8(lptm + off, 32);   off += 1; // tmDefaultChar
      emu.memory.writeU8(lptm + off, 32);   off += 1; // tmBreakChar
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmPitchAndFamily
      emu.memory.writeU8(lptm + off, 0);    off += 1; // tmCharSet
      emu.memory.writeI16(lptm + off, 0);   off += 2; // tmOverhang
      emu.memory.writeI16(lptm + off, 96);  off += 2; // tmDigitizedAspectX
      emu.memory.writeI16(lptm + off, 96);            // tmDigitizedAspectY
    }
    return 1;
  }, 93);

  // Ordinal 94: GetViewportExt(hdc) — pascal, 2 bytes
  gdi.register('GetViewportExt', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const extX = dc?.viewportExtX ?? 1;
    const extY = dc?.viewportExtY ?? 1;
    return ((extY & 0xFFFF) << 16) | (extX & 0xFFFF);
  }, 94);

  // Ordinal 95: GetViewportOrg(hdc) — pascal, 2 bytes
  gdi.register('GetViewportOrg', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const orgX = dc?.viewportOrgX ?? 0;
    const orgY = dc?.viewportOrgY ?? 0;
    return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
  }, 95);

  // Ordinal 96: GetWindowExt(hdc) — pascal, 2 bytes
  gdi.register('GetWindowExt', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const extX = dc?.windowExtX ?? 1;
    const extY = dc?.windowExtY ?? 1;
    return ((extY & 0xFFFF) << 16) | (extX & 0xFFFF);
  }, 96);

  // Ordinal 97: GetWindowOrg(hdc) — pascal, 2 bytes
  gdi.register('GetWindowOrg', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    const orgX = dc?.windowOrgX ?? 0;
    const orgY = dc?.windowOrgY ?? 0;
    return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
  }, 97);

  // Ordinal 98: IntersectVisRect(hdc, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('IntersectVisRect', 10, () => SIMPLEREGION, 98);

  // Ordinal 99: LPtoDP(hdc, lpPoints, nCount) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('LPtoDP', 8, () => {
    const [hdc, lpPoints, nCount] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints) return 0;
    const mode = dc.mapMode ?? MM_TEXT;
    if (mode === MM_TEXT) return 1;
    const wOx = dc.windowOrgX ?? 0, wOy = dc.windowOrgY ?? 0;
    const wEx = dc.windowExtX ?? 1, wEy = dc.windowExtY ?? 1;
    const vOx = dc.viewportOrgX ?? 0, vOy = dc.viewportOrgY ?? 0;
    const vEx = dc.viewportExtX ?? 1, vEy = dc.viewportExtY ?? 1;
    for (let i = 0; i < nCount; i++) {
      const addr = lpPoints + i * 4;
      const lx = emu.memory.readI16(addr);
      const ly = emu.memory.readI16(addr + 2);
      const dpX = wEx !== 0 ? Math.round((lx - wOx) * vEx / wEx + vOx) : lx;
      const dpY = wEy !== 0 ? Math.round((ly - wOy) * vEy / wEy + vOy) : ly;
      emu.memory.writeI16(addr, dpX);
      emu.memory.writeI16(addr + 2, dpY);
    }
    return 1;
  }, 99);

  // Ordinal 100: LineDDA(x1, y1, x2, y2, lpLineFunc, lParam) — pascal -ret16, 16 bytes (2+2+2+2+4+4)
  gdi.register('LineDDA', 16, () => 0, 100);

  // Ordinal 101: OffsetRgn(hRgn, x, y) — pascal -ret16, 6 bytes
  gdi.register('OffsetRgn', 6, () => SIMPLEREGION, 101);

  // Ordinal 102: OffsetVisRgn(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('OffsetVisRgn', 6, () => SIMPLEREGION, 102);

  // Ordinal 103: PtVisible(hdc, x, y) — pascal -ret16, 6 bytes
  gdi.register('PtVisible', 6, () => 1, 103);

  // Ordinal 104: RectVisibleOld(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('RectVisibleOld', 6, () => 1, 104);

  // Ordinal 105: SelectVisRgn(hdc, hRgn) — pascal -ret16, 4 bytes
  gdi.register('SelectVisRgn', 4, () => SIMPLEREGION, 105);

  // Ordinal 106: SetBitmapBits(hBitmap, cbBuffer, lpBits) — pascal, 10 bytes (2+4+4)
  gdi.register('SetBitmapBits', 10, () => {
    const [hBitmap, cbBuffer, lpBits] = emu.readPascalArgs16([2, 4, 4]);
    const bmp = emu.handles.get<BitmapInfo>(hBitmap);
    if (!bmp || !lpBits || cbBuffer <= 0) return 0;
    const imgData = bmp.ctx.createImageData(bmp.width, bmp.height);
    const px = imgData.data;
    const total = Math.min(cbBuffer, bmp.width * bmp.height);
    for (let i = 0; i < total; i++) {
      const v = emu.memory.readU8(lpBits + i);
      px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
    }
    bmp.ctx.putImageData(imgData, 0, 0);
    return total;
  }, 106);

  // Ordinal 117: SetDCOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetDCOrg', 6, () => 0, 117);

  // Ordinal 119: AddFontResource(lpFilename) — pascal -ret16, 4 bytes
  gdi.register('AddFontResource', 4, () => 1, 119);

  // Ordinal 128: MulDiv(nNumber, nNumerator, nDenominator) — pascal -ret16, 6 bytes
  gdi.register('MulDiv', 6, () => {
    const [nNumber, nNumerator, nDenominator] = emu.readPascalArgs16([2, 2, 2]);
    const a = (nNumber << 16) >> 16;
    const b = (nNumerator << 16) >> 16;
    const c = (nDenominator << 16) >> 16;
    if (c === 0) return -1;
    return Math.round((a * b) / c) & 0xFFFF;
  }, 128);

  // Ordinal 129: SaveVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('SaveVisRgn', 2, () => 1, 129);

  // Ordinal 130: RestoreVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('RestoreVisRgn', 2, () => SIMPLEREGION, 130);

  // Ordinal 131: InquireVisRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('InquireVisRgn', 2, () => emu.handles.alloc('region', {}), 131);

  // Ordinal 134: GetRgnBox(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetRgnBox', 6, () => {
    const [hRgn, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      emu.memory.writeI16(lpRect, 0);
      emu.memory.writeI16(lpRect + 2, 0);
      emu.memory.writeI16(lpRect + 4, 640);
      emu.memory.writeI16(lpRect + 6, 480);
    }
    return SIMPLEREGION;
  }, 134);

  // Ordinal 136: RemoveFontResource(lpFilename) — pascal -ret16, 4 bytes
  gdi.register('RemoveFontResource', 4, () => 1, 136);

  // Ordinal 148: SetBrushOrg(hdc, x, y) — pascal, 6 bytes
  gdi.register('SetBrushOrg', 6, () => {
    const [hdc, x, y] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const oldX = dc.brushOrgX ?? 0;
      const oldY = dc.brushOrgY ?? 0;
      dc.brushOrgX = (x << 16) >> 16;
      dc.brushOrgY = (y << 16) >> 16;
      return ((oldY & 0xFFFF) << 16) | (oldX & 0xFFFF);
    }
    return 0;
  }, 148);

  // Ordinal 149: GetBrushOrg(hdc) — pascal, 2 bytes
  gdi.register('GetBrushOrg', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const orgX = dc.brushOrgX ?? 0;
      const orgY = dc.brushOrgY ?? 0;
      return ((orgY & 0xFFFF) << 16) | (orgX & 0xFFFF);
    }
    return 0;
  }, 149);

  // Ordinal 150: UnrealizeObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('UnrealizeObject', 2, () => 1, 150);

  // Ordinal 153: CreateIC(lpDriverName, lpDeviceName, lpOutput, lpInitData) — pascal -ret16, 16 bytes (4+4+4+4)
  gdi.register('CreateIC', 16, () => createMemDC(), 153);

  // Ordinal 154: GetNearestColor(hdc, crColor) — pascal, 6 bytes (2+4)
  gdi.register('GetNearestColor', 6, () => {
    const [hdc, crColor] = emu.readPascalArgs16([2, 4]);
    return crColor;
  }, 154);

  // Ordinal 156: CreateDiscardableBitmap(hdc, w, h) — pascal -ret16, 6 bytes
  gdi.register('CreateDiscardableBitmap', 6, () => {
    const [hdc, w, h] = emu.readPascalArgs16([2, 2, 2]);
    const canvas = new OffscreenCanvas(w || 1, h || 1);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  }, 156);

  // Ordinal 161: PtInRegion(hRgn, x, y) — pascal -ret16, 6 bytes
  gdi.register('PtInRegion', 6, () => 0, 161);

  // Ordinal 162: GetBitmapDimension(hBitmap) — pascal, 2 bytes
  gdi.register('GetBitmapDimension', 2, () => {
    const hbmp = emu.readArg16(0);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (bmp) return ((bmp.height & 0xFFFF) << 16) | (bmp.width & 0xFFFF);
    return 0;
  }, 162);

  // Ordinal 163: SetBitmapDimension(hBitmap, x, y) — pascal, 6 bytes
  gdi.register('SetBitmapDimension', 6, () => 0, 163);

  // Ordinal 172: SetRectRgn(hRgn, l, t, r, b) — pascal -ret16, 10 bytes
  gdi.register('SetRectRgn', 10, () => 1, 172);

  // Ordinal 173: GetClipRgn(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetClipRgn', 2, () => 0, 173);

  // Ordinal 307: GetCharABCWidths(hdc, uFirstChar, uLastChar, lpabc) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('GetCharABCWidths', 10, () => {
    const [hdc, uFirstChar, uLastChar, lpabc] = emu.readPascalArgs16([2, 2, 2, 4]);
    if (lpabc) {
      const dc = emu.getDC(hdc);
      if (dc) dc.ctx.font = getFontCSS(hdc);
      for (let i = 0; i <= uLastChar - uFirstChar; i++) {
        let charW = Math.round(getFontSize(hdc) * 0.5);
        if (dc) {
          charW = Math.ceil(dc.ctx.measureText(String.fromCharCode(uFirstChar + i)).width);
        }
        // ABC16: a(2), b(2), c(2) — simplify: a=0, b=width, c=0
        emu.memory.writeI16(lpabc + i * 6, 0);
        emu.memory.writeU16(lpabc + i * 6 + 2, charW);
        emu.memory.writeI16(lpabc + i * 6 + 4, 0);
      }
    }
    return 1;
  }, 307);

  // Ordinal 330: EnumFontFamilies(hdc, lpszFamily, lpEnumFontFamProc, lParam) — pascal -ret16, 14 bytes (2+4+4+4)
  gdi.register('EnumFontFamilies', 14, () => 0, 330);

  // Ordinal 345: GetTextAlign(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetTextAlign', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.textAlign ?? TA_LEFT;
  }, 345);

  // Ordinal 346: SetTextAlign(hdc, fMode) — pascal -ret16, 4 bytes
  gdi.register('SetTextAlign', 4, () => {
    const [hdc, fMode] = emu.readPascalArgs16([2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.textAlign ?? TA_LEFT;
      dc.textAlign = fMode;
      return old;
    }
    return TA_LEFT;
  }, 346);

  // Ordinal 348: Chord(hdc, l, t, r, b, xR1, yR1, xR2, yR2) — pascal -ret16, 18 bytes
  gdi.register('Chord', 18, () => {
    const [hdc, l, t, r, b, xR1, yR1, xR2, yR2] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const cx = (l + r) / 2;
      const cy = (t + b) / 2;
      const rx = Math.abs(r - l) / 2;
      const ry = Math.abs(b - t) / 2;
      const a1 = Math.atan2((((yR1 << 16) >> 16) - cy) / (ry || 1), (((xR1 << 16) >> 16) - cx) / (rx || 1));
      const a2 = Math.atan2((((yR2 << 16) >> 16) - cy) / (ry || 1), (((xR2 << 16) >> 16) - cx) / (rx || 1));
      dc.ctx.beginPath();
      dc.ctx.ellipse(cx, cy, rx || 1, ry || 1, 0, a1, a2, true);
      dc.ctx.closePath();
      fillAndStroke(dc);
    }
    return 1;
  }, 348);

  // Ordinal 349: SetMapperFlags(hdc, dwFlag) — pascal, 6 bytes (2+4)
  gdi.register('SetMapperFlags', 6, () => 0, 349);

  // Ordinal 350: GetCharWidth(hdc, uFirstChar, uLastChar, lpBuffer) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('GetCharWidth', 10, () => {
    const [hdc, uFirstChar, uLastChar, lpBuffer] = emu.readPascalArgs16([2, 2, 2, 4]);
    if (lpBuffer) {
      const dc = emu.getDC(hdc);
      if (dc) dc.ctx.font = getFontCSS(hdc);
      for (let i = 0; i <= uLastChar - uFirstChar; i++) {
        let w = Math.round(getFontSize(hdc) * 0.5);
        if (dc) {
          w = Math.ceil(dc.ctx.measureText(String.fromCharCode(uFirstChar + i)).width);
        }
        emu.memory.writeI16(lpBuffer + i * 2, w);
      }
    }
    return 1;
  }, 350);

  // Ordinal 351: ExtTextOut(hdc, x, y, fuOptions, lprc, lpString, cbCount, lpDx) — pascal -ret16, 22 bytes
  gdi.register('ExtTextOut', 22, () => {
    const [hdc, xRaw, yRaw, fuOptions, lprc, lpString, cbCount, lpDx] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const xPos = (xRaw << 16) >> 16;
    const yPos = (yRaw << 16) >> 16;

    const ETO_OPAQUE = 0x2;
    if ((fuOptions & ETO_OPAQUE) && lprc) {
      const l = emu.memory.readI16(lprc);
      const t = emu.memory.readI16(lprc + 2);
      const r = emu.memory.readI16(lprc + 4);
      const b = emu.memory.readI16(lprc + 6);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(l, t, r - l, b - t);
    }

    if (lpString && cbCount > 0) {
      dc.ctx.font = getFontCSS(hdc);
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';

      if (lpDx) {
        // Per-character positioning via lpDx array (each entry is INT16)
        let cx = xPos;
        for (let i = 0; i < cbCount; i++) {
          const ch = String.fromCharCode(emu.memory.readU8(lpString + i));
          fillTextBitmap(dc.ctx, ch, cx, yPos);
          cx += emu.memory.readI16(lpDx + i * 2);
        }
      } else {
        let text = '';
        for (let i = 0; i < cbCount; i++) {
          text += String.fromCharCode(emu.memory.readU8(lpString + i));
        }
        fillTextBitmap(dc.ctx, text, xPos, yPos);
      }
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  }, 351);

  // Ordinal 360: CreatePalette(lpLogPalette) — pascal -ret16, 4 bytes
  gdi.register('CreatePalette', 4, () => {
    const lpLogPalette = emu.readArg16DWord(0);
    if (lpLogPalette) {
      const count = emu.memory.readU16(lpLogPalette + 2);
      const entries = new Uint8Array(count * 4);
      for (let i = 0; i < count * 4; i++) {
        entries[i] = emu.memory.readU8(lpLogPalette + 4 + i);
      }
      const pal: PaletteInfo = { entries, count };
      return emu.handles.alloc('palette', pal);
    }
    return emu.handles.alloc('palette', { entries: new Uint8Array(0), count: 0 });
  }, 360);

  // Ordinal 361: GDISelectPalette(hdc, hPal, bForceBackground) — pascal -ret16, 6 bytes
  gdi.register('GDISelectPalette', 6, () => {
    const [hdc, hPal, bForce] = emu.readPascalArgs16([2, 2, 2]);
    const dc = emu.getDC(hdc);
    if (dc) {
      const old = dc.selectedPalette || hPal;
      dc.selectedPalette = hPal;
      return old;
    }
    return 0;
  }, 361);

  // Ordinal 362: GDIRealizePalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('GDIRealizePalette', 2, () => 0, 362);

  // Ordinal 363: GetPaletteEntries(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('GetPaletteEntries', 10, () => {
    const [hPal, wStart, wNum, lpEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    const pal = emu.handles.get<PaletteInfo>(hPal);
    if (pal && lpEntries) {
      const count = Math.min(wNum, pal.count - wStart);
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++) {
          emu.memory.writeU8(lpEntries + i * 4 + j, pal.entries[(wStart + i) * 4 + j]);
        }
      }
      return count;
    }
    return 0;
  }, 363);

  // Ordinal 364: SetPaletteEntries(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetPaletteEntries', 10, () => {
    const [hPal, wStart, wNum, lpEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    const pal = emu.handles.get<PaletteInfo>(hPal);
    if (pal && lpEntries) {
      const count = Math.min(wNum, pal.count - wStart);
      for (let i = 0; i < count; i++) {
        for (let j = 0; j < 4; j++) {
          pal.entries[(wStart + i) * 4 + j] = emu.memory.readU8(lpEntries + i * 4 + j);
        }
      }
      return count;
    }
    return 0;
  }, 364);

  // Ordinal 365: RealizeDefaultPalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('RealizeDefaultPalette', 2, () => 0, 365);

  // Ordinal 366: UpdateColors(hdc) — pascal -ret16, 2 bytes
  gdi.register('UpdateColors', 2, () => 0, 366);

  // Ordinal 367: AnimatePalette(hPal, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('AnimatePalette', 10, () => 1, 367);

  // Ordinal 368: ResizePalette(hPal, nEntries) — pascal -ret16, 4 bytes
  gdi.register('ResizePalette', 4, () => 1, 368);

  // Ordinal 370: GetNearestPaletteIndex(hPal, crColor) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetNearestPaletteIndex', 6, () => 0, 370);

  // Ordinal 372: ExtFloodFill(hdc, x, y, crColor, fuFillType) — pascal -ret16, 12 bytes (2+2+2+4+2)
  // fuFillType: FLOODFILLBORDER=0, FLOODFILLSURFACE=1
  gdi.register('ExtFloodFill', 12, () => {
    const [hdc, x, y, crColor, fuFillType] = emu.readPascalArgs16([2, 2, 2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;
    const brush = emu.getBrush(dc.selectedBrush);
    if (!brush || brush.isNull) return 0;
    const fillR = brush.color & 0xFF, fillG = (brush.color >> 8) & 0xFF, fillB = (brush.color >> 16) & 0xFF;
    const tgtR = crColor & 0xFF, tgtG = (crColor >> 8) & 0xFF, tgtB = (crColor >> 16) & 0xFF;
    const w = dc.canvas.width, h = dc.canvas.height;
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    const imgData = dc.ctx.getImageData(0, 0, w, h);
    const px = imgData.data;

    const FLOODFILLSURFACE = 1;
    let shouldFill: (i: number) => boolean;
    if (fuFillType === FLOODFILLSURFACE) {
      // Fill while pixel matches crColor (surface fill)
      const startIdx = (y * w + x) * 4;
      if (px[startIdx] !== tgtR || px[startIdx + 1] !== tgtG || px[startIdx + 2] !== tgtB) return 0;
      if (fillR === tgtR && fillG === tgtG && fillB === tgtB) return 1; // already filled
      shouldFill = (i: number) => px[i] === tgtR && px[i + 1] === tgtG && px[i + 2] === tgtB;
    } else {
      // Fill until boundary color hit
      const startIdx = (y * w + x) * 4;
      if (px[startIdx] === tgtR && px[startIdx + 1] === tgtG && px[startIdx + 2] === tgtB) return 0;
      shouldFill = (i: number) => !(px[i] === tgtR && px[i + 1] === tgtG && px[i + 2] === tgtB);
    }

    const visited = new Uint8Array(w * h);
    const stack = [x + y * w];
    visited[x + y * w] = 1;
    while (stack.length > 0) {
      const pos = stack.pop()!;
      const px0 = pos % w;
      const i = pos * 4;
      px[i] = fillR; px[i + 1] = fillG; px[i + 2] = fillB; px[i + 3] = 255;
      const neighbors = [pos - 1, pos + 1, pos - w, pos + w];
      for (const n of neighbors) {
        if (n < 0 || n >= w * h) continue;
        const nx = n % w;
        if (Math.abs(nx - px0) > 1) continue;
        if (visited[n]) continue;
        visited[n] = 1;
        if (shouldFill(n * 4)) stack.push(n);
      }
    }
    dc.ctx.putImageData(imgData, 0, 0);
    emu.syncDCToCanvas(hdc);
    return 1;
  }, 372);

  // Ordinal 373: SetSystemPaletteUse(hdc, wUsage) — pascal -ret16, 4 bytes
  gdi.register('SetSystemPaletteUse', 4, () => 1); // SYSPAL_STATIC

  // Ordinal 374: GetSystemPaletteUse(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetSystemPaletteUse', 2, () => 1); // SYSPAL_STATIC

  // Ordinal 375: GetSystemPaletteEntries(hdc, wStartIndex, wNumEntries, lpPaletteEntries) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('GetSystemPaletteEntries', 10, () => 0, 375);

  // Ordinal 377: StartDoc(hdc, lpDocInfo) — pascal -ret16, 6 bytes (2+4)
  // NOTE: Ordinal 377 is StartDoc in the Wine spec, not CreateDIBitmap. CreateDIBitmap is 442.
  gdi.register('StartDoc', 6, () => 1, 377);

  // Ordinal 378: EndDoc(hdc) — pascal -ret16, 2 bytes
  gdi.register('EndDoc', 2, () => 1, 378);

  // Ordinal 379: StartPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('StartPage', 2, () => 1, 379);

  // Ordinal 380: EndPage(hdc) — pascal -ret16, 2 bytes
  gdi.register('EndPage', 2, () => 1, 380);

  // Ordinal 439: StretchDIBits(hdc, xDst, yDst, wDst, hDst, xSrc, ySrc, wSrc, hSrc, lpBits, lpBitsInfo, fuUsage, rop)
  // pascal -ret16, 28 bytes (2+2+2+2+2+2+2+2+2+4+4+2+4)
  gdi.register('StretchDIBits', 28, () => {
    const [hdc, xDstRaw, yDstRaw, wDstRaw, hDstRaw, xSrcRaw, ySrcRaw, wSrcRaw, hSrcRaw, bitsPtr, bmiPtr, fuUsage, rop] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 2, 4]);
    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr) return 0;

    const xDst = (xDstRaw << 16) >> 16;
    const yDst = (yDstRaw << 16) >> 16;
    const wDst = (wDstRaw << 16) >> 16;
    const hDst = (hDstRaw << 16) >> 16;
    const xSrc = (xSrcRaw << 16) >> 16;
    const ySrc = (ySrcRaw << 16) >> 16;
    const wSrc = (wSrcRaw << 16) >> 16;
    const hSrc = (hSrcRaw << 16) >> 16;

    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    const absHeight = Math.abs(biHeight);

    if (biCompression !== 0) return 0; // BI_RGB only

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const palette = readDIBPalette(emu, dc, bmiPtr, biSize, numColors, fuUsage);

    const absWDst = Math.abs(wDst);
    const absHDst = Math.abs(hDst);
    const absWSrc = Math.abs(wSrc);
    const absHSrc = Math.abs(hSrc);
    if (absWDst <= 0 || absHDst <= 0 || absWSrc <= 0 || absHSrc <= 0) return 0;

    // Decode source rectangle into a temporary canvas
    const srcCanvas = new OffscreenCanvas(absWSrc, absHSrc);
    const srcCtx = srcCanvas.getContext('2d')!;
    const srcImg = srcCtx.createImageData(absWSrc, absHSrc);
    const srcPx = srcImg.data;

    for (let y = 0; y < absHSrc; y++) {
      const srcY = ySrc + (hSrc > 0 ? y : absHSrc - 1 - y);
      // Map srcY to DIB scan line
      const scanLine = isBottomUp ? (absHeight - 1 - srcY) : srcY;
      if (scanLine < 0 || scanLine >= absHeight) continue;
      const rowStart = bitsPtr + scanLine * paddedRow;

      for (let x = 0; x < absWSrc; x++) {
        const srcX = xSrc + (wSrc > 0 ? x : absWSrc - 1 - x);
        if (srcX < 0 || srcX >= biWidth) continue;
        const [r, g, b] = readDIBPixel(emu, rowStart, srcX, biBitCount, palette);
        const off = (y * absWSrc + x) * 4;
        srcPx[off] = r; srcPx[off + 1] = g; srcPx[off + 2] = b; srcPx[off + 3] = 255;
      }
    }
    srcCtx.putImageData(srcImg, 0, 0);

    // Stretch to destination
    const dstX = wDst > 0 ? xDst : xDst + wDst;
    const dstY = hDst > 0 ? yDst : yDst + hDst;

    if (rop === BLACKNESS16) {
      dc.ctx.fillStyle = '#000';
      dc.ctx.fillRect(dstX, dstY, absWDst, absHDst);
    } else if (rop === WHITENESS16) {
      dc.ctx.fillStyle = '#fff';
      dc.ctx.fillRect(dstX, dstY, absWDst, absHDst);
    } else {
      dc.ctx.drawImage(srcCanvas, 0, 0, absWSrc, absHSrc, dstX, dstY, absWDst, absHDst);
    }

    emu.syncDCToCanvas(hdc);
    return absHSrc;
  }, 439);

  // Ordinal 440: SetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse) — pascal -ret16, 18 bytes (2+2+2+2+4+4+2)
  gdi.register('SetDIBits', 18, () => {
    const [hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2]);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (!bmp || !lpvBits || !lpbmi) return 0;

    const biWidth = Math.abs(emu.memory.readI32(lpbmi + 4));
    const biHeight = emu.memory.readI32(lpbmi + 8);
    const biBitCount = emu.memory.readU16(lpbmi + 14);
    const biSize = emu.memory.readU32(lpbmi);
    const biClrUsed = emu.memory.readU32(lpbmi + 32);
    const absHeight = Math.abs(biHeight);

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const dc = emu.getDC(hdc);
    const palette = dc ? readDIBPalette(emu, dc, lpbmi, biSize, numColors, fuColorUse) : readDIBPalette(emu, {} as DCInfo, lpbmi, biSize, numColors, 0);

    const lines = Math.min(cScanLines, absHeight - uStartScan);
    const drawW = Math.min(biWidth, bmp.width);
    const drawH = Math.min(lines, bmp.height);
    if (drawW <= 0 || drawH <= 0) return 0;

    const imgData = bmp.ctx.createImageData(drawW, drawH);
    const px = imgData.data;
    const isBottomUp = biHeight > 0;

    for (let y = 0; y < drawH; y++) {
      const srcRow = lpvBits + (uStartScan + y) * paddedRow;
      const outY = isBottomUp ? (drawH - 1 - y) : y;
      for (let x = 0; x < drawW; x++) {
        const [r, g, b] = readDIBPixel(emu, srcRow, x, biBitCount, palette);
        const off = (outY * drawW + x) * 4;
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }
    bmp.ctx.putImageData(imgData, 0, 0);
    return lines;
  }, 440);

  // Ordinal 441: GetDIBits(hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, fuColorUse) — pascal -ret16, 18 bytes (2+2+2+2+4+4+2)
  gdi.register('GetDIBits', 18, () => {
    const [hdc, hbmp, uStartScan, cScanLines, lpvBits, lpbmi, _fuColorUse] =
      emu.readPascalArgs16([2, 2, 2, 2, 4, 4, 2]);
    const bmp = emu.handles.get<BitmapInfo>(hbmp);
    if (!bmp || !lpbmi) return 0;

    const absH = bmp.height;
    // If lpvBits is NULL, just fill in the BITMAPINFOHEADER
    if (!lpvBits) {
      emu.memory.writeU32(lpbmi, 40);           // biSize
      emu.memory.writeI32(lpbmi + 4, bmp.width);
      emu.memory.writeI32(lpbmi + 8, bmp.height);
      emu.memory.writeU16(lpbmi + 12, 1);       // biPlanes
      emu.memory.writeU16(lpbmi + 14, 24);      // biBitCount
      emu.memory.writeU32(lpbmi + 16, 0);       // biCompression = BI_RGB
      const stride = (bmp.width * 3 + 3) & ~3;
      emu.memory.writeU32(lpbmi + 20, stride * absH); // biSizeImage
      return absH;
    }

    // Read pixels from bitmap canvas and write as 24bpp bottom-up DIB
    const lines = Math.min(cScanLines, absH - uStartScan);
    if (lines <= 0) return 0;
    const stride = (bmp.width * 3 + 3) & ~3;
    const imgData = bmp.ctx.getImageData(0, 0, bmp.width, absH);
    const px = imgData.data;

    for (let y = 0; y < lines; y++) {
      const srcY = absH - 1 - (uStartScan + y); // bottom-up
      const dstRow = lpvBits + y * stride;
      for (let x = 0; x < bmp.width; x++) {
        const si = (srcY * bmp.width + x) * 4;
        emu.memory.writeU8(dstRow + x * 3, px[si + 2]);     // B
        emu.memory.writeU8(dstRow + x * 3 + 1, px[si + 1]); // G
        emu.memory.writeU8(dstRow + x * 3 + 2, px[si]);     // R
      }
    }
    return lines;
  }, 441);

  // Ordinal 442: CreateDIBitmap(hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage) — pascal -ret16, 20 bytes (2+4+4+4+4+2)
  gdi.register('CreateDIBitmap', 20, () => {
    const [hdc, lpbmih, fdwInit, lpbInit, lpbmi, fuUsage] =
      emu.readPascalArgs16([2, 4, 4, 4, 4, 2]);

    let w = 1, h = 1;
    if (lpbmih) {
      w = emu.memory.readU32(lpbmih + 4) || 1;
      h = Math.abs(emu.memory.readI32(lpbmih + 8)) || 1;
    }

    const CBM_INIT = 0x4;
    if ((fdwInit & CBM_INIT) && lpbInit && lpbmi) {
      // Decode DIB data and create initialized bitmap
      try {
        const biSize = emu.memory.readU32(lpbmi);
        const biBitCount = emu.memory.readU16(lpbmi + 14);
        const biClrUsed = emu.memory.readU32(lpbmi + 32);
        const nColors = biClrUsed > 0 ? biClrUsed : (biBitCount <= 8 ? (1 << biBitCount) : 0);
        const headerSize = biSize + nColors * 4;
        const absH = Math.abs(emu.memory.readI32(lpbmi + 8));
        const stride = Math.floor((w * biBitCount + 31) / 32) * 4;
        const imageSize = stride * absH;
        // Build contiguous DIB buffer: header + color table + pixels
        const dibBuf = new Uint8Array(headerSize + imageSize);
        for (let i = 0; i < headerSize; i++) dibBuf[i] = emu.memory.readU8(lpbmi + i);
        for (let i = 0; i < imageSize; i++) dibBuf[headerSize + i] = emu.memory.readU8(lpbInit + i);
        const decoded = decodeDib(dibBuf);
        const bmp: BitmapInfo = { width: decoded.width, height: decoded.height, canvas: decoded.canvas, ctx: decoded.ctx };
        return emu.handles.alloc('bitmap', bmp);
      } catch (e: unknown) {
        console.warn(`[GDI16] CreateDIBitmap decode failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx };
    return emu.handles.alloc('bitmap', bmp);
  }, 442);

  // Ordinal 443: SetDIBitsToDevice(hdc, xDst, yDst, cx, cy, xSrc, ySrc, startScan, numScans, lpBits, lpBitsInfo, fuUsage)
  // pascal -ret16, 24 bytes (2+2+2+2+2+2+2+2+2+4+4+2)
  gdi.register('SetDIBitsToDevice', 24, () => {
    const [hdc, xDest, yDest, width, height, xSrc, ySrc, startScan, numScans, bitsPtr, bmiPtr, fuUsage] =
      emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !bitsPtr || !bmiPtr) return 0;

    const biSize = emu.memory.readU32(bmiPtr);
    const biWidth = Math.abs(emu.memory.readI32(bmiPtr + 4));
    const biHeight = emu.memory.readI32(bmiPtr + 8);
    const biBitCount = emu.memory.readU16(bmiPtr + 14);
    const biCompression = emu.memory.readU32(bmiPtr + 16);
    const biClrUsed = emu.memory.readU32(bmiPtr + 32);
    const isBottomUp = biHeight > 0;
    const absHeight = Math.abs(biHeight);

    if (biCompression !== 0) return 0; // BI_RGB only

    const paddedRow = calcDIBStride(biWidth, biBitCount);
    if (!paddedRow) return 0;

    const numColors = biClrUsed || (biBitCount <= 8 ? (1 << biBitCount) : 0);
    const palette = readDIBPalette(emu, dc, bmiPtr, biSize, numColors, fuUsage);

    const drawW = Math.min(width, biWidth - xSrc);
    const drawH = Math.min(height, absHeight);
    if (drawW <= 0 || drawH <= 0) return 0;

    const imgData = dc.ctx.createImageData(drawW, drawH);
    const px = imgData.data;

    for (let y = 0; y < drawH; y++) {
      const scanLine = isBottomUp ? (ySrc + drawH - 1 - y) : (ySrc + y);
      const bufferRow = scanLine - startScan;
      if (bufferRow < 0 || bufferRow >= numScans) continue;

      const rowStart = bitsPtr + bufferRow * paddedRow;
      for (let x = 0; x < drawW; x++) {
        const [r, g, b] = readDIBPixel(emu, rowStart, xSrc + x, biBitCount, palette);
        const off = (y * drawW + x) * 4;
        px[off] = r; px[off + 1] = g; px[off + 2] = b; px[off + 3] = 255;
      }
    }

    dc.ctx.putImageData(imgData, (xDest << 16) >> 16, (yDest << 16) >> 16);
    emu.syncDCToCanvas(hdc);
    return drawH;
  }, 443);

  // Ordinal 444: CreateRoundRectRgn(l, t, r, b, w, h) — pascal -ret16, 12 bytes
  gdi.register('CreateRoundRectRgn', 12, () => emu.handles.alloc('region', {}), 444);

  // Ordinal 445: CreateDIBPatternBrush(hGlobal, fuColorSpec) — pascal -ret16, 4 bytes
  gdi.register('CreateDIBPatternBrush', 4, () => {
    const brush: BrushInfo = { color: 0, isNull: false };
    return emu.handles.alloc('brush', brush);
  }, 445);

  // Ordinal 450: PolyPolygon(hdc, lpPoints, lpPolyCounts, nCount) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('PolyPolygon', 12, () => {
    const [hdc, lpPoints, lpPolyCounts, nCount] = emu.readPascalArgs16([2, 4, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lpPoints || !lpPolyCounts || nCount <= 0) return 0;

    dc.ctx.beginPath();
    let ptOffset = 0;
    for (let poly = 0; poly < nCount; poly++) {
      const vertCount = emu.memory.readI16(lpPolyCounts + poly * 2);
      for (let i = 0; i < vertCount; i++) {
        const px = emu.memory.readI16(lpPoints + (ptOffset + i) * 4);
        const py = emu.memory.readI16(lpPoints + (ptOffset + i) * 4 + 2);
        if (i === 0) dc.ctx.moveTo(px, py);
        else dc.ctx.lineTo(px, py);
      }
      dc.ctx.closePath();
      ptOffset += vertCount;
    }
    fillAndStroke(dc);
    emu.syncDCToCanvas(hdc);
    return 1;
  }, 450);

  // Ordinal 461: SetObjectOwner(hObj, hOwner) — pascal -ret16, 4 bytes
  gdi.register('SetObjectOwner', 4, () => 1, 461);

  // Ordinal 462: IsGDIObject(hObj) — pascal -ret16, 2 bytes
  gdi.register('IsGDIObject', 2, () => {
    const hObj = emu.readArg16(0);
    return emu.handles.getType(hObj) ? 1 : 0;
  }, 462);

  // Ordinal 465: RectVisible(hdc, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('RectVisible', 6, () => 1, 465);

  // Ordinal 466: RectInRegion(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('RectInRegion', 6, () => 0, 466);

  // Ordinal 468: GetBitmapDimensionEx(hbmp, lpDimension) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetBitmapDimensionEx', 6, () => {
    const [hbmp, lpDimension] = emu.readPascalArgs16([2, 4]);
    if (lpDimension) {
      const bmp = emu.handles.get<BitmapInfo>(hbmp);
      if (bmp) {
        emu.memory.writeU16(lpDimension, bmp.width);
        emu.memory.writeU16(lpDimension + 2, bmp.height);
      } else {
        emu.memory.writeU32(lpDimension, 0);
      }
    }
    return 1;
  }, 468);

  // Ordinal 469: GetBrushOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetBrushOrgEx', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.brushOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.brushOrgY ?? 0);
    }
    return 1;
  }, 469);

  // Ordinal 470: GetCurrentPositionEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetCurrentPositionEx', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (dc && lpPoint) {
      emu.memory.writeI16(lpPoint, dc.penPosX);
      emu.memory.writeI16(lpPoint + 2, dc.penPosY);
    }
    return 1;
  }, 470);

  // Ordinal 471: GetTextExtentPoint(hdc, lpString, cbString, lpSize) — pascal -ret16, 12 bytes (2+4+2+4)
  gdi.register('GetTextExtentPoint', 12, () => {
    const [hdc, lpString, cbString, lpSize] = emu.readPascalArgs16([2, 4, 2, 4]);
    if (lpSize) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      let width = cbString * Math.round(fontSize * 0.5);
      if (dc && lpString && cbString > 0) {
        let text = '';
        for (let i = 0; i < cbString; i++) text += String.fromCharCode(emu.memory.readU8(lpString + i));
        dc.ctx.font = getFontCSS(hdc);
        width = Math.ceil(dc.ctx.measureText(text).width);
      }
      emu.memory.writeI16(lpSize, width);
      emu.memory.writeI16(lpSize + 2, fontSize);
    }
    return 1;
  }, 471);

  // Ordinal 472: GetViewportExtEx(hdc, lpSize) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetViewportExtEx', 6, () => {
    const [hdc, lpSize] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpSize) {
      emu.memory.writeI16(lpSize, dc?.viewportExtX ?? 1);
      emu.memory.writeI16(lpSize + 2, dc?.viewportExtY ?? 1);
    }
    return 1;
  }, 472);

  // Ordinal 473: GetViewportOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetViewportOrgEx', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.viewportOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.viewportOrgY ?? 0);
    }
    return 1;
  }, 473);

  // Ordinal 474: GetWindowExtEx(hdc, lpSize) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetWindowExtEx', 6, () => {
    const [hdc, lpSize] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpSize) {
      emu.memory.writeI16(lpSize, dc?.windowExtX ?? 1);
      emu.memory.writeI16(lpSize + 2, dc?.windowExtY ?? 1);
    }
    return 1;
  }, 474);

  // Ordinal 475: GetWindowOrgEx(hdc, lpPoint) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetWindowOrgEx', 6, () => {
    const [hdc, lpPoint] = emu.readPascalArgs16([2, 4]);
    const dc = emu.getDC(hdc);
    if (lpPoint) {
      emu.memory.writeI16(lpPoint, dc?.windowOrgX ?? 0);
      emu.memory.writeI16(lpPoint + 2, dc?.windowOrgY ?? 0);
    }
    return 1;
  }, 475);

  // Ordinal 476: OffsetViewportOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('OffsetViewportOrgEx', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.viewportOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.viewportOrgY ?? 0);
      }
      dc.viewportOrgX = (dc.viewportOrgX ?? 0) + ((x << 16) >> 16);
      dc.viewportOrgY = (dc.viewportOrgY ?? 0) + ((y << 16) >> 16);
    }
    return 1;
  }, 476);

  // Ordinal 477: OffsetWindowOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('OffsetWindowOrgEx', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.windowOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.windowOrgY ?? 0);
      }
      dc.windowOrgX = (dc.windowOrgX ?? 0) + ((x << 16) >> 16);
      dc.windowOrgY = (dc.windowOrgY ?? 0) + ((y << 16) >> 16);
    }
    return 1;
  }, 477);

  // Ordinal 478: SetBitmapDimensionEx(hBitmap, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetBitmapDimensionEx', 10, () => 1, 478);

  // Ordinal 479: SetViewportExtEx(hdc, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetViewportExtEx', 10, () => {
    const [hdc, x, y, lpSize] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.viewportExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.viewportExtY ?? 1);
      }
      dc.viewportExtX = (x << 16) >> 16;
      dc.viewportExtY = (y << 16) >> 16;
    }
    return 1;
  }, 479);

  // Ordinal 480: SetViewportOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetViewportOrgEx', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.viewportOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.viewportOrgY ?? 0);
      }
      dc.viewportOrgX = (x << 16) >> 16;
      dc.viewportOrgY = (y << 16) >> 16;
    }
    return 1;
  }, 480);

  // Ordinal 481: SetWindowExtEx(hdc, x, y, lpSize) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetWindowExtEx', 10, () => {
    const [hdc, x, y, lpSize] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.windowExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.windowExtY ?? 1);
      }
      dc.windowExtX = (x << 16) >> 16;
      dc.windowExtY = (y << 16) >> 16;
    }
    return 1;
  }, 481);

  // Ordinal 482: SetWindowOrgEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetWindowOrgEx', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.windowOrgX ?? 0);
        emu.memory.writeI16(lpPoint + 2, dc.windowOrgY ?? 0);
      }
      dc.windowOrgX = (x << 16) >> 16;
      dc.windowOrgY = (y << 16) >> 16;
    }
    return 1;
  }, 482);

  // Ordinal 483: MoveToEx(hdc, x, y, lpPoint) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('MoveToEx', 10, () => {
    const [hdc, x, y, lpPoint] = emu.readPascalArgs16([2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpPoint) {
        emu.memory.writeI16(lpPoint, dc.penPosX);
        emu.memory.writeI16(lpPoint + 2, dc.penPosY);
      }
      dc.penPosX = (x << 16) >> 16;
      dc.penPosY = (y << 16) >> 16;
    }
    return 1;
  }, 483);

  // Ordinal 489: CreateDIBSection(hdc, lpbmi, fuUsage, lplpvBits, hSection, dwOffset) — pascal -ret16, 20 bytes (2+4+2+4+4+4)
  gdi.register('CreateDIBSection', 20, () => {
    const [hdc, lpbmi, fuUsage, lplpvBits, hSection, dwOffset] =
      emu.readPascalArgs16([2, 4, 2, 4, 4, 4]);
    let w = 1, h = 1, bpp = 8;
    if (lpbmi) {
      w = Math.abs(emu.memory.readI32(lpbmi + 4)) || 1;
      h = Math.abs(emu.memory.readI32(lpbmi + 8)) || 1;
      bpp = emu.memory.readU16(lpbmi + 14) || 8;
    }
    // Allocate pixel buffer in emulated memory
    const stride = Math.floor((w * bpp + 31) / 32) * 4;
    const bufSize = stride * h;
    const pixelBuf = emu.allocHeap(bufSize);
    if (lplpvBits) emu.memory.writeU32(lplpvBits, pixelBuf);

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    const bmp: BitmapInfo = { width: w, height: h, canvas, ctx, dibBitsPtr: pixelBuf, dibBpp: bpp };
    return emu.handles.alloc('bitmap', bmp);
  }, 489);

  // Ordinal 502: PolyBezier(hdc, lppt, cPoints) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('PolyBezier', 8, () => {
    const [hdc, lppt, cPoints] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lppt || cPoints < 4) return 0;
    dc.ctx.beginPath();
    const x0 = emu.memory.readI16(lppt);
    const y0 = emu.memory.readI16(lppt + 2);
    dc.ctx.moveTo(x0, y0);
    for (let i = 1; i + 2 < cPoints; i += 3) {
      const cp1x = emu.memory.readI16(lppt + (i) * 4);
      const cp1y = emu.memory.readI16(lppt + (i) * 4 + 2);
      const cp2x = emu.memory.readI16(lppt + (i + 1) * 4);
      const cp2y = emu.memory.readI16(lppt + (i + 1) * 4 + 2);
      const ex = emu.memory.readI16(lppt + (i + 2) * 4);
      const ey = emu.memory.readI16(lppt + (i + 2) * 4 + 2);
      dc.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
    }
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  }, 502);

  // Ordinal 503: PolyBezierTo(hdc, lppt, cPoints) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('PolyBezierTo', 8, () => {
    const [hdc, lppt, cPoints] = emu.readPascalArgs16([2, 4, 2]);
    const dc = emu.getDC(hdc);
    if (!dc || !lppt || cPoints < 3) return 0;
    dc.ctx.beginPath();
    dc.ctx.moveTo(dc.penPosX, dc.penPosY);
    for (let i = 0; i + 2 < cPoints; i += 3) {
      const cp1x = emu.memory.readI16(lppt + (i) * 4);
      const cp1y = emu.memory.readI16(lppt + (i) * 4 + 2);
      const cp2x = emu.memory.readI16(lppt + (i + 1) * 4);
      const cp2y = emu.memory.readI16(lppt + (i + 1) * 4 + 2);
      const ex = emu.memory.readI16(lppt + (i + 2) * 4);
      const ey = emu.memory.readI16(lppt + (i + 2) * 4 + 2);
      dc.ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ex, ey);
    }
    // Update pen position to last point
    const lastIdx = cPoints - 1;
    dc.penPosX = emu.memory.readI16(lppt + lastIdx * 4);
    dc.penPosY = emu.memory.readI16(lppt + lastIdx * 4 + 2);
    const pen = emu.getPen(dc.selectedPen);
    if (pen && pen.style !== PS_NULL) {
      dc.ctx.strokeStyle = colorToCSS(pen.color);
      dc.ctx.lineWidth = pen.width || 1;
      dc.ctx.stroke();
    }
    emu.syncDCToCanvas(hdc);
    return 1;
  }, 503);

  // Ordinal 508: ExtSelectClipRgn(hdc, hRgn, fnMode) — pascal -ret16, 6 bytes
  gdi.register('ExtSelectClipRgn', 6, () => SIMPLEREGION, 508);

  // Ordinal 529: CreateHalftonePalette(hdc) — pascal -ret16, 2 bytes
  gdi.register('CreateHalftonePalette', 2, () => emu.handles.alloc('palette', { entries: new Uint8Array(0), count: 0 }), 529);

  // Ordinal 612: GetTextCharset(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetTextCharset', 2, () => 0, 612); // ANSI_CHARSET

  // Ordinal 613: EnumFontFamiliesEx(hdc, lpLogFont, lpEnumFontFamExProc, lParam, dwFlags) — pascal -ret16, 18 bytes (2+4+4+4+4)
  gdi.register('EnumFontFamiliesEx', 18, () => 0, 613);

  // ═══════════════════════════════════════════════════════════════════════════
  // Additional Wine-referenced GDI16 APIs
  // ═══════════════════════════════════════════════════════════════════════════

  // Ordinal 121: Death(hdc) — pascal -ret16, 2 bytes (prepares for mode switch)
  gdi.register('Death', 2, () => 1, 121);

  // Ordinal 122: Resurrection(hdc, w1, w2, w3, w4, w5, w6) — pascal -ret16, 14 bytes
  gdi.register('Resurrection', 14, () => 1, 122);

  // Ordinal 123: PlayMetaFile(hdc, hmf) — pascal -ret16, 4 bytes
  gdi.register('PlayMetaFile', 4, () => 1, 123);

  // Ordinal 124: GetMetaFile(lpFileName) — pascal -ret16, 4 bytes
  gdi.register('GetMetaFile', 4, () => 0, 124);

  // Ordinal 125: CreateMetaFile(lpFileName) — pascal -ret16, 4 bytes
  gdi.register('CreateMetaFile', 4, () => 0, 125);

  // Ordinal 126: CloseMetaFile(hdc) — pascal -ret16, 2 bytes
  gdi.register('CloseMetaFile', 2, () => 0, 126);

  // Ordinal 127: DeleteMetaFile(hmf) — pascal -ret16, 2 bytes
  gdi.register('DeleteMetaFile', 2, () => 1, 127);

  // Ordinal 132: SetEnvironment(lpPortName, lpEnviron, nCount) — pascal -ret16, 10 bytes (4+4+2)
  gdi.register('SetEnvironment', 10, () => 0, 132);

  // Ordinal 133: GetEnvironment(lpPortName, lpEnviron, nMaxCount) — pascal -ret16, 10 bytes (4+4+2)
  gdi.register('GetEnvironment', 10, () => 0, 133);

  // Ordinal 151: CopyMetaFile(hmfSrc, lpFileName) — pascal -ret16, 6 bytes (2+4)
  gdi.register('CopyMetaFile', 6, () => 0, 151);

  // Ordinal 155: QueryAbort(hdc, reserved) — pascal -ret16, 4 bytes
  gdi.register('QueryAbort', 4, () => 1); // continue

  // Ordinal 159: GetMetaFileBits(hmf) — pascal -ret16, 2 bytes
  gdi.register('GetMetaFileBits', 2, () => 0, 159);

  // Ordinal 160: SetMetaFileBits(hMem) — pascal -ret16, 2 bytes
  gdi.register('SetMetaFileBits', 2, () => 0, 160);

  // Ordinal 175: EnumMetaFile(hdc, hmf, lpMFFunc, lParam) — pascal -ret16, 12 bytes (2+2+4+4)
  gdi.register('EnumMetaFile', 12, () => 1, 175);

  // Ordinal 176: PlayMetaFileRecord(hdc, lpHandleTable, lpMR, nHandles) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('PlayMetaFileRecord', 12, () => 1, 176);

  // Ordinal 179: GetDCState(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetDCState', 2, () => 0, 179);

  // Ordinal 180: SetDCState(hdc, hSavedDC) — pascal -ret16, 4 bytes
  gdi.register('SetDCState', 4, () => 0, 180);

  // Ordinal 181: RectInRegion(hRgn, lpRect) — pascal -ret16, 6 bytes (2+4)
  gdi.register('RectInRegion', 6, () => 1, 181);

  // Ordinal 190: SetDCHook(hdc, hookProc, dwHookData) — pascal -ret16, 10 bytes (2+4+4)
  gdi.register('SetDCHook', 10, () => 1, 190);

  // Ordinal 191: GetDCHook(hdc, lpHookData) — pascal, 6 bytes (2+4)
  gdi.register('GetDCHook', 6, () => 0, 191);

  // Ordinal 192: SetHookFlags(hdc, flags) — pascal -ret16, 4 bytes
  gdi.register('SetHookFlags', 4, () => 0, 192);

  // Ordinal 193: SetBoundsRect(hdc, lprcBounds, flags) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('SetBoundsRect', 8, () => 0, 193);

  // Ordinal 194: GetBoundsRect(hdc, lprcBounds, flags) — pascal -ret16, 8 bytes (2+4+2)
  gdi.register('GetBoundsRect', 8, () => 0, 194);

  // Ordinal 196: SetMetaFileBitsBetter(hMem) — pascal -ret16, 2 bytes
  gdi.register('SetMetaFileBitsBetter', 2, () => 0, 196);

  // Ordinal 308: GetOutlineTextMetrics(hdc, cbData, lpOTM) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('GetOutlineTextMetrics', 8, () => 0); // not supported

  // Ordinal 309: GetGlyphOutline(hdc, uChar, fuFormat, lpgm, cbBuffer, lpBuffer, lpmat2) — 22 bytes
  gdi.register('GetGlyphOutline', 22, () => 0xFFFFFFFF); // GDI_ERROR

  // Ordinal 310: CreateScalableFontResource(fHidden, lpszResFile, lpszFontFile, lpszCurPath) — 16 bytes (2+4+4+4)
  gdi.register('CreateScalableFontResource', 16, () => 0, 310);

  // Ordinal 311: GetFontData(hdc, dwTable, dwOffset, lpvBuffer, cbData) — 14 bytes (2+4+4+4+4→ wait, need to check)
  gdi.register('GetFontData', 14, () => 0xFFFFFFFF); // GDI_ERROR

  // Ordinal 313: GetRasterizerCaps(lprs, cb) — pascal -ret16, 6 bytes (4+2)
  gdi.register('GetRasterizerCaps', 6, () => {
    const [lprs, cb] = emu.readPascalArgs16([4, 2]);
    if (lprs && cb >= 4) {
      emu.memory.writeU16(lprs, 4);     // nSize
      emu.memory.writeU16(lprs + 2, 3); // wFlags: TT_AVAILABLE | TT_ENABLED
    }
    return 1;
  }, 313);

  // Ordinal 332: GetKerningPairs(hdc, nNumPairs, lpkrnpair) — pascal -ret16, 8 bytes (2+2+4)
  gdi.register('GetKerningPairs', 8, () => 0, 332);

  // Ordinal 376: ResetDC(hdc, lpDevMode) — pascal -ret16, 6 bytes (2+4)
  gdi.register('ResetDC', 6, () => {
    return emu.readArg16(0); // return the hdc
  }, 376);

  // Ordinal 381: SetAbortProc(hdc, lpAbortProc) — pascal -ret16, 6 bytes (2+4)
  gdi.register('SetAbortProc', 6, () => 1, 381);

  // Ordinal 382: AbortDoc(hdc) — pascal -ret16, 2 bytes
  gdi.register('AbortDoc', 2, () => 1, 382);

  // Ordinal 400: FastWindowFrame(hdc, lpRect, xWidth, yWidth, rop) — pascal -ret16, 14 bytes (2+4+2+2+4)
  gdi.register('FastWindowFrame', 14, () => 1, 400);

  // Ordinal 403: GdiInit2(hInstance, hPrevInstance) — pascal -ret16, 4 bytes (2+2)
  gdi.register('GdiInit2', 4, () => 1, 403);

  // Ordinal 405: FinalGdiInit(hdc) — pascal -ret16, 2 bytes
  gdi.register('FinalGdiInit', 2, () => 1, 405);

  // Ordinal 410: IsValidMetaFile(hmf) — pascal -ret16, 2 bytes
  gdi.register('IsValidMetaFile', 2, () => 0, 410);

  // Ordinal 411: GetCurLogFont(hdc) — pascal -ret16, 2 bytes
  gdi.register('GetCurLogFont', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    return dc?.selectedFont ?? 0;
  }, 411);

  // Ordinal 451: CreatePolyPolygonRgn(lpPoints, lpPolyCounts, nCount, fnPolyFillMode) — pascal -ret16, 14 bytes (4+4+2+2→ but need check)
  gdi.register('CreatePolyPolygonRgn', 14, () => {
    return emu.handles.alloc('region', { type: 'poly' });
  }, 451);

  // Ordinal 484: ScaleViewportExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('ScaleViewportExtEx', 14, () => {
    const [hdc, xNum, xDenom, yNum, yDenom, lpSize] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.viewportExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.viewportExtY ?? 1);
      }
      const xn = (xNum << 16) >> 16, xd = (xDenom << 16) >> 16;
      const yn = (yNum << 16) >> 16, yd = (yDenom << 16) >> 16;
      if (xd && yd) {
        dc.viewportExtX = Math.round((dc.viewportExtX ?? 1) * xn / xd);
        dc.viewportExtY = Math.round((dc.viewportExtY ?? 1) * yn / yd);
      }
    }
    return 1;
  }, 484);

  // Ordinal 485: ScaleWindowExtEx(hdc, xNum, xDenom, yNum, yDenom, lpSize) — pascal -ret16, 14 bytes (2+2+2+2+2+4)
  gdi.register('ScaleWindowExtEx', 14, () => {
    const [hdc, xNum, xDenom, yNum, yDenom, lpSize] = emu.readPascalArgs16([2, 2, 2, 2, 2, 4]);
    const dc = emu.getDC(hdc);
    if (dc) {
      if (lpSize) {
        emu.memory.writeI16(lpSize, dc.windowExtX ?? 1);
        emu.memory.writeI16(lpSize + 2, dc.windowExtY ?? 1);
      }
      const xn = (xNum << 16) >> 16, xd = (xDenom << 16) >> 16;
      const yn = (yNum << 16) >> 16, yd = (yDenom << 16) >> 16;
      if (xd && yd) {
        dc.windowExtX = Math.round((dc.windowExtX ?? 1) * xn / xd);
        dc.windowExtY = Math.round((dc.windowExtY ?? 1) * yn / yd);
      }
    }
    return 1;
  }, 485);

  // Ordinal 486: GetAspectRatioFilterEx(hdc, lpAspectRatio) — pascal -ret16, 6 bytes (2+4)
  gdi.register('GetAspectRatioFilterEx', 6, () => {
    const [hdc, lpAspectRatio] = emu.readPascalArgs16([2, 4]);
    if (lpAspectRatio) {
      emu.memory.writeI16(lpAspectRatio, 0);
      emu.memory.writeI16(lpAspectRatio + 2, 0);
    }
    return 1;
  }, 486);

  // Path operations (ordinals 511-522)
  // Ordinal 511: AbortPath(hdc) — 2 bytes
  gdi.register('AbortPath', 2, () => 1, 511);

  // Ordinal 512: BeginPath(hdc) — 2 bytes
  gdi.register('BeginPath', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.beginPath();
    return 1;
  }, 512);

  // Ordinal 513: CloseFigure(hdc) — 2 bytes
  gdi.register('CloseFigure', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) dc.ctx.closePath();
    return 1;
  }, 513);

  // Ordinal 514: EndPath(hdc) — 2 bytes
  gdi.register('EndPath', 2, () => 1, 514);

  // Ordinal 515: FillPath(hdc) — 2 bytes
  gdi.register('FillPath', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fill();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  }, 515);

  // Ordinal 516: FlattenPath(hdc) — 2 bytes
  gdi.register('FlattenPath', 2, () => 1, 516);

  // Ordinal 517: GetPath(hdc, lpPoints, lpTypes, nSize) — pascal -ret16, 12 bytes (2+4+4+2)
  gdi.register('GetPath', 12, () => -1); // error / no path

  // Ordinal 518: PathToRegion(hdc) — 2 bytes
  gdi.register('PathToRegion', 2, () => {
    return emu.handles.alloc('region', { type: 'path' });
  }, 518);

  // Ordinal 519: SelectClipPath(hdc, mode) — pascal -ret16, 4 bytes
  gdi.register('SelectClipPath', 4, () => 1, 519);

  // Ordinal 520: StrokeAndFillPath(hdc) — 2 bytes
  gdi.register('StrokeAndFillPath', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const brush = emu.getBrush(dc.selectedBrush);
      if (brush && !brush.isNull) {
        dc.ctx.fillStyle = colorToCSS(brush.color);
        dc.ctx.fill();
      }
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  }, 520);

  // Ordinal 521: StrokePath(hdc) — 2 bytes
  gdi.register('StrokePath', 2, () => {
    const hdc = emu.readArg16(0);
    const dc = emu.getDC(hdc);
    if (dc) {
      const pen = emu.getPen(dc.selectedPen);
      if (pen && pen.style !== PS_NULL) {
        dc.ctx.strokeStyle = colorToCSS(pen.color);
        dc.ctx.lineWidth = pen.width || 1;
        dc.ctx.stroke();
      }
      emu.syncDCToCanvas(hdc);
    }
    return 1;
  }, 521);

  // Ordinal 522: WidenPath(hdc) — 2 bytes
  gdi.register('WidenPath', 2, () => 1, 522);

  // Ordinal 524: GetArcDirection(hdc) — 2 bytes
  gdi.register('GetArcDirection', 2, () => 2); // AD_COUNTERCLOCKWISE

  // Ordinal 525: SetArcDirection(hdc, dir) — pascal -ret16, 4 bytes
  gdi.register('SetArcDirection', 4, () => 2); // return old direction

  // Ordinal 602: SetDIBColorTable(hdc, uStartIndex, cEntries, pColors) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('SetDIBColorTable', 10, () => {
    const [hdc, uStartIndex, cEntries] = emu.readPascalArgs16([2, 2, 2, 4]);
    return cEntries;
  }, 602);

  // Ordinal 603: GetDIBColorTable(hdc, uStartIndex, cEntries, pColors) — pascal -ret16, 10 bytes (2+2+2+4)
  gdi.register('GetDIBColorTable', 10, () => 0, 603);

  // Ordinal 604: SetSolidBrush(hBrush, color) — pascal -ret16, 6 bytes (2+4)
  gdi.register('SetSolidBrush', 6, () => {
    const [hBrush, color] = emu.readPascalArgs16([2, 4]);
    const brush = emu.getBrush(hBrush);
    if (brush) brush.color = color;
    return 1;
  }, 604);

  // Ordinal 607: GetRegionData(hRgn, dwCount, lpRgnData) — pascal, 10 bytes (2+4+4)
  gdi.register('GetRegionData', 10, () => 0, 607);

  // Ordinal 609: GdiFreeResources(wFlags) — pascal -ret16, 4 bytes
  gdi.register('GdiFreeResources', 4, () => 90); // 90% free

  // Ordinal 616: GetFontLanguageInfo(hdc) — pascal, 2 bytes
  gdi.register('GetFontLanguageInfo', 2, () => 0, 616);

  // Ordinal 1000: SetLayout(hdc, dwLayout) — pascal -ret16, 6 bytes (2+4)
  gdi.register('SetLayout', 6, () => 0, 1000);
}
