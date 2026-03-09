import type { Emulator } from '../../emulator';
import { fillTextBitmap } from '../../emu-render';
import { decodeMBCS } from '../../memory';
import { OPAQUE } from '../types';
import { colorToCSS } from './_helpers';

export function registerText(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  const getFontSize = (hdc: number): number => {
    const dc = emu.getDC(hdc);
    if (!dc) return 13;
    const font = emu.handles.get<{ height: number }>(dc.selectedFont);
    if (font && font.height) return Math.abs(font.height);
    return 13;
  };

  const getFontCSS = (hdc: number): string => {
    const sz = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    const font = dc ? emu.handles.get<{ height: number; faceName?: string }>(dc.selectedFont) : null;
    const face = font?.faceName || 'Tahoma';
    return `${sz}px "${face}", Tahoma, sans-serif`;
  };

  gdi32.register('TextOutA', 5, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const strPtr = emu.readArg(3);
    const count = emu.readArg(4);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = emu.memory.readBytesMBCS(strPtr, count);

    const fontSize = getFontSize(hdc);
    dc.ctx.font = getFontCSS(hdc);
    if (dc.bkMode === OPAQUE) {
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      const m = dc.ctx.measureText(text);
      dc.ctx.fillRect(x, y, m.width, fontSize);
    }
    dc.ctx.fillStyle = colorToCSS(dc.textColor);
    dc.ctx.textBaseline = 'top';
    fillTextBitmap(dc.ctx, text, x, y);

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('ExtTextOutA', 8, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const options = emu.readArg(3);
    const rectPtr = emu.readArg(4);
    const strPtr = emu.readArg(5);
    const count = emu.readArg(6);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    // If ETO_OPAQUE (0x2), fill background rect
    if ((options & 0x2) && rectPtr) {
      const left = emu.memory.readI32(rectPtr);
      const top = emu.memory.readI32(rectPtr + 4);
      const right = emu.memory.readI32(rectPtr + 8);
      const bottom = emu.memory.readI32(rectPtr + 12);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(left, top, right - left, bottom - top);
    }

    if (strPtr && count > 0) {
      const text = emu.memory.readBytesMBCS(strPtr, count);
      dc.ctx.font = getFontCSS(hdc);
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, x, y);
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  // DrawTextA is a USER32 function — the full implementation with word-wrap
  // is in user32/text.ts. Only register under GDI32 as a simple fallback.
  gdi32.register('DrawTextA', 5, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    let count = emu.readArg(2) | 0;
    const rectPtr = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = count === -1
      ? emu.memory.readCString(strPtr)
      : emu.memory.readBytesMBCS(strPtr, count);

    const left = emu.memory.readI32(rectPtr);
    const top = emu.memory.readI32(rectPtr + 4);

    dc.ctx.font = getFontCSS(hdc);
    dc.ctx.fillStyle = colorToCSS(dc.textColor);
    dc.ctx.textBaseline = 'top';
    fillTextBitmap(dc.ctx, text, left, top);

    emu.syncDCToCanvas(hdc);
    return getFontSize(hdc);
  });

  gdi32.register('GetTextExtentPoint32A', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);

    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    const text = emu.memory.readBytesMBCS(strPtr, count);

    const fontSize = getFontSize(hdc);
    dc.ctx.font = getFontCSS(hdc);
    const m = dc.ctx.measureText(text);
    const w = Math.ceil(m.width);
    emu.memory.writeU32(sizePtr, w);
    emu.memory.writeU32(sizePtr + 4, fontSize);
    return 1;
  });

  gdi32.register('GetTextExtentPointA', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      const fontSize = getFontSize(hdc);
      const dc = emu.getDC(hdc);
      if (dc) {
        dc.ctx.font = getFontCSS(hdc);
        let text = '';
        for (let i = 0; i < count; i++) {
          text += String.fromCharCode(emu.memory.readU8(strPtr + i));
        }
        const m = dc.ctx.measureText(text);
        emu.memory.writeU32(sizePtr, Math.ceil(m.width));
      } else {
        emu.memory.writeU32(sizePtr, count * 7);
      }
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('GetTextMetricsA', 2, () => {
    const hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    const fontSize = getFontSize(hdc);
    const dc = emu.getDC(hdc);
    let aveCharWidth = Math.round(fontSize * 0.45);
    let maxCharWidth = fontSize;
    if (dc) {
      dc.ctx.font = getFontCSS(hdc);
      // Measure average width using standard TEXTMETRIC method (average of a-z, A-Z)
      const sample = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      aveCharWidth = Math.round(dc.ctx.measureText(sample).width / sample.length);
      maxCharWidth = Math.ceil(dc.ctx.measureText('W').width);
    }
    const ascent = Math.round(fontSize * 0.8);
    const descent = fontSize - ascent;
    emu.memory.writeU32(ptr, fontSize);      // tmHeight
    emu.memory.writeU32(ptr + 4, ascent);    // tmAscent
    emu.memory.writeU32(ptr + 8, descent);   // tmDescent
    emu.memory.writeU32(ptr + 12, 0); // tmInternalLeading
    emu.memory.writeU32(ptr + 16, 0); // tmExternalLeading
    emu.memory.writeU32(ptr + 20, aveCharWidth); // tmAveCharWidth
    emu.memory.writeU32(ptr + 24, maxCharWidth); // tmMaxCharWidth
    return 1;
  });

  gdi32.register('CreateFontA', 14, () => {
    // Return a pseudo font handle
    return emu.handles.alloc('font', { height: emu.readArg(0) });
  });

  gdi32.register('CreateFontW', 14, () => {
    return emu.handles.alloc('font', { height: emu.readArg(0) });
  });

  gdi32.register('CreateFontIndirectA', 1, () => {
    const ptr = emu.readArg(0);
    const height = emu.memory.readI32(ptr);
    // LOGFONT: lfFaceName at offset 28, 32 bytes (ANSI)
    const faceName = emu.memory.readCString(ptr + 28);
    return emu.handles.alloc('font', { height, faceName });
  });

  gdi32.register('CreateFontIndirectW', 1, () => {
    const ptr = emu.readArg(0);
    const height = emu.memory.readI32(ptr);
    // LOGFONTW: lfFaceName at offset 28, 32 wide chars
    const faceName = emu.memory.readUTF16String(ptr + 28);
    return emu.handles.alloc('font', { height, faceName });
  });

  gdi32.register('GetTextExtentPointW', 4, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      const dc = emu.getDC(hdc);
      const fontSize = getFontSize(hdc);
      if (dc) {
        let text = '';
        for (let i = 0; i < count; i++) text += String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
        dc.ctx.font = `${fontSize}px Tahoma, sans-serif`;
        const m = dc.ctx.measureText(text);
        emu.memory.writeU32(sizePtr, Math.ceil(m.width));
        emu.memory.writeU32(sizePtr + 4, fontSize);
      } else {
        emu.memory.writeU32(sizePtr, count * Math.ceil(fontSize * 0.6));
        emu.memory.writeU32(sizePtr + 4, fontSize);
      }
    }
    return 1;
  });

  gdi32.register('GetTextExtentExPointA', 7, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const maxExtent = emu.readArg(3);
    const fitPtr = emu.readArg(4);
    const dxPtr = emu.readArg(5);
    const sizePtr = emu.readArg(6);
    const dc = emu.getDC(hdc);
    const fontSize = getFontSize(hdc);
    let totalW = 0;
    let fit = 0;
    if (dc) {
      dc.ctx.font = getFontCSS(hdc);
      for (let i = 0; i < count; i++) {
        let s = '';
        for (let j = 0; j <= i; j++) s += String.fromCharCode(emu.memory.readU8(strPtr + j));
        totalW = Math.ceil(dc.ctx.measureText(s).width);
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    } else {
      const charW = Math.ceil(fontSize * 0.6);
      for (let i = 0; i < count; i++) {
        totalW = (i + 1) * charW;
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    }
    if (fitPtr) emu.memory.writeU32(fitPtr, fit);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, totalW);
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('GetTextExtentExPointW', 7, () => {
    const hdc = emu.readArg(0);
    const strPtr = emu.readArg(1);
    const count = emu.readArg(2);
    const maxExtent = emu.readArg(3);
    const fitPtr = emu.readArg(4);
    const dxPtr = emu.readArg(5);
    const sizePtr = emu.readArg(6);
    const dc = emu.getDC(hdc);
    const fontSize = getFontSize(hdc);
    let totalW = 0;
    let fit = 0;
    if (dc) {
      dc.ctx.font = `${fontSize}px Tahoma, sans-serif`;
      for (let i = 0; i < count; i++) {
        const ch = String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
        totalW = Math.ceil(dc.ctx.measureText(
          (() => { let s = ''; for (let j = 0; j <= i; j++) s += String.fromCharCode(emu.memory.readU16(strPtr + j * 2)); return s; })()
        ).width);
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    } else {
      const charW = Math.ceil(fontSize * 0.6);
      for (let i = 0; i < count; i++) {
        totalW = (i + 1) * charW;
        if (dxPtr) emu.memory.writeU32(dxPtr + i * 4, totalW);
        if (maxExtent === 0 || totalW <= maxExtent) fit = i + 1;
      }
    }
    if (fitPtr) emu.memory.writeU32(fitPtr, fit);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, totalW);
      emu.memory.writeU32(sizePtr + 4, fontSize);
    }
    return 1;
  });

  gdi32.register('ExtTextOutW', 8, () => {
    const hdc = emu.readArg(0);
    const x = emu.readArg(1) | 0;
    const y = emu.readArg(2) | 0;
    const options = emu.readArg(3);
    const rectPtr = emu.readArg(4);
    const strPtr = emu.readArg(5);
    const count = emu.readArg(6);
    const dc = emu.getDC(hdc);
    if (!dc) return 0;

    let text = '';
    if (strPtr && count > 0) {
      for (let i = 0; i < count; i++) text += String.fromCharCode(emu.memory.readU16(strPtr + i * 2));
    }
    if ((options & 0x2) && rectPtr) {
      const left = emu.memory.readI32(rectPtr);
      const top = emu.memory.readI32(rectPtr + 4);
      const right = emu.memory.readI32(rectPtr + 8);
      const bottom = emu.memory.readI32(rectPtr + 12);
      dc.ctx.fillStyle = colorToCSS(dc.bkColor);
      dc.ctx.fillRect(left, top, right - left, bottom - top);
    }

    if (text) {
      const fontSize = getFontSize(hdc);
      dc.ctx.font = `${fontSize}px Tahoma, sans-serif`;
      dc.ctx.fillStyle = colorToCSS(dc.textColor);
      dc.ctx.textBaseline = 'top';
      fillTextBitmap(dc.ctx, text, x, y);
    }

    emu.syncDCToCanvas(hdc);
    return 1;
  });

  gdi32.register('SetTextAlign', 2, () => 0); // return previous alignment
  gdi32.register('GetTextAlign', 1, () => 0); // TA_LEFT|TA_TOP
  gdi32.register('SetTextCharacterExtra', 2, () => 0); // return previous spacing
  gdi32.register('SetTextJustification', 3, () => 1);
  gdi32.register('GetNearestColor', 2, () => emu.readArg(1)); // return the color as-is
  gdi32.register('TranslateCharsetInfo', 3, () => 0); // fail
  gdi32.register('GetFontAssocStatus', 1, () => 0); // no font association

  gdi32.register('EnumFontsA', 4, () => 0); // return 0 = no fonts enumerated
  gdi32.register('EnumFontsW', 4, () => 0);
  gdi32.register('EnumFontFamiliesW', 4, () => 1);
  gdi32.register('EnumFontFamiliesExW', 5, () => 1);
  gdi32.register('AddFontResourceA', 1, () => 0);
  gdi32.register('RemoveFontResourceA', 1, () => 0);

  gdi32.register('GetTextFaceW', 3, () => {
    const _hdc = emu.readArg(0);
    const nCount = emu.readArg(1);
    const bufPtr = emu.readArg(2);
    const faceName = 'Tahoma';
    if (bufPtr && nCount > 0) {
      const len = Math.min(faceName.length, nCount - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, faceName.charCodeAt(i));
      emu.memory.writeU16(bufPtr + len * 2, 0);
      return len;
    }
    return faceName.length;
  });

  gdi32.register('GetTextMetricsW', 2, () => {
    const _hdc = emu.readArg(0);
    const ptr = emu.readArg(1);
    if (ptr) {
      // Fill TEXTMETRICW (60 bytes) with reasonable defaults
      emu.memory.writeU32(ptr + 0, 16);  // tmHeight
      emu.memory.writeU32(ptr + 4, 13);  // tmAscent
      emu.memory.writeU32(ptr + 8, 3);   // tmDescent
      emu.memory.writeU32(ptr + 12, 0);  // tmInternalLeading
      emu.memory.writeU32(ptr + 16, 0);  // tmExternalLeading
      emu.memory.writeU32(ptr + 20, 7);  // tmAveCharWidth
      emu.memory.writeU32(ptr + 24, 14); // tmMaxCharWidth
      emu.memory.writeU32(ptr + 28, 400);// tmWeight
      emu.memory.writeU32(ptr + 32, 0);  // tmOverhang
      emu.memory.writeU32(ptr + 36, 96); // tmDigitizedAspectX
      emu.memory.writeU32(ptr + 40, 96); // tmDigitizedAspectY
      emu.memory.writeU16(ptr + 44, 0x20); // tmFirstChar
      emu.memory.writeU16(ptr + 46, 0xFF); // tmLastChar
      emu.memory.writeU16(ptr + 48, 0x3F); // tmDefaultChar
      emu.memory.writeU16(ptr + 50, 0x20); // tmBreakChar
      emu.memory.writeU8(ptr + 52, 0);   // tmItalic
      emu.memory.writeU8(ptr + 53, 0);   // tmUnderlined
      emu.memory.writeU8(ptr + 54, 0);   // tmStruckOut
      emu.memory.writeU8(ptr + 55, 0);   // tmPitchAndFamily
      emu.memory.writeU8(ptr + 56, 0);   // tmCharSet (ANSI)
    }
    return 1;
  });

  gdi32.register('TextOutW', 5, () => 1);

  gdi32.register('GetTextExtentPoint32W', 4, () => {
    const _hdc = emu.readArg(0);
    const _str = emu.readArg(1);
    const count = emu.readArg(2);
    const sizePtr = emu.readArg(3);
    if (sizePtr) {
      emu.memory.writeU32(sizePtr, count * 7); // cx
      emu.memory.writeU32(sizePtr + 4, 16);    // cy
    }
    return 1;
  });

  // GetCharWidthW(hdc, iFirstChar, iLastChar, lpBuffer)
  gdi32.register('GetCharWidthW', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) {
        emu.memory.writeU32(buf + i * 4, 7); // average char width
      }
    }
    return 1;
  });

  // GetCharWidth32W — same as GetCharWidthW (newer name)
  gdi32.register('GetCharWidth32W', 4, () => {
    const _hdc = emu.readArg(0);
    const first = emu.readArg(1);
    const last = emu.readArg(2);
    const buf = emu.readArg(3);
    if (buf) {
      for (let i = 0; i <= last - first; i++) {
        emu.memory.writeU32(buf + i * 4, 7);
      }
    }
    return 1;
  });

  // GetOutlineTextMetricsW(hdc, cbData, lpotm) — returns size of OUTLINETEXTMETRICW
  const OUTLINETEXTMETRICW_SIZE = 212;
  gdi32.register('GetOutlineTextMetricsW', 3, () => {
    const _hdc = emu.readArg(0);
    const cbData = emu.readArg(1);
    const lpotm = emu.readArg(2);
    if (cbData === 0 || !lpotm) return OUTLINETEXTMETRICW_SIZE;
    // Zero-fill and populate key fields
    for (let i = 0; i < Math.min(cbData, OUTLINETEXTMETRICW_SIZE); i++) emu.memory.writeU8(lpotm + i, 0);
    emu.memory.writeU32(lpotm, OUTLINETEXTMETRICW_SIZE); // otmSize
    // Embedded TEXTMETRICW at offset 4 (56 bytes)
    const tm = lpotm + 4;
    emu.memory.writeU32(tm + 0, 16);   // tmHeight
    emu.memory.writeU32(tm + 4, 13);   // tmAscent
    emu.memory.writeU32(tm + 8, 3);    // tmDescent
    emu.memory.writeU32(tm + 20, 7);   // tmAveCharWidth
    emu.memory.writeU32(tm + 24, 14);  // tmMaxCharWidth
    emu.memory.writeU32(tm + 28, 400); // tmWeight
    return OUTLINETEXTMETRICW_SIZE;
  });

  gdi32.register('CreateDCW', 4, () => 0);
  gdi32.register('LPtoDP', 3, () => 1);
  gdi32.register('StartDocW', 2, () => 1);
  gdi32.register('SetAbortProc', 2, () => 1);
  gdi32.register('StartPage', 1, () => 1);
  gdi32.register('EndPage', 1, () => 1);
  gdi32.register('EndDoc', 1, () => 1);
}
