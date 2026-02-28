import type { Emulator, Win16Module } from '../../emulator';
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
    const jsTimer = window.setInterval(() => {
      emu.postMessage(hWnd, 0x0113, nIDEvent, lpTimerFunc);
    }, uElapse);
    emu.setWin32Timer(hWnd, nIDEvent, jsTimer);
    return 1;
  });

  // Ordinal 12: KillTimer(hWnd, nIDEvent) — 4 bytes
  user.register('ord_12', 4, () => 1);

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
  user.register('ord_22', 2, () => emu.readArg16(0));

  // Ordinal 28: ClientToScreen(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ord_28', 6, () => 0);

  // Ordinal 29: ScreenToClient(hWnd, lpPoint_ptr) — 6 bytes
  user.register('ord_29', 6, () => 0);

  // Ordinal 31: IsIconic(hWnd) — 2 bytes
  user.register('ord_31', 2, () => 0);

  // Ordinal 69: SetCursor(hCursor) — 2 bytes
  user.register('ord_69', 2, () => 1);

  // Ordinal 70: SetCursorPos(x, y) — 4 bytes
  user.register('ord_70', 4, () => 0);

  // Ordinal 71: ShowCursor(bShow) — 2 bytes
  user.register('ord_71', 2, () => 1);

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

  // Ordinal 404: GetClassInfo — 10 bytes
  user.register('ord_404', 10, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 420: wsprintf — varargs, tricky
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_420', 0, () => 0);

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
    const [s1, s2] = emu.readPascalArgs16([4, 4]);
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
  // Ordinal 473: AnsiPrev(lpStart, lpCurrent) — 8 bytes (4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_473', 8, () => {
    const [lpStart, lpCurrent] = emu.readPascalArgs16([4, 4]);
    if (!lpStart || !lpCurrent || lpCurrent <= lpStart) return lpStart;
    return lpCurrent - 1;
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

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 608: GetForegroundWindow() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_608', 0, () => emu.mainWindow);
}
