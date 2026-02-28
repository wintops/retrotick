import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';

// Win16 USER module — Message loop & dispatch

export function registerWin16UserMessage(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 107: DefWindowProc(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_107', 10, () => {
    const [hWnd, msg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    const WM_CLOSE = 0x0010;
    const WM_SYSCOMMAND = 0x0112;
    const WM_DESTROY = 0x0002;
    const SC_CLOSE = 0xF060;

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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 108: GetMessage(lpMsg_segptr, hWnd, wMsgFilterMin, wMsgFilterMax) — 10 bytes (4+2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_108', 10, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 109: PeekMessage(lpMsg_ptr, hWnd, wMsgFilterMin, wMsgFilterMax, wRemoveMsg) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_109', 12, () => {
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
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 110: PostMessage(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_110', 10, () => {
    const [hWnd, msg, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    emu.postMessage(hWnd, msg, wParam, lParam);
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 111: SendMessage(hWnd, msg, wParam, lParam_long) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_111', 10, () => {
    const [hWnd, message, wParam, lParam] = emu.readPascalArgs16([2, 2, 2, 4]);
    console.log(`[WIN16] SendMessage hwnd=0x${hWnd.toString(16)} msg=0x${message.toString(16)} wParam=${wParam} lParam=0x${lParam.toString(16)}`);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd?.wndProc) {
      return emu.callWndProc16(wnd.wndProc, hWnd, message, wParam, lParam);
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 113: TranslateMessage(lpMsg_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_113', 4, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 114: DispatchMessage(lpMsg_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_114', 4, () => {
    const lpMsg = h.readFarPtr(0);
    const hWnd = emu.memory.readU16(lpMsg);
    const message = emu.memory.readU16(lpMsg + 2);
    const wParam = emu.memory.readU16(lpMsg + 4);
    const lParam = emu.memory.readU32(lpMsg + 6);

    // WM_TIMER with non-zero lParam: call timer callback directly
    if (message === 0x0113 && lParam !== 0) {
      return emu.callWndProc16(lParam, hWnd, message, wParam, Date.now() & 0xFFFFFFFF);
    }
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd?.wndProc) {
      return emu.callWndProc16(wnd.wndProc, hWnd, message, wParam, lParam);
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 118: RegisterWindowMessage(lpString_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_118', 4, () => 0xC000);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 119: GetMessagePos() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_119', 0, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 120: GetMessageTime() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_120', 0, () => Date.now() & 0xFFFFFFFF);
}
