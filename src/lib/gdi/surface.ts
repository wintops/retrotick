// Canvas surface factories and primitive draw helpers shared across all
// GDI-style callers. Kept deliberately small — anything beyond raw pixel
// ops belongs in higher-level layout code.
import type { GdiCtx } from './metrics';
import { colorrefToCSS, rgbToCSS, type RGB } from './color';

export interface Surface {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: GdiCtx;
}

/** Create an OffscreenCanvas-backed surface with anti-aliasing disabled
 *  for pixel-perfect GDI parity. */
export function createOffscreenSurface(width: number, height: number): Surface {
  const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx };
}

export function disableSmoothing(ctx: GdiCtx): void {
  ctx.imageSmoothingEnabled = false;
}

/** Fill a rectangle in COLORREF (BGR) color. */
export function fillRectColorref(ctx: GdiCtx, x: number, y: number, w: number, h: number, colorref: number): void {
  ctx.fillStyle = colorrefToCSS(colorref);
  ctx.fillRect(x, y, w, h);
}

/** Fill a rectangle in plain RGB. */
export function fillRectRGB(ctx: GdiCtx, x: number, y: number, w: number, h: number, rgb: RGB): void {
  ctx.fillStyle = rgbToCSS(rgb);
  ctx.fillRect(x, y, w, h);
}

/** Draw a horizontal 1-pixel line. */
export function hLine(ctx: GdiCtx, x: number, y: number, w: number, colorref: number): void {
  ctx.fillStyle = colorrefToCSS(colorref);
  ctx.fillRect(x, y, w, 1);
}

/** Draw a vertical 1-pixel line. */
export function vLine(ctx: GdiCtx, x: number, y: number, h: number, colorref: number): void {
  ctx.fillStyle = colorrefToCSS(colorref);
  ctx.fillRect(x, y, 1, h);
}
