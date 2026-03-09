import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';

// Win16 USER module — Message loop & dispatch

// Win16 LB_ messages (WM_USER + offset, different from Win32 0x018x!)
const LB16_ADDSTRING     = 0x0401;
const LB16_INSERTSTRING  = 0x0402;
const LB16_DELETESTRING  = 0x0403;
const LB16_RESETCONTENT  = 0x0405;
const LB16_SETSEL        = 0x0406;
const LB16_SETCURSEL     = 0x0407;
const LB16_GETSEL        = 0x0408;
const LB16_GETCURSEL     = 0x0409;
const LB16_GETTEXT       = 0x040A;
const LB16_GETTEXTLEN    = 0x040B;
const LB16_GETCOUNT      = 0x040C;
const LB16_SETITEMDATA   = 0x041A;
const LB16_GETITEMDATA   = 0x0419;
const LB16_SELECTSTRING  = 0x040D;
const LB16_DIR           = 0x040E;
const LB16_GETTOPINDEX   = 0x040F;
const LB16_FINDSTRING    = 0x0410;
const LB16_GETSELCOUNT   = 0x0411;
const LB16_GETSELITEMS   = 0x0412;
const LB16_SETTABSTOPS   = 0x0413;
const LB16_SETHORIZONTALEXTENT = 0x0415;
const LB16_SETCOLUMNWIDTH = 0x0416;
const LB16_SETTOPINDEX   = 0x0418;
const LB16_SELITEMRANGE  = 0x041B;
const LB16_SETITEMHEIGHT = 0x041F;
const LB16_GETITEMHEIGHT = 0x0420;
const LB16_GETITEMRECT   = 0x0422;
const LB16_FINDSTRINGEXACT = 0x0423;
const LB16_ERR = -1;

export function handleListBoxMessage16(emu: Emulator, wnd: WindowInfo, message: number, wParam: number, lParam: number): number {
  if (!wnd.lbItems) { wnd.lbItems = []; wnd.lbItemData = []; }

  if (message === LB16_ADDSTRING) {
    const addr = emu.resolveFarPtr(lParam);
    const text = addr ? emu.memory.readCString(addr) : '';
    wnd.lbItems.push(text);
    wnd.lbItemData!.push(0);
    return wnd.lbItems.length - 1;
  }
  if (message === LB16_INSERTSTRING) {
    const addr = emu.resolveFarPtr(lParam);
    const text = addr ? emu.memory.readCString(addr) : '';
    const idx = wParam === 0xFFFF || wParam >= wnd.lbItems.length ? wnd.lbItems.length : wParam;
    wnd.lbItems.splice(idx, 0, text);
    wnd.lbItemData!.splice(idx, 0, 0);
    return idx;
  }
  if (message === LB16_DELETESTRING) {
    if (wParam >= wnd.lbItems.length) return LB16_ERR;
    wnd.lbItems.splice(wParam, 1);
    wnd.lbItemData!.splice(wParam, 1);
    return wnd.lbItems.length;
  }
  if (message === LB16_RESETCONTENT) {
    wnd.lbItems.length = 0;
    wnd.lbItemData!.length = 0;
    return 0;
  }
  if (message === LB16_GETCOUNT) return wnd.lbItems.length;
  if (message === LB16_GETCURSEL) return wnd.lbSelectedIndex ?? LB16_ERR;
  if (message === LB16_SETCURSEL) {
    wnd.lbSelectedIndex = wParam === 0xFFFF ? undefined : wParam;
    return wParam === 0xFFFF ? LB16_ERR : wParam;
  }
  if (message === LB16_GETTEXT) {
    if (wParam >= wnd.lbItems.length) return LB16_ERR;
    const text = wnd.lbItems[wParam];
    const addr = emu.resolveFarPtr(lParam);
    if (addr) {
      for (let i = 0; i < text.length; i++) emu.memory.writeU8(addr + i, text.charCodeAt(i) & 0xFF);
      emu.memory.writeU8(addr + text.length, 0);
    }
    return text.length;
  }
  if (message === LB16_GETTEXTLEN) {
    if (wParam >= wnd.lbItems.length) return LB16_ERR;
    return wnd.lbItems[wParam].length;
  }
  if (message === LB16_SETITEMDATA) {
    if (wParam >= wnd.lbItems.length) return LB16_ERR;
    wnd.lbItemData![wParam] = lParam;
    return 0;
  }
  if (message === LB16_GETITEMDATA) {
    if (wParam >= wnd.lbItems.length) return LB16_ERR;
    return wnd.lbItemData![wParam] ?? 0;
  }
  if (message === LB16_DIR) {
    // LB_DIR: wParam = attributes, lParam = far ptr to filespec
    // Attributes: 0x0010 = DDL_DIRECTORY, 0x4000 = DDL_DRIVES, 0x8000 = DDL_EXCLUSIVE
    const DDL_DIRECTORY = 0x0010;
    const DDL_DRIVES = 0x4000;
    const DDL_EXCLUSIVE = 0x8000;
    const addr = emu.resolveFarPtr(lParam);
    const filespec = addr ? emu.memory.readCString(addr) : '*.*';
    const attrs = wParam & 0xFFFF;

    if (attrs & DDL_DRIVES) {
      // Add drive letters: [-a-], [-b-], [-c-]
      wnd.lbItems.push('[-a-]'); wnd.lbItemData!.push(0);
      wnd.lbItems.push('[-b-]'); wnd.lbItemData!.push(0);
      wnd.lbItems.push('[-c-]'); wnd.lbItemData!.push(0);
    }
    if (!(attrs & DDL_EXCLUSIVE) || !(attrs & DDL_DRIVES)) {
      // List files matching filespec
      const entries = emu.fs.getVirtualDirListing(emu.resolvePath(filespec), emu.additionalFiles);
      for (const entry of entries) {
        if (entry.isDir) {
          if (attrs & DDL_DIRECTORY) {
            wnd.lbItems.push(`[${entry.name.toLowerCase()}]`);
            wnd.lbItemData!.push(0);
          }
        } else {
          wnd.lbItems.push(entry.name.toLowerCase());
          wnd.lbItemData!.push(0);
        }
      }
    }
    return wnd.lbItems.length > 0 ? wnd.lbItems.length - 1 : LB16_ERR;
  }
  if (message === LB16_SELECTSTRING) {
    const addr = emu.resolveFarPtr(lParam);
    const search = addr ? emu.memory.readCString(addr).toLowerCase() : '';
    const start = wParam === 0xFFFF ? 0 : (wParam + 1) % wnd.lbItems.length;
    for (let n = 0; n < wnd.lbItems.length; n++) {
      const i = (start + n) % wnd.lbItems.length;
      if (wnd.lbItems[i].toLowerCase().startsWith(search)) {
        wnd.lbSelectedIndex = i;
        return i;
      }
    }
    return LB16_ERR;
  }
  if (message === LB16_GETTOPINDEX) return wnd.lbTopIndex ?? 0;
  if (message === LB16_SETTOPINDEX) { wnd.lbTopIndex = wParam; return 0; }
  if (message === LB16_FINDSTRING) {
    const addr = emu.resolveFarPtr(lParam);
    const search = addr ? emu.memory.readCString(addr).toLowerCase() : '';
    const start = wParam === 0xFFFF ? 0 : (wParam + 1) % wnd.lbItems.length;
    for (let n = 0; n < wnd.lbItems.length; n++) {
      const i = (start + n) % wnd.lbItems.length;
      if (wnd.lbItems[i].toLowerCase().startsWith(search)) return i;
    }
    return LB16_ERR;
  }
  if (message === LB16_FINDSTRINGEXACT) {
    const addr = emu.resolveFarPtr(lParam);
    const search = addr ? emu.memory.readCString(addr).toLowerCase() : '';
    const start = wParam === 0xFFFF ? 0 : (wParam + 1) % wnd.lbItems.length;
    for (let n = 0; n < wnd.lbItems.length; n++) {
      const i = (start + n) % wnd.lbItems.length;
      if (wnd.lbItems[i].toLowerCase() === search) return i;
    }
    return LB16_ERR;
  }
  if (message === LB16_GETSELCOUNT) {
    return wnd.lbSelectedIndices?.size ?? (wnd.lbSelectedIndex !== undefined ? 1 : 0);
  }
  if (message === LB16_GETSELITEMS) {
    const maxItems = wParam;
    const bufAddr = emu.resolveFarPtr(lParam);
    let count = 0;
    if (wnd.lbSelectedIndices) {
      for (const idx of wnd.lbSelectedIndices) {
        if (count >= maxItems) break;
        emu.memory.writeU16(bufAddr + count * 2, idx);
        count++;
      }
    }
    return count;
  }
  if (message === LB16_SETTABSTOPS) return 1; // stub
  if (message === LB16_SETHORIZONTALEXTENT) return 0; // stub
  if (message === LB16_SETCOLUMNWIDTH) return 0; // stub
  if (message === LB16_SELITEMRANGE) {
    if (!wnd.lbSelectedIndices) wnd.lbSelectedIndices = new Set();
    const first = lParam & 0xFFFF;
    const last = (lParam >>> 16) & 0xFFFF;
    for (let i = first; i <= last; i++) {
      if (wParam) wnd.lbSelectedIndices.add(i);
      else wnd.lbSelectedIndices.delete(i);
    }
    return 0;
  }
  if (message === LB16_SETITEMHEIGHT) { wnd.lbItemHeight = lParam & 0xFFFF; return 0; }
  if (message === LB16_GETITEMHEIGHT) return wnd.lbItemHeight ?? 16;
  if (message === LB16_GETITEMRECT) {
    const idx = wParam;
    const rectAddr = emu.resolveFarPtr(lParam);
    if (rectAddr) {
      const ih = wnd.lbItemHeight ?? 16;
      const top = (wnd.lbTopIndex ?? 0);
      emu.memory.writeU16(rectAddr, 0); // left
      emu.memory.writeU16(rectAddr + 2, ((idx - top) * ih) & 0xFFFF); // top
      emu.memory.writeU16(rectAddr + 4, wnd.width || 100); // right
      emu.memory.writeU16(rectAddr + 6, (((idx - top) + 1) * ih) & 0xFFFF); // bottom
    }
    return 0;
  }
  if (message === LB16_SETSEL) {
    if (!wnd.lbSelectedIndices) wnd.lbSelectedIndices = new Set();
    if (wParam) {
      if (lParam === -1) { for (let i = 0; i < wnd.lbItems.length; i++) wnd.lbSelectedIndices.add(i); }
      else wnd.lbSelectedIndices.add(lParam & 0xFFFF);
    } else {
      if (lParam === -1) wnd.lbSelectedIndices.clear();
      else wnd.lbSelectedIndices.delete(lParam & 0xFFFF);
    }
    return 0;
  }
  if (message === LB16_GETSEL) {
    return wnd.lbSelectedIndices?.has(wParam) ? 1 : 0;
  }
  // WM_SETTEXT / WM_GETTEXT / WM_GETTEXTLENGTH
  if (message === 0x000C) { // WM_SETTEXT
    const addr = emu.resolveFarPtr(lParam);
    wnd.title = addr ? emu.memory.readCString(addr) : '';
    return 1;
  }
  if (message === 0x000E) return wnd.title?.length || 0; // WM_GETTEXTLENGTH
  return 0;
}

export function registerWin16UserMessage(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 107: DefWindowProc(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DefWindowProc', 10, () => {
    const [hWnd, msg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    const WM_CLOSE = 0x0010;
    const WM_SYSCOMMAND = 0x0112;
    const WM_DESTROY = 0x0002;
    const SC_CLOSE = 0xF060;

    const WM_NCCREATE = 0x0081;
    if (msg === WM_NCCREATE) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd) {
        // Initialize scroll bars if window has WS_HSCROLL or WS_VSCROLL
        const WS_HSCROLL = 0x00100000;
        const WS_VSCROLL = 0x00200000;
        if (wnd.style & (WS_HSCROLL | WS_VSCROLL)) {
          wnd.scrollInfo = [
            { min: 0, max: 100, pos: 0, page: 0 }, // SB_HORZ
            { min: 0, max: 100, pos: 0, page: 0 }, // SB_VERT
          ];
        }
        // Set window text from CREATESTRUCT.lpszName if lParam is valid
        if (lParam) {
          // Win16 CREATESTRUCT: lpszName is a far pointer at offset +22
          const lpszName = emu.memory.readU32(lParam + 22);
          if (lpszName) {
            const seg = (lpszName >>> 16) & 0xFFFF;
            const off = lpszName & 0xFFFF;
            const base = emu.cpu.segBases.get(seg);
            if (base !== undefined) {
              const text = emu.memory.readCString(base + off);
              if (text) wnd.title = text;
            }
          }
        }
      }
      return 1;
    }

    if (msg === WM_SYSCOMMAND) {
      if ((wParam & 0xFFF0) === SC_CLOSE) {
        emu.postMessage(hWnd, WM_CLOSE, 0, 0);
      }
      return 0;
    }
    if (msg === WM_CLOSE) {
      // DefWindowProc calls DestroyWindow for WM_CLOSE
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd && wnd.wndProc) {
        emu.callWndProc16(wnd.wndProc, hWnd, WM_DESTROY, 0, 0);
        const WM_NCDESTROY = 0x0082;
        emu.callWndProc16(wnd.wndProc, hWnd, WM_NCDESTROY, 0, 0);
      }
      if (wnd && wnd.parent) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd?.childList) {
          const idx = parentWnd.childList.indexOf(hWnd);
          if (idx >= 0) parentWnd.childList.splice(idx, 1);
        }
      }
      if (hWnd === emu.mainWindow) {
        emu.mainWindow = 0;
      }
      emu.handles.free(hWnd);
      return 0;
    }
    // WM_ERASEBKGND (0x14): fill window background with class brush
    if (msg === 0x14) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd && wnd.classInfo) {
        const hBrush = wnd.classInfo.hbrBackground;
        if (hBrush) {
          const hdc = wParam;
          const dc = emu.getDC(hdc);
          if (dc) {
            const brush = emu.getBrush(hBrush);
            if (brush && !brush.isNull) {
              const r = brush.color & 0xFF, g = (brush.color >> 8) & 0xFF, b = (brush.color >> 16) & 0xFF;
              dc.ctx.fillStyle = `rgb(${r},${g},${b})`;
              dc.ctx.fillRect(0, 0, dc.canvas.width, dc.canvas.height);
              emu.syncDCToCanvas(hdc);
            }
          }
        }
      }
      return 1;
    }
    return 0;
  }, 107);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 108: GetMessage(lpMsg_segptr, hWnd, wMsgFilterMin, wMsgFilterMax) — 10 bytes (4+2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetMessage', 10, () => {
    const [lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax] = emu.readPascalArgs16([4, 2, 2, 2]);
    if (emu.messageQueue.length > 0) {
      const msg = emu.messageQueue.shift()!;
      emu.memory.writeU16(lpMsg, msg.hwnd);
      emu.memory.writeU16(lpMsg + 2, msg.message);
      emu.memory.writeU16(lpMsg + 4, msg.wParam);
      emu.memory.writeU32(lpMsg + 6, msg.lParam);
      emu.memory.writeU32(lpMsg + 10, Date.now() & 0xFFFFFFFF);
      return msg.message === 0x0012 ? 0 : 1;
    }
    // Synthesize WM_PAINT for windows that need repainting
    for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
      if (wnd && wnd.needsPaint && wnd.wndProc) {
        if (wnd.needsErase) {
          wnd.needsErase = false;
          const hdc = emu.getWindowDC(handle);
          emu.memory.writeU16(lpMsg, handle);
          emu.memory.writeU16(lpMsg + 2, 0x0014); // WM_ERASEBKGND
          emu.memory.writeU16(lpMsg + 4, hdc);
          emu.memory.writeU32(lpMsg + 6, 0);
          emu.memory.writeU32(lpMsg + 10, Date.now() & 0xFFFFFFFF);
          return 1;
        }
        emu.memory.writeU16(lpMsg, handle);
        emu.memory.writeU16(lpMsg + 2, 0x000F); // WM_PAINT
        emu.memory.writeU16(lpMsg + 4, 0);
        emu.memory.writeU32(lpMsg + 6, 0);
        emu.memory.writeU32(lpMsg + 10, Date.now() & 0xFFFFFFFF);
        return 1;
      }
    }
    // No messages — wait for one
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu._onMessageAvailable = () => {
      const msg = emu.messageQueue.shift()!;
      emu.memory.writeU16(lpMsg, msg.hwnd & 0xFFFF);
      emu.memory.writeU16(lpMsg + 2, msg.message & 0xFFFF);
      emu.memory.writeU16(lpMsg + 4, msg.wParam & 0xFFFF);
      emu.memory.writeU32(lpMsg + 6, msg.lParam);
      emu.memory.writeU32(lpMsg + 10, (Date.now() & 0xFFFFFFFF) >>> 0);
      if (msg.message >= 0x200 && msg.message <= 0x20d) {
        emu.memory.writeU16(lpMsg + 14, msg.lParam & 0xFFFF);
        emu.memory.writeU16(lpMsg + 16, (msg.lParam >>> 16) & 0xFFFF);
      } else {
        emu.memory.writeU16(lpMsg + 14, 0);
        emu.memory.writeU16(lpMsg + 16, 0);
      }
      emu.waitingForMessage = false;
      emuCompleteThunk16(emu, msg.message === 0x0012 ? 0 : 1, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    };
    return undefined;
  }, 108);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 109: PeekMessage(lpMsg_ptr, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('PeekMessage', 12, () => {
    const [lpMsg, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg] = emu.readPascalArgs16([4, 2, 2, 2, 2]);

    // Check for synthesized WM_PAINT
    if (emu.messageQueue.length === 0 && emu.wndProcDepth === 0) {
      for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (wnd && wnd.needsPaint && wnd.wndProc) {
          const hasFilter = wMsgFilterMin !== 0 || wMsgFilterMax !== 0;
          const WM_PAINT = 0x000F;
          if (!hasFilter || (WM_PAINT >= wMsgFilterMin && WM_PAINT <= wMsgFilterMax)) {
            if (lpMsg) {
              emu.memory.writeU16(lpMsg, handle & 0xFFFF);
              emu.memory.writeU16(lpMsg + 2, WM_PAINT);
              emu.memory.writeU16(lpMsg + 4, 0);
              emu.memory.writeU32(lpMsg + 6, 0);
              emu.memory.writeU32(lpMsg + 10, Date.now() & 0xFFFFFFFF);
            }
            wnd.needsPaint = false;
            return 1;
          }
        }
      }
    }

    if (emu.messageQueue.length > 0) {
      const msg = (wRemoveMsg & 1) ? emu.messageQueue.shift()! : emu.messageQueue[0];
      if (lpMsg) {
        emu.memory.writeU16(lpMsg, msg.hwnd);
        emu.memory.writeU16(lpMsg + 2, msg.message);
        emu.memory.writeU16(lpMsg + 4, msg.wParam);
        emu.memory.writeU32(lpMsg + 6, msg.lParam);
        emu.memory.writeU32(lpMsg + 10, Date.now() & 0xFFFFFFFF);
      }
      return 1;
    }
    if (emu.wndProcDepth > 0) {
      const stackBytes = emu._currentThunkStackBytes;
      emu.waitingForMessage = true;
      const resumeWith0 = () => {
        emu._onMessageAvailable = null;
        emu.waitingForMessage = false;
        emuCompleteThunk16(emu, 0, stackBytes);
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      };
      emu._onMessageAvailable = resumeWith0;
      requestAnimationFrame(() => {
        if (emu._onMessageAvailable === resumeWith0) resumeWith0();
      });
      return undefined;
    }
    return 0;
  }, 109);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 110: PostMessage(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('PostMessage', 10, () => {
    const [hWnd, msg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    emu.postMessage(hWnd, msg, wParam, lParam);
    return 1;
  }, 110);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 111: SendMessage(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SendMessage', 10, () => {
    const [hWnd, message, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd?.wndProc) {
      return emu.callWndProc16(wnd.wndProc, hWnd, message, wParam, lParam);
    }
    // Handle messages for built-in EDIT controls (no wndProc, backed by HTML overlay)
    const cn = wnd?.classInfo?.className;
    if (wnd && cn && cn.toUpperCase() === 'EDIT') {
      // Standard WM_ messages (same values as Win32)
      const WM_SETTEXT = 0x000C, WM_GETTEXT = 0x000D, WM_GETTEXTLENGTH = 0x000E;
      const WM_CUT = 0x0300, WM_COPY = 0x0301, WM_PASTE = 0x0302, WM_CLEAR = 0x0303;
      const WM_SETFONT = 0x0030;
      // Win16 EM_ messages start at WM_USER (0x0400), NOT at 0x00B0 like Win32!
      const EM_GETSEL = 0x0400, EM_SETSEL = 0x0401;
      const EM_GETRECT = 0x0402, EM_SETRECT = 0x0403;
      const EM_REPLACESEL = 0x0412;
      const EM_GETMODIFY = 0x0408, EM_SETMODIFY = 0x0409;
      const EM_GETLINECOUNT = 0x040A, EM_LINEINDEX = 0x040B;
      const EM_SETHANDLE = 0x040C, EM_GETHANDLE = 0x040D;
      const EM_LINELENGTH = 0x0411;
      const EM_GETLINE = 0x0414, EM_LIMITTEXT = 0x0415;
      const EM_CANUNDO = 0x0416, EM_UNDO = 0x0417;
      const EM_LINEFROMCHAR = 0x0419;

      if (message === WM_GETTEXTLENGTH) return wnd.title?.length || 0;
      if (message === WM_GETTEXT) {
        const buf = lParam;
        const maxLen = wParam;
        const text = wnd.title || '';
        for (let i = 0; i < maxLen - 1 && i < text.length; i++) {
          emu.memory.writeU8(buf + i, text.charCodeAt(i) & 0xFF);
        }
        emu.memory.writeU8(buf + Math.min(maxLen - 1, text.length), 0);
        return Math.min(text.length, maxLen - 1);
      }
      if (message === WM_SETTEXT) {
        const text = lParam ? emu.memory.readCString(lParam) : '';
        wnd.title = text;
        if (wnd.domInput) wnd.domInput.value = text;
        emu.notifyControlOverlays();
        return 1;
      }
      if (message === WM_SETFONT) return 0; // stub — HTML overlay uses CSS fonts
      // Helper: get selection (prefer live DOM, fallback to saved)
      const getSel = (): [number, number] => {
        const el = wnd.domInput;
        if (el && document.activeElement === el) {
          return [el.selectionStart ?? 0, el.selectionEnd ?? 0];
        }
        return [wnd.editSelStart ?? 0, wnd.editSelEnd ?? 0];
      };
      // Helper: set selection on DOM + save
      const setSel = (start: number, end: number) => {
        wnd.editSelStart = start;
        wnd.editSelEnd = end;
        if (wnd.domInput) {
          wnd.domInput.selectionStart = start;
          wnd.domInput.selectionEnd = end;
        }
      };

      if (message === WM_COPY || message === WM_CUT) {
        const text = wnd.title || '';
        const [start, end] = getSel();
        if (start !== end) {
          const selected = text.slice(start, end);
          try { navigator.clipboard.writeText(selected); } catch {}
          if (message === WM_CUT) {
            wnd.title = text.slice(0, start) + text.slice(end);
            if (wnd.domInput) wnd.domInput.value = wnd.title;
            setSel(start, start);
            emu.notifyControlOverlays();
          }
        }
        return 0;
      }
      if (message === WM_PASTE) {
        navigator.clipboard.readText().then((clipText) => {
          const text = wnd.title || '';
          const [start, end] = getSel();
          wnd.title = text.slice(0, start) + clipText + text.slice(end);
          if (wnd.domInput) wnd.domInput.value = wnd.title;
          const newPos = start + clipText.length;
          setSel(newPos, newPos);
          emu.notifyControlOverlays();
        }).catch(() => {});
        return 0;
      }
      if (message === WM_CLEAR) {
        const [start, end] = getSel();
        if (start !== end) {
          const text = wnd.title || '';
          wnd.title = text.slice(0, start) + text.slice(end);
          if (wnd.domInput) wnd.domInput.value = wnd.title;
          setSel(start, start);
          emu.notifyControlOverlays();
        }
        return 0;
      }
      // Win16 EM_SETSEL: wParam=0, lParam=MAKELONG(start, end)
      if (message === EM_SETSEL) {
        const textLen = (wnd.title || '').length;
        const rawStart = lParam & 0xFFFF;
        const rawEnd = (lParam >>> 16) & 0xFFFF;
        const start = rawStart === 0xFFFF ? textLen : rawStart;
        const end = rawEnd === 0xFFFF ? textLen : rawEnd;
        setSel(start, end);
        if (wnd.domInput) wnd.domInput.focus();
        return 0;
      }
      // Win16 EM_GETSEL: returns MAKELONG(start, end)
      if (message === EM_GETSEL) {
        const [start, end] = getSel();
        return ((end & 0xFFFF) << 16) | (start & 0xFFFF);
      }
      // EM_GETHANDLE: allocate local buffer with current text, return handle
      if (message === EM_GETHANDLE) {
        const text = wnd.title || '';
        const size = text.length + 1;
        const handle = emu.allocLocal(size);
        if (handle) {
          const dsBase = emu.cpu.segBases.get(emu.cpu.ds) ?? 0;
          const addr = dsBase + handle;
          for (let i = 0; i < text.length; i++) {
            emu.memory.writeU8(addr + i, text.charCodeAt(i) & 0xFF);
          }
          emu.memory.writeU8(addr + text.length, 0);
          wnd.editBufferHandle = handle;
        }
        return handle;
      }
      // EM_SETHANDLE: read text from local buffer, update edit control
      if (message === EM_SETHANDLE) {
        const handle = wParam;
        if (handle) {
          const dsBase = emu.cpu.segBases.get(emu.cpu.ds) ?? 0;
          const addr = dsBase + handle;
          const text = emu.memory.readCString(addr);
          wnd.title = text;
          if (wnd.domInput) wnd.domInput.value = text;
          wnd.editBufferHandle = handle;
          emu.notifyControlOverlays();
        }
        return 0;
      }
      if (message === EM_REPLACESEL) {
        const replText = lParam ? emu.memory.readCString(lParam) : '';
        const cur = wnd.title || '';
        const [start, end] = getSel();
        wnd.title = cur.slice(0, start) + replText + cur.slice(end);
        if (wnd.domInput) wnd.domInput.value = wnd.title;
        const newPos = start + replText.length;
        setSel(newPos, newPos);
        emu.notifyControlOverlays();
        return 0;
      }
      if (message === EM_GETMODIFY) return wnd.editModified ? 1 : 0;
      if (message === EM_SETMODIFY) { wnd.editModified = !!wParam; return 0; }
      if (message === EM_GETLINECOUNT) return (wnd.title || '').split('\n').length;
      if (message === EM_LINEINDEX) {
        const line = wParam === 0xFFFF ? -1 : wParam;
        const lines = (wnd.title || '').split('\n');
        if (line === -1) {
          // Current line — use caret position
          const [pos] = getSel();
          let idx = 0;
          for (const l of lines) { if (idx + l.length + 1 > pos) return idx; idx += l.length + 1; }
          return idx;
        }
        let idx = 0;
        for (let i = 0; i < line && i < lines.length; i++) idx += lines[i].length + 1;
        return idx;
      }
      if (message === EM_LINELENGTH) {
        const charIdx = wParam;
        const text = wnd.title || '';
        let pos = 0;
        for (const line of text.split('\n')) {
          if (pos + line.length >= charIdx) return line.length;
          pos += line.length + 1;
        }
        return 0;
      }
      if (message === EM_GETLINE) {
        const lineNum = wParam;
        const buf = lParam;
        const lines = (wnd.title || '').split('\n');
        if (lineNum < lines.length) {
          const line = lines[lineNum];
          const maxLen = emu.memory.readU16(buf); // first word = buffer size
          const len = Math.min(line.length, maxLen);
          for (let i = 0; i < len; i++) emu.memory.writeU8(buf + i, line.charCodeAt(i) & 0xFF);
          return len;
        }
        return 0;
      }
      if (message === EM_LIMITTEXT) { wnd.editLimit = wParam || 0x7FFFFFFE; return 0; }
      if (message === EM_CANUNDO) return 0;
      if (message === EM_UNDO) return 0;
      if (message === EM_LINEFROMCHAR) {
        const charIdx = wParam === 0xFFFF ? getSel()[0] : wParam;
        let pos = 0, lineNum = 0;
        for (const line of (wnd.title || '').split('\n')) {
          if (pos + line.length >= charIdx) return lineNum;
          pos += line.length + 1;
          lineNum++;
        }
        return lineNum;
      }
      if (message === EM_GETRECT || message === EM_SETRECT) return 0;
    }

    // Handle messages for built-in LISTBOX controls
    if (wnd && cn && cn.toUpperCase() === 'LISTBOX') {
      return handleListBoxMessage16(emu, wnd, message, wParam, lParam);
    }

    // Handle WM_MDICREATE for MDICLIENT windows
    const WM_MDICREATE = 0x0220;
    const WM_MDIGETACTIVE = 0x0229;
    if (wnd && cn && cn.toUpperCase() === 'MDICLIENT') {
      if (message === WM_MDICREATE) {
        // lParam is a far pointer to MDICREATESTRUCT (Win16):
        //   szClass   (4) far ptr to class name
        //   szTitle   (4) far ptr to title
        //   hOwner    (2) instance handle
        //   x         (2)
        //   y         (2)
        //   cx        (2)
        //   cy        (2)
        //   style     (4) window style
        //   lParam    (4) app-defined
        const mdiAddr = emu.resolveFarPtr(lParam);
        const szClassPtr = emu.memory.readU32(mdiAddr);
        const szTitlePtr = emu.memory.readU32(mdiAddr + 4);
        const hOwner = emu.memory.readU16(mdiAddr + 8);
        const mdiX = emu.memory.readU16(mdiAddr + 10);
        const mdiY = emu.memory.readU16(mdiAddr + 12);
        const mdiCX = emu.memory.readU16(mdiAddr + 14);
        const mdiCY = emu.memory.readU16(mdiAddr + 16);
        const mdiStyle = emu.memory.readU32(mdiAddr + 18);
        const mdiLParam = emu.memory.readU32(mdiAddr + 22);

        const classAddr = emu.resolveFarPtr(szClassPtr);
        const titleAddr = emu.resolveFarPtr(szTitlePtr);
        const mdiClassName = classAddr ? emu.memory.readCString(classAddr) : '';
        const mdiTitle = titleAddr ? emu.memory.readCString(titleAddr) : '';

        const classInfo = emu.windowClasses.get(mdiClassName.toUpperCase());
        console.log(`[WIN16] WM_MDICREATE class="${mdiClassName}" title="${mdiTitle}" ${mdiCX}x${mdiCY} style=0x${mdiStyle.toString(16)} wndProc=0x${(classInfo?.wndProc||0).toString(16)} cbExtra=${classInfo?.cbWndExtra||0} lParam=0x${mdiLParam.toString(16)}`);

        const WS_CHILD = 0x40000000;
        const WS_VISIBLE = 0x10000000;
        const WS_CLIPSIBLINGS = 0x04000000;
        const childStyle = mdiStyle | WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS;

        // Auto-size to MDIClient area when dimensions are 0 or CW_USEDEFAULT
        const clientW = wnd.width || (emu.canvas?.width ?? 320);
        const clientH = wnd.height || (emu.canvas?.height ?? 200);
        const childHwnd = emu.handles.alloc('window', {
          classInfo: classInfo || { className: mdiClassName, wndProc: 0, rawWndProc: 0, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
          title: mdiTitle,
          style: childStyle,
          exStyle: 0,
          x: mdiX === 0x8000 ? 0 : mdiX,
          y: mdiY === 0x8000 ? 0 : mdiY,
          width: (mdiCX === 0x8000 || mdiCX === 0) ? clientW : mdiCX,
          height: (mdiCY === 0x8000 || mdiCY === 0) ? clientH : mdiCY,
          hMenu: 0,
          parent: hWnd,
          wndProc: classInfo?.wndProc || 0,
          rawWndProc: classInfo?.rawWndProc || 0,
          visible: true,
          extraBytes: new Uint8Array(classInfo?.cbWndExtra || 0),
          children: new Map(),
        });
        { const w = emu.handles.get<WindowInfo>(childHwnd); if (w) w.hwnd = childHwnd; }

        // Register child in parent's childList
        if (!wnd.childList) wnd.childList = [];
        wnd.childList.push(childHwnd);

        // Track active MDI child on the MDIClient
        (wnd as any).mdiActiveChild = childHwnd;

        // Send WM_CREATE to child if it has a wndProc
        if (classInfo?.wndProc) {
          const savedSP = emu.cpu.reg[4] & 0xFFFF;
          // Build a minimal Win16 CREATESTRUCT on the heap for WM_CREATE lParam
          // CREATESTRUCT16: lpCreateParams(4), hInstance(2), hMenu(2), hWndParent(2),
          //   cy(2), cx(2), y(2), x(2), style(4), lpszName(4), lpszClass(4), dwExStyle(4)
          const csAddr = emu.allocHeap(34);
          emu.memory.writeU32(csAddr + 0, mdiLParam);     // lpCreateParams = MDICREATESTRUCT.lParam
          emu.memory.writeU16(csAddr + 4, hOwner);         // hInstance
          emu.memory.writeU16(csAddr + 6, 0);              // hMenu
          emu.memory.writeU16(csAddr + 8, hWnd);           // hWndParent (MDIClient)
          const childWnd = emu.handles.get<WindowInfo>(childHwnd)!;
          emu.memory.writeU16(csAddr + 10, childWnd.height & 0xFFFF); // cy
          emu.memory.writeU16(csAddr + 12, childWnd.width & 0xFFFF);  // cx
          emu.memory.writeU16(csAddr + 14, childWnd.y & 0xFFFF);      // y
          emu.memory.writeU16(csAddr + 16, childWnd.x & 0xFFFF);      // x
          emu.memory.writeU32(csAddr + 18, childStyle);    // style
          emu.memory.writeU32(csAddr + 22, szTitlePtr);    // lpszName
          emu.memory.writeU32(csAddr + 26, szClassPtr);    // lpszClass
          emu.memory.writeU32(csAddr + 30, 0);             // dwExStyle
          // Convert to far pointer (DS:offset)
          const csOff = csAddr - (emu.cpu.segBases.get(emu.cpu.ds) ?? 0);
          const csFarPtr = ((emu.cpu.ds & 0xFFFF) << 16) | (csOff & 0xFFFF);
          emu.callWndProc16(classInfo.wndProc, childHwnd, 0x0001, 0, csFarPtr);
          emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | savedSP;

          // Send WM_SIZE so child knows its dimensions
          const WM_SIZE = 0x0005;
          const sizeLParam = ((childWnd.height & 0xFFFF) << 16) | (childWnd.width & 0xFFFF);
          emu.callWndProc16(classInfo.wndProc, childHwnd, WM_SIZE, 0, sizeLParam);
          emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | savedSP;
        }

        console.log(`[WIN16] WM_MDICREATE → created hwnd=0x${childHwnd.toString(16)}`);
        return childHwnd;
      }
      if (message === WM_MDIGETACTIVE) {
        return (wnd as any).mdiActiveChild || 0;
      }
      const WM_MDIACTIVATE = 0x0222;
      const WM_MDIDESTROY = 0x0221;
      const WM_MDITILE = 0x0226;
      const WM_MDICASCADE = 0x0227;
      const WM_MDIICONARRANGE = 0x0228;
      const WM_MDISETMENU = 0x0230;
      if (message === WM_MDIACTIVATE) {
        (wnd as any).mdiActiveChild = wParam;
        return 0;
      }
      if (message === WM_MDIDESTROY || message === WM_MDITILE ||
          message === WM_MDICASCADE || message === WM_MDIICONARRANGE ||
          message === WM_MDISETMENU) {
        return 0;
      }
    }

    return 0;
  }, 111);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 113: TranslateMessage(lpMsg_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('TranslateMessage', 4, () => 0, 113);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 114: DispatchMessage(lpMsg_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DispatchMessage', 4, () => {
    const lpMsg = h.readFarPtr(0);
    const hWnd = emu.memory.readU16(lpMsg);
    const message = emu.memory.readU16(lpMsg + 2);
    const wParam = emu.memory.readU16(lpMsg + 4);
    const lParam = emu.memory.readU32(lpMsg + 6);

    if (message === 0x0111) {
      // Standard edit menu command IDs (WM_CUT=0x300..WM_CLEAR=0x303) — relay to focused EDIT child
      if (wParam >= 0x0300 && wParam <= 0x0304 && lParam === 0) {
        const focusHwnd = emu.focusedWindow;
        if (focusHwnd) {
          const fw = emu.handles.get<WindowInfo>(focusHwnd);
          if (fw && !fw.wndProc && fw.classInfo?.className?.toUpperCase() === 'EDIT' && fw.domInput) {
            const el = fw.domInput;
            const start = el.selectionStart ?? fw.editSelStart ?? 0;
            const end = el.selectionEnd ?? fw.editSelEnd ?? 0;
            const text = fw.title || '';
            if (wParam === 0x0301 || wParam === 0x0300) { // WM_COPY / WM_CUT
              if (start !== end) {
                try { navigator.clipboard.writeText(text.slice(start, end)); } catch {}
                if (wParam === 0x0300) { // WM_CUT
                  fw.title = text.slice(0, start) + text.slice(end);
                  el.value = fw.title;
                  el.selectionStart = el.selectionEnd = start;
                  fw.editSelStart = fw.editSelEnd = start;
                  emu.notifyControlOverlays();
                }
              }
            } else if (wParam === 0x0302) { // WM_PASTE
              navigator.clipboard.readText().then((clip) => {
                fw.title = text.slice(0, start) + clip + text.slice(end);
                el.value = fw.title;
                const np = start + clip.length;
                el.selectionStart = el.selectionEnd = np;
                fw.editSelStart = fw.editSelEnd = np;
                emu.notifyControlOverlays();
              }).catch(() => {});
            } else if (wParam === 0x0303) { // WM_CLEAR
              if (start !== end) {
                fw.title = text.slice(0, start) + text.slice(end);
                el.value = fw.title;
                el.selectionStart = el.selectionEnd = start;
                fw.editSelStart = fw.editSelEnd = start;
                emu.notifyControlOverlays();
              }
            } else if (wParam === 0x0304) { // WM_UNDO
              el.focus();
              document.execCommand('undo');
              // Sync DOM state back to emulator
              fw.title = el.value;
              fw.editSelStart = el.selectionStart ?? 0;
              fw.editSelEnd = el.selectionEnd ?? 0;
              emu.notifyControlOverlays();
            }
          }
        }
      }
    }
    // WM_TIMER with non-zero lParam: call timer callback directly
    if (message === 0x0113 && lParam !== 0) {
      return emu.callWndProc16(lParam, hWnd, message, wParam, Date.now() & 0xFFFFFFFF);
    }
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd?.wndProc) {
      return emu.callWndProc16(wnd.wndProc, hWnd, message, wParam, lParam);
    }
    return 0;
  }, 114);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 118: RegisterWindowMessage(lpString_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('RegisterWindowMessage', 4, () => 0xC000, 118);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 119: GetMessagePos() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetMessagePos', 0, () => 0, 119);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 120: GetMessageTime() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetMessageTime', 0, () => Date.now() & 0xFFFFFFFF, 120);
}
