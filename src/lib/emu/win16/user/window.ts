import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { getClientSize, getNonClientMetrics } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Window creation & properties
// Ordinal mappings from Wine's user.exe16.spec

export function registerWin16UserWindow(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 41: CreateWindow — 30 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_41', 30, () => {
    const lpParam = h.readFarPtr(0);
    const hInstance = emu.readArg16(4);
    const hMenu = emu.readArg16(6);
    const hWndParent = emu.readArg16(8);
    const height = emu.readArg16(10);
    const w = emu.readArg16(12);
    const y = emu.readArg16(14);
    const x = emu.readArg16(16);
    const dwStyle = emu.readArg16DWord(18);
    const lpWindowName = h.readFarPtr(22);
    const lpClassName = h.readFarPtr(26);

    const className = lpClassName ? emu.memory.readCString(lpClassName) : '';
    const windowName = lpWindowName ? emu.memory.readCString(lpWindowName) : '';
    console.log(`[WIN16] CreateWindow class="${className}" title="${windowName}" ${w}x${height}`);

    const classInfo = emu.windowClasses.get(className.toUpperCase());
    let effectiveMenu = hMenu;
    if (!effectiveMenu && classInfo?.menuName) {
      effectiveMenu = 1;
      console.log(`[WIN16] CreateWindow: auto-loading menu from class menuName=0x${classInfo.menuName.toString(16)}`);
    }
    const hwnd = emu.handles.alloc('window', {
      classInfo: classInfo || { className, wndProc: 0, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: windowName,
      style: dwStyle,
      exStyle: 0,
      x: x === 0x8000 ? 0 : x,
      y: y === 0x8000 ? 0 : y,
      width: w === 0x8000 ? 320 : w,
      height: height === 0x8000 ? 200 : height,
      hMenu: effectiveMenu,
      parent: hWndParent,
      wndProc: classInfo?.wndProc || 0,
      visible: !!(dwStyle & 0x10000000),
      extraBytes: new Uint8Array(classInfo?.cbWndExtra || 0),
      children: new Map(),
    });

    if (!emu.mainWindow && hWndParent === 0) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (wnd) emu.promoteToMainWindow(hwnd, wnd);
    }

    if (classInfo?.wndProc) {
      emu.callWndProc16(classInfo.wndProc, hwnd, 0x0001, 0, 0);
    }

    if (hWndParent === emu.mainWindow && emu.mainWindow && emu.canvas && emu.ne) {
      const dsBase = emu.cpu.segBase(emu.ne.dataSegSelector);
      emu.memory.writeU16(dsBase + 0x240, 0);
      const cw = emu.canvas.width, ch = emu.canvas.height;
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      console.log(`[WIN16] CreateWindow: posting WM_SIZE to main after child 0x${hwnd.toString(16)} created`);
      emu.postMessage(emu.mainWindow, 0x0005, 0, lParam);
    }

    return hwnd;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 42: ShowWindow(hWnd, nCmdShow) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_42', 4, () => {
    const [hWnd, nCmdShow] = emu.readPascalArgs16([2, 2]);
    console.log(`[WIN16] ShowWindow hwnd=0x${hWnd.toString(16)} nCmdShow=${nCmdShow} mainWindow=0x${emu.mainWindow.toString(16)}`);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) { console.log(`[WIN16] ShowWindow: wnd not found!`); return 0; }

    const wasVisible = wnd.visible;
    wnd.visible = nCmdShow !== 0;

    if (hWnd === emu.mainWindow && (wnd.style & 0x10000000) && nCmdShow === 0) {
      wnd.visible = true;
    }

    if (wnd.wndProc) {
      let { cw, ch } = getClientSize(wnd.style, !!wnd.hMenu, wnd.width, wnd.height, true);
      if (hWnd === emu.mainWindow && emu.canvas) {
        cw = emu.canvas.width;
        ch = emu.canvas.height;
      }
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      console.log(`[WIN16] ShowWindow sending WM_SIZE hwnd=0x${hWnd.toString(16)} cw=${cw} ch=${ch}`);
      emu.callWndProc16(wnd.wndProc, hWnd, 0x0005, 0, lParam);
    }
    return wasVisible ? 1 : 0;
  });

  // Ordinal 44: OpenIcon(hWnd) — 2 bytes
  user.register('ord_44', 2, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 46: GetParent(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_46', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.parent || 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 47: IsWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_47', 2, () => {
    const hWnd = emu.readArg16(0);
    return emu.handles.getType(hWnd) === 'window' ? 1 : 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 48: IsChild(hWndParent, hWnd) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_48', 4, () => {
    const [hWndParent, hWnd] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.parent === hWndParent ? 1 : 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 49: IsWindowVisible(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_49', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.visible ? 1 : 0;
  });

  // Ordinal 50: FindWindow(lpClassName:4, lpWindowName:4) — 8 bytes
  user.register('ord_50', 8, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 53: DestroyWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_53', 2, () => {
    const hWnd = emu.readPascalArgs16([2])[0];
    const WM_DESTROY = 0x0002;
    const WM_NCDESTROY = 0x0082;
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd && wnd.wndProc) {
      emu.callWndProc16(wnd.wndProc, hWnd, WM_DESTROY, 0, 0);
      emu.callWndProc16(wnd.wndProc, hWnd, WM_NCDESTROY, 0, 0);
    }
    // Remove from parent's child list
    if (wnd && wnd.parent) {
      const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
      if (parentWnd) {
        if (parentWnd.childList) {
          const idx = parentWnd.childList.indexOf(hWnd);
          if (idx >= 0) parentWnd.childList.splice(idx, 1);
        }
        if (parentWnd.children && wnd.controlId !== undefined) {
          parentWnd.children.delete(wnd.controlId);
        }
      }
    }
    if (hWnd === emu.mainWindow) {
      console.log(`[WND] mainWindow 0x${hWnd.toString(16)} destroyed, clearing`);
      emu.mainWindow = 0;
    }
    emu.handles.free(hWnd);
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 56: MoveWindow(hWnd, x, y, w, h, bRepaint) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_56', 12, () => {
    const [hWnd, x, y, w, height, bRepaint] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd) {
      wnd.x = (x << 16 >> 16); wnd.y = (y << 16 >> 16);
      wnd.width = w; wnd.height = height;
      const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, w, height, true);
      if (hWnd === emu.mainWindow) {
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
      const WM_SIZE = 0x0005;
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      emu.callWndProc16(wnd.wndProc, hWnd, WM_SIZE, 0, lParam);
      if (bRepaint) {
        wnd.needsPaint = true;
        wnd.needsErase = true;
      }
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 57: RegisterClass(lpWndClass_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_57', 4, () => {
    const lpWndClass = h.readFarPtr(0);
    if (lpWndClass) {
      const style = emu.memory.readU16(lpWndClass);
      const wndProc = emu.memory.readU32(lpWndClass + 2);
      const cbClsExtra = emu.memory.readU16(lpWndClass + 6);
      const cbWndExtra = emu.memory.readU16(lpWndClass + 8);
      const hInstance = emu.memory.readU16(lpWndClass + 10);
      const hIcon = emu.memory.readU16(lpWndClass + 12);
      const hCursor = emu.memory.readU16(lpWndClass + 14);
      const hbrBackground = emu.memory.readU16(lpWndClass + 16);
      const lpszMenuName = emu.memory.readU32(lpWndClass + 18);
      const lpszClassName = emu.memory.readU32(lpWndClass + 22);

      const className = lpszClassName ? emu.memory.readCString(lpszClassName) : 'UNKNOWN';
      console.log(`[WIN16] RegisterClass "${className}" wndProc=0x${wndProc.toString(16)}`);

      emu.windowClasses.set(className.toUpperCase(), {
        className,
        wndProc,
        style,
        cbClsExtra: 0,
        cbWndExtra,
        hInstance: 0,
        hbrBackground,
        hIcon,
        hCursor,
        menuName: lpszMenuName,
      });
      return emu.nextClassAtom++;
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 58: GetClassName(hWnd, lpClassName, nMaxCount) — 8 bytes (2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_58', 8, () => {
    const [hWnd, lpClassName, nMaxCount] = emu.readPascalArgs16([2, 4, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const name = wnd?.classInfo?.className || '';
    if (lpClassName && nMaxCount > 0) {
      const maxCopy = Math.min(name.length, nMaxCount - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(lpClassName + i, name.charCodeAt(i));
      emu.memory.writeU8(lpClassName + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 59: SetActiveWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_59', 2, () => emu.readArg16(0));

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 133: GetWindowWord(hWnd, nIndex) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_133', 4, () => {
    const [hWnd, nIndex] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 2 <= wnd.extraBytes.length) {
      return wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex + 1] << 8);
    }
    // GWW_HINSTANCE = -6
    if (nIndex === 0xFFFA || nIndex === -6) return 1;
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 135: GetWindowLong(hWnd, nIndex) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_135', 4, () => {
    const [hWnd, nIndex] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const signedIndex = (nIndex << 16) >> 16;
    if (signedIndex === -4 && wnd) return wnd.wndProc || 0;
    if (signedIndex === -16 && wnd) return wnd.style || 0;
    if (signedIndex === -20 && wnd) return wnd.exStyle || 0;
    if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 4 <= wnd.extraBytes.length) {
      return wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex+1]<<8) | (wnd.extraBytes[nIndex+2]<<16) | (wnd.extraBytes[nIndex+3]<<24);
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 136: SetWindowLong(hWnd, nIndex, dwNewLong) — 8 bytes (2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_136', 8, () => {
    const [hWnd, nIndex, dwNewLong] = emu.readPascalArgs16([2, 2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const signedIndex = (nIndex << 16) >> 16;
    let old = 0;
    if (signedIndex === -4 && wnd) { old = wnd.wndProc || 0; wnd.wndProc = dwNewLong; }
    else if (signedIndex === -16 && wnd) { old = wnd.style || 0; wnd.style = dwNewLong; }
    else if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 4 <= wnd.extraBytes.length) {
      old = wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex+1]<<8) | (wnd.extraBytes[nIndex+2]<<16) | (wnd.extraBytes[nIndex+3]<<24);
      wnd.extraBytes[nIndex] = dwNewLong & 0xFF;
      wnd.extraBytes[nIndex+1] = (dwNewLong >> 8) & 0xFF;
      wnd.extraBytes[nIndex+2] = (dwNewLong >> 16) & 0xFF;
      wnd.extraBytes[nIndex+3] = (dwNewLong >> 24) & 0xFF;
    }
    return old;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 232: SetWindowPos(hWnd, hWndInsertAfter, x, y, cx, cy, uFlags) — 14 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_232', 14, () => {
    const [hWnd, _hInsertAfter, x, y, cx, cy, uFlags] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) return 0;

    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2;
    const SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80;
    let sizeChanged = false;

    if (!(uFlags & SWP_NOMOVE)) {
      wnd.x = (x << 16 >> 16); wnd.y = (y << 16 >> 16);
    }
    if (!(uFlags & SWP_NOSIZE)) {
      if (wnd.width !== cx || wnd.height !== cy) sizeChanged = true;
      wnd.width = cx; wnd.height = cy;
    }
    if (uFlags & SWP_SHOWWINDOW) wnd.visible = true;
    if (uFlags & SWP_HIDEWINDOW) wnd.visible = false;

    if (sizeChanged) {
      const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height, true);
      if (hWnd === emu.mainWindow) {
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
      const WM_SIZE = 0x0005;
      emu.callWndProc16(wnd.wndProc, hWnd, WM_SIZE, 0,
        ((ch & 0xFFFF) << 16) | (cw & 0xFFFF));
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 258: MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_258', 10, () => 0);

  // Ordinal 259-261: DeferWindowPos
  user.register('ord_259', 2, () => 1);   // BeginDeferWindowPos
  user.register('ord_260', 16, () => 1);  // DeferWindowPos
  user.register('ord_261', 2, () => 1);   // EndDeferWindowPos

  // Ordinal 262: GetWindow(hWnd, uCmd) — 4 bytes
  user.register('ord_262', 4, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 266: SetMessageQueue(cMsg) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_266', 2, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 452: CreateWindowEx — 32 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_452', 32, () => {
    const lpParam = h.readFarPtr(0);
    const hInstance = emu.readArg16(4);
    const hMenu = emu.readArg16(6);
    const hWndParent = emu.readArg16(8);
    const height = emu.readArg16(10);
    const w = emu.readArg16(12);
    const y = emu.readArg16(14);
    const x = emu.readArg16(16);
    const dwStyle = emu.readArg16DWord(18);
    const lpWindowName = h.readFarPtr(22);
    const lpClassName = h.readFarPtr(26);
    const dwExStyle = emu.readArg16DWord(28);

    const className = lpClassName ? emu.memory.readCString(lpClassName) : '';
    const windowName = lpWindowName ? emu.memory.readCString(lpWindowName) : '';
    console.log(`[WIN16] CreateWindowEx exStyle=0x${dwExStyle.toString(16)} class="${className}" title="${windowName}" ${w}x${height}`);

    const classInfo = emu.windowClasses.get(className.toUpperCase());
    const hwnd = emu.handles.alloc('window', {
      classInfo: classInfo || { className, wndProc: 0, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: windowName,
      style: dwStyle,
      exStyle: dwExStyle,
      x: x === 0x8000 ? 0 : x,
      y: y === 0x8000 ? 0 : y,
      width: w === 0x8000 ? 320 : w,
      height: height === 0x8000 ? 200 : height,
      hMenu,
      parent: hWndParent,
      wndProc: classInfo?.wndProc || 0,
      visible: !!(dwStyle & 0x10000000),
      extraBytes: new Uint8Array(classInfo?.cbWndExtra || 0),
      children: new Map(),
    });

    if (!emu.mainWindow && hWndParent === 0) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (wnd) emu.promoteToMainWindow(hwnd, wnd);
    }

    if (classInfo?.wndProc) {
      emu.callWndProc16(classInfo.wndProc, hwnd, 0x0001, 0, 0);
    }

    return hwnd;
  });
}
