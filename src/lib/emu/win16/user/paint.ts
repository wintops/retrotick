import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { getClientSize } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Painting & DC

export function registerWin16UserPaint(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 32: GetWindowRect(hWnd, lpRect_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_32', 6, () => {
    const [hWnd, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      const wnd = emu.handles.get<WindowInfo>(hWnd || emu.mainWindow);
      if (wnd) {
        h.writeRect(lpRect, wnd.x || 0, wnd.y || 0, (wnd.x || 0) + wnd.width, (wnd.y || 0) + wnd.height);
      } else {
        h.writeRect(lpRect, 0, 0, 640, 480);
      }
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 33: GetClientRect(hWnd, lpRect_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_33', 6, () => {
    const [hWnd, lpRect] = emu.readPascalArgs16([2, 4]);
    if (lpRect) {
      const targetHwnd = hWnd || emu.mainWindow;
      if (targetHwnd === emu.mainWindow && emu.canvas) {
        console.log(`[WIN16] GetClientRect hwnd=0x${targetHwnd.toString(16)} → ${emu.canvas.width}x${emu.canvas.height} (canvas)`);
        h.writeRect(lpRect, 0, 0, emu.canvas.width, emu.canvas.height);
      } else {
        const wnd = emu.handles.get<WindowInfo>(targetHwnd);
        if (wnd) {
          const { cw, ch } = getClientSize(wnd.style, !!wnd.hMenu, wnd.width, wnd.height, true);
          console.log(`[WIN16] GetClientRect hwnd=0x${targetHwnd.toString(16)} → ${cw}x${ch} (wnd ${wnd.width}x${wnd.height})`);
          h.writeRect(lpRect, 0, 0, cw, ch);
        } else {
          console.log(`[WIN16] GetClientRect hwnd=0x${targetHwnd.toString(16)} → 640x480 (fallback)`);
          h.writeRect(lpRect, 0, 0, 640, 480);
        }
      }
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 34: EnableWindow(hWnd, bEnable) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_34', 4, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 37: SetWindowText(hWnd, lpString_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_37', 6, () => {
    const [hWnd, lpString] = emu.readPascalArgs16([2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd && lpString) {
      wnd.title = emu.memory.readCString(lpString);
      console.log(`[WIN16] SetWindowText(0x${hWnd.toString(16)}, "${wnd.title}")`);
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 38: GetWindowTextLength(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_38', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.title?.length || 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 39: BeginPaint(hWnd, lpPaint_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_39', 6, () => {
    const [hWnd, lpPaint] = emu.readPascalArgs16([2, 4]);
    const targetHwnd = hWnd || emu.mainWindow;
    const hdc = emu.beginPaint(targetHwnd);
    const wndBP = emu.handles.get<WindowInfo>(targetHwnd);
    if (wndBP) { wndBP.needsPaint = false; wndBP.needsErase = false; }
    if (lpPaint) {
      emu.memory.writeU16(lpPaint, hdc);
      emu.memory.writeU16(lpPaint + 2, 0);
      let cw = 640, ch = 480;
      if (targetHwnd === emu.mainWindow && emu.canvas) {
        cw = emu.canvas.width; ch = emu.canvas.height;
      } else {
        const wnd = emu.handles.get<WindowInfo>(targetHwnd);
        if (wnd) { cw = wnd.width; ch = wnd.height; }
      }
      h.writeRect(lpPaint + 4, 0, 0, cw, ch);
      emu.memory.writeU16(lpPaint + 12, 0);
      emu.memory.writeU16(lpPaint + 14, 0);
    }
    return hdc;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 40: EndPaint(hWnd, lpPaint_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_40', 6, () => {
    const [hWnd] = emu.readPascalArgs16([2, 4]);
    emu.endPaint(hWnd || emu.mainWindow, 0);
    emu.notifyControlOverlays();
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 66: GetDC(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_66', 2, () => {
    const hWnd = emu.readArg16(0);
    const dc = emu.getWindowDC(hWnd || emu.mainWindow);
    console.log(`[WIN16] GetDC hwnd=0x${(hWnd || emu.mainWindow).toString(16)} → dc=${dc}`);
    return dc;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 68: ReleaseDC(hWnd, hDC) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_68', 4, () => {
    const [_hWnd, hDC] = emu.readPascalArgs16([2, 2]);
    emu.releaseChildDC(hDC);
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 124: UpdateWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_124', 2, () => {
    const hWnd = emu.readArg16(0);
    if (hWnd) {
      emu.postMessage(hWnd, 0x000F, 0, 0);
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 125: InvalidateRect(hWnd, lpRect_ptr, bErase) — 8 bytes (2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_125', 8, () => {
    const [hWnd, _lpRect, bErase] = emu.readPascalArgs16([2, 4, 2]);
    console.log(`[WIN16] InvalidateRect hwnd=0x${hWnd.toString(16)} erase=${bErase}`);
    if (hWnd) {
      const wnd = emu.handles.get<WindowInfo>(hWnd);
      if (wnd) {
        wnd.needsPaint = true;
        if (bErase) wnd.needsErase = true;
      }
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 127: ValidateRect(hWnd, lpRect) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_127', 6, () => 1);
}
