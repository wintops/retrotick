// Paragraph format decoder.
//
// Layout for type-1/20/22/23/35: TopicSize (clong) + TopicLength (clong) +
//   per-paragraph format stream.
//
// Layout for type-32 (HCW4 main display): a 4-byte clong-pair prefix, then
//   a u32 ParaState bitfield (bits 16..29 describe per-paragraph fields),
//   per-paragraph metadata, then format opcodes. Text comes from LinkData2
//   split on NUL bytes.
//
// Format opcodes:
//   0x80 + u16:                font change
//   0x81:                      line break
//   0x82:                      paragraph end
//   0x83:                      tab
//   0x85 + u16:                3 bytes
//   0x86/0x87/0x88 + struct:   picture (char/left/right alignment)
//   0x89:                      end-of-hotspot
//   (op & 0xD8) == 0xC0:       opcode + u32 hash (5 bytes)
//   (op & 0xD8) == 0xC8:       opcode + clong size + size bytes (variable)
//   0xFF:                      end of stream
import { Cursor } from './cint';

export interface ParaState {
  spacingAbove?: number;
  spacingBelow?: number;
  spacingLines?: number;
  leftIndent?: number;
  rightIndent?: number;
  firstLineIndent?: number;
  borderFlags?: number;
  borderColor?: number;
  tabStops?: number[];
  alignment?: 'left' | 'center' | 'right' | 'justify';
}

export type RenderEvent =
  | { kind: 'text'; bytes: Uint8Array }
  | { kind: 'lineBreak' }
  | { kind: 'paraEnd' }
  | { kind: 'paraBegin'; state: ParaState }
  | { kind: 'tab' }
  | { kind: 'hardSpace' }
  | { kind: 'hardHyphen' }
  | { kind: 'nbsp' }
  | { kind: 'nbHyphen' }
  | { kind: 'font'; index: number }
  | { kind: 'picture'; align: 'char' | 'left' | 'right'; type: number; payload: Uint8Array }
  | { kind: 'jump'; hash: number; underline: boolean; window?: number }
  | { kind: 'popup'; hash: number; underline: boolean; window?: number }
  | { kind: 'crossFile'; popup: boolean; window: number; hash: number; file: string; underline: boolean }
  | { kind: 'macroHotspot'; macro: string; underline: boolean }
  | { kind: 'hotspotEnd' }
  | { kind: 'unknownOp'; op: number };

export interface DecodedParagraph {
  recordType: number;
  events: RenderEvent[];
  /** Table info — set for type-23 / type-35 records. Each TopicLink record
   *  is one row; `cells` lists the events per cell within this row. */
  table?: { columns: number; type: number; columnWidths: Array<{ gap: number; width: number }>; minWidth: number };
  /** Per-cell events when `table` is set. */
  cells?: RenderEvent[][];
}

export function decodeDisplayLink(recordType: number, linkData1: Uint8Array, linkData2: Uint8Array): DecodedParagraph {
  // HCW4 type-32: NUL-segmented LD2, ParaInfo prefix, simpler format ops.
  if (recordType === 32) {
    return decodeType32(linkData1, linkData2);
  }

  // type-23 / type-35: table rows. One TopicLink record = one row with N
  // cells laid out inline in LD1.
  if (recordType === 23 || recordType === 35) {
    return decodeTableRow(recordType, linkData1, linkData2);
  }

  // Types 1 / 20 / 22: standalone paragraph records. LinkData1 starts with
  // TopicSize (clongBiased) + TopicOffsetIncrement (cuint) + ParaInfo,
  // then a format-opcode stream terminated by 0xFF. LD2 carries the text
  // (one NUL-delimited run drains BEFORE each opcode dispatch — same
  // pattern as table cells).
  return decodeFlatParagraph(recordType, linkData1, linkData2);
}

/** Decode a standalone paragraph record (type 1 / 20 / 22). */
function decodeFlatParagraph(recordType: number, linkData1: Uint8Array, linkData2: Uint8Array): DecodedParagraph {
  const c = new Cursor(linkData1);
  const events: RenderEvent[] = [];

  // TopicSize + TopicOffsetIncrement.
  try { c.clongBiased(); } catch {}
  try { c.cuint(); } catch {}

  // ParaInfo prefix (only present for types 20 / 22; type 1 has none).
  const state: ParaState = {};
  if (recordType !== 1 && c.remaining >= 3) {
    /* const skipByte = */ c.u8();
    let psLow = 0, psHigh = 0;
    if (!c.eof) psLow = c.u8();
    if (!c.eof) psHigh = c.u8();
    const ps = psLow | (psHigh << 8);
    if (ps & 0x0001) state.spacingAbove = c.cuint();
    if (ps & 0x0002) state.spacingBelow = c.cuint();
    if (ps & 0x0004) state.spacingLines = c.cuint();
    if (ps & 0x0008) state.leftIndent = c.cuint();
    if (ps & 0x0010) state.rightIndent = c.cuint();
    if (ps & 0x0020) state.firstLineIndent = c.cuint();
    if (ps & 0x0100 && c.remaining >= 3) {
      state.borderFlags = c.u8();
      state.borderColor = c.u16();
    }
    if (ps & 0x0200) {
      const ntabs = c.cuint();
      const stops: number[] = [];
      for (let i = 0; i < ntabs && !c.eof; i++) stops.push(c.cuint());
      state.tabStops = stops;
    }
    if (ps & 0x0400) state.alignment = 'center';
    else if (ps & 0x0800) state.alignment = 'right';
    else if (ps & 0x1000) state.alignment = 'justify';
  }
  events.push({ kind: 'paraBegin', state });

  // For type-1 / 20 / 22 (HC30-style flat paragraphs) the LD2 text stream
  // is consumed in chunks at "termination" opcodes — 0x89 ends the text
  // inside a hotspot, 0x82 ends a plain paragraph, 0xFF terminates the
  // record. Each drain skips empty NUL-segments and emits the next
  // non-empty run.
  const ld2Pos = { v: 0 };
  const drainText = () => {
    while (ld2Pos.v < linkData2.length && linkData2[ld2Pos.v] === 0) ld2Pos.v++;
    const start = ld2Pos.v;
    while (ld2Pos.v < linkData2.length && linkData2[ld2Pos.v] !== 0) ld2Pos.v++;
    if (ld2Pos.v > start) events.push({ kind: 'text', bytes: linkData2.subarray(start, ld2Pos.v) });
    if (ld2Pos.v < linkData2.length) ld2Pos.v++;
  };
  decodeFlatFormat(c, events, drainText);
  events.push({ kind: 'paraEnd' });
  return { recordType, events };
}

/** Format-opcode loop for a HC30 / HCW3.x flat paragraph (type 1/20/22).
 *  Differs from the table-cell decoder: text drains are triggered only at
 *  text-terminator opcodes (0x89 inside a hotspot, 0x82 between plain
 *  paragraph runs) so the LD2 stream stays aligned with the hotspot
 *  structure of multi-jump paragraphs. */
function decodeFlatFormat(c: Cursor, events: RenderEvent[], drainText: () => void): void {
  // `expectAt` tracks the opcode at which the next text drain should fire:
  //   '0x82' — plain paragraph: text gets drained at the closing 0x82.
  //   '0x89' — inside a hotspot: text is drained at the closing 0x89.
  //   null   — text was just drained; the next 0x82 is a structural
  //            paragraph break with no text and shouldn't drain.
  let expectAt: 0x82 | 0x89 | null = 0x82;
  let safety = 0;
  while (!c.eof && safety++ < 1000) {
    const op = c.buf[c.pos];
    if (op === 0xFF) {
      c.pos++;
      if (expectAt === 0x82) drainText();
      return;
    }
    c.pos++;
    if (op === 0x20) { events.push({ kind: 'hardSpace' }); continue; }
    if (op === 0x21) { events.push({ kind: 'hardHyphen' }); continue; }
    if (op === 0x80 && c.remaining >= 2) { events.push({ kind: 'font', index: c.u16() }); continue; }
    if (op === 0x81) { events.push({ kind: 'lineBreak' }); continue; }
    if (op === 0x82) {
      if (expectAt === 0x82) drainText();
      events.push({ kind: 'paraEnd' });
      events.push({ kind: 'paraBegin', state: {} });
      expectAt = 0x82;
      continue;
    }
    if (op === 0x83) { events.push({ kind: 'tab' }); continue; }
    if (op === 0x85 && c.remaining >= 2) { c.u16(); continue; }
    if (op === 0x86 || op === 0x87 || op === 0x88) {
      const savedPos = c.pos;
      try {
        const t = c.u8();
        const sz = c.clong();
        if (t > 0x10) c.cuint();
        if (sz < 0 || sz > c.remaining) throw new Error('picture overruns LD1');
        const payload = c.bytes(sz);
        const align: 'char' | 'left' | 'right' = op === 0x86 ? 'char' : op === 0x87 ? 'left' : 'right';
        events.push({ kind: 'picture', align, type: t, payload });
      } catch {
        c.pos = savedPos;
        events.push({ kind: 'unknownOp', op });
      }
      continue;
    }
    if (op === 0x89) {
      drainText();
      events.push({ kind: 'hotspotEnd' });
      expectAt = null;
      continue;
    }
    if (op === 0x8B) { events.push({ kind: 'nbsp' }); continue; }
    if (op === 0x8C) { events.push({ kind: 'nbHyphen' }); continue; }
    // 5-byte hotspot: opcode + u32 target.
    if ((op & 0xD8) === 0xC0) {
      if (c.remaining < 4) { events.push({ kind: 'unknownOp', op }); continue; }
      const target = c.u32();
      const isJump = (op & 0x01) !== 0;
      const noUnderline = (op & 0x04) !== 0;
      events.push({ kind: isJump ? 'jump' : 'popup', hash: target, underline: !noUnderline });
      expectAt = 0x89;
      continue;
    }
    // Variable-size hotspot: opcode + u16 length + payload.
    if ((op & 0xD8) === 0xC8) {
      const savedPos = c.pos;
      if (c.remaining < 2) { events.push({ kind: 'unknownOp', op }); continue; }
      const sz = c.u16();
      if (sz < 0 || sz > c.remaining) {
        c.pos = savedPos;
        events.push({ kind: 'unknownOp', op });
        continue;
      }
      const payload = c.bytes(sz);
      const ev = decodeExtendedHotspot(op, payload);
      if (ev) {
        events.push(ev);
        expectAt = 0x89;
      }
      continue;
    }
    events.push({ kind: 'unknownOp', op });
  }
}

/** Decode a type-23 or type-35 TopicLink record (one table row).
 *  Layout:
 *    scanlong  TopicSize
 *    scanword  TopicOffsetIncrement
 *    u8        cols
 *    u8        tableType   (0/2 → has minWidth, 1/3 → no)
 *   [i16       minTableWidth]
 *    cols × { i16 width; i16 gap }
 *    cells loop:
 *      i16 column (-1 = end of row)
 *      u16 cellFlag
 *      u8  cellByte
 *      ParaInfo (u8 byte0, u8 byte1, u16 paraId, u16 x2 mask, conditional fields)
 *      format-opcode stream (text emitted from LD2), terminated by 0xFF
 */
function decodeTableRow(recordType: number, linkData1: Uint8Array, linkData2: Uint8Array): DecodedParagraph {
  const c = new Cursor(linkData1);
  try { c.clongBiased(); } catch {}    // TopicSize
  try { c.cuint(); } catch {}          // TopicOffsetIncrement

  let cols = 0, tableType = 0, minWidth = 0;
  const colW: Array<{ gap: number; width: number }> = [];
  if (c.remaining >= 2) {
    cols = c.u8();
    tableType = c.u8();
    if (tableType === 0 || tableType === 2) {
      if (c.remaining >= 2) minWidth = c.u16();
    }
    for (let i = 0; i < cols && c.remaining >= 4; i++) {
      const width = c.u16();
      const gap = c.u16();
      colW.push({ width, gap });
    }
  }

  // LD2 is shared across all cells in this row; we drain text from it
  // up to (and including) the NEXT NUL before dispatching each format
  // opcode.
  const ld2Pos = { v: 0 };
  const drainText = (target: RenderEvent[]): void => {
    const start = ld2Pos.v;
    while (ld2Pos.v < linkData2.length && linkData2[ld2Pos.v] !== 0) ld2Pos.v++;
    const end = ld2Pos.v;
    if (end > start) target.push({ kind: 'text', bytes: linkData2.subarray(start, end) });
    if (ld2Pos.v < linkData2.length) ld2Pos.v++; // consume the NUL
  };

  const cells: RenderEvent[][] = [];
  const overall: RenderEvent[] = [];
  // The font opcode (0x80) is a stream-level state: a font set in cell N
  // stays active for cell N+1 unless overridden. Carry it across cells so
  // each cell's render starts with the correct font.
  let curFont = 0;
  let safety = 0;
  while (!c.eof && safety++ < 100) {
    // Cell header: i16 column (sentinel -1), u16 cellFlag, u8 cellByte.
    if (c.remaining < 5) break;
    const colIdx = (c.buf[c.pos] | (c.buf[c.pos + 1] << 8));
    if (colIdx === 0xFFFF) { c.pos += 2; break; }
    c.pos += 2;        // column index
    c.u16();           // cellFlag
    c.u8();            // cellByte
    if (c.eof) break;

    // ParaInfo: u8 byte0, u8 byte1, u16 paraId, u16 x2 mask, conditional fields.
    /* const byte0   = */ c.u8();
    /* const byte1   = */ c.u8();
    /* const paraId  = */ c.u16();
    let x2 = 0;
    if (c.remaining >= 2) x2 = c.u16();

    const state: ParaState = {};
    if (x2 & 0x0001) skipScanLong(c);
    if (x2 & 0x0002) state.spacingAbove = readScanInt(c);
    if (x2 & 0x0004) state.spacingBelow = readScanInt(c);
    if (x2 & 0x0008) state.spacingLines = readScanInt(c);
    if (x2 & 0x0010) state.leftIndent = readScanInt(c);
    if (x2 & 0x0020) state.rightIndent = readScanInt(c);
    if (x2 & 0x0040) state.firstLineIndent = readScanInt(c);
    if (x2 & 0x0080) skipScanInt(c);
    if (x2 & 0x0100) {
      if (c.remaining >= 3) { state.borderFlags = c.u8(); state.borderColor = c.u16(); }
    }
    if (x2 & 0x0200) {
      const ntabs = c.cuint();
      const stops: number[] = [];
      for (let i = 0; i < ntabs && !c.eof; i++) stops.push(c.cuint());
      state.tabStops = stops;
    }
    if (x2 & 0x0400) state.alignment = 'center';
    else if (x2 & 0x0800) state.alignment = 'right';
    else if (x2 & 0x1000) state.alignment = 'justify';

    const cellEvents: RenderEvent[] = [{ kind: 'paraBegin', state }, { kind: 'font', index: curFont }];
    decodeTableCellFormat(c, cellEvents, () => drainText(cellEvents));
    cellEvents.push({ kind: 'paraEnd' });
    // Update curFont from the last font event in this cell so the next
    // cell starts where this one left off.
    for (let k = cellEvents.length - 1; k >= 0; k--) {
      const ev = cellEvents[k];
      if (ev.kind === 'font') { curFont = ev.index; break; }
    }
    cells.push(cellEvents);
  }
  // Flatten cells into the overall events stream so renderers without
  // table support still see all the row's text in order.
  for (const cellEvents of cells) for (const e of cellEvents) overall.push(e);

  const table = { columns: cols, type: tableType, columnWidths: colW, minWidth };
  return { recordType, events: overall, table, cells };
}

/** Format-opcode loop for a single table cell. Drain one NUL-terminated
 *  text run from LD2 BEFORE each opcode dispatch; stop when the next
 *  opcode byte is 0xFF. */
function decodeTableCellFormat(c: Cursor, events: RenderEvent[], drainText: () => void): void {
  let safety = 0;
  while (!c.eof && safety++ < 1000) {
    drainText();
    const op = c.buf[c.pos];
    if (op === 0xFF) { c.pos++; return; }
    c.pos++;
    if (op === 0x20) { events.push({ kind: 'hardSpace' }); continue; }
    if (op === 0x21) { events.push({ kind: 'hardHyphen' }); continue; }
    if (op === 0x80 && c.remaining >= 2) { events.push({ kind: 'font', index: c.u16() }); continue; }
    if (op === 0x81) { events.push({ kind: 'lineBreak' }); continue; }
    if (op === 0x82) {
      // Paragraph end inside a cell. Followed by 0xFF it's redundant; in
      // multi-paragraph cells it ends the run. We elide it here — the
      // cell already renders as one logical block in the table.
      continue;
    }
    if (op === 0x83) { events.push({ kind: 'tab' }); continue; }
    if (op === 0x85 && c.remaining >= 2) { c.u16(); continue; }
    if (op === 0x86 || op === 0x87 || op === 0x88) {
      // Picture: type byte + scanlong size + (cuint when type > 0x10) + payload.
      // If the encoded size exceeds what's left in LD1, the bytes weren't
      // really a picture opcode (we mis-aligned with HC30 ParaInfo data,
      // for example) — back up and treat as unknown.
      const savedPos = c.pos;
      try {
        const t = c.u8();
        const sz = c.clong();
        if (t > 0x10) c.cuint();
        if (sz < 0 || sz > c.remaining) throw new Error('picture overruns LD1');
        const payload = c.bytes(sz);
        const align: 'char' | 'left' | 'right' = op === 0x86 ? 'char' : op === 0x87 ? 'left' : 'right';
        events.push({ kind: 'picture', align, type: t, payload });
      } catch {
        c.pos = savedPos;
        events.push({ kind: 'unknownOp', op });
      }
      continue;
    }
    if (op === 0x89) { events.push({ kind: 'hotspotEnd' }); continue; }
    if (op === 0x8B) { events.push({ kind: 'nbsp' }); continue; }
    if (op === 0x8C) { events.push({ kind: 'nbHyphen' }); continue; }
    // 5-byte hotspot range (0xC0..0xC7 / 0xE0..0xE7): opcode + u32 target.
    // Bit 0 (0x01) discriminates popup (0) vs jump (1).
    // Bit 1 (0x02) discriminates HC30 topic-number target (0) from HCW3.1+
    // hash target (1) — both forms read as i32, just routed through
    // different lookup tables by the host.
    // Bit 2 (0x04) is "no underline" (font-change variant vs plain).
    if ((op & 0xD8) === 0xC0) {
      if (c.remaining < 4) { events.push({ kind: 'unknownOp', op }); continue; }
      const target = c.u32();
      const isJump = (op & 0x01) !== 0;
      const noUnderline = (op & 0x04) !== 0;
      events.push({ kind: isJump ? 'jump' : 'popup', hash: target, underline: !noUnderline });
      continue;
    }
    // Variable-size hotspot range (0xC8..0xCF / 0xE8..0xEF): opcode + u16
    // length + payload. If the encoded length doesn't fit in what's left,
    // the byte was something else (e.g. HC30 ParaInfo data we don't yet
    // recognise) — back the cursor up to just past the opcode and treat
    // it as unknown.
    if ((op & 0xD8) === 0xC8) {
      const savedPos = c.pos;
      if (c.remaining < 2) { events.push({ kind: 'unknownOp', op }); continue; }
      const sz = c.u16();
      if (sz < 0 || sz > c.remaining) {
        c.pos = savedPos;
        events.push({ kind: 'unknownOp', op });
        continue;
      }
      const payload = c.bytes(sz);
      const ev = decodeExtendedHotspot(op, payload);
      if (ev) events.push(ev);
      continue;
    }
    events.push({ kind: 'unknownOp', op });
  }
}

/** Signed compressed int. 1-byte form: `(b>>1) - 0x40`. 2-byte form (bit0=1):
 *  `(u16>>1) - 0x4000`. */
function readScanInt(c: Cursor): number {
  if (c.eof) return 0;
  const b = c.buf[c.pos];
  if (b & 1) {
    if (c.remaining < 2) return 0;
    const v = c.buf[c.pos] | (c.buf[c.pos + 1] << 8);
    c.pos += 2;
    return (v >> 1) - 0x4000;
  }
  c.pos += 1;
  return (b >> 1) - 0x40;
}
function skipScanInt(c: Cursor): void { readScanInt(c); }
function skipScanLong(c: Cursor): void {
  if (c.eof) return;
  const b = c.buf[c.pos];
  c.pos += (b & 1) ? 4 : 2;
}

/** Decode a type-32 (HCW4 main display) link into render events. */
function decodeType32(linkData1: Uint8Array, linkData2: Uint8Array): DecodedParagraph {
  const events: RenderEvent[] = [];
  // Parse ParaInfo prefix for fonts/indents (best-effort).
  const c = new Cursor(linkData1);
  const state = parseType32ParaInfo(c);
  // Walk format opcodes.
  const formatEvents: RenderEvent[] = [];
  // Buffer hotspot opcodes so we can attach text segment that follows.
  let pendingHotspot: { kind: 'jump' | 'popup' | 'macroHotspot'; hash?: number; macro?: string; underline: boolean; window?: number } | null = null;
  let safety = 0;
  // Format-opcode set: 0x80, 0x81, 0x82, 0x83, 0x85, 0x86–88, 0x89,
  // 0xC0..C7 / 0xE0..E7 (5-byte hotspots), 0xC8..CF / 0xE8..EF (variable
  // hotspots), 0xFF terminator. The "extras" 0x20 (hard-space), 0x21
  // (hard-hyphen), 0x8B (nbsp), 0x8C (nb-hyphen) only appear in some
  // authoring-tool variants — handle them too so those files render.
  while (!c.eof && safety++ < 1000) {
    const op = c.u8();
    if (op === 0xFF) break;
    if (op === 0x20) {
      formatEvents.push({ kind: 'hardSpace' });
    } else if (op === 0x21) {
      formatEvents.push({ kind: 'hardHyphen' });
    } else if (op === 0x80 && c.remaining >= 2) {
      formatEvents.push({ kind: 'font', index: c.u16() });
    } else if (op === 0x81) {
      formatEvents.push({ kind: 'lineBreak' });
    } else if (op === 0x82) {
      formatEvents.push({ kind: 'paraEnd' });
    } else if (op === 0x83) {
      formatEvents.push({ kind: 'tab' });
    } else if (op === 0x85 && c.remaining >= 2) {
      c.u16(); // 3-byte op of unknown semantics — skip
    } else if (op === 0x8B) {
      formatEvents.push({ kind: 'nbsp' });
    } else if (op === 0x8C) {
      formatEvents.push({ kind: 'nbHyphen' });
    } else if (op === 0x86 || op === 0x87 || op === 0x88) {
      // picture: type byte + clongBiased size + (cuint, when type > 0x10) + payload.
      if (c.remaining < 1) break;
      const t = c.u8();
      let sz = 0;
      try { sz = c.clongBiased(); } catch {}
      if (t > 0x10) { try { c.cuint(); } catch {} }
      if (sz < 0 || sz > c.remaining) break;
      const payload = c.bytes(sz);
      formatEvents.push({ kind: 'picture', align: op === 0x86 ? 'char' : op === 0x87 ? 'left' : 'right', type: t, payload });
    } else if (op === 0x89) {
      formatEvents.push({ kind: 'hotspotEnd' });
      pendingHotspot = null;
    } else if ((op & 0xD8) === 0xC0) {
      // 5-byte hotspot opcodes: opcode + u32 target. Bit 0 = jump (1) /
      // popup (0). Bit 1 = HC30 topic-number target (0) vs HCW3.1+ hash
      // target (1). Bit 2 = no-underline (font-change variant).
      if (c.remaining < 4) break;
      const hash = c.u32();
      const isJump = (op & 0x01) !== 0;
      const noUnderline = (op & 0x04) !== 0;
      const ev = { kind: isJump ? 'jump' : 'popup', hash, underline: !noUnderline } as RenderEvent;
      formatEvents.push(ev);
      pendingHotspot = ev as typeof pendingHotspot;
    } else if ((op & 0xF8) === 0xC8 || (op & 0xF8) === 0xE8) {
      // Variable-size hotspot: opcode + u16 size + size bytes payload.
      if (c.remaining < 2) break;
      const sz = c.u16();
      if (sz > c.remaining) break;
      const payload = c.bytes(sz);
      const ev = decodeExtendedHotspot(op, payload);
      if (ev) {
        formatEvents.push(ev);
        if (ev.kind === 'jump' || ev.kind === 'popup' || ev.kind === 'macroHotspot') {
          pendingHotspot = ev as typeof pendingHotspot;
        }
      }
    } else {
      formatEvents.push({ kind: 'unknownOp', op });
    }
  }
  void pendingHotspot;

  // Split LinkData2 by NUL bytes into segments. Each NUL marks a
  // text-run boundary that the format stream consumes at certain opcodes
  // (tab, line-break, hotspot-end, paragraph-end). Initial NULs are skipped.
  const segments: Uint8Array[] = [];
  let segStart = 0;
  for (let i = 0; i < linkData2.length; i++) {
    if (linkData2[i] === 0) {
      segments.push(linkData2.subarray(segStart, i));
      segStart = i + 1;
    }
  }
  if (segStart < linkData2.length) segments.push(linkData2.subarray(segStart));

  // Render strategy:
  //   Each format opcode "owns" one NUL-delimited segment of LinkData2.
  //   The opcode is emitted AFTER the segment text (so state-changing ops
  //   like font/picture/hotspot-start apply only to subsequent text, while
  //   boundary ops like paraEnd/hotspotEnd close out a run of text). Most
  //   state-changing segments are empty — they only matter to advance the
  //   per-op cursor through LD2.
  let segIdx = 0;
  let firstPara = true;
  let inPara = false;
  const consumeSegment = () => {
    if (segIdx < segments.length) {
      const s = segments[segIdx++];
      if (s.length > 0) events.push({ kind: 'text', bytes: s });
    }
  };
  const startPara = () => {
    events.push({ kind: 'paraBegin', state: firstPara ? state : {} });
    firstPara = false;
    inPara = true;
  };
  startPara();
  for (const ev of formatEvents) {
    consumeSegment();
    if (ev.kind === 'paraEnd') {
      events.push({ kind: 'paraEnd' });
      inPara = false;
      if (segIdx < segments.length) startPara();
    } else {
      events.push(ev);
    }
  }
  if (inPara) {
    consumeSegment();
    events.push({ kind: 'paraEnd' });
  }
  return { recordType: 32, events };
}

/** Parse the type-32 ParaInfo prefix into a ParaState. Advances cursor
 *  past the entire prefix, leaving it at the first format opcode. */
function parseType32ParaInfo(c: Cursor): ParaState {
  const state: ParaState = {};
  if (c.eof) return state;
  // Field 1: clong (TopicSize). 2-byte form if bit0=0, 4-byte if bit0=1.
  if (!skipClong(c)) return state;
  // Field 2: cuint (TopicLength). 2-byte form if bit0=1, 1-byte if bit0=0.
  // (For these fields: bit set → advance 2; bit clear → advance 1.)
  if (!skipCuintRev(c)) return state;
  // ParaSize-like field: 4 bytes if bit0=1, 2 if bit0=0.
  if (!skipClong(c)) return state;
  // u32 ParaState bitfield.
  if (c.remaining < 4) return state;
  const ps = c.u32();
  // Bit 16 (0x10000): SpacingAbove (clong)
  if (ps & 0x10000) skipClong(c);
  // Bits 17..23: cuint (1-or-2 byte) fields
  if (ps & 0x20000) state.spacingBelow = readCuintRev(c);
  if (ps & 0x40000) state.spacingLines = readCuintRev(c);
  if (ps & 0x80000) state.leftIndent = readCuintRev(c);
  if (ps & 0x100000) state.rightIndent = readCuintRev(c);
  if (ps & 0x200000) state.firstLineIndent = readCuintRev(c);
  if (ps & 0x400000) skipCuintRev(c);
  if (ps & 0x800000) skipCuintRev(c);
  // Bit 24: Borders — 3 bytes
  if (ps & 0x1000000) {
    if (c.remaining >= 3) { state.borderFlags = c.u8(); state.borderColor = c.u16(); }
  }
  // Bit 25: Tab stops. Tab COUNT is a signed cint (1-byte form: (b>>1)-64;
  // 2-byte form: (u16>>1)-0x4000). Each tab is then a cuint position;
  // if its high-byte bit 0x40 is set, an extra cuint follows for tab-type
  // info.
  if (ps & 0x2000000) {
    const nTabs = readCintRev(c);
    const stops: number[] = [];
    for (let i = 0; i < nTabs && !c.eof; i++) {
      const pos = readCuintRev(c);
      stops.push(pos);
      if ((pos >> 8) & 0x40) {
        readCuintRev(c); // skip extra
      }
    }
    state.tabStops = stops;
  }
  // Alignment bits
  if (ps & 0x4000000) state.alignment = 'right';
  else if (ps & 0x8000000) state.alignment = 'center';
  return state;
}

function skipClong(c: Cursor): boolean {
  if (c.eof) return false;
  const b = c.buf[c.pos];
  c.pos += (b & 1) ? 4 : 2;
  return c.pos <= c.buf.length;
}

function skipCuintRev(c: Cursor): boolean {
  if (c.eof) return false;
  const b = c.buf[c.pos];
  c.pos += (b & 1) ? 2 : 1;
  return c.pos <= c.buf.length;
}

/** Decode the payload of an extended (u16-size-prefixed) hotspot opcode.
 *  These come in several flavors:
 *    0xC8 / 0xCC: popup / jump via context name string (asciiz)
 *    0xCA / 0xCE: popup / jump variants
 *    0xE8 / 0xEC: same with bit-5 set (macro-bearing or named-window)
 *    0xEA / 0xEB: cross-file popup / jump (header byte + window + hash + filename)
 *    0xEE / 0xEF: macro hotspot (asciiz macro string)
 *  We dispatch by the LSB pattern. */
function decodeExtendedHotspot(op: number, payload: Uint8Array): RenderEvent | null {
  // Bit 0 = jump (1) / popup (0); bit 2 = no-underline / no-font-change (1).
  const isJump = (op & 0x01) !== 0;
  const noUnderline = (op & 0x04) !== 0;
  // 0xEE / 0xEF: macro hotspot. Payload is asciiz macro string.
  if ((op & 0xFE) === 0xEE) {
    const macro = readAsciiZ(payload, 0);
    return { kind: 'macroHotspot', macro, underline: !noUnderline };
  }
  // 0xEA / 0xEB: cross-file. Payload: u8 type, u8 windownum, u32 hash, asciiz file.
  if ((op & 0xFE) === 0xEA) {
    if (payload.length < 7) return null;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const t = dv.getUint8(0);
    const win = dv.getUint8(1);
    const hash = dv.getUint32(2, true);
    const file = readAsciiZ(payload, 6);
    return { kind: 'crossFile', popup: !isJump, window: win, hash, file, underline: !noUnderline };
  }
  // 0xE6 / 0xE7: popup / jump in named window. Payload: u32 hash, u16 window.
  if ((op & 0xFE) === 0xE6) {
    if (payload.length < 6) return null;
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const hash = dv.getUint32(0, true);
    const win = dv.getUint16(4, true);
    return { kind: isJump ? 'jump' : 'popup', hash, underline: !noUnderline, window: win };
  }
  // Generic 0xC8/0xCC/0xCA/0xCE/0xE8/0xEC/etc: payload starts with a printable
  // character → treat as a context-name / ALink macro asciiz. Otherwise try
  // to parse a u32 hash from the start.
  if (payload.length === 0) return null;
  const first = payload[0];
  if (first >= 0x20 && first < 0x7F) {
    const s = readAsciiZ(payload, 0);
    // ALink/KLink macros look like AL("...") or KL("..."); treat as macro
    // hotspots. Otherwise treat as a context-name jump (use hashContext to
    // look up).
    if (/^[AK]L\b|^[AK]Link\b/i.test(s)) {
      return { kind: 'macroHotspot', macro: s, underline: !noUnderline };
    }
    // Plain context name — caller can hash it on demand. Encode as macro
    // hotspot for now (more permissive fallback).
    return { kind: 'macroHotspot', macro: s, underline: !noUnderline };
  }
  // First byte non-printable: assume u32 hash format.
  if (payload.length >= 4) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const hash = dv.getUint32(0, true);
    return { kind: isJump ? 'jump' : 'popup', hash, underline: !noUnderline };
  }
  return null;
}

function readAsciiZ(payload: Uint8Array, start: number): string {
  let s = '';
  for (let i = start; i < payload.length; i++) {
    const c = payload[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function readCuintRev(c: Cursor): number {
  if (c.eof) return 0;
  const b = c.buf[c.pos];
  if (b & 1) {
    if (c.remaining < 2) return 0;
    const v = (c.buf[c.pos] | (c.buf[c.pos + 1] << 8));
    c.pos += 2;
    return v >> 1;
  }
  c.pos += 1;
  return b >> 1;
}

/** Signed compressed-int (used for tab count). 1-byte: (b>>1) - 64.
 *  2-byte: (u16>>1) - 0x4000. */
function readCintRev(c: Cursor): number {
  if (c.eof) return 0;
  const b = c.buf[c.pos];
  if (b & 1) {
    if (c.remaining < 2) return 0;
    const v = (c.buf[c.pos] | (c.buf[c.pos + 1] << 8));
    c.pos += 2;
    return (v >> 1) - 0x4000;
  }
  c.pos += 1;
  return (b >> 1) - 64;
}

