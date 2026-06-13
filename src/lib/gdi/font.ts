// GDI font model shared by all callers. Mirrors the LOGFONTA fields the
// rest of the codebase actually uses; everything else stays defaultable.
// CSS font shorthand is produced by `toCSSFont` so canvas measurement and
// fillText pick up exactly the same font selection.

export const FW_NORMAL = 400;
export const FW_BOLD = 700;

export const DEFAULT_PIXEL_HEIGHT = 13;

/** Display DPI assumed for px ↔ point math. Mirrors GDI's screen LOGPIXELSY
 *  default and keeps HLP halfPoints conversions identical to WinHelp's
 *  `MulDiv(LOGPIXELSY, halfPoints, 144)` formula. */
export const SCREEN_DPI = 96;

/** Subset of LOGFONTA fields actually consumed by HLP layout / GDI text
 *  emulation. `height` follows GDI conventions: negative = character height
 *  (cell minus internal leading), positive = full cell height, 0 = default. */
export interface GdiFont {
  height: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strikeout: boolean;
  faceName: string;
}

export function makeFont(partial: Partial<GdiFont> = {}): GdiFont {
  return {
    height: partial.height ?? -DEFAULT_PIXEL_HEIGHT,
    weight: partial.weight ?? FW_NORMAL,
    italic: !!partial.italic,
    underline: !!partial.underline,
    strikeout: !!partial.strikeout,
    faceName: partial.faceName || 'Tahoma',
  };
}

/** Effective pixel size used to drive the canvas `font` shorthand. */
export function fontPixelSize(font: GdiFont): number {
  const h = Math.abs(font.height) || DEFAULT_PIXEL_HEIGHT;
  return h;
}

/** Resolve a Windows face name into a CSS font-family list that hits
 *  whatever's actually installed on the host (macOS / modern Windows /
 *  Ubuntu). The requested face is always first — when it happens to be
 *  present we keep using it — followed by per-classification fallbacks
 *  and finally a generic family.
 *
 *  The classification mirrors how Win95 / NT ships these face names:
 *    serif:     MS Serif, Roman, Times, Times New Roman, Garamond,
 *               Bookman, Century, Palatino, 宋体 / SimSun / MS Mincho
 *    mono:      Fixedsys, Courier, Courier New, Terminal, Lucida Console,
 *               Consolas, "Lucida Sans Typewriter"
 *    symbol:    Symbol, WingDings (kept as-is, then plain serif)
 *    sans:      MS Sans Serif, MS UI Gothic, Helv, Tahoma, Arial,
 *               System, 微软雅黑 / Microsoft YaHei, 黑体 / SimHei,
 *               MS Gothic, everything else
 */
export function fontFamilyFallback(faceName: string): string {
  const f = faceName.trim();
  const lc = f.toLowerCase();
  const wrap = (n: string) => /[\s,'"]/.test(n) ? `"${n}"` : n;
  const cjkFallback = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Zen Hei"';
  const cjkSerifFallback = '"Songti SC", "Source Han Serif SC", "Noto Serif CJK SC", SimSun, "MS Mincho"';
  // Symbol fonts — keep the original (most browsers ship Symbol on every
  // platform) and fall back to STIX/Cambria Math so glyphs at least render.
  if (lc === 'symbol' || lc === 'wingdings' || lc === 'webdings' || lc === 'marlett' || lc === 'monotype sorts') {
    return `${wrap(f)}, "Symbol", "STIX Two Math", "Cambria Math", serif`;
  }
  // Monospace / terminal fonts.
  if (lc === 'fixedsys' || lc === 'terminal' || lc === 'courier' || lc === 'courier new'
      || lc === 'consolas' || lc === 'lucida console' || lc === 'lucida sans typewriter'
      || lc === 'system fixed') {
    return `${wrap(f)}, "Courier New", Courier, "Menlo", "DejaVu Sans Mono", monospace`;
  }
  // Serif / proportional book fonts.
  if (lc === 'ms serif' || lc === 'roman' || lc === 'times' || lc === 'times new roman'
      || lc === 'serif' || lc === 'tms rmn' || lc === 'garamond' || lc === 'bookman'
      || lc === 'century schoolbook' || lc === 'palatino' || lc === 'palatino linotype'
      || lc === 'cambria' || lc === 'georgia' || lc === 'book antiqua') {
    return `${wrap(f)}, "Times New Roman", "Times", "Liberation Serif", "DejaVu Serif", serif`;
  }
  // CJK fonts that ship with Windows in CHS/CHT/JP/KR locales.
  if (f === '宋体' || lc === 'simsun' || lc === 'nsimsun' || lc === '新宋体'
      || lc === '仿宋' || lc === '仿宋_gb2312' || lc === 'fangsong' || lc === 'fangsong_gb2312'
      || lc === 'ms mincho' || lc === 'ms pmincho' || lc === 'batang' || lc === 'batangche'
      || lc === 'mingliu' || lc === 'pmingliu') {
    return `${wrap(f)}, ${cjkSerifFallback}, "Times New Roman", serif`;
  }
  if (f === '黑体' || lc === 'simhei' || f === '微软雅黑' || lc === 'microsoft yahei'
      || lc === 'microsoft jhenghei' || lc === 'ms gothic' || lc === 'ms pgothic'
      || lc === 'meiryo' || lc === 'malgun gothic' || lc === 'dotum' || lc === 'gulim') {
    return `${wrap(f)}, ${cjkFallback}, sans-serif`;
  }
  // Default to a sans chain. Win-only sans names (MS Sans Serif, Helv,
  // System, Small Fonts) and any unknown name end up here.
  return `${wrap(f)}, ${cjkFallback}, Tahoma, "Segoe UI", "Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;
}

/** Compose a `ctx.font` shorthand from a GdiFont, including weight, style,
 *  and a Windows-aware fallback chain that maps Win95 face names onto
 *  fonts present on macOS / Win11 / Ubuntu / common Linux distros. */
export function toCSSFont(font: GdiFont): string {
  const px = fontPixelSize(font);
  const style = font.italic ? 'italic ' : '';
  const weight = font.weight >= FW_BOLD ? 'bold ' : '';
  return `${style}${weight}${px}px ${fontFamilyFallback(font.faceName)}`;
}

/** Build a GdiFont from WinHelp's |FONT FontDescriptor. WinHelp encodes
 *  text size as half-points; convert to pixels via `LOGPIXELSY * hp / 144`
 *  just like WinHelp's font factory does. lfHeight is negative because the
 *  authoring tool requests "character height" rather than cell height. */
export function gdiFontFromHlpDescriptor(
  attributes: number,
  halfPoints: number,
  faceName: string,
): GdiFont {
  const px = Math.max(1, Math.round(SCREEN_DPI * halfPoints / 144));
  return {
    height: -px,
    weight: (attributes & 0x01) ? FW_BOLD : FW_NORMAL,
    italic: !!(attributes & 0x02),
    underline: !!(attributes & 0x04),
    strikeout: !!(attributes & 0x08),
    faceName: faceName || 'Tahoma',
  };
}
