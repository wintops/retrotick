// COLORREF helpers shared by HLP rendering, x86 GDI emulation, DDraw and
// DOS graphics layers. Win32 COLORREF stores BGR (low byte = R, byte 2 = B).
// Top byte 0x01 marks PALETTEINDEX; top byte 0x02 marks PALETTERGB.

export type RGB = readonly [number, number, number];

export const RGB_BLACK: RGB = [0, 0, 0];
export const RGB_WHITE: RGB = [255, 255, 255];

export function colorrefToRGB(bgr: number): RGB {
  return [bgr & 0xFF, (bgr >> 8) & 0xFF, (bgr >> 16) & 0xFF];
}

export function rgbToColorref(r: number, g: number, b: number): number {
  return ((b & 0xFF) << 16) | ((g & 0xFF) << 8) | (r & 0xFF);
}

export function colorrefToCSS(bgr: number): string {
  return `rgb(${bgr & 0xFF},${(bgr >> 8) & 0xFF},${(bgr >> 16) & 0xFF})`;
}

export function rgbToCSS(rgb: RGB): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export function isPaletteIndex(colorref: number): boolean {
  return (colorref & 0xFF000000) === 0x01000000;
}

export function paletteIndexOf(colorref: number): number {
  return colorref & 0xFFFF;
}

/** Resolve a COLORREF that may be PALETTEINDEX-encoded against a palette
 *  (entries laid out R,G,B,flags × count). Direct RGB values pass through. */
export function resolveColorref(colorref: number, palette?: { entries: Uint8Array; count: number }): RGB {
  if (isPaletteIndex(colorref) && palette) {
    const idx = paletteIndexOf(colorref);
    if (idx < palette.count) {
      const o = idx * 4;
      return [palette.entries[o], palette.entries[o + 1], palette.entries[o + 2]];
    }
    return RGB_BLACK;
  }
  return colorrefToRGB(colorref);
}
