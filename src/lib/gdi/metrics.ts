// Text measurement helpers. All callers — HLP layout, x86 GDI text APIs,
// DDraw text overlays — should go through these so the font selected on
// the context matches what we actually measured against.
import { fontPixelSize, toCSSFont, type GdiFont } from './font';

export interface TextMetrics {
  /** Cell height — matches Win32 TEXTMETRIC.tmHeight. */
  height: number;
  ascent: number;
  descent: number;
  /** Internal leading: portion of tmHeight that sits above the cap line
   *  (zero in our approximation — browsers don't expose it reliably). */
  internalLeading: number;
  /** External leading: extra padding between lines that GDI advises but
   *  does not include in tmHeight. */
  externalLeading: number;
  aveCharWidth: number;
  maxCharWidth: number;
}

export type GdiCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Apply a GdiFont to a Canvas context, returning the CSS shorthand used.
 *  Always sets `textBaseline = 'alphabetic'` so y/baseline arithmetic
 *  matches GDI's expectations. */
export function applyFont(ctx: GdiCtx, font: GdiFont): string {
  const css = toCSSFont(font);
  ctx.font = css;
  ctx.textBaseline = 'alphabetic';
  return css;
}

/** Measure horizontal advance of a string under the supplied font. Reuses
 *  the context's current font setting if it already matches. */
export function measureTextWidth(ctx: GdiCtx, font: GdiFont, text: string): number {
  if (!text) return 0;
  applyFont(ctx, font);
  return Math.ceil(ctx.measureText(text).width);
}

/** Synthesize a GDI-style TEXTMETRIC. We don't have access to real font
 *  metrics from canvas (`actualBoundingBoxAscent` reflects the measured
 *  glyphs, not the font), so we derive ascent/descent from cell height
 *  using ratios that GDI uses for typical Windows fonts. */
export function getTextMetrics(ctx: GdiCtx, font: GdiFont): TextMetrics {
  const height = fontPixelSize(font);
  applyFont(ctx, font);
  // Sample width across letters; matches GDI's reported tmAveCharWidth.
  const sample = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const sampleW = ctx.measureText(sample).width;
  const aveCharWidth = Math.max(1, Math.round(sampleW / sample.length));
  const maxCharWidth = Math.max(aveCharWidth, Math.ceil(ctx.measureText('W').width));
  const ascent = Math.round(height * 0.8);
  const descent = height - ascent;
  return {
    height, ascent, descent,
    internalLeading: 0,
    externalLeading: 0,
    aveCharWidth, maxCharWidth,
  };
}

/** Per-character cumulative widths for word-wrap. Returns an array `cw`
 *  of length `text.length + 1`; `cw[i]` is the pixel width of `text[0..i]`. */
export function cumulativeWidths(ctx: GdiCtx, font: GdiFont, text: string): number[] {
  applyFont(ctx, font);
  const out = new Array<number>(text.length + 1);
  out[0] = 0;
  let acc = 0;
  // measureText per substring is O(n²) but cumulativeWidths is only used
  // for word-wrap on short paragraph fragments; this is fast enough and
  // robust to kerning/ligature effects in canvas implementations.
  for (let i = 1; i <= text.length; i++) {
    const w = ctx.measureText(text.substring(0, i)).width;
    if (w > acc) acc = w;
    out[i] = acc;
  }
  return out;
}
