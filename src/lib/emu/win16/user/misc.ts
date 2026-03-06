import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';

// Win16 USER module — Miscellaneous APIs

export function registerWin16UserMisc(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 1: MessageBox(hWnd, lpText_ptr, lpCaption_ptr, uType) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_1', 12, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 5: InitApp(hInstance) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_5', 2, () => emu.readArg16(0));

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 6: PostQuitMessage(exitCode) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_6', 2, () => {
    emu.postMessage(0, 0x0012, 0, 0); // WM_QUIT
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 10: SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc_segptr) — 10 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_10', 10, () => {
    const [hWnd, nIDEvent, uElapse, lpTimerFunc] = emu.readPascalArgs16([2, 2, 2, 4]);
    console.log(`[WIN16] SetTimer hwnd=0x${hWnd.toString(16)} id=${nIDEvent} elapse=${uElapse} timerFunc=0x${lpTimerFunc.toString(16)}`);
    // Clear existing timer with same ID
    emu.clearWin32Timer(hWnd, nIDEvent);
    const jsTimer = setInterval(() => {
      emu.postMessage(hWnd, 0x0113, nIDEvent, lpTimerFunc);
    }, uElapse);
    emu.setWin32Timer(hWnd, nIDEvent, jsTimer);
    return 1;
  });

  // Ordinal 12: KillTimer(hWnd, nIDEvent) — 4 bytes
  user.register('ord_12', 4, () => {
    const [hWnd, nIDEvent] = emu.readPascalArgs16([2, 2]);
    emu.clearWin32Timer(hWnd, nIDEvent);
    return 1;
  });

  // Ordinal 13: GetTickCount() — 0 bytes
  user.register('ord_13', 0, () => Date.now() & 0xFFFFFFFF);

  // Ordinal 15: GetCurrentTime() — 0 bytes
  user.register('ord_15', 0, () => Date.now() & 0xFFFFFFFF);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 18: SetCapture(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_18', 2, () => {
    const hWnd = emu.readArg16(0);
    emu.capturedWindow = hWnd;
    return hWnd;
  });

  // Ordinal 19: ReleaseCapture() — 0 bytes
  user.register('ord_19', 0, () => { emu.capturedWindow = 0; return 0; });

  // Ordinal 22: SetFocus(hWnd) — 2 bytes
  user.register('ord_22', 2, () => {
    const hWnd = emu.readArg16(0);
    const prev = emu.focusedWindow;
    emu.focusedWindow = hWnd;
    return prev;
  });

  // Ordinal 28: ClientToScreen(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ord_28', 6, () => 0);

  // Ordinal 29: ScreenToClient(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ord_29', 6, () => 0);

  // Ordinal 31: IsIconic(hWnd) — 2 bytes
  user.register('ord_31', 2, () => 0);

  // Ordinal 61: SetScrollPos(hWnd, nBar, nPos, bRedraw) — 8 bytes
  user.register('ord_61', 8, () => {
    const [hWnd, nBar, nPos] = emu.readPascalArgs16([2, 2, 2]);
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
  });

  // Ordinal 62: GetScrollPos(hWnd, nBar) — 4 bytes
  user.register('ord_62', 4, () => {
    const [hWnd, nBar] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const bar = nBar & 1;
    return wnd?.scrollInfo?.[bar]?.pos ?? 0;
  });

  // Ordinal 64: SetScrollRange(hWnd, nBar, nMinPos, nMaxPos, bRedraw) — 10 bytes
  user.register('ord_64', 10, () => {
    const [hWnd, nBar, nMinPos, nMaxPos] = emu.readPascalArgs16([2, 2, 2, 2]);
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
  });

  // Ordinal 69: SetCursor(hCursor) — 2 bytes
  user.register('ord_69', 2, () => {
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
  });

  // Ordinal 70: SetCursorPos(x, y) — 4 bytes
  user.register('ord_70', 4, () => 0);

  // Ordinal 71: ShowCursor(bShow) — 2 bytes
  user.register('ord_71', 2, () => 1);

  // Ordinal 93: GetScrollRange(hWnd, nBar, lpMinPos, lpMaxPos) — 10 bytes
  user.register('ord_93', 10, () => {
    const [hWnd, nBar, lpMinPos, lpMaxPos] = emu.readPascalArgs16([2, 2, 4, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const bar = nBar & 1;
    const info = wnd?.scrollInfo?.[bar];
    if (lpMinPos) emu.memory.writeU16(lpMinPos, (info?.min ?? 0) & 0xFFFF);
    if (lpMaxPos) emu.memory.writeU16(lpMaxPos, (info?.max ?? 0) & 0xFFFF);
    return 1;
  });

  // Ordinal 101: SendDlgItemMessage(hDlg, nIDDlgItem, wMsg, wParam, lParam) — 12 bytes (2+2+2+2+4)
  user.register('ord_101', 12, () => {
    const [hDlg, nIDDlgItem, wMsg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 2, 4]);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const childHwnd = dlgWnd?.children?.get(nIDDlgItem);
    const STM_SETICON = 0x0170;
    const WM_USER = 0x0400;
    if ((wMsg === STM_SETICON || wMsg === WM_USER) && childHwnd) {
      const child = emu.handles.get<WindowInfo>(childHwnd);
      if (child && wParam) {
        const icon = emu.handles.get<{ width?: number; height?: number }>(wParam);
        if (icon) {
          child.hImage = wParam;
          // Auto-size SS_ICON controls to icon dimensions
          if ((child.style & 0x1F) === 0x03 && child.width === 0 && child.height === 0) {
            child.width = icon.width ?? 32;
            child.height = icon.height ?? 32;
          }
        }
      }
      return wParam;
    }
    return 0;
  });

  // Ordinal 84: DrawIcon(hDC, x, y, hIcon) — 8 bytes (2+2+2+2)
  user.register('ord_84', 8, () => 1);

  // Ordinal 85: DrawText(hDC, lpString_ptr, nCount_sword, lpRect_ptr, uFormat) — 14 bytes
  user.register('ord_85', 14, () => 0);

  // Ordinal 104: MessageBeep(uType) — 2 bytes
  user.register('ord_104', 2, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 106: GetKeyState(nVirtKey) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_106', 2, () => 0);

  // Ordinal 171: WinHelp(hWndMain, lpszHelp_ptr, uCommand, dwData_long) — 12 bytes (2+4+2+4)
  user.register('ord_171', 12, () => 1);

  // Ordinal 178: TranslateAccelerator — 8 bytes
  user.register('ord_178', 8, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 179: GetSystemMetrics(nIndex) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_179', 2, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 180: GetSysColor(nIndex) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_180', 2, () => {
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
  });

  // Ordinal 181: SetSysColors(cElements, lpSysColor_ptr, lpColorValues_ptr) — 10 bytes (2+4+4)
  user.register('ord_181', 10, () => 1);

  // Ordinal 188: SetSysModalWindow(hWnd) — 2 bytes
  user.register('ord_188', 2, () => 0);

  // Ordinal 228: GetNextDlgTabItem — 6 bytes
  user.register('ord_228', 6, () => 0);

  // Ordinal 229: GetTopWindow — 2 bytes
  user.register('ord_229', 2, () => 0);

  // Ordinal 230: GetNextWindow — 4 bytes
  user.register('ord_230', 4, () => 0);

  // Ordinal 234: UnhookWindowsHook — 6 bytes
  user.register('ord_234', 6, () => 0);

  // Ordinal 235: DefHookProc — 12 bytes
  user.register('ord_235', 12, () => 0);

  // Ordinal 236: GetCapture() — 0 bytes
  user.register('ord_236', 0, () => 0);

  // Ordinal 267: ShowScrollBar — 6 bytes
  user.register('ord_267', 6, () => 0);

  // Ordinal 269: GlobalDeleteAtom — 2 bytes
  user.register('ord_269', 2, () => 0);

  // Ordinal 277: GetDlgCtrlID — 2 bytes
  user.register('ord_277', 2, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 278: GetDesktopHwnd() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_278', 0, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 286: GetDesktopWindow() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_286', 0, () => 0);

  // Ordinal 287: GetLastActivePopup(hWnd) — 2 bytes
  user.register('ord_287', 2, () => emu.readArg16(0));

  // Ordinal 291: SetWindowsHookEx(nFilterType, pfnFilterProc, hInstance, wThreadID) — 10 bytes
  user.register('ord_291', 10, () => {
    const [nFilterType, pfnFilterProc, _hInstance, _wThreadID] = emu.readPascalArgs16([2, 4, 2, 2]);
    const WH_CBT = 5;
    if (nFilterType === WH_CBT && pfnFilterProc) {
      emu.cbtHooks.push({ lpfn: pfnFilterProc, hMod: 0 });
    }
    return emu.handles.alloc('hook', { idHook: nFilterType, lpfn: pfnFilterProc });
  });

  // Ordinal 292: UnhookWindowsHookEx — 4 bytes
  user.register('ord_292', 4, () => 0);

  // Ordinal 293: CallNextHookEx — 12 bytes
  user.register('ord_293', 12, () => 0);

  // Ordinal 404: GetClassInfo(hInstance, className, lpWndClass) — 10 bytes (2+4+4)
  user.register('ord_404', 10, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 420: _wsprintf(lpOutput, lpFormat, ...) — varargs cdecl (stackBytes=0)
  // Win16 wsprintf: args on stack are 16-bit words unless %l prefix → 32-bit
  // %s → far pointer (32-bit), %d → 16-bit word, %ld → 32-bit long
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_420', 0, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 421: wvsprintf(lpOutput, lpFormat, lpArgList) — 12 bytes
  // Like wsprintf but takes a far pointer to the varargs instead of inline args
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_421', 12, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 430: lstrcmp(s1, s2) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_430', 8, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 431: AnsiUpper(lpStr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_431', 4, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 471: lstrcmpi(s1, s2) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_471', 8, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 472: AnsiNext(lpCurrentChar) — 4 bytes (segptr)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_472', 4, () => {
    const raw = emu.readPascalArgs16([4])[0];
    if (!raw) return 0;
    const linear = emu.resolveFarPtr(raw);
    // Advance past current char; if NUL, stay at NUL
    if (emu.memory.readU8(linear) === 0) return raw;
    // Increment offset portion of seg:off
    return ((raw & 0xFFFF0000) | ((raw + 1) & 0xFFFF)) >>> 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 473: AnsiPrev(lpStart, lpCurrent) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_473', 8, () => {
    const [lpStart, lpCurrent] = emu.readPascalArgs16([4, 4]);
    if (!lpStart || !lpCurrent || lpCurrent <= lpStart) return lpStart;
    // Decrement offset portion of seg:off
    return ((lpCurrent & 0xFFFF0000) | ((lpCurrent - 1) & 0xFFFF)) >>> 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 483: SystemParametersInfo(uAction, uParam, lpvParam, fuWinIni) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_483', 10, () => {
    const [uAction, uParam, lpvParam] = emu.readPascalArgs16([2, 2, 4]);
    // SPI_GETWORKAREA = 48
    if (uAction === 48 && lpvParam) {
      h.writeRect(lpvParam, 0, 0, 640, 480);
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 145: RegisterClipboardFormat(lpFormatName: ptr) → UINT
  // Returns an atom value ≥ 0xC000 for the named clipboard format.
  // ───────────────────────────────────────────────────────────────────────────
  const clipboardFormatMap = new Map<string, number>();
  let nextClipboardAtom = 0xC000;
  user.register('ord_145', 4, () => {
    const [lpFormatName] = emu.readPascalArgs16([4]);
    const name = lpFormatName ? emu.memory.readCString(lpFormatName) : '';
    if (!name) return 0;
    const key = name.toUpperCase();
    if (!clipboardFormatMap.has(key)) clipboardFormatMap.set(key, nextClipboardAtom++);
    return clipboardFormatMap.get(key)!;
  });

  // Ordinal 17: GetCursorPos(lpPoint) — 4 bytes (ptr)
  user.register('ord_17', 4, () => {
    const lpPoint = emu.readArg16DWord(0);
    if (lpPoint) {
      emu.memory.writeU16(lpPoint, 0);     // x
      emu.memory.writeU16(lpPoint + 2, 0); // y
    }
    return 1;
  });

  // Ordinal 21: GetDoubleClickTime() — 0 bytes
  user.register('ord_21', 0, () => 500);

  // Ordinal 23: GetFocus() — 0 bytes
  user.register('ord_23', 0, () => emu.focusedWindow || 0);

  // Ordinal 30: WindowFromPoint(pt) — 4 bytes (long = POINT packed)
  user.register('ord_30', 4, () => emu.mainWindow || 0);

  // Ordinal 35: IsWindowEnabled(hWnd) — 2 bytes
  user.register('ord_35', 2, () => 1);

  // Ordinal 36: GetWindowText(hWnd, lpString, nMaxCount) — 8 bytes (2+4+2)
  user.register('ord_36', 8, () => {
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
  });

  // Ordinal 60: GetActiveWindow() — 0 bytes
  user.register('ord_60', 0, () => emu.mainWindow || 0);

  // Ordinal 63: GetScrollPos(hWnd, nBar) — 4 bytes
  user.register('ord_63', 4, () => 0);

  // Ordinal 75: IsRectEmpty(lpRect) — 4 bytes (ptr)
  user.register('ord_75', 4, () => {
    const lpRect = emu.readArg16DWord(0);
    if (!lpRect) return 1;
    const l = emu.memory.readI16(lpRect);
    const t = emu.memory.readI16(lpRect + 2);
    const r = emu.memory.readI16(lpRect + 4);
    const b = emu.memory.readI16(lpRect + 6);
    return (l >= r || t >= b) ? 1 : 0;
  });

  // Ordinal 89: CreateDialog(hInst, lpTemplate, hWndParent, lpDialogFunc) — 12 bytes (2+4+2+4)
  user.register('ord_89', 12, () => 0); // stub: return NULL

  // Ordinal 112: WaitMessage() — 0 bytes
  user.register('ord_112', 0, () => { emu.waitingForMessage = true; return undefined; });

  // Ordinal 121: SetWindowsHook(nFilterType, pfnFilterProc) — 6 bytes (2+4)
  user.register('ord_121', 6, () => 0);

  // Ordinal 122: CallWindowProc(lpPrevWndFunc, hWnd, Msg, wParam, lParam) — 14 bytes (4+2+2+2+4)
  user.register('ord_122', 14, () => {
    const [lpPrevWndFunc, hWnd, msg, wParam, lParam] = emu.readPascalArgs16([4, 2, 2, 2, 4]);
    const resolved = emu.resolveFarPtr(lpPrevWndFunc);
    console.log(`[WIN16] CallWindowProc(0x${lpPrevWndFunc.toString(16)}→0x${resolved.toString(16)}, hwnd=0x${hWnd.toString(16)}, msg=0x${msg.toString(16)}, wP=0x${wParam.toString(16)}, lP=0x${lParam.toString(16)})`);
    if (resolved) {
      const result = emu.callWndProc16(resolved, hWnd, msg, wParam, lParam);
      console.log(`[WIN16] CallWindowProc result=0x${(result??0).toString(16)}`);
      return result;
    }
    return 0;
  });

  // Ordinal 129: GetClassWord(hWnd, nIndex) — 4 bytes (2+2)
  user.register('ord_129', 4, () => 0);

  // Ordinal 131: GetClassLong(hWnd, nIndex) — 4 bytes (2+2)
  user.register('ord_131', 4, () => 0);

  // Ordinal 134: SetWindowWord(hWnd, nIndex, wNewWord) — 6 bytes (2+2+2)
  user.register('ord_134', 6, () => 0);

  // Ordinal 137: OpenClipboard(hWnd) — 2 bytes
  user.register('ord_137', 2, () => 1);

  // Ordinal 138: CloseClipboard() — 0 bytes
  user.register('ord_138', 0, () => 1);

  // Ordinal 139: EmptyClipboard() — 0 bytes
  user.register('ord_139', 0, () => 1);

  // Ordinal 141: SetClipboardData(uFormat, hMem) — 4 bytes
  user.register('ord_141', 4, () => emu.readArg16(2)); // return handle

  // Ordinal 142: GetClipboardData(uFormat) — 2 bytes
  user.register('ord_142', 2, () => 0);

  // Ordinal 152: DestroyMenu(hMenu) — 2 bytes
  user.register('ord_152', 2, () => 1);

  // Ordinal 156: GetSystemMenu(hWnd, bRevert) — 4 bytes
  user.register('ord_156', 4, () => 0);

  // Ordinal 161: GetMenuString(hMenu, uIDItem, lpString, nMaxCount, uFlag) — 12 bytes (2+2+4+2+2)
  user.register('ord_161', 12, () => 0);

  // Ordinal 165: SetCaretPos(x, y) — 4 bytes
  user.register('ord_165', 4, () => 0);

  // Ordinal 183: GetCaretPos(lpPoint) — 4 bytes (ptr)
  user.register('ord_183', 4, () => {
    const lpPoint = emu.readArg16DWord(0);
    if (lpPoint) {
      emu.memory.writeU16(lpPoint, 0);
      emu.memory.writeU16(lpPoint + 2, 0);
    }
    return 0;
  });

  // Ordinal 187: EndMenu() — 0 bytes
  user.register('ord_187', 0, () => 0);

  // Ordinal 193: InSendMessage() — 0 bytes
  user.register('ord_193', 0, () => 0);

  // Ordinal 196: TabbedTextOut(hDC, x, y, lpStr, nCount, nTabPositions, lpnTabStopPositions, nTabOrigin) — 20 bytes
  user.register('ord_196', 20, () => 0);

  // Ordinal 197: GetTabbedTextExtent(hDC, lpStr, nCount, nTabPositions, lpnTabStopPositions) — 14 bytes (2+4+2+2+4)
  user.register('ord_197', 14, () => 0);

  // Ordinal 222: GetKeyboardState(lpKeyState) — 4 bytes
  user.register('ord_222', 4, () => 0);

  // Ordinal 223: SetKeyboardState(lpKeyState) — 4 bytes
  user.register('ord_223', 4, () => 0);

  // Ordinal 224: GetWindowTask(hWnd) — 2 bytes
  user.register('ord_224', 2, () => 1); // return a pseudo task handle

  // Ordinal 237: GetUpdateRgn(hWnd, hRgn, bErase) — 6 bytes
  user.register('ord_237', 6, () => 1); // NULLREGION

  // Ordinal 250: GetMenuState(hMenu, uId, uFlags) — 6 bytes
  user.register('ord_250', 6, () => 0xFFFFFFFF); // -1 = menu item doesn't exist

  // Ordinal 264: GetMenuItemID(hMenu, nPos) — 4 bytes
  user.register('ord_264', 4, () => 0xFFFF); // -1

  // Ordinal 272: IsZoomed(hWnd) — 2 bytes
  user.register('ord_272', 2, () => 0);

  // Ordinal 282: SelectPalette(hDC, hPal, bForceBackground) — 6 bytes
  user.register('ord_282', 6, () => 0);

  // Ordinal 283: RealizePalette(hDC) — 2 bytes
  user.register('ord_283', 2, () => 0);

  // Ordinal 407: CreateIcon(hInst, nWidth, nHeight, nPlanes, nBitsPixel, lpANDbits, lpXORbits) — 18 bytes (2+2+2+2+2+4+4)
  user.register('ord_407', 18, () => 0);

  // Ordinal 414: ModifyMenu(hMenu, uPosition, uFlags, uIDNewItem, lpNewItem) — 12 bytes (2+2+2+2+4)
  user.register('ord_414', 12, () => 1);

  // Ordinal 416: TrackPopupMenu(hMenu, uFlags, x, y, nReserved, hWnd, lpRect) — 18 bytes (2+2+2+2+2+2+4)
  user.register('ord_416', 18, () => 0);

  // Ordinal 432: AnsiLower(lpStr) — 4 bytes (segstr)
  user.register('ord_432', 4, () => {
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
  });

  // Ordinal 433: IsCharAlpha(ch) — 2 bytes
  user.register('ord_433', 2, () => {
    const ch = emu.readArg16(0) & 0xFF;
    return ((ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  });

  // Ordinal 434: IsCharAlphaNumeric(ch) — 2 bytes
  user.register('ord_434', 2, () => {
    const ch = emu.readArg16(0) & 0xFF;
    return ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x5A) || (ch >= 0x61 && ch <= 0x7A)) ? 1 : 0;
  });

  // Ordinal 437: AnsiUpperBuff(lpStr, uLength) — 6 bytes (4+2)
  user.register('ord_437', 6, () => {
    const [lpStr, uLength] = emu.readPascalArgs16([4, 2]);
    if (lpStr) {
      for (let i = 0; i < uLength; i++) {
        const ch = emu.memory.readU8(lpStr + i);
        if (ch >= 0x61 && ch <= 0x7A) emu.memory.writeU8(lpStr + i, ch - 0x20);
      }
    }
    return uLength;
  });

  // Ordinal 438: AnsiLowerBuff(lpStr, uLength) — 6 bytes (4+2)
  user.register('ord_438', 6, () => {
    const [lpStr, uLength] = emu.readPascalArgs16([4, 2]);
    if (lpStr) {
      for (let i = 0; i < uLength; i++) {
        const ch = emu.memory.readU8(lpStr + i);
        if (ch >= 0x41 && ch <= 0x5A) emu.memory.writeU8(lpStr + i, ch + 0x20);
      }
    }
    return uLength;
  });

  // Ordinal 445: DefFrameProc(hWnd, hWndMDIClient, uMsg, wParam, lParam) — 12 bytes (2+2+2+2+4)
  user.register('ord_445', 12, () => 0);

  // Ordinal 447: DefMDIChildProc(hWnd, uMsg, wParam, lParam) — 10 bytes (2+2+2+4)
  user.register('ord_447', 10, () => 0);

  // Ordinal 451: TranslateMDISysAccel(hWndClient, lpMsg) — 6 bytes (2+4)
  user.register('ord_451', 6, () => 0);

  // Ordinal 458: DestroyCursor(hCursor) — 2 bytes
  user.register('ord_458', 2, () => 1);

  // Ordinal 466: DragDetect(hWnd, pt) — 6 bytes (2+4)
  user.register('ord_466', 6, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 116: PostAppMessage(hTask, msg, wParam, lParam) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_116', 10, () => 1); // stub: always succeed

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 241: CreateDialogParam(hInst, lpTemplate, hWndParent, dlgFunc, dwInitParam) — 14 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_241', 14, () => 0); // stub: return NULL (dialog not created)

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 243: GetDialogBaseUnits() — 0 bytes
  // Returns LOWORD=x base unit, HIWORD=y base unit.
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_243', 0, () => ((16 << 16) | 8));

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 308: DefDlgProc(hDlg, msg, wParam, lParam) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_308', 10, () => 0); // stub: return 0

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 608: GetForegroundWindow() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_608', 0, () => emu.mainWindow);
}
