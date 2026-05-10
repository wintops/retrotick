// |SYSTEM file parser.

export interface SystemHeader {
  magic: number;
  minor: number;
  major: number;
  genDate: number;
  flags: number;
}

export const SYSFLAG_LZ77 = 0x0004;
export const SYSFLAG_PHRASE = 0x0008;
export const SYSFLAG_HALL = 0x0010;
export const SYSFLAG_MVB = 0x0040;

export interface SecondaryWindow {
  flags: number;
  typeName: string;
  caption: string;
  x: number; y: number; width: number; height: number;
  maximize: number;
  rgb: Array<[number, number, number]>;
  onTop?: number;
  autoSize?: number;
}

export interface SystemInfo {
  header: SystemHeader;
  title: string;
  copyright: string;
  citation: string;
  language: string;
  contentsTopic: number;        // 4-byte topic offset, or -1
  startupMacros: string[];      // record type 4
  windows: SecondaryWindow[];
  iconBytes?: Uint8Array;
  charset: number;              // 0=ANSI, 128=SHIFTJIS, etc
  defaultFont?: { fontNumber: number; charset: number };
  lcid?: number;
  cntFile?: string;
  groups: string[];
  indexSeparators: string;
  dllMaps: string[];
}

function readAsciiZ(buf: Uint8Array, start: number, end: number): { s: string; next: number } {
  let s = '';
  let i = start;
  while (i < end) {
    const c = buf[i++];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return { s, next: i };
}

function readAsciiPadded(buf: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = buf[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

export function parseSystem(body: Uint8Array): SystemInfo {
  if (body.length < 12) throw new Error('|SYSTEM truncated');
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const header: SystemHeader = {
    magic: dv.getUint16(0, true),
    minor: dv.getUint16(2, true),
    major: dv.getUint16(4, true),
    genDate: dv.getUint32(6, true),
    flags: dv.getUint16(10, true),
  };
  if (header.magic !== 0x036C) throw new Error(`|SYSTEM magic mismatch 0x${header.magic.toString(16)}`);
  if (!(header.minor === 15 || (header.minor >= 21 && header.minor <= 33))) {
    if (header.minor < 15 || header.minor > 33) {
      // tolerate but warn
      console.warn(`[hlp] |SYSTEM Minor=${header.minor} outside known range`);
    }
  }
  if (header.minor === 15) header.flags &= 0x0001;

  const info: SystemInfo = {
    header,
    title: '',
    copyright: '',
    citation: '',
    language: '',
    contentsTopic: -1,
    startupMacros: [],
    windows: [],
    charset: 0,
    groups: [],
    indexSeparators: ', ',
    dllMaps: [],
  };

  if (header.minor === 15) {
    // HC30: body after 12-byte header is the title string
    info.title = readAsciiZ(body, 12, body.length).s;
    return info;
  }

  let p = 12;
  while (p + 4 <= body.length) {
    const recordType = dv.getUint16(p, true);
    const dataSize = dv.getUint16(p + 2, true);
    const dataStart = p + 4;
    const dataEnd = dataStart + dataSize;
    if (dataEnd > body.length) break;
    const sub = body.subarray(dataStart, dataEnd);
    switch (recordType) {
      case 1: info.title = readAsciiZ(sub, 0, sub.length).s; break;
      case 2: info.copyright = readAsciiZ(sub, 0, sub.length).s; break;
      case 3: info.contentsTopic = sub.length >= 4 ? new DataView(sub.buffer, sub.byteOffset, 4).getUint32(0, true) : -1; break;
      case 4: info.startupMacros.push(readAsciiZ(sub, 0, sub.length).s); break;
      case 5: info.iconBytes = sub.slice(); break;
      case 6: {
        const w = parseSecondaryWindow(sub);
        if (w) info.windows.push(w);
        break;
      }
      case 8: info.citation = readAsciiZ(sub, 0, sub.length).s; break;
      case 9: {
        if (sub.length >= 8) {
          const ldv = new DataView(sub.buffer, sub.byteOffset, sub.byteLength);
          info.lcid = ldv.getUint32(2, true);
        }
        break;
      }
      case 10: info.cntFile = readAsciiZ(sub, 0, sub.length).s; break;
      case 11: info.charset = sub[0] ?? 0; break;
      case 12:
        if (sub.length >= 2) info.defaultFont = { fontNumber: sub[0], charset: sub[1] };
        break;
      case 13: info.groups.push(readAsciiZ(sub, 0, sub.length).s); break;
      case 14: info.indexSeparators = readAsciiZ(sub, 0, sub.length).s; break;
      case 18: info.language = readAsciiZ(sub, 0, sub.length).s; break;
      case 19: info.dllMaps.push(readAsciiZ(sub, 0, sub.length).s); break;
      default: break; // unknown — skip
    }
    p = dataEnd;
  }
  return info;
}

function parseSecondaryWindow(b: Uint8Array): SecondaryWindow | null {
  // SECWINDOW layout (HCW4):
  //   u16 flags
  //   char[10] Type      — internal type name (e.g. "main")
  //   char[9]  Name      — display name (sometimes "main" too)
  //   char[51] Caption   — title-bar text
  //   i16 x, y           — position in 1024ths of screen
  //   i16 width, height  — size in 1024ths of screen
  //   i16 maximize       — non-zero = open maximized
  //   u8[9] rgb          — 3 RGB triplets (text fg, scroll bg, nonscroll bg)
  //   (HCW4 may add: onTop, autoSize trailing bytes)
  if (b.length < 82) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flags = dv.getUint16(0, true);
  const typeName = readAsciiPadded(b, 2, 10);
  const caption = readAsciiPadded(b, 21, 51);
  const x = dv.getInt16(72, true);
  const y = dv.getInt16(74, true);
  const width = dv.getInt16(76, true);
  const height = dv.getInt16(78, true);
  const maximize = dv.getUint16(80, true);
  const rgb: Array<[number, number, number]> = [];
  let p = 82;
  for (let i = 0; i < 3 && p + 3 <= b.length; i++) {
    rgb.push([b[p], b[p + 1], b[p + 2]]);
    p += 3;
  }
  // Optional trailing fields (HCW4 only).
  let onTop: number | undefined;
  let autoSize: number | undefined;
  if (b.length >= p + 1) onTop = b[p];
  if (b.length >= p + 2) autoSize = b[p + 1];
  return { flags, typeName, caption, x, y, width, height, maximize, rgb, onTop, autoSize };
}
