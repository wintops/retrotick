// HLP → DOM renderer. Walks decoded paragraph events and emits a
// preact VNode tree. Browser handles reflow, word-wrap and CJK
// line-breaking — we only translate ParaInfo / font / hotspot opcodes
// into the matching HTML structure.
import type { VNode } from 'preact';
import type { DecodedParagraph, RenderEvent, ParaState } from './format';
import type { FontTable, FontDescriptor } from './font';
import { FONT_BOLD, FONT_ITALIC, FONT_UNDERLINE, FONT_STRIKEOUT } from './font';
import type { HlpHotspot } from './picture';
import { fontFamilyFallback } from '../gdi';
import { hashContext } from './hash';

export interface RenderBitmap {
  url: string;
  width: number;
  height: number;
  hotspots: HlpHotspot[];
}

export type ClickAction =
  | { kind: 'jump'; hash: number; window?: number }
  | { kind: 'popup'; hash: number; window?: number }
  | { kind: 'macro'; macro: string }
  | { kind: 'crossFile'; file: string; hash: number; popup: boolean; window: number }
  | { kind: 'context'; context: string };

export interface ClickEvent {
  action: ClickAction;
  clientX: number;
  clientY: number;
}

export interface RenderOpts {
  fontTable: FontTable;
  bitmaps: Map<number, RenderBitmap>;
  initialFontIdx?: number;
  onAction: (e: ClickEvent) => void;
}

// --- ParaInfo unit conversion --------------------------------------------
// Most ParaInfo lengths (HCW3 flat type 1/20/22 and HCW4 type 32) are
// stored in 1/144 inch — half-points / 10 twips. The reference converts
// them to device pixels via `value * LOGPIXELS / 144`, which at 96 DPI
// is `value * 2/3`. HCW3 table cells (types 23 / 35) store values in
// device pixels already; pass them through unchanged.
function paraConv(recordType: number): (n: number) => number {
  if (recordType === 23 || recordType === 35) return (n) => n;
  return (n) => Math.round(n * 96 / 144);
}

// --- font ----------------------------------------------------------------

function fontStyle(fd: FontDescriptor | undefined, facenames: string[]): Record<string, string> {
  if (!fd) return {};
  const face = facenames[fd.facenameIdx] || 'Tahoma';
  const px = Math.max(1, Math.round(96 * (fd.halfPoints || 24) / 144));
  const style: Record<string, string> = {
    fontFamily: fontFamilyFallback(face),
    fontSize: `${px}px`,
  };
  if (fd.attributes & FONT_BOLD) style.fontWeight = 'bold';
  if (fd.attributes & FONT_ITALIC) style.fontStyle = 'italic';
  const dec: string[] = [];
  if (fd.attributes & FONT_UNDERLINE) dec.push('underline');
  if (fd.attributes & FONT_STRIKEOUT) dec.push('line-through');
  if (dec.length) style.textDecoration = dec.join(' ');
  if (fd.fgR || fd.fgG || fd.fgB) style.color = `rgb(${fd.fgR},${fd.fgG},${fd.fgB})`;
  return style;
}

// --- paragraph CSS -------------------------------------------------------

function paraStyle(ps: ParaState, recordType: number): Record<string, string | number> {
  const conv = paraConv(recordType);
  // `flow-root` establishes a new block-formatting context so the
  // paragraph contains any block-aligned pictures inside it (matching
  // WinHelp: a left-aligned picture stays within its paragraph and the
  // next paragraph starts cleanly below). `margin: 0` strips the default
  // `<div>` zero / `<p>` 1em margins so ParaInfo's spacingAbove/Below
  // is the sole source of vertical gap.
  const s: Record<string, string | number> = { margin: 0, display: 'flow-root' };
  // Margin-left / margin-right come from ParaInfo's leftIndent /
  // rightIndent. Reference (sub_413BA0) lets negative values shift the
  // paragraph outside the body-padding clip rect (Rect.left + 3) and
  // relies on the outer window chrome to absorb it. Our container has
  // overflow: hidden with no chrome, so negative values disappear past
  // the left edge — clamp to 0 to keep content visible.
  if (ps.leftIndent !== undefined && ps.leftIndent > 0) {
    s.marginLeft = `${conv(ps.leftIndent)}px`;
  }
  if (ps.rightIndent !== undefined && ps.rightIndent > 0) {
    s.marginRight = `${conv(ps.rightIndent)}px`;
  }
  // firstLineIndent maps to CSS text-indent. Positive shifts the first
  // line right; negative creates a hanging indent (first line out-dented
  // relative to wrapped lines).
  if (ps.firstLineIndent && ps.firstLineIndent !== 0) {
    s.textIndent = `${conv(ps.firstLineIndent)}px`;
  }
  if (ps.spacingAbove && ps.spacingAbove > 0) s.marginTop = `${conv(ps.spacingAbove)}px`;
  if (ps.spacingBelow && ps.spacingBelow > 0) s.marginBottom = `${conv(ps.spacingBelow)}px`;
  // spacingLines is not mapped to CSS line-height. The reference adds a
  // dynamic baseline value (the live font's tmHeight in 1/144 inch) to
  // the stored field before converting — without knowing the active font
  // at paragraph layout time we can't replicate that, and any naive
  // mapping crushes lines. Browser default (`line-height: normal`, ~1.2x
  // font size) is close enough to WinHelp single-spacing.
  if (ps.alignment) s.textAlign = ps.alignment;
  // Tab semantics in WinHelp: tab advances the cursor to the next stop
  // in ParaInfo's tab-stop list, or to the default 1/2-inch grid when
  // no stops are defined. CSS `tab-size: <length>` implements the same
  // "advance to the next integer multiple of <length>" formula, and
  // `white-space: pre-wrap` is needed for the literal U+0009 we emit
  // for `tab` events to be honored.
  const tabPx = (ps.tabStops && ps.tabStops.length > 0)
    ? conv(ps.tabStops[0])
    : 48;  // default tab when no stops defined (72 / 144 inch at 96 DPI)
  if (tabPx > 0) {
    s.tabSize = `${tabPx}px`;
    s.whiteSpace = 'pre-wrap';
  }
  if (ps.borderFlags) {
    // border palette is implementation-defined; gray reads neutrally
    // against both the white scroll region and the gray banner.
    const c = '1px solid #808080';
    if (ps.borderFlags & 0x01) s.borderTop = c;
    if (ps.borderFlags & 0x02) s.borderLeft = c;
    if (ps.borderFlags & 0x04) s.borderBottom = c;
    if (ps.borderFlags & 0x08) s.borderRight = c;
    if (ps.borderFlags & 0x10) s.border = c;
  }
  return s;
}

// --- MBCS text decoding --------------------------------------------------

function decodeBytes(b: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === 0) { i++; continue; }
    if (c < 0x20 && c !== 0x09 && c !== 0x0A) { i++; continue; }
    if (c >= 0x81 && c <= 0xFE && i + 1 < b.length) {
      const c2 = b[i + 1];
      if (c2 >= 0x40) {
        out += String.fromCharCode((c << 8) | c2);
        i += 2;
        continue;
      }
    }
    out += String.fromCharCode(c);
    i++;
  }
  return out;
}

// --- hotspot helpers -----------------------------------------------------

type HotspotRef =
  | { kind: 'jump'; action: ClickAction; underline: boolean }
  | { kind: 'popup'; action: ClickAction; underline: boolean }
  | { kind: 'macro'; action: ClickAction; tooltip: string; underline: boolean }
  | { kind: 'crossFile'; action: ClickAction; underline: boolean };

function hotspotStyle(ref: HotspotRef): Record<string, string> {
  // WinHelp encodes a per-hotspot "no underline" flag (opcode bit 0x04).
  // We honor it here — the visual treatment is colour only, no decoration
  // — so links like "Move Around in a Help file" on the WINHELP.HLP main
  // page show up as green text without the underline that normal jumps
  // get. Popups when underlined use a dotted line, jumps use solid.
  const s: Record<string, string> = {
    color: '#008000',
    cursor: 'pointer',
  };
  if (ref.underline) {
    s.textDecoration = ref.kind === 'popup' ? 'underline dotted' : 'underline';
  } else {
    s.textDecoration = 'none';
  }
  return s;
}

function clickHandler(action: ClickAction, onAction: (e: ClickEvent) => void) {
  return (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onAction({ action, clientX: e.clientX, clientY: e.clientY });
  };
}

function pictureIdFromEvent(ev: Extract<RenderEvent, { kind: 'picture' }>): number {
  if (ev.type === 0x03 && ev.payload.length >= 2) {
    return new DataView(ev.payload.buffer, ev.payload.byteOffset, ev.payload.byteLength).getUint16(0, true);
  }
  if (ev.type === 0x22 && ev.payload.length >= 4) {
    return new DataView(ev.payload.buffer, ev.payload.byteOffset, ev.payload.byteLength).getUint16(2, true);
  }
  return -1;
}

function imageActionFromHotspot(h: HlpHotspot): ClickAction | null {
  if (h.macro) return { kind: 'macro', macro: h.macro };
  if (h.hash) return { kind: 'jump', hash: h.hash };
  if (h.context) return { kind: 'context', context: h.context };
  return null;
}

// --- grouping ------------------------------------------------------------
// Consecutive table-row paragraphs (record types 23 / 35 with `cells`
// populated) get rendered as one <table>. Everything else is a flat para.

type Group =
  | { kind: 'para'; para: DecodedParagraph }
  | { kind: 'table'; rows: DecodedParagraph[]; columns: number; columnWidths: { width: number; gap: number }[] };

function group(paras: DecodedParagraph[]): Group[] {
  const out: Group[] = [];
  let i = 0;
  while (i < paras.length) {
    const p = paras[i];
    if (p.cells && p.table) {
      const rows: DecodedParagraph[] = [p];
      let j = i + 1;
      while (j < paras.length) {
        const n = paras[j];
        if (!n.cells || !n.table || n.table.columns !== p.table.columns) break;
        rows.push(n);
        j++;
      }
      out.push({ kind: 'table', rows, columns: p.table.columns, columnWidths: p.table.columnWidths });
      i = j;
    } else {
      out.push({ kind: 'para', para: p });
      i++;
    }
  }
  return out;
}

// --- main entry ----------------------------------------------------------

export function renderParagraphs(paras: DecodedParagraph[], opts: RenderOpts): VNode[] {
  const groups = group(paras);
  const out: VNode[] = [];
  // Font state survives across paragraphs (HCW carries the active font
  // forward) so we thread the index across `<p>` boundaries.
  const carry = { fontIdx: opts.initialFontIdx ?? 0 };
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.kind === 'para') {
      out.push(renderFlatPara(g.para, opts, carry, i));
    } else {
      out.push(renderTable(g, opts, carry, i));
    }
  }
  return out;
}

// --- flat paragraph ------------------------------------------------------

interface Carry { fontIdx: number; }

function renderFlatPara(para: DecodedParagraph, opts: RenderOpts, carry: Carry, key: number): VNode {
  // Some HCW4 streams emit several paraBegin/paraEnd cycles in one record.
  // Split into one logical <p> per cycle to give every alignment / indent
  // its own block.
  const blocks: VNode[] = [];
  let bucket: RenderEvent[] | null = null;
  let bucketState: ParaState = {};
  let logicalKey = 0;
  const flush = () => {
    if (!bucket) return;
    // Skip purely-empty paragraphs (no text, picture or hotspot). When a
    // table cell ends with a 0x82 right before 0xFF, the format decoder
    // emits a trailing paraBegin/paraEnd pair — rendering that would
    // pile an extra spacingAbove/Below margin on top of the next block.
    const hasContent = bucket.some(ev =>
      ev.kind === 'text' || ev.kind === 'picture'
      || ev.kind === 'jump' || ev.kind === 'popup'
      || ev.kind === 'macroHotspot' || ev.kind === 'crossFile');
    if (hasContent) {
      blocks.push(renderLogicalPara(para.recordType, bucketState, bucket, opts, carry, `${key}-${logicalKey++}`));
    }
    bucket = null;
  };
  for (const e of para.events) {
    if (e.kind === 'paraBegin') {
      flush();
      bucket = [];
      bucketState = e.state;
      continue;
    }
    if (e.kind === 'paraEnd') {
      flush();
      continue;
    }
    if (bucket) bucket.push(e);
    else if (e.kind === 'font') carry.fontIdx = e.index;
  }
  flush();
  if (blocks.length === 1) return blocks[0];
  return <div key={key}>{blocks}</div>;
}

function renderLogicalPara(
  recordType: number,
  state: ParaState,
  events: RenderEvent[],
  opts: RenderOpts,
  carry: Carry,
  key: string,
): VNode {
  // Walk events, batching adjacent inline content under the active font
  // and hotspot. Each style change closes the current span and opens a
  // new one — preserves the per-run grouping the renderer cares about
  // without any per-word work.
  const children: VNode[] = [];
  let groupItems: (VNode | string)[] = [];
  let groupFontIdx = carry.fontIdx;
  let groupHotspot: HotspotRef | null = null;

  const flushGroup = (gk: number) => {
    if (groupItems.length === 0) return;
    const fd = opts.fontTable.descriptors[groupFontIdx];
    const span = <span key={`s${gk}`} style={fontStyle(fd, opts.fontTable.facenames)}>{groupItems}</span>;
    if (groupHotspot) {
      children.push(
        <a key={`a${gk}`}
          href="#"
          title={groupHotspot.kind === 'macro' ? (groupHotspot as any).tooltip : undefined}
          onClick={clickHandler(groupHotspot.action, opts.onAction)}
          style={hotspotStyle(groupHotspot)}>
          {span}
        </a>,
      );
    } else {
      children.push(span);
    }
    groupItems = [];
  };

  let gk = 0;
  const setStyle = (nextFontIdx: number, nextHotspot: HotspotRef | null) => {
    if (nextFontIdx === groupFontIdx && nextHotspot === groupHotspot) return;
    flushGroup(gk++);
    groupFontIdx = nextFontIdx;
    groupHotspot = nextHotspot;
  };

  for (const ev of events) {
    switch (ev.kind) {
      case 'font':
        carry.fontIdx = ev.index;
        setStyle(ev.index, groupHotspot);
        continue;
      case 'jump':
        setStyle(groupFontIdx, { kind: 'jump', action: { kind: 'jump', hash: ev.hash, window: ev.window }, underline: ev.underline });
        continue;
      case 'popup':
        setStyle(groupFontIdx, { kind: 'popup', action: { kind: 'popup', hash: ev.hash, window: ev.window }, underline: ev.underline });
        continue;
      case 'macroHotspot':
        setStyle(groupFontIdx, { kind: 'macro', action: { kind: 'macro', macro: ev.macro }, tooltip: ev.macro, underline: ev.underline });
        continue;
      case 'crossFile':
        setStyle(groupFontIdx, { kind: 'crossFile', action: { kind: 'crossFile', file: ev.file, hash: ev.hash, popup: ev.popup, window: ev.window }, underline: ev.underline });
        continue;
      case 'hotspotEnd':
        setStyle(groupFontIdx, null);
        continue;
      case 'text': {
        const text = decodeBytes(ev.bytes);
        if (text) groupItems.push(text);
        continue;
      }
      case 'lineBreak':
        groupItems.push(<br key={`br${gk++}`} />);
        continue;
      case 'tab':
        // Emit a literal U+0009. Combined with `tab-size: tabStops[0]px`
        // and `white-space: pre-wrap` on the paragraph, the browser
        // advances to the next tab stop > current x — matching WinHelp's
        // tab semantics (advance to next ParaInfo tabStops slot, or the
        // default 1/2-inch grid when no stops are defined).
        groupItems.push('\t');
        continue;
      case 'hardSpace':
      case 'nbsp':
        groupItems.push(' ');
        continue;
      case 'hardHyphen':
      case 'nbHyphen':
        groupItems.push('‑');
        continue;
      case 'picture': {
        const id = pictureIdFromEvent(ev);
        const bm = id >= 0 ? opts.bitmaps.get(id) : undefined;
        if (!bm) continue;
        groupItems.push(renderImage(bm, ev.align, opts, groupHotspot, gk++));
        continue;
      }
      case 'paraBegin':
      case 'paraEnd':
        continue;
      default:
        continue;
    }
  }
  flushGroup(gk++);

  // Use a `<div>` rather than `<p>` so we can embed block-level floating
  // pictures inside the paragraph — HTML doesn't permit `<div>` inside
  // `<p>` and the browser would auto-close the `<p>`, mangling our tree.
  return <div key={key} style={paraStyle(state, recordType)}>{children}</div>;
}

// --- image rendering -----------------------------------------------------

function renderImage(
  bm: RenderBitmap, align: 'char' | 'left' | 'right',
  opts: RenderOpts, parentHotspot: HotspotRef | null, key: number,
): VNode {
  // WinHelp's "floating" pictures (`\bmlf` / `\bmrt`) don't behave like
  // CSS floats. The reference renders them as block elements that take
  // up a full row anchored to the left or right; subsequent content goes
  // BELOW the picture, not beside it. Consecutive floating pictures stack
  // vertically (the Empires contents page navigation strip), so we make
  // them block + clear both. Only `char`-aligned pictures sit inline
  // with the surrounding text.
  const isBlock = align === 'left' || align === 'right';
  const hotspots = bm.hotspots ?? [];
  const wrapperStyle: Record<string, string> = isBlock
    ? {
        display: 'block',
        clear: 'both',
        width: `${bm.width}px`,
        marginLeft: align === 'right' ? 'auto' : '0',
        marginRight: align === 'left' ? 'auto' : '0',
        position: 'relative',
      }
    : {
        display: 'inline-block',
        position: 'relative',
        verticalAlign: 'text-bottom',
      };
  const imgEl = (
    <img
      src={bm.url} width={bm.width} height={bm.height} alt=""
      draggable={false}
      style={{ imageRendering: 'pixelated', userSelect: 'none', display: 'block' }}
    />
  );
  const overlays = hotspots.map((h, i) => {
    const action = imageActionFromHotspot(h);
    if (!action) return null;
    return (
      <a key={`h${i}`}
        href="#"
        title={h.context || h.macro || ''}
        onClick={clickHandler(action, opts.onAction)}
        style={{
          position: 'absolute',
          left: `${h.left}px`, top: `${h.top}px`,
          width: `${h.width}px`, height: `${h.height}px`,
          cursor: 'pointer',
          border: h.showBorder ? '1px dotted rgba(0,0,128,0.5)' : 'none',
          background: 'transparent',
        }} />
    );
  });
  void parentHotspot;
  // Block-floated pictures need a block-level container so they break out
  // of the surrounding inline span context — `<div>` is the safe choice
  // because the parent paragraph already uses `<div>` (not `<p>`).
  if (isBlock) return <div key={`pi${key}`} style={wrapperStyle}>{imgEl}{overlays}</div>;
  return <span key={`pi${key}`} style={wrapperStyle}>{imgEl}{overlays}</span>;
}

// --- tables (record types 23 / 35) ---------------------------------------

function renderTable(g: Extract<Group, { kind: 'table' }>, opts: RenderOpts, carry: Carry, key: number): VNode {
  const totalW = g.columnWidths.reduce((s, c) => s + Math.max(1, c.width), 0) || 1;
  return (
    <table key={key} style={{
      borderCollapse: 'collapse',
      width: '100%',
      tableLayout: 'fixed',
      margin: 0,
    }}>
      <colgroup>
        {g.columnWidths.map((c, i) => (
          <col key={`c${i}`} style={{ width: `${(Math.max(1, c.width) / totalW * 100).toFixed(2)}%` }} />
        ))}
      </colgroup>
      <tbody>
        {g.rows.map((row, ri) => {
          const cells = row.cells || [];
          const cellCols = row.cellCols || cells.map((_, i) => i);
          const byCol: RenderEvent[][][] = Array.from({ length: g.columns }, () => []);
          for (let i = 0; i < cells.length; i++) {
            const c = cellCols[i];
            if (c >= 0 && c < g.columns) byCol[c].push(cells[i]);
          }
          return (
            <tr key={`r${ri}`}>
              {byCol.map((cellList, ci) => {
                // HCW3 table column gap is "space between this column
                // and the next" in twips. Convert to px and skip it for
                // the last column (no "next" — the trailing value the
                // file stores there is usually the table's right margin
                // and isn't column padding).
                const rawGap = ci < g.columns - 1 ? (g.columnWidths[ci]?.gap ?? 0) : 0;
                const padPx = Math.max(0, Math.round(rawGap / 15));
                return (
                  <td key={`d${ci}`} style={{
                    verticalAlign: 'top',
                    paddingRight: `${padPx}px`,
                    border: 'none',
                  }}>
                    {cellList.map((cellEvents, pi) => (
                      <CellPara
                        key={`p${pi}`}
                        recordType={row.recordType}
                        events={cellEvents}
                        opts={opts}
                        carry={carry}
                      />
                    ))}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CellPara({ recordType, events, opts, carry, ...rest }: {
  recordType: number;
  events: RenderEvent[];
  opts: RenderOpts;
  carry: Carry;
  key?: string;
}): VNode {
  // Re-use the same flat-paragraph pipeline for the contents of a table
  // cell so font/hotspot carry-over and ParaInfo handling stay uniform.
  const subPara: DecodedParagraph = { recordType, events };
  void rest;
  return renderFlatPara(subPara, opts, carry, 0);
}

// Kept exported so non-render call sites can still hash context names
// (used by ALink resolution in HelpViewerWindow's macro host).
export { hashContext };
