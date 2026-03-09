import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';
import { handleListBoxMessage16 } from './message';

// Win16 USER module — Miscellaneous APIs

export function registerWin16UserMisc(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 1: MessageBox(hWnd, lpText_ptr, lpCaption_ptr, uType) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('MessageBox', 12, () => {
    const [hWnd, lpText, lpCaption, uType] = emu.readPascalArgs16([2, 4, 4, 2]);
    const text = lpText ? emu.memory.readCString(lpText) : '';
    const caption = lpCaption ? emu.memory.readCString(lpCaption) : '';
    console.log(`[WIN16] MessageBox(0x${hWnd.toString(16)}, "${text}", "${caption}", 0x${uType.toString(16)})`);
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.showMessageBox(caption, text, uType, result => {
      emu.waitingForMessage = false;
      emuCompleteThunk16(emu, result, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    });
    return undefined;
  }, 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 5: InitApp(hInstance) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('InitApp', 2, () => emu.readArg16(0), 5);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 6: PostQuitMessage(exitCode) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('PostQuitMessage', 2, () => {
    emu.postMessage(0, 0x0012, 0, 0); // WM_QUIT
    return 0;
  }, 6);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 10: SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc_segptr) — 10 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetTimer', 10, () => {
    const [hWnd, nIDEvent, uElapse, lpTimerFunc] = emu.readPascalArgs16([2, 2, 2, 4]);
    console.log(`[WIN16] SetTimer hwnd=0x${hWnd.toString(16)} id=${nIDEvent} elapse=${uElapse} timerFunc=0x${lpTimerFunc.toString(16)}`);
    // Clear existing timer with same ID
    emu.clearWin32Timer(hWnd, nIDEvent);
    const jsTimer = setInterval(() => {
      emu.postMessage(hWnd, 0x0113, nIDEvent, lpTimerFunc);
    }, uElapse);
    emu.setWin32Timer(hWnd, nIDEvent, jsTimer);
    return 1;
  }, 10);

  // Ordinal 12: KillTimer(hWnd, nIDEvent) — 4 bytes
  user.register('KillTimer', 4, () => {
    const [hWnd, nIDEvent] = emu.readPascalArgs16([2, 2]);
    emu.clearWin32Timer(hWnd, nIDEvent);
    return 1;
  }, 12);

  // Ordinal 13: GetTickCount() — 0 bytes
  user.register('GetTickCount', 0, () => Date.now() & 0xFFFFFFFF, 13);

  // Ordinal 15: GetCurrentTime() — 0 bytes
  user.register('GetCurrentTime', 0, () => Date.now() & 0xFFFFFFFF, 15);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 18: SetCapture(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetCapture', 2, () => {
    const hWnd = emu.readArg16(0);
    emu.capturedWindow = hWnd;
    return hWnd;
  }, 18);

  // Ordinal 19: ReleaseCapture() — 0 bytes
  user.register('ReleaseCapture', 0, () => { emu.capturedWindow = 0; return 0; }, 19);

  // Ordinal 22: SetFocus(hWnd) — 2 bytes
  user.register('SetFocus', 2, () => {
    const hWnd = emu.readArg16(0);
    const prev = emu.focusedWindow;
    emu.focusedWindow = hWnd;
    return prev;
  }, 22);

  // Ordinal 28: ClientToScreen(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ClientToScreen', 6, () => 0, 28);

  // Ordinal 29: ScreenToClient(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ScreenToClient', 6, () => 0, 29);

  // Ordinal 31: IsIconic(hWnd) — 2 bytes
  user.register('IsIconic', 2, () => 0, 31);

  // Ordinal 61: ScrollWindow(hWnd, nBar, nPos, bRedraw) — 8 bytes
  user.register('ScrollWindow', 8, () => {
    const [hWnd, nBar, nPos, _bRedraw] = emu.readPascalArgs16([2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) return 0;
    if (!wnd.scrollInfo) wnd.scrollInfo = [
      { min: 0, max: 100, pos: 0, page: 0 },
      { min: 0, max: 100, pos: 0, page: 0 },
    ];
    const bar = nBar & 1; // SB_HORZ=0, SB_VERT=1
    const old = wnd.scrollInfo[bar].pos;
    wnd.scrollInfo[bar].pos = (nPos << 16 >> 16); // sign-extend
    return old;
  }, 61);

  // Ordinal 62: SetScrollPos(hWnd, nBar) — 4 bytes
  user.register('SetScrollPos', 4, () => {
    const [hWnd, nBar] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const bar = nBar & 1;
    return wnd?.scrollInfo?.[bar]?.pos ?? 0;
  }, 62);

  // Ordinal 64: SetScrollRange(hWnd, nBar, nMinPos, nMaxPos, bRedraw) — 10 bytes
  user.register('SetScrollRange', 10, () => {
    const [hWnd, nBar, nMinPos, nMaxPos, _bRedraw] = emu.readPascalArgs16([2, 2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) return 1;
    if (!wnd.scrollInfo) wnd.scrollInfo = [
      { min: 0, max: 100, pos: 0, page: 0 },
      { min: 0, max: 100, pos: 0, page: 0 },
    ];
    const bar = nBar & 1;
    wnd.scrollInfo[bar].min = (nMinPos << 16 >> 16);
    wnd.scrollInfo[bar].max = (nMaxPos << 16 >> 16);
    return 1;
  }, 64);

  // Ordinal 69: SetCursor(hCursor) — 2 bytes
  user.register('SetCursor', 2, () => {
    const hCursor = emu.readArg16(0);
    const prev = emu.currentCursor;
    emu.currentCursor = hCursor;
    const cursorInfo = emu.handles.get<{ css?: string }>(hCursor);
    if (emu.canvas) {
      const css = cursorInfo?.css || 'default';
      emu.canvas.style.cursor = css;
      if (emu.canvas.parentElement) {
        emu.canvas.parentElement.style.cursor = css;
      }
    }
    return prev;
  }, 69);

  // Ordinal 70: SetCursorPos(x, y) — 4 bytes
  user.register('SetCursorPos', 4, () => 0, 70);

  // Ordinal 71: ShowCursor(bShow) — 2 bytes
  user.register('ShowCursor', 2, () => 1, 71);

  // Ordinal 93: GetDlgItemText(hWnd, nBar, lpMinPos, lpMaxPos) — 12 bytes
  user.register('GetDlgItemText', 12, () => {
    const [hWnd, nBar, lpMinPos, lpMaxPos] = emu.readPascalArgs16([2, 2, 4, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const bar = nBar & 1;
    const info = wnd?.scrollInfo?.[bar];
    if (lpMinPos) emu.memory.writeU16(lpMinPos, (info?.min ?? 0) & 0xFFFF);
    if (lpMaxPos) emu.memory.writeU16(lpMaxPos, (info?.max ?? 0) & 0xFFFF);
    return 1;
  }, 93);

  // Ordinal 101: SendDlgItemMessage(hDlg, nIDDlgItem, wMsg, wParam, lParam) — 12 bytes (2+2+2+2+4)
  user.register('SendDlgItemMessage', 12, () => {
    const [hDlg, nIDDlgItem, wMsg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 2, 4]);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    let childHwnd = dlgWnd?.children?.get(nIDDlgItem) ?? 0;
    // Fallback: search childList by controlId
    if (!childHwnd && dlgWnd?.childList) {
      for (const ch of dlgWnd.childList) {
        const cw = emu.handles.get<WindowInfo>(ch);
        if (cw?.controlId === nIDDlgItem) { childHwnd = ch; break; }
      }
    }
    if (!childHwnd) {
      return 0;
    }
    const child = emu.handles.get<WindowInfo>(childHwnd);
    if (!child) return 0;

    // Forward to child's wndProc if it has one
    if (child.wndProc) {
      return emu.callWndProc16(child.wndProc, childHwnd, wMsg, wParam, lParam);
    }

    const cn = child.classInfo?.className?.toUpperCase();

    // LISTBOX messages
    if (cn === 'LISTBOX') {
      return handleListBoxMessage16(emu, child, wMsg, wParam, lParam);
    }

    // STM_SETICON for STATIC controls
    const STM_SETICON = 0x0170;
    const WM_USER = 0x0400;
    if ((wMsg === STM_SETICON || wMsg === WM_USER) && wParam) {
      const icon = emu.handles.get<{ width?: number; height?: number }>(wParam);
      if (icon) {
        child.hImage = wParam;
        if ((child.style & 0x1F) === 0x03 && child.width === 0 && child.height === 0) {
          child.width = icon.width ?? 32;
          child.height = icon.height ?? 32;
        }
      }
      return wParam;
    }

    // WM_SETTEXT
    if (wMsg === 0x000C) {
      const addr = emu.resolveFarPtr(lParam);
      child.title = addr ? emu.memory.readCString(addr) : '';
      return 1;
    }
    // WM_GETTEXT
    if (wMsg === 0x000D) {
      const text = child.title || '';
      const addr = emu.resolveFarPtr(lParam);
      if (addr && wParam > 0) {
        const maxCopy = Math.min(text.length, wParam - 1);
        for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(addr + i, text.charCodeAt(i) & 0xFF);
        emu.memory.writeU8(addr + maxCopy, 0);
        return maxCopy;
      }
      return 0;
    }
    // WM_GETTEXTLENGTH
    if (wMsg === 0x000E) return child.title?.length || 0;

    return 0;
  }, 101);

  // Ordinal 84: DrawIcon(hDC, x, y, hIcon) — 8 bytes (2+2+2+2)
  user.register('DrawIcon', 8, () => 1, 84);

  // Ordinal 85: DrawText(hDC, lpString_ptr, nCount_sword, lpRect_ptr, uFormat) — 14 bytes
  user.register('DrawText', 14, () => 0, 85);

  // Ordinal 104: MessageBeep(uType) — 2 bytes
  user.register('MessageBeep', 2, () => 1, 104);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 106: GetKeyState(nVirtKey) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetKeyState', 2, () => 0, 106);

  // Ordinal 171: WinHelp(hWndMain, lpszHelp_ptr, uCommand, dwData_long) — 12 bytes (2+4+2+4)
  user.register('WinHelp', 12, () => 1, 171);

  // Ordinal 178: TranslateAccelerator — 8 bytes
  user.register('TranslateAccelerator', 8, () => 0, 178);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 179: GetSystemMetrics(nIndex) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetSystemMetrics', 2, () => {
    const idx = emu.readArg16(0);
    const metrics: Record<number, number> = {
      0: 640,   // SM_CXSCREEN
      1: 480,   // SM_CYSCREEN
      2: 20,    // SM_CXVSCROLL
      3: 20,    // SM_CYVSCROLL
      4: 20,    // SM_CYCAPTION (Win 3.1)
      5: 1,     // SM_CXBORDER
      6: 1,     // SM_CYBORDER
      7: 1,     // SM_CXDLGFRAME (Win 3.1: single border)
      8: 1,     // SM_CYDLGFRAME (Win 3.1: single border)
      11: 20,   // SM_CXHTHUMB
      12: 20,   // SM_CYVTHUMB
      15: 20,   // SM_CXMIN
      16: 19,   // SM_CYMIN
      28: 1,    // SM_CXMINTRACK
      29: 1,    // SM_CYMINTRACK
      32: 1,    // SM_CXFRAME (Win 3.1: single border)
      33: 1,    // SM_CYFRAME (Win 3.1: single border)
      36: 32,   // SM_CXICON
      37: 32,   // SM_CYICON
      49: 0,    // SM_CYKANJIWINDOW
    };
    return metrics[idx] ?? 0;
  }, 179);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 180: GetSysColor(nIndex) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetSysColor', 2, () => {
    const idx = emu.readArg16(0);
    const colors: Record<number, number> = {
      0: 0x808000,   // COLOR_SCROLLBAR
      1: 0x808000,   // COLOR_BACKGROUND (desktop)
      2: 0x800000,   // COLOR_ACTIVECAPTION
      3: 0x808080,   // COLOR_INACTIVECAPTION
      4: 0xC8D0D4,   // COLOR_MENU
      5: 0xFFFFFF,   // COLOR_WINDOW
      6: 0x000000,   // COLOR_WINDOWFRAME
      7: 0x000000,   // COLOR_MENUTEXT
      8: 0x000000,   // COLOR_WINDOWTEXT
      9: 0xFFFFFF,   // COLOR_CAPTIONTEXT
      10: 0xC8D0D4,  // COLOR_ACTIVEBORDER
      11: 0xC8D0D4,  // COLOR_INACTIVEBORDER
      12: 0x808080,  // COLOR_APPWORKSPACE
      13: 0xFF0000,  // COLOR_HIGHLIGHT
      14: 0xFFFFFF,  // COLOR_HIGHLIGHTTEXT
      15: 0xC8D0D4,  // COLOR_BTNFACE
      16: 0x808080,  // COLOR_BTNSHADOW
      17: 0x808080,  // COLOR_GRAYTEXT
      18: 0x000000,  // COLOR_BTNTEXT
      19: 0xC8D0D4,  // COLOR_INACTIVECAPTIONTEXT
      20: 0xFFFFFF,  // COLOR_BTNHIGHLIGHT
    };
    return colors[idx] ?? 0xC8D0D4;
  }, 180);

  // Ordinal 181: SetSysColors(cElements, lpSysColor_ptr, lpColorValues_ptr) — 10 bytes (2+4+4)
  user.register('SetSysColors', 10, () => 1, 181);


  // Ordinal 228: GetNextDlgTabItem — 6 bytes
  user.register('GetNextDlgTabItem', 6, () => 0, 228);

  // Ordinal 229: GetTopWindow(hWnd) — 2 bytes
  user.register('GetTopWindow', 2, () => {
    const hWnd = emu.readPascalArgs16([2])[0];
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.childList?.[0] ?? 0;
  }, 229);

  // Ordinal 230: GetNextWindow(hWnd, uCmd) — 4 bytes
  user.register('GetNextWindow', 4, () => {
    const [hWnd, uCmd] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd?.parent) return 0;
    const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
    const siblings = parentWnd?.childList;
    if (!siblings) return 0;
    const idx = siblings.indexOf(hWnd);
    if (idx < 0) return 0;
    // GW_HWNDNEXT=2, GW_HWNDPREV=3
    if (uCmd === 3) return idx > 0 ? siblings[idx - 1] : 0;
    return idx + 1 < siblings.length ? siblings[idx + 1] : 0;
  }, 230);

  // Ordinal 234: UnhookWindowsHook — 6 bytes
  user.register('UnhookWindowsHook', 6, () => 0, 234);

  // Ordinal 235: DefHookProc — 12 bytes
  user.register('DefHookProc', 12, () => 0, 235);

  // Ordinal 236: GetCapture() — 0 bytes
  user.register('GetCapture', 0, () => 0, 236);

  // Ordinal 267: ShowScrollBar — 6 bytes
  user.register('ShowScrollBar', 6, () => 0, 267);

  // Ordinal 269: GlobalDeleteAtom — 2 bytes
  user.register('GlobalDeleteAtom', 2, () => 0, 269);

  // Ordinal 277: GetDlgCtrlID(hWnd) — 2 bytes
  user.register('GetDlgCtrlID', 2, () => {
    const hWnd = emu.readPascalArgs16([2])[0];
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.controlId ?? 0;
  }, 277);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 278: GetDesktopHwnd() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetDesktopHwnd', 0, () => 0, 278);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 286: GetDesktopWindow() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetDesktopWindow', 0, () => 0, 286);

  // Ordinal 287: GetLastActivePopup(hWnd) — 2 bytes
  user.register('GetLastActivePopup', 2, () => emu.readArg16(0), 287);

  // Ordinal 291: SetWindowsHookEx(nFilterType, pfnFilterProc, hInstance, wThreadID) — 10 bytes
  user.register('SetWindowsHookEx', 10, () => {
    const [nFilterType, pfnFilterProc, _hInstance, _wThreadID] = emu.readPascalArgs16([2, 4, 2, 2]);
    const WH_CBT = 5;
    if (nFilterType === WH_CBT && pfnFilterProc) {
      emu.cbtHooks.push({ lpfn: pfnFilterProc, hMod: 0 });
    }
    return emu.handles.alloc('hook', { idHook: nFilterType, lpfn: pfnFilterProc });
  }, 291);

  // Ordinal 292: UnhookWindowsHookEx — 4 bytes
  user.register('UnhookWindowsHookEx', 4, () => 0, 292);

  // Ordinal 293: CallNextHookEx — 12 bytes
  user.register('CallNextHookEx', 12, () => 0, 293);

  // Ordinal 404: GetClassInfo(hInstance, className, lpWndClass) — 10 bytes (2+4+4)
  user.register('GetClassInfo', 10, () => {
    const args = emu.readPascalArgs16([2, 4, 4]);
    const hInstance = args[0];
    const classNameRaw = args[1];
    const classNamePtr = emu.resolveFarPtr(classNameRaw);
    const lpWndClass = emu.resolveFarPtr(args[2]);
    // className can be an atom (HIWORD=0, LOWORD<0xC000) or a far string pointer
    const classNameHi = (classNameRaw >>> 16) & 0xFFFF;
    let className = '';
    if (classNameHi !== 0) {
      className = emu.memory.readCString(classNamePtr);
    } else if (classNameRaw === 0) {
      className = '';
    } else {
      // It's an atom — look up in registered classes by scanning
      const atom = classNameRaw & 0xFFFF;
      for (const [name, cls] of emu.windowClasses) {
        if ((cls as any).atom === atom) { className = name; break; }
      }
      if (!className) className = `ATOM_${atom}`;
    }
    const BUILTIN_CLASSES = ['BUTTON', 'EDIT', 'STATIC', 'LISTBOX', 'COMBOBOX', 'SCROLLBAR', 'MDICLIENT'];
    const upperName = className.toUpperCase();
    let cls = emu.windowClasses.get(upperName);
    // For built-in system classes (hInstance=0 or any), return success
    if (!cls && BUILTIN_CLASSES.includes(upperName)) {
      cls = { className: upperName, wndProc: 0, style: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hbrBackground: 0, hIcon: 0, hCursor: 0 } as any;
    }
    console.log(`[WIN16] GetClassInfo("${className}") → ${cls ? 'found' : 'not found'}`);
    if (cls && lpWndClass) {
      // Write WNDCLASS16 struct: style(2), wndProc(4), cbClsExtra(2), cbWndExtra(2),
      // hInstance(2), hIcon(2), hCursor(2), hbrBackground(2), lpszMenuName(4), lpszClassName(4)
      emu.memory.writeU16(lpWndClass, cls.style || 0);
      emu.memory.writeU32(lpWndClass + 2, (cls as any).rawWndProc || cls.wndProc || 0);
      emu.memory.writeU16(lpWndClass + 6, cls.cbClsExtra || 0);
      emu.memory.writeU16(lpWndClass + 8, cls.cbWndExtra || 0);
      emu.memory.writeU16(lpWndClass + 10, cls.hInstance || hInstance);
      emu.memory.writeU16(lpWndClass + 12, cls.hIcon || 0);
      emu.memory.writeU16(lpWndClass + 14, cls.hCursor || 0);
      emu.memory.writeU16(lpWndClass + 16, cls.hbrBackground || 0);
      emu.memory.writeU32(lpWndClass + 18, 0); // lpszMenuName
      emu.memory.writeU32(lpWndClass + 22, 0); // lpszClassName
      return 1;
    }
    return cls ? 1 : 0;
  }, 404);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 420: _wsprintf(lpOutput, lpFormat, ...) — varargs cdecl (stackBytes=0)
  // Win16 wsprintf: args on stack are 16-bit words unless %l prefix → 32-bit
  // %s → far pointer (32-bit), %d → 16-bit word, %ld → 32-bit long
  // ───────────────────────────────────────────────────────────────────────────
  user.register('_wsprintf', 0, () => {
    // Stack: [retaddr 4] [lpOutput 4] [lpFormat 4] [varargs...]
    const lpOutput = emu.resolveFarPtr(emu.readArg16DWord(0));
    const lpFormat = emu.resolveFarPtr(emu.readArg16DWord(4));
    const fmt = emu.memory.readCString(lpFormat);

    // Parse format string and read 16-bit varargs
    let argOff = 8; // byte offset on stack after lpOutput + lpFormat
    let result = '';
    let fi = 0;
    while (fi < fmt.length) {
      if (fmt[fi] !== '%' || fi + 1 >= fmt.length) {
        result += fmt[fi++];
        continue;
      }
      fi++; // skip '%'

      // Flags
      let flagMinus = false, flagPlus = false, flagZero = false, flagSpace = false, flagHash = false;
      for (;;) {
        const ch = fmt[fi];
        if (ch === '-') flagMinus = true;
        else if (ch === '+') flagPlus = true;
        else if (ch === '0') flagZero = true;
        else if (ch === ' ') flagSpace = true;
        else if (ch === '#') flagHash = true;
        else break;
        fi++;
      }

      // Width
      let width = 0;
      if (fmt[fi] === '*') {
        width = emu.readArg16(argOff); argOff += 2;
        fi++;
      } else {
        while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
          width = width * 10 + (fmt.charCodeAt(fi) - 48);
          fi++;
        }
      }

      // Precision
      let precision = -1;
      if (fi < fmt.length && fmt[fi] === '.') {
        fi++; precision = 0;
        if (fmt[fi] === '*') {
          precision = emu.readArg16(argOff); argOff += 2;
          fi++;
        } else {
          while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
            precision = precision * 10 + (fmt.charCodeAt(fi) - 48);
            fi++;
          }
        }
      }

      // Length modifier
      let isLong = false;
      if (fi < fmt.length && fmt[fi] === 'l') { isLong = true; fi++; }
      else if (fi < fmt.length && fmt[fi] === 'h') { fi++; }

      if (fi >= fmt.length) break;
      const spec = fmt[fi++];

      if (spec === '%') { result += '%'; continue; }

      let val = '';
      let isNeg = false;

      const read16 = (): number => { const v = emu.readArg16(argOff); argOff += 2; return v; };
      const read32 = (): number => { const v = emu.readArg16DWord(argOff); argOff += 4; return v; };

      switch (spec) {
        case 'd': case 'i': {
          if (isLong) {
            const n = read32() | 0;
            isNeg = n < 0;
            val = Math.abs(n).toString();
          } else {
            const n = (read16() << 16) >> 16; // sign-extend 16-bit
            isNeg = n < 0;
            val = Math.abs(n).toString();
          }
          break;
        }
        case 'u': {
          val = (isLong ? read32() >>> 0 : read16()).toString();
          break;
        }
        case 'x': case 'X': {
          const n = isLong ? read32() >>> 0 : read16();
          val = n.toString(16);
          if (spec === 'X') val = val.toUpperCase();
          if (flagHash && n !== 0) val = (spec === 'X' ? '0X' : '0x') + val;
          break;
        }
        case 'o': {
          const n = isLong ? read32() >>> 0 : read16();
          val = n.toString(8);
          if (flagHash && val[0] !== '0') val = '0' + val;
          break;
        }
        case 's': {
          const ptr = emu.resolveFarPtr(read32()); // far pointer (32-bit)
          val = ptr ? emu.memory.readCString(ptr) : '(null)';
          if (precision >= 0 && val.length > precision) val = val.slice(0, precision);
          break;
        }
        case 'c': {
          val = String.fromCharCode(read16() & 0xFF);
          break;
        }
        default:
          result += '%' + spec;
          continue;
      }

      // Numeric precision
      if (precision >= 0 && 'diouxX'.includes(spec)) {
        let prefix = '';
        if (flagHash && (spec === 'x' || spec === 'X') && val.startsWith('0')) {
          prefix = val.slice(0, 2); val = val.slice(2);
        }
        val = val.padStart(precision, '0');
        val = prefix + val;
        flagZero = false;
      }

      // Sign
      let sign = '';
      if (spec === 'd' || spec === 'i') {
        if (isNeg) sign = '-';
        else if (flagPlus) sign = '+';
        else if (flagSpace) sign = ' ';
      }

      // Width padding
      const totalLen = sign.length + val.length;
      if (width > totalLen) {
        const padLen = width - totalLen;
        if (flagMinus) result += sign + val + ' '.repeat(padLen);
        else if (flagZero) result += sign + '0'.repeat(padLen) + val;
        else result += ' '.repeat(padLen) + sign + val;
      } else {
        result += sign + val;
      }
    }

    // Write result to lpOutput
    emu.memory.writeCString(lpOutput, result);
    console.log(`[WIN16] wsprintf → "${result}"`);
    return result.length;
  }, 420);

  // ───────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 421: wvsprintf(lpOutput, lpFormat, lpArgList) — 12 bytes
  // Like wsprintf but takes a far pointer to the varargs instead of inline args
  // ───────────────────────────────────────────────────────────────────────────
  user.register('wvsprintf', 12, () => {
    const [lpOutputFar, lpFormatFar, lpArgListFar] = emu.readPascalArgs16([4, 4, 4]);
    const lpOutput = emu.resolveFarPtr(lpOutputFar);
    const lpFormat = emu.resolveFarPtr(lpFormatFar);
    const argBase = emu.resolveFarPtr(lpArgListFar);
    const fmt = emu.memory.readCString(lpFormat);

    let argOff = 0;
    let result = '';
    let fi = 0;

    const read16 = (): number => { const v = emu.memory.readU16(argBase + argOff); argOff += 2; return v; };
    const read32 = (): number => { const v = emu.memory.readU16(argBase + argOff) | (emu.memory.readU16(argBase + argOff + 2) << 16); argOff += 4; return v; };

    while (fi < fmt.length) {
      if (fmt[fi] !== '%' || fi + 1 >= fmt.length) { result += fmt[fi++]; continue; }
      fi++;

      let flagMinus = false, flagZero = false, flagPlus = false, flagSpace = false, flagHash = false;
      for (;;) {
        const ch = fmt[fi];
        if (ch === '-') flagMinus = true;
        else if (ch === '+') flagPlus = true;
        else if (ch === '0') flagZero = true;
        else if (ch === ' ') flagSpace = true;
        else if (ch === '#') flagHash = true;
        else break;
        fi++;
      }

      let width = 0;
      while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
        width = width * 10 + (fmt.charCodeAt(fi) - 48); fi++;
      }

      let precision = -1;
      if (fi < fmt.length && fmt[fi] === '.') {
        fi++; precision = 0;
        while (fi < fmt.length && fmt[fi] >= '0' && fmt[fi] <= '9') {
          precision = precision * 10 + (fmt.charCodeAt(fi) - 48); fi++;
        }
      }

      let isLong = false;
      if (fi < fmt.length && fmt[fi] === 'l') { isLong = true; fi++; }
      else if (fi < fmt.length && fmt[fi] === 'h') { fi++; }

      if (fi >= fmt.length) break;
      const spec = fmt[fi++];
      if (spec === '%') { result += '%'; continue; }

      let val = '', isNeg = false;
      switch (spec) {
        case 'd': case 'i': {
          if (isLong) { const n = read32() | 0; isNeg = n < 0; val = Math.abs(n).toString(); }
          else { const n = (read16() << 16) >> 16; isNeg = n < 0; val = Math.abs(n).toString(); }
          break;
        }
        case 'u': val = (isLong ? read32() >>> 0 : read16()).toString(); break;
        case 'x': case 'X': {
          const n = isLong ? read32() >>> 0 : read16();
          val = n.toString(16); if (spec === 'X') val = val.toUpperCase();
          if (flagHash && n !== 0) val = (spec === 'X' ? '0X' : '0x') + val;
          break;
        }
        case 's': {
          const ptr = emu.resolveFarPtr(read32());
          val = ptr ? emu.memory.readCString(ptr) : '(null)';
          if (precision >= 0 && val.length > precision) val = val.slice(0, precision);
          break;
        }
        case 'c': val = String.fromCharCode(read16() & 0xFF); break;
        default: result += '%' + spec; continue;
      }

      let sign = '';
      if ((spec === 'd' || spec === 'i') && isNeg) sign = '-';
      else if ((spec === 'd' || spec === 'i') && flagPlus) sign = '+';
      else if ((spec === 'd' || spec === 'i') && flagSpace) sign = ' ';

      const totalLen = sign.length + val.length;
      if (width > totalLen) {
        const padLen = width - totalLen;
        if (flagMinus) result += sign + val + ' '.repeat(padLen);
        else if (flagZero) result += sign + '0'.repeat(padLen) + val;
        else result += ' '.repeat(padLen) + sign + val;
      } else {
        result += sign + val;
      }
    }

    emu.memory.writeCString(lpOutput, result);
    console.log(`[WIN16] wvsprintf → "${result}"`);
    return result.length;
  }, 421);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 430: lstrcmp(s1, s2) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('lstrcmp', 8, () => {
    const [s1, s2] = emu.readPascalArgs16([4, 4]);
    if (!s1 || !s2) return 0;
    let i = 0;
    while (true) {
      const c1 = emu.memory.readU8(s1 + i);
      const c2 = emu.memory.readU8(s2 + i);
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i++;
    }
  }, 430);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 431: AnsiUpper(lpStr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AnsiUpper', 4, () => {
    const lpStr = emu.readArg16DWord(0);
    if ((lpStr & 0xFFFF0000) === 0) {
      const ch = lpStr & 0xFF;
      return (ch >= 0x61 && ch <= 0x7A) ? ch - 0x20 : ch;
    }
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(lpStr + i);
      if (ch === 0) break;
      if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU8(lpStr + i, ch - 0x20);
      i++;
    }
    return lpStr;
  }, 431);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 471: lstrcmpi(s1, s2) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('lstrcmpi', 8, () => {
    const [s1Raw, s2Raw] = emu.readPascalArgs16([4, 4]);
    const s1 = emu.resolveFarPtr(s1Raw);
    const s2 = emu.resolveFarPtr(s2Raw);
    if (!s1 || !s2) return 0;
    let i = 0;
    while (true) {
      let c1 = emu.memory.readU8(s1 + i);
      let c2 = emu.memory.readU8(s2 + i);
      if (c1 >= 0x61 && c1 <= 0x7A) c1 -= 0x20;
      if (c2 >= 0x61 && c2 <= 0x7A) c2 -= 0x20;
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i++;
    }
  }, 471);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 472: AnsiNext(lpCurrentChar) — 4 bytes (segptr)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AnsiNext', 4, () => {
    const raw = emu.readPascalArgs16([4])[0];
    if (!raw) return 0;
    const linear = emu.resolveFarPtr(raw);
    // Advance past current char; if NUL, stay at NUL
    if (emu.memory.readU8(linear) === 0) return raw;
    // Increment offset portion of seg:off
    return ((raw & 0xFFFF0000) | ((raw + 1) & 0xFFFF)) >>> 0;
  }, 472);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 473: AnsiPrev(lpStart, lpCurrent) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AnsiPrev', 8, () => {
    const [lpStart, lpCurrent] = emu.readPascalArgs16([4, 4]);
    if (!lpStart || !lpCurrent || lpCurrent <= lpStart) return lpStart;
    // Decrement offset portion of seg:off
    return ((lpCurrent & 0xFFFF0000) | ((lpCurrent - 1) & 0xFFFF)) >>> 0;
  }, 473);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 483: SystemParametersInfo(uAction, uParam, lpvParam, fuWinIni) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SystemParametersInfo', 10, () => {
    const [uAction, uParam, lpvParam] = emu.readPascalArgs16([2, 2, 4]);
    // SPI_GETWORKAREA = 48
    if (uAction === 48 && lpvParam) {
      h.writeRect(lpvParam, 0, 0, 640, 480);
    }
    return 1;
  }, 483);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 145: RegisterClipboardFormat(lpFormatName: ptr) → UINT
  // Returns an atom value ≥ 0xC000 for the named clipboard format.
  // ───────────────────────────────────────────────────────────────────────────
  const clipboardFormatMap = new Map<string, number>();
  let nextClipboardAtom = 0xC000;
  user.register('RegisterClipboardFormat', 4, () => {
    const [lpFormatName] = emu.readPascalArgs16([4]);
    const name = lpFormatName ? emu.memory.readCString(lpFormatName) : '';
    if (!name) return 0;
    const key = name.toUpperCase();
    if (!clipboardFormatMap.has(key)) clipboardFormatMap.set(key, nextClipboardAtom++);
    return clipboardFormatMap.get(key)!;
  }, 145);

  // Ordinal 17: GetCursorPos(lpPoint) — 4 bytes (ptr)
  user.register('GetCursorPos', 4, () => {
    const lpPoint = emu.readArg16DWord(0);
    if (lpPoint) {
      emu.memory.writeU16(lpPoint, 0);     // x
      emu.memory.writeU16(lpPoint + 2, 0); // y
    }
    return 1;
  }, 17);

  // Ordinal 21: GetDoubleClickTime() — 0 bytes
  user.register('GetDoubleClickTime', 0, () => 500, 21);

  // Ordinal 23: GetFocus() — 0 bytes
  user.register('GetFocus', 0, () => emu.focusedWindow || 0, 23);

  // Ordinal 30: WindowFromPoint(pt) — 4 bytes (long = POINT packed)
  user.register('WindowFromPoint', 4, () => emu.mainWindow || 0, 30);

  // Ordinal 35: IsWindowEnabled(hWnd) — 2 bytes
  user.register('IsWindowEnabled', 2, () => 1, 35);

  // Ordinal 37: SetWindowText(hWnd, lpString) — 6 bytes (2+4)
  user.register('SetWindowText', 6, () => {
    const [hWnd, lpStringRaw] = emu.readPascalArgs16([2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const lpString = emu.resolveFarPtr(lpStringRaw);
    const text = lpString ? emu.memory.readCString(lpString) : '';
    if (wnd) {
      wnd.title = text;
      if (wnd.domInput) wnd.domInput.value = text;
      emu.notifyControlOverlays();
    }
    return 0;
  }, 37);

  // Ordinal 36: GetWindowText(hWnd, lpString, nMaxCount) — 8 bytes (2+4+2)
  user.register('GetWindowText', 8, () => {
    const [hWnd, lpString, nMaxCount] = emu.readPascalArgs16([2, 4, 2]);
    const win = emu.handles.get<WindowInfo>(hWnd);
    const title = win?.title || '';
    if (lpString && nMaxCount > 0) {
      for (let i = 0; i < Math.min(title.length, nMaxCount - 1); i++) {
        emu.memory.writeU8(lpString + i, title.charCodeAt(i) & 0xFF);
      }
      emu.memory.writeU8(lpString + Math.min(title.length, nMaxCount - 1), 0);
    }
    return title.length;
  }, 36);

  // Ordinal 60: GetActiveWindow() — 0 bytes
  user.register('GetActiveWindow', 0, () => emu.mainWindow || 0, 60);

  // Ordinal 63: GetScrollPos(hWnd, nBar) — 4 bytes
  user.register('GetScrollPos', 4, () => 0, 63);

  // Ordinal 75: IsRectEmpty(lpRect) — 4 bytes (ptr)
  user.register('IsRectEmpty', 4, () => {
    const lpRect = emu.readArg16DWord(0);
    if (!lpRect) return 1;
    const l = emu.memory.readI16(lpRect);
    const t = emu.memory.readI16(lpRect + 2);
    const r = emu.memory.readI16(lpRect + 4);
    const b = emu.memory.readI16(lpRect + 6);
    return (l >= r || t >= b) ? 1 : 0;
  }, 75);

  // Ordinal 89: CreateDialog(hInst, lpTemplate, hWndParent, lpDialogFunc) — 12 bytes (2+4+2+4)
  user.register('CreateDialog', 12, () => 0); // stub: return NULL

  // Ordinal 112: WaitMessage() — 0 bytes
  user.register('WaitMessage', 0, () => { emu.waitingForMessage = true; return undefined; }, 112);

  // Ordinal 121: SetWindowsHook(nFilterType, pfnFilterProc) — 6 bytes (2+4)
  user.register('SetWindowsHook', 6, () => 0, 121);

  // Ordinal 122: CallWindowProc(lpPrevWndFunc, hWnd, Msg, wParam, lParam) — 14 bytes (4+2+2+2+4)
  user.register('CallWindowProc', 14, () => {
    const [lpPrevWndFunc, hWnd, msg, wParam, lParam] = emu.readPascalArgs16([4, 2, 2, 2, 4]);
    const resolved = emu.resolveFarPtr(lpPrevWndFunc);
    console.log(`[WIN16] CallWindowProc(0x${lpPrevWndFunc.toString(16)}→0x${resolved.toString(16)}, hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)}, wP=0x${wParam.toString(16)}, lP=0x${lParam.toString(16)})`);
    if (resolved) {
      const result = emu.callWndProc16(resolved, hWnd, msg, wParam, lParam);
      console.log(`[WIN16] CallWindowProc result=0x${(result??0).toString(16)}`);
      return result;
    }
    return 0;
  }, 122);

  // Ordinal 129: GetClassWord(hWnd, nIndex) — 4 bytes (2+2)
  user.register('GetClassWord', 4, () => 0, 129);

  // Ordinal 131: GetClassLong(hWnd, nIndex) — 4 bytes (2+2)
  user.register('GetClassLong', 4, () => 0, 131);

  // Ordinal 134: SetWindowWord(hWnd, nIndex, wNewWord) — 6 bytes (2+2+2)
  user.register('SetWindowWord', 6, () => 0, 134);

  // Ordinal 137: OpenClipboard(hWnd) — 2 bytes
  user.register('OpenClipboard', 2, () => 1, 137);

  // Ordinal 138: CloseClipboard() — 0 bytes
  user.register('CloseClipboard', 0, () => 1, 138);

  // Ordinal 139: EmptyClipboard() — 0 bytes
  user.register('EmptyClipboard', 0, () => 1, 139);

  // Ordinal 141: SetClipboardData(uFormat, hMem) — 4 bytes
  user.register('SetClipboardData', 4, () => emu.readArg16(2), 141); // return handle

  // Ordinal 142: GetClipboardData(uFormat) — 2 bytes
  user.register('GetClipboardData', 2, () => 0, 142);

  // Ordinal 152: DestroyMenu(hMenu) — 2 bytes
  user.register('DestroyMenu', 2, () => 1, 152);

  // Ordinal 156: GetSystemMenu(hWnd, bRevert) — 4 bytes
  user.register('GetSystemMenu', 4, () => 0, 156);

  // Ordinal 161: GetMenuString(hMenu, uIDItem, lpString, nMaxCount, uFlag) — 12 bytes (2+2+4+2+2)
  user.register('GetMenuString', 12, () => 0, 161);

  // Ordinal 165: SetCaretPos(x, y) — 4 bytes
  user.register('SetCaretPos', 4, () => 0, 165);

  // Ordinal 183: GetCaretPos(lpPoint) — 4 bytes (ptr)
  user.register('GetCaretPos', 4, () => {
    const lpPoint = emu.readArg16DWord(0);
    if (lpPoint) {
      emu.memory.writeU16(lpPoint, 0);
      emu.memory.writeU16(lpPoint + 2, 0);
    }
    return 0;
  }, 183);

  // Ordinal 187: EndMenu() — 0 bytes
  user.register('EndMenu', 0, () => 0, 187);

  // Ordinal 193: IsClipboardFormatAvailable() — 0 bytes
  user.register('IsClipboardFormatAvailable', 0, () => 0, 193);

  // Ordinal 196: TabbedTextOut(hDC, x, y, lpStr, nCount, nTabPositions, lpnTabStopPositions, nTabOrigin) — 20 bytes
  user.register('TabbedTextOut', 20, () => 0, 196);

  // Ordinal 197: GetTabbedTextExtent(hDC, lpStr, nCount, nTabPositions, lpnTabStopPositions) — 14 bytes (2+4+2+2+4)
  user.register('GetTabbedTextExtent', 14, () => 0, 197);

  // Ordinal 222: GetKeyboardState(lpKeyState) — 4 bytes
  user.register('GetKeyboardState', 4, () => 0, 222);

  // Ordinal 223: SetKeyboardState(lpKeyState) — 4 bytes
  user.register('SetKeyboardState', 4, () => 0, 223);

  // Ordinal 224: GetWindowTask(hWnd) — 2 bytes
  user.register('GetWindowTask', 2, () => 1, 224); // return a pseudo task handle

  // Ordinal 237: GetUpdateRgn(hWnd, hRgn, bErase) — 6 bytes
  user.register('GetUpdateRgn', 6, () => 1); // NULLREGION

  // Ordinal 250: GetMenuState(hMenu, uId, uFlags) — 6 bytes
  user.register('GetMenuState', 6, () => 0xFFFFFFFF, 250); // -1 = menu item doesn't exist

  // Ordinal 264: GetMenuItemID(hMenu, nPos) — 4 bytes
  user.register('GetMenuItemID', 4, () => 0xFFFF, 264); // -1

  // Ordinal 272: IsZoomed(hWnd) — 2 bytes
  user.register('IsZoomed', 2, () => 0, 272);

  // Ordinal 282: SelectPalette(hDC, hPal, bForceBackground) — 6 bytes
  user.register('SelectPalette', 6, () => 0, 282);

  // Ordinal 283: RealizePalette(hDC) — 2 bytes
  user.register('RealizePalette', 2, () => 0, 283);

  // Ordinal 407: CreateIcon(hInst, nWidth, nHeight, nPlanes, nBitsPixel, lpANDbits, lpXORbits) — 18 bytes (2+2+2+2+2+4+4)
  user.register('CreateIcon', 18, () => 0, 407);

  // Ordinal 414: ModifyMenu(hMenu, uPosition, uFlags, uIDNewItem, lpNewItem) — 12 bytes (2+2+2+2+4)
  user.register('ModifyMenu', 12, () => 1, 414);

  // Ordinal 416: TrackPopupMenu(hMenu, uFlags, x, y, nReserved, hWnd, lpRect) — 18 bytes (2+2+2+2+2+2+4)
  user.register('TrackPopupMenu', 18, () => 0, 416);

  // Ordinal 432: AnsiLower(lpStr) — 4 bytes (segstr)
  user.register('AnsiLower', 4, () => {
    const lpStr = emu.readArg16DWord(0);
    if ((lpStr & 0xFFFF0000) === 0) {
      const ch = lpStr & 0xFF;
      return (ch >= 0x41 && ch <= 0x5A) ? ch + 0x20 : ch;
    }
    let i = 0;
    while (true) {
      const ch = emu.memory.readU8(lpStr + i);
      if (ch === 0) break;
      if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU8(lpStr + i, ch + 0x20);
      i++;
    }
    return lpStr;
  }, 432);

  // Ordinal 433: IsCharAlpha(ch) — 2 bytes
  user.register('IsCharAlpha', 2, () => {
    const ch = emu.readArg16(0) & 0xFF;
    return ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  }, 433);

  // Ordinal 434: IsCharAlphaNumeric(ch) — 2 bytes
  user.register('IsCharAlphaNumeric', 2, () => {
    const ch = emu.readArg16(0) & 0xFF;
    return ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  }, 434);

  // Ordinal 437: AnsiUpperBuff(lpStr, uLength) — 6 bytes (4+2)
  user.register('AnsiUpperBuff', 6, () => {
    const [lpStr, uLength] = emu.readPascalArgs16([4, 2]);
    if (lpStr) {
      for (let i = 0; i < uLength; i++) {
        const ch = emu.memory.readU8(lpStr + i);
        if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU8(lpStr + i, ch - 0x20);
      }
    }
    return uLength;
  }, 437);

  // Ordinal 438: AnsiLowerBuff(lpStr, uLength) — 6 bytes (4+2)
  user.register('AnsiLowerBuff', 6, () => {
    const [lpStr, uLength] = emu.readPascalArgs16([4, 2]);
    if (lpStr) {
      for (let i = 0; i < uLength; i++) {
        const ch = emu.memory.readU8(lpStr + i);
        if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU8(lpStr + i, ch + 0x20);
      }
    }
    return uLength;
  }, 438);

  // Ordinal 445: DefFrameProc(hWnd, hWndMDIClient, uMsg, wParam, lParam) — 12 bytes (2+2+2+2+4)
  user.register('DefFrameProc', 12, () => 0, 445);

  // Ordinal 447: DefMDIChildProc(hWnd, uMsg, wParam, lParam) — 10 bytes (2+2+2+4)
  user.register('DefMDIChildProc', 10, () => 0, 447);

  // Ordinal 451: TranslateMDISysAccel(hWndClient, lpMsg) — 6 bytes (2+4)
  user.register('TranslateMDISysAccel', 6, () => 0, 451);

  // Ordinal 458: DestroyCursor(hCursor) — 2 bytes
  user.register('DestroyCursor', 2, () => 1, 458);

  // Ordinal 466: DrawFocusRect(hWnd, pt) — 6 bytes (2+4)
  user.register('DrawFocusRect', 6, () => 0, 466);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 116: PostAppMessage(hTask, msg, wParam, lParam) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('PostAppMessage', 10, () => 1, 116); // stub: always succeed

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 241: CreateDialogParam(hInst, lpTemplate, hWndParent, dlgFunc, dwInitParam) — 14 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreateDialogParam', 14, () => 0); // stub: return NULL (dialog not created)

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 308: DefDlgProc(hDlg, msg, wParam, lParam) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DefDlgProc', 10, () => 0, 308); // stub: return 0

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 608: GetForegroundWindow() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetForegroundWindow', 0, () => emu.mainWindow, 608);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 512: WNetGetConnection(lpLocalName, lpRemoteName, lpcbRemoteName) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  const WN_NOT_CONNECTED = 0x30;
  user.register('WNetGetConnection', 12, () => WN_NOT_CONNECTED, 512);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 513: WNetGetCaps(nIndex) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('WNetGetCaps', 2, () => 0, 513); // no network capabilities

  // --- Commonly needed stubs for Win16 programs (WNet, caret, misc) ---

  // OldExitWindows() — 0 bytes
  user.register('OldExitWindows', 0, () => 0, 2);

  // ExitWindows(dwReturnCode, wReserved) — 6 bytes
  user.register('ExitWindows', 6, () => 0, 7);

  // SetSystemTimer(hWnd, nIDEvent, uElapse, lpTimerFunc) — 10 bytes
  user.register('SetSystemTimer', 10, () => {
    // Reuse SetTimer logic: just return a non-zero timer ID
    return emu.readArg16(2) || 1;
  }, 11);

  // GetTimerResolution() — 0 bytes
  user.register('GetTimerResolution', 0, () => 1000, 14);

  // ClipCursor(lpRect) — 4 bytes
  user.register('ClipCursor', 4, () => 0, 16);

  // SetDoubleClickTime(uInterval) — 2 bytes
  user.register('SetDoubleClickTime', 2, () => 0, 20);

  // RemoveProp(hWnd, lpString) — 6 bytes
  user.register('RemoveProp', 6, () => 0, 24);

  // GetProp(hWnd, lpString) — 6 bytes
  user.register('GetProp', 6, () => 0, 25);

  // SetProp(hWnd, lpString, hData) — 8 bytes
  user.register('SetProp', 8, () => 1, 26);

  // EnumProps(hWnd, lpEnumFunc) — 6 bytes
  user.register('EnumProps', 6, () => -1, 27);

  // AnyPopup() — 0 bytes
  user.register('AnyPopup', 0, () => 0, 52);

  // EnumWindows(lpEnumFunc, lParam) — 8 bytes
  user.register('EnumWindows', 8, () => 1, 54);

  // EnumChildWindows(hWndParent, lpEnumFunc, lParam) — 10 bytes
  user.register('EnumChildWindows', 10, () => 1, 55);

  // GetScrollRange(hWnd, nBar, lpMinPos, lpMaxPos) — 12 bytes
  user.register('GetScrollRange', 12, () => {
    const lpMinPos = emu.readArg16FarPtr(6);
    const lpMaxPos = emu.readArg16FarPtr(10);
    if (lpMinPos) emu.memory.writeU16(lpMinPos, 0);
    if (lpMaxPos) emu.memory.writeU16(lpMaxPos, 0);
    return 0;
  }, 65);

  // GetWindowDC(hWnd) — 2 bytes
  user.register('GetWindowDC', 2, () => {
    // Return same as GetDC
    const hWnd = emu.readArg16(0);
    return emu.windowDCs.get(hWnd) || 0;
  }, 67);

  // SetRectEmpty(lpRect) — 4 bytes
  user.register('SetRectEmpty', 4, () => {
    const lpRect = emu.readArg16FarPtr(0);
    if (lpRect) {
      emu.memory.writeU16(lpRect, 0);
      emu.memory.writeU16(lpRect + 2, 0);
      emu.memory.writeU16(lpRect + 4, 0);
      emu.memory.writeU16(lpRect + 6, 0);
    }
    return 1;
  }, 73);

  // IconSize() — 0 bytes (returns DWORD: width in low, height in high)
  user.register('IconSize', 0, () => (32 << 16) | 32, 86);

  // DlgDirSelect(hDlg, lpString, nIDListBox) — 8 bytes
  user.register('DlgDirSelect', 8, () => {
    const [hDlg, lpString, nIDListBox] = emu.readPascalArgs16([2, 4, 2]);
    const outAddr = emu.resolveFarPtr(lpString);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const lbHwnd = dlgWnd?.children?.get(nIDListBox);
    const lbWnd = lbHwnd ? emu.handles.get<WindowInfo>(lbHwnd) : null;
    const sel = lbWnd?.lbSelectedIndex ?? 0;
    const items = lbWnd?.lbItems || [];
    const item = items[sel] || '';
    // DlgDirSelect strips brackets: [-c-] → c:, [dirname] → dirname
    let result = item;
    let isDrive = false;
    if (item.startsWith('[-') && item.endsWith('-]')) {
      result = item.substring(2, item.length - 2) + ':';
      isDrive = true;
    } else if (item.startsWith('[') && item.endsWith(']')) {
      result = item.substring(1, item.length - 1);
    }
    if (outAddr) {
      for (let i = 0; i < result.length; i++) {
        emu.memory.writeU8(outAddr + i, result.charCodeAt(i));
      }
      emu.memory.writeU8(outAddr + result.length, 0);
    }
    return isDrive ? 1 : 0;
  }, 99);

  // DlgDirList(hDlg, lpPathSpec, nIDListBox, nIDStaticPath, uFileType) — 12 bytes
  user.register('DlgDirList', 12, () => {
    const [hDlg, lpPathSpec, nIDListBox, nIDStaticPath, uFileType] = emu.readPascalArgs16([2, 4, 2, 2, 2]);
    const DDL_DIRECTORY = 0x0010;
    const DDL_DRIVES = 0x4000;
    const DDL_EXCLUSIVE = 0x8000;

    const pathSpecAddr = emu.resolveFarPtr(lpPathSpec);
    const pathSpec = pathSpecAddr ? emu.memory.readCString(pathSpecAddr) : '*.*';
    console.log(`[WIN16] DlgDirList hDlg=0x${hDlg.toString(16)} pathSpec="${pathSpec}" listBox=${nIDListBox} static=${nIDStaticPath} type=0x${uFileType.toString(16)}`);

    // Find the listbox child
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const lbHwnd = dlgWnd?.children?.get(nIDListBox);
    const lbWnd = lbHwnd ? emu.handles.get<WindowInfo>(lbHwnd) : null;

    if (lbWnd) {
      lbWnd.lbItems = [];
      lbWnd.lbItemData = [];

      const exclusive = !!(uFileType & DDL_EXCLUSIVE);

      // Add file/directory entries unless DDL_EXCLUSIVE with only DDL_DRIVES
      if (!exclusive || !(uFileType & DDL_DRIVES)) {
        const entries = emu.fs.getVirtualDirListing(
          emu.resolvePath(pathSpec), emu.additionalFiles);
        for (const entry of entries) {
          if (entry.isDir && (uFileType & DDL_DIRECTORY)) {
            lbWnd.lbItems.push(`[${entry.name.toLowerCase()}]`);
            lbWnd.lbItemData!.push(0);
          } else if (!entry.isDir) {
            lbWnd.lbItems.push(entry.name.toLowerCase());
            lbWnd.lbItemData!.push(0);
          }
        }
      }

      // Add drive entries
      if (uFileType & DDL_DRIVES) {
        lbWnd.lbItems.push('[-c-]');
        lbWnd.lbItemData!.push(0);
      }
    }

    // Set static control text to current directory
    if (nIDStaticPath && dlgWnd) {
      const staticHwnd = dlgWnd.children?.get(nIDStaticPath);
      const staticWnd = staticHwnd ? emu.handles.get<WindowInfo>(staticHwnd) : null;
      if (staticWnd) {
        staticWnd.title = emu.currentDirs.get(emu.currentDrive) || 'C:\\';
      }
    }

    // Update pathSpec buffer to just the filename pattern
    if (pathSpecAddr) {
      const lastSlash = pathSpec.lastIndexOf('\\');
      const pattern = lastSlash >= 0 ? pathSpec.substring(lastSlash + 1) : pathSpec;
      for (let i = 0; i < pattern.length; i++) {
        emu.memory.writeU8(pathSpecAddr + i, pattern.charCodeAt(i));
      }
      emu.memory.writeU8(pathSpecAddr + pattern.length, 0);
    }

    return 1;
  }, 100);

  // MapDialogRect(hDlg, lpRect) — 6 bytes
  user.register('MapDialogRect', 6, () => 1, 103);

  // FlashWindow(hWnd, bInvert) — 4 bytes
  user.register('FlashWindow', 4, () => 0, 105);

  // WindowFromDC(hDC) — 2 bytes
  user.register('WindowFromDC', 2, () => emu.mainWindow || 0, 117);

  // CallMsgFilter(lpMsg, nCode) — 6 bytes
  user.register('CallMsgFilter', 6, () => 0, 123);

  // InvalidateRgn(hWnd, hRgn, bErase) — 6 bytes
  user.register('InvalidateRgn', 6, () => 1, 126);

  // ValidateRgn(hWnd, hRgn) — 4 bytes
  user.register('ValidateRgn', 4, () => 1, 128);

  // SetClassWord(hWnd, nIndex, wNewWord) — 6 bytes
  user.register('SetClassWord', 6, () => 0, 130);

  // SetClassLong(hWnd, nIndex, dwNewLong) — 8 bytes
  user.register('SetClassLong', 8, () => 0, 132);

  // GetClipboardOwner() — 0 bytes
  user.register('GetClipboardOwner', 0, () => 0, 140);

  // CountClipboardFormats() — 0 bytes
  user.register('CountClipboardFormats', 0, () => 0, 143);

  // EnumClipboardFormats(format) — 2 bytes
  user.register('EnumClipboardFormats', 2, () => 0, 144);

  // GetClipboardFormatName(format, lpszFormatName, cchMaxCount) — 8 bytes
  user.register('GetClipboardFormatName', 8, () => 0, 146);

  // SetClipboardViewer(hWndNewViewer) — 2 bytes
  user.register('SetClipboardViewer', 2, () => 0, 147);

  // GetClipboardViewer() — 0 bytes
  user.register('GetClipboardViewer', 0, () => 0, 148);

  // ChangeClipboardChain(hWndRemove, hWndNewNext) — 4 bytes
  user.register('ChangeClipboardChain', 4, () => 0, 149);

  // ChangeMenu(hMenu, cmdID, lpszNewItem, cmdIDNewItem, flags) — 14 bytes
  user.register('ChangeMenu', 14, () => 1, 153);

  // HiliteMenuItem(hWnd, hMenu, uIDHiliteItem, uHilite) — 8 bytes
  user.register('HiliteMenuItem', 8, () => 0, 162);

  // CreateCaret(hWnd, hBitmap, nWidth, nHeight) — 8 bytes
  user.register('CreateCaret', 8, () => 0, 163);

  // DestroyCaret() — 0 bytes
  user.register('DestroyCaret', 0, () => 0, 164);

  // HideCaret(hWnd) — 2 bytes
  user.register('HideCaret', 2, () => 0, 166);

  // ShowCaret(hWnd) — 2 bytes
  user.register('ShowCaret', 2, () => 0, 167);

  // SetCaretBlinkTime(uMSeconds) — 2 bytes
  user.register('SetCaretBlinkTime', 2, () => 0, 168);

  // GetCaretBlinkTime() — 0 bytes
  user.register('GetCaretBlinkTime', 0, () => 530, 169);

  // ArrangeIconicWindows(hWnd) — 2 bytes
  user.register('ArrangeIconicWindows', 2, () => 0, 170);

  // SwitchToThisWindow(hWnd, fAltTab) — 4 bytes
  user.register('SwitchToThisWindow', 4, () => 0, 172);

  // KillSystemTimer(hWnd, uIDEvent) — 4 bytes
  user.register('KillSystemTimer', 4, () => 1, 182);

  // SwapMouseButton(fSwap) — 2 bytes
  user.register('SwapMouseButton', 2, () => 0, 186);

  // SetSysModalWindow(hWnd) — 2 bytes
  user.register('SetSysModalWindow', 2, () => 0, 188);

  // GetSysModalWindow() — 0 bytes
  user.register('GetSysModalWindow', 0, () => 0, 189);

  // GetUpdateRect(hWnd, lpRect, bErase) — 8 bytes
  user.register('GetUpdateRect', 8, () => 0, 190);

  // ChildWindowFromPoint(hWndParent, pt) — 6 bytes
  user.register('ChildWindowFromPoint', 6, () => 0, 191);

  // InSendMessage() — 0 bytes
  user.register('InSendMessage', 0, () => 0, 192);

  // DlgDirSelectComboBox(hDlg, lpString, nIDComboBox) — 8 bytes
  user.register('DlgDirSelectComboBox', 8, () => {
    const [hDlg, lpString, nIDComboBox] = emu.readPascalArgs16([2, 4, 2]);
    const outAddr = emu.resolveFarPtr(lpString);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const cbHwnd = dlgWnd?.children?.get(nIDComboBox);
    const cbWnd = cbHwnd ? emu.handles.get<WindowInfo>(cbHwnd) : null;
    const sel = cbWnd?.cbSelectedIndex ?? cbWnd?.lbSelectedIndex ?? 0;
    const items = cbWnd?.cbItems || cbWnd?.lbItems || [];
    const item = items[sel] || '';
    let result = item;
    let isDrive = false;
    if (item.startsWith('[-') && item.endsWith('-]')) {
      result = item.substring(2, item.length - 2) + ':';
      isDrive = true;
    } else if (item.startsWith('[') && item.endsWith(']')) {
      result = item.substring(1, item.length - 1);
    }
    if (outAddr) {
      for (let i = 0; i < result.length; i++) emu.memory.writeU8(outAddr + i, result.charCodeAt(i));
      emu.memory.writeU8(outAddr + result.length, 0);
    }
    return isDrive ? 1 : 0;
  }, 194);

  // DlgDirListComboBox(hDlg, lpPathSpec, nIDComboBox, nIDStaticPath, uFileType) — 12 bytes
  user.register('DlgDirListComboBox', 12, () => {
    const [hDlg, lpPathSpec, nIDComboBox, nIDStaticPath, uFileType] = emu.readPascalArgs16([2, 4, 2, 2, 2]);
    const DDL_DRIVES = 0x4000;
    const DDL_EXCLUSIVE = 0x8000;
    const DDL_DIRECTORY = 0x0010;

    const pathSpecAddr = emu.resolveFarPtr(lpPathSpec);
    const pathSpec = pathSpecAddr ? emu.memory.readCString(pathSpecAddr) : '*.*';
    console.log(`[WIN16] DlgDirListComboBox hDlg=0x${hDlg.toString(16)} pathSpec="${pathSpec}" comboBox=${nIDComboBox} type=0x${uFileType.toString(16)}`);

    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const cbHwnd = dlgWnd?.children?.get(nIDComboBox);
    const cbWnd = cbHwnd ? emu.handles.get<WindowInfo>(cbHwnd) : null;

    if (cbWnd) {
      cbWnd.lbItems = [];
      cbWnd.lbItemData = [];
      const exclusive = !!(uFileType & DDL_EXCLUSIVE);

      if (!exclusive || !(uFileType & DDL_DRIVES)) {
        const entries = emu.fs.getVirtualDirListing(
          emu.resolvePath(pathSpec), emu.additionalFiles);
        for (const entry of entries) {
          if (entry.isDir && (uFileType & DDL_DIRECTORY)) {
            cbWnd.lbItems.push(`[${entry.name.toLowerCase()}]`);
            cbWnd.lbItemData!.push(0);
          } else if (!entry.isDir) {
            cbWnd.lbItems.push(entry.name.toLowerCase());
            cbWnd.lbItemData!.push(0);
          }
        }
      }

      if (uFileType & DDL_DRIVES) {
        cbWnd.lbItems.push('[-c-]');
        cbWnd.lbItemData!.push(0);
      }
    }

    if (nIDStaticPath && dlgWnd) {
      const staticHwnd = dlgWnd.children?.get(nIDStaticPath);
      const staticWnd = staticHwnd ? emu.handles.get<WindowInfo>(staticHwnd) : null;
      if (staticWnd) {
        staticWnd.title = emu.currentDirs.get(emu.currentDrive) || 'C:\\';
      }
    }

    return 1;
  }, 195);

  // EnumTaskWindows(hTask, lpEnumFunc, lParam) — 8 bytes
  user.register('EnumTaskWindows', 8, () => 1, 225);

  // GetNextDlgGroupItem(hDlg, hCtl, bPrevious) — 6 bytes
  user.register('GetNextDlgGroupItem', 6, () => 0, 227);

  // GetSystemDebugState() — 0 bytes
  user.register('GetSystemDebugState', 0, () => 0, 231);

  // SetParent(hWndChild, hWndNewParent) — 4 bytes
  user.register('SetParent', 4, () => 0, 233);

  // GetDialogBaseUnits() — 0 bytes (DWORD: x in low, y in high)
  user.register('GetDialogBaseUnits', 0, () => (16 << 16) | 8, 243);

  // GetCursor() — 0 bytes
  user.register('GetCursor', 0, () => emu.currentCursor || 0, 247);

  // GetOpenClipboardWindow() — 0 bytes
  user.register('GetOpenClipboardWindow', 0, () => 0, 248);

  // GetAsyncKeyState(vKey) — 2 bytes
  user.register('GetAsyncKeyState', 2, () => 0, 249);

  // ShowOwnedPopups(hWnd, fShow) — 4 bytes
  user.register('ShowOwnedPopups', 4, () => 0, 265);

  // GetFreeSystemResources(fuSysResource) — 2 bytes
  user.register('GetFreeSystemResources', 2, () => 90, 284); // 90% free

  // GetDesktopWindow() — already have 286, also add alias for name
  // (286 is already registered as ord_286)

  // RedrawWindow(hWnd, lprcUpdate, hrgnUpdate, flags) — 10 bytes
  user.register('RedrawWindow', 10, () => 1, 290);

  // LockWindowUpdate(hWndLock) — 2 bytes
  user.register('LockWindowUpdate', 2, () => 1, 294);

  // GetClipCursor(lpRect) — 4 bytes
  user.register('GetClipCursor', 4, () => 0, 309);

  // GetWindowPlacement(hWnd, lpwndpl) — 6 bytes
  user.register('GetWindowPlacement', 6, () => 0, 370);

  // SetWindowPlacement(hWnd, lpwndpl) — 6 bytes
  user.register('SetWindowPlacement', 6, () => 1, 371);

  // SubtractRect(lprcDst, lprcSrc1, lprcSrc2) — 12 bytes
  user.register('SubtractRect', 12, () => 0, 373);

  // UnregisterClass(lpClassName, hInstance) — 6 bytes
  user.register('UnregisterClass', 6, () => 1, 403);

  // DrawFocusRect(hDC, lpRect) — 6 bytes (already registered as ord_466)
  // (466 is already registered)

  // SetScrollInfo(hWnd, nBar, lpScrollInfo, fRedraw) — 10 bytes
  user.register('SetScrollInfo', 10, () => 0, 475);

  // GetScrollInfo(hWnd, nBar, lpScrollInfo) — 8 bytes
  user.register('GetScrollInfo', 8, () => 0, 476);

  // EnableScrollBar(hWnd, wSBflags, wArrows) — 6 bytes
  user.register('EnableScrollBar', 6, () => 1, 482);

  // --- WNet stubs (all return WN_NOT_SUPPORTED = 0x01) ---
  const WN_NOT_SUPPORTED = 0x01;

  // WNetDeviceMode(hWnd) — 2 bytes
  user.register('WNetDeviceMode', 2, () => WN_NOT_SUPPORTED, 514);

  // WNetBrowseDialog(hWnd, wType, lpszPath) — 8 bytes
  user.register('WNetBrowseDialog', 8, () => WN_NOT_SUPPORTED, 515);

  // WNetGetUser(lpszUser, lpcchBuffer) — 8 bytes
  user.register('WNetGetUser', 8, () => WN_NOT_SUPPORTED, 516);

  // WNetAddConnection(lpszNetPath, lpszPassword, lpszLocalName) — 12 bytes
  user.register('WNetAddConnection', 12, () => WN_NOT_SUPPORTED, 517);

  // WNetCancelConnection(lpszName, fForce) — 6 bytes
  user.register('WNetCancelConnection', 6, () => WN_NOT_SUPPORTED, 518);

  // WNetGetError(lpError) — 4 bytes
  user.register('WNetGetError', 4, () => WN_NOT_SUPPORTED, 519);

  // WNetGetErrorText(nError, lpBuffer, lpcbBuffer) — 8 bytes
  user.register('WNetGetErrorText', 8, () => WN_NOT_SUPPORTED, 520);

  // WNetRestoreConnection(hWnd, lpszDevice) — 6 bytes
  user.register('WNetRestoreConnection', 6, () => WN_NOT_SUPPORTED, 523);

  // WNetConnectDialog(hWnd, wType) — 4 bytes
  user.register('WNetConnectDialog', 4, () => WN_NOT_SUPPORTED, 525);

  // WNetDisconnectDialog(hWnd, wType) — 4 bytes
  user.register('WNetDisconnectDialog', 4, () => WN_NOT_SUPPORTED, 526);

  // WNetConnectionDialog(hWnd, wType) — 4 bytes
  user.register('WNetConnectionDialog', 4, () => WN_NOT_SUPPORTED, 527);

  // WNetGetDirectoryType(lpszDir, lpnType) — 8 bytes
  user.register('WNetGetDirectoryType', 8, () => {
    // Write 0 (not a network directory) to the output pointer
    const lpnType = emu.readArg16FarPtr(4);
    if (lpnType) emu.memory.writeU16(lpnType, 0);
    return 0; // WN_SUCCESS
  }, 530);

  // WNetDirectoryNotify(hWnd, lpDir, wOper) — 8 bytes
  user.register('WNetDirectoryNotify', 8, () => 0, 531);

  // WNetGetPropertyText(iButton, nPropSel, lpszName, lpszButtonName, nButtonNameLen, nType) — 14 bytes
  user.register('WNetGetPropertyText', 14, () => WN_NOT_SUPPORTED, 532);

  // SetForegroundWindow(hWnd) — 2 bytes
  user.register('SetForegroundWindow', 2, () => 1, 609);

  // WNetErrorText(nError, lpBuffer, nBufferSize) — 8 bytes (word+ptr+word)
  user.register('WNetErrorText', 8, () => WN_NOT_SUPPORTED, 499);

  // WNetPropertyDialog(hwnd, iButton, nPropSel, lpszName, nType) — 12 bytes (word+word+word+ptr+word)
  user.register('WNetPropertyDialog', 12, () => WN_NOT_SUPPORTED, 529);

  // OpenDriver(lpDriverName, lpSectionName, lParam) — 12 bytes (ptr+ptr+long)
  user.register('OpenDriver', 12, () => 0, 252);

  // CloseDriver(hDriver, lParam1, lParam2) — 10 bytes (word+long+long)
  user.register('CloseDriver', 10, () => 0, 253);

  // GetMessageExtraInfo() — 0 bytes
  user.register('GetMessageExtraInfo', 0, () => 0, 288);

  // DragObject(hwndParent, hwndFrom, wFmt, dwData, hCursor, lpPt) — 16 bytes (word+word+word+long+word+long)
  user.register('DragObject', 16, () => 0, 464);
}
