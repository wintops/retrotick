import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { getClientSize, getNonClientMetrics } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Window creation & properties
// Ordinal mappings from Wine's user.exe16.spec

// Fix CCS control (toolbar/statusbar) position at creation time.
// The x86 COMMCTRL.DLL creates these at wrong positions, but
// GetEffectiveClientRect reads them before WM_SIZE fires.
const WS_VISIBLE_BIT = 0x10000000;
function fixCcsPosition(emu: Emulator, hwnd: number, hWndParent: number): void {
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  if (!wnd || !hWndParent) return;
  const ucn = wnd.classInfo?.className?.toUpperCase();
  if (ucn !== 'TOOLBARWINDOW' && ucn !== 'MSCTLS_STATUSBAR') return;
  const parent = emu.handles.get<WindowInfo>(hWndParent);
  if (!parent) return;
  let parentCW: number, parentCH: number;
  if (hWndParent === emu.mainWindow && emu.canvas) {
    parentCW = emu.canvas.width; parentCH = emu.canvas.height;
  } else {
    const cs = getClientSize(parent.style, !!parent.hMenu, parent.width, parent.height, true);
    parentCW = cs.cw; parentCH = cs.ch;
  }
  // Store the offset between original and fixed position.
  // The x86 COMMCTRL code reads position from Win16's internal WND struct
  // (which we don't expose in memory), so it positions children relative to
  // the original (-100,-100) coordinates. We'll apply this offset in MoveWindow.
  const origX = wnd.x;
  const origY = wnd.y;
  // CCS controls must be visible and have WS_VISIBLE in style bits
  // (x86 code reads style bits directly to check visibility)
  wnd.visible = true;
  wnd.style |= WS_VISIBLE_BIT;
  if (ucn === 'TOOLBARWINDOW') {
    wnd.x = 0; wnd.y = 0;
    wnd.width = parentCW;
  } else {
    wnd.x = 0; wnd.y = parentCH - wnd.height;
    wnd.width = parentCW;
  }
  // Compute the delta and apply it to existing children.
  // Children created during WM_CREATE were positioned using coordinates based on
  // the original CCS position (e.g. GetWindowRect returning (-100,-100)).
  // Now that we've moved the CCS window, adjust children by the same delta
  // and clamp to y>=0 so nothing extends above the toolbar.
  const dx = wnd.x - origX;
  const dy = wnd.y - origY;
  if (dx !== 0 || dy !== 0) {
    (wnd as any)._ccsChildOffsetX = dx;
    (wnd as any)._ccsChildOffsetY = dy;
    if (wnd.childList) {
      for (const childHwnd of wnd.childList) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child) {
          child.x += dx;
          child.y = Math.max(0, child.y + dy);
        }
      }
    }
  }
}

// Build a Win16 CREATESTRUCT on the stack and return its linear address.
// Win16 CREATESTRUCT layout (34 bytes):
//   +0:  lpCreateParams (4, far ptr)
//   +4:  hInstance      (2)
//   +6:  hMenu          (2)
//   +8:  hwndParent     (2)
//   +10: cy             (2)
//   +12: cx             (2)
//   +14: y              (2)
//   +16: x              (2)
//   +18: style          (4, LONG)
//   +22: lpszName       (4, far ptr)
//   +26: lpszClass      (4, far ptr)
//   +30: dwExStyle      (4)
function buildCreateStruct16(
  emu: Emulator, lpCreateParams: number, hInstance: number, hMenu: number,
  hWndParent: number, cy: number, cx: number, y: number, x: number,
  style: number, lpszName: number, lpszClass: number, exStyle: number,
): number {
  // Build CREATESTRUCT on the stack (SS == DS in Win16 DGROUP).
  // Don't use allocLocal — it permanently consumes heap space and conflicts
  // with the app's own local heap allocations starting at the heap base.
  // Allocate CREATESTRUCT on the stack by decrementing SP.
  // Don't use allocLocal — it permanently consumes heap space and can
  // overwrite the app's own local heap data at the heap start.
  // SP will be restored by the caller after WM_NCCREATE/WM_CREATE dispatch.
  const sp = emu.cpu.reg[4] & 0xFFFF;
  const dsOffset = (sp - 36) & 0xFFFF; // 34 bytes + 2 alignment
  emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | dsOffset;
  const dsBase = emu.cpu.segBase(emu.cpu.ss); // SS == DS in DGROUP
  const addr = dsBase + dsOffset;
  emu.memory.writeU32(addr, lpCreateParams);
  emu.memory.writeU16(addr + 4, hInstance);
  emu.memory.writeU16(addr + 6, hMenu);
  emu.memory.writeU16(addr + 8, hWndParent);
  emu.memory.writeU16(addr + 10, cy & 0xFFFF);
  emu.memory.writeU16(addr + 12, cx & 0xFFFF);
  emu.memory.writeU16(addr + 14, y & 0xFFFF);
  emu.memory.writeU16(addr + 16, x & 0xFFFF);
  emu.memory.writeU32(addr + 18, style);
  emu.memory.writeU32(addr + 22, lpszName);
  emu.memory.writeU32(addr + 26, lpszClass);
  emu.memory.writeU32(addr + 30, exStyle);
  return dsOffset; // Return DS offset (near pointer for 16-bit code)
}

// Send WM_NCCREATE and WM_CREATE to the window's wndProc with a valid CREATESTRUCT.
function sendCreateMessages16(
  emu: Emulator, wndProc: number, hwnd: number, createStructDsOffset: number,
): void {
  const WM_NCCREATE = 0x0081;
  const WM_CREATE = 0x0001;
  // lParam must be a far pointer (DS:offset) packed as seg<<16 | offset
  const lParam = (emu.cpu.ds << 16) | (createStructDsOffset & 0xFFFF);
  emu.callWndProc16(wndProc, hwnd, WM_NCCREATE, 0, lParam);
  emu.callWndProc16(wndProc, hwnd, WM_CREATE, 0, lParam);
}

// Built-in Win16 class atoms (same as Win32)
const BUILTIN_ATOMS: Record<number, string> = {
  0x0080: 'BUTTON',
  0x0081: 'EDIT',
  0x0082: 'STATIC',
  0x0083: 'LISTBOX',
  0x0084: 'SCROLLBAR',
  0x0085: 'COMBOBOX',
  0x0086: 'MDICLIENT',
};

// Resolve a Win16 class name from a raw far-pointer DWORD.
// If HIWORD is 0 and LOWORD is small, it's an atom — resolve to a class name.
function resolveClassName16(emu: Emulator, rawDWord: number, resolvedPtr: number): string {
  const seg = (rawDWord >>> 16) & 0xFFFF;
  if (seg !== 0) {
    // Real far pointer to a string
    return resolvedPtr ? emu.memory.readCString(resolvedPtr) : '';
  }
  const atom = rawDWord & 0xFFFF;
  if (atom === 0) return '';
  // Check built-in class atoms
  const builtin = BUILTIN_ATOMS[atom];
  if (builtin) return builtin;
  // Look up registered classes by atom
  for (const [name, cls] of emu.windowClasses) {
    if ((cls as any).atom === atom) return name;
  }
  return `ATOM_${atom}`;
}

export function registerWin16UserWindow(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 41: CreateWindow — 30 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreateWindow', 30, () => {
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
    const classNameRaw = emu.readArg16DWord(26);

    const className = resolveClassName16(emu, classNameRaw, lpClassName);
    const windowName = lpWindowName ? emu.memory.readCString(lpWindowName) : '';
    const classInfo = emu.windowClasses.get(className.toUpperCase());
    let effectiveMenu = hMenu;
    if (!effectiveMenu && classInfo?.menuName) {
      effectiveMenu = 1;
    }
    // Windows adjusts style: WS_SYSMENU implies WS_CAPTION
    const WS_CAPTION = 0x00C00000;
    const WS_SYSMENU = 0x00080000;
    let adjustedStyle = dwStyle;
    if ((dwStyle & WS_SYSMENU) && !(dwStyle & WS_CAPTION)) {
      adjustedStyle |= WS_CAPTION;
    }
    // Sign-extend 16-bit values for positions (can be negative)
    const sx = (x << 16 >> 16);
    const sy = (y << 16 >> 16);
    const sw = (w << 16 >> 16);
    const sh = (height << 16 >> 16);
    const CW_USEDEFAULT = -0x8000;
    // MDICLIENT is always visible in practice (container for MDI children)
    const isMDIClient = className.toUpperCase() === 'MDICLIENT';
    const hwnd = emu.handles.alloc('window', {
      classInfo: classInfo || { className, wndProc: 0, rawWndProc: 0, style: 0, hbrBackground: isMDIClient ? 13 : 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: windowName,
      style: adjustedStyle,
      exStyle: 0,
      x: sx === CW_USEDEFAULT ? 0 : sx,
      y: sx === CW_USEDEFAULT ? 0 : sy,
      width: sw === CW_USEDEFAULT ? 320 : (sw < 0 ? 0 : sw),
      height: sw === CW_USEDEFAULT ? 200 : (sh < 0 ? 0 : sh),
      hMenu: effectiveMenu,
      parent: hWndParent,
      wndProc: classInfo?.wndProc || 0,
      rawWndProc: classInfo?.rawWndProc || 0,
      visible: isMDIClient || !!(dwStyle & 0x10000000),
      extraBytes: new Uint8Array(classInfo?.cbWndExtra || 0),
      children: new Map(),
    });
    { const w = emu.handles.get<WindowInfo>(hwnd); if (w) { w.hwnd = hwnd; if ((dwStyle & 0x10000000) || isMDIClient) { w.needsPaint = true; w.needsErase = true; } } }

    // Register child in parent's childList (mirrors Win32 create-window.ts)
    if (hWndParent) {
      const parentWnd = emu.handles.get<WindowInfo>(hWndParent);
      if (parentWnd) {
        if (!parentWnd.childList) parentWnd.childList = [];
        const wnd = emu.handles.get<WindowInfo>(hwnd);
        if (wnd) {
          const WS_CHILD = 0x40000000;
          if (dwStyle & WS_CHILD) {
            wnd.controlId = hMenu;
            if (!parentWnd.children) parentWnd.children = new Map();
            parentWnd.children.set(hMenu, hwnd);
          }
        }
        parentWnd.childList.push(hwnd);
      }
    }

    if (!emu.mainWindow && hWndParent === 0) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (wnd) emu.promoteToMainWindow(hwnd, wnd);
    }

    if (classInfo?.wndProc) {
      const savedSP = emu.cpu.reg[4] & 0xFFFF;
      const cs = buildCreateStruct16(emu, emu.readArg16DWord(0), hInstance, hMenu, hWndParent,
        height, w, y, x, dwStyle, emu.readArg16DWord(22), emu.readArg16DWord(26), 0);
      if (cs) {
        sendCreateMessages16(emu, classInfo.wndProc, hwnd, cs);
      } else {
        emu.callWndProc16(classInfo.wndProc, hwnd, 0x0001, 0, 0);
      }
      emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | savedSP;
    }

    // Fix CCS_TOP/CCS_BOTTOM position AFTER WM_CREATE.
    // The x86 code reads position from Win16's internal WND struct (which we don't
    // expose), so it uses the original (-100,-100). We fix the toolbar position AND
    // adjust any children that were positioned relative to the original coordinates.
    fixCcsPosition(emu, hwnd, hWndParent);

    if (hWndParent === emu.mainWindow && emu.mainWindow && emu.canvas && emu.ne) {
      const dsBase = emu.cpu.segBase(emu.ne.dataSegSelector);
      emu.memory.writeU16(dsBase + 0x240, 0);
      const cw = emu.canvas.width, ch = emu.canvas.height;
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      emu.postMessage(emu.mainWindow, 0x0005, 0, lParam);
    }

    return hwnd;
  }, 41);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 42: ShowWindow(hWnd, nCmdShow) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ShowWindow', 4, () => {
    const [hWnd, nCmdShow] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) { console.log(`[WIN16] ShowWindow: wnd not found!`); return 0; }

    const WS_VISIBLE = 0x10000000;
    const wasVisible = wnd.visible;
    wnd.visible = nCmdShow !== 0;
    // Sync WS_VISIBLE style bit so x86 code reading style directly sees correct state
    if (wnd.visible) wnd.style |= WS_VISIBLE;
    else wnd.style &= ~WS_VISIBLE;

    if (hWnd === emu.mainWindow && (wnd.style & WS_VISIBLE) && nCmdShow === 0) {
      wnd.visible = true;
      wnd.style |= WS_VISIBLE;
    }

    // When transitioning from hidden to visible, mark window as needing paint
    if (!wasVisible && wnd.visible) {
      wnd.needsPaint = true;
      wnd.needsErase = true;
    }

    if (wnd.wndProc) {
      const WM_SHOWWINDOW = 0x0018;
      const WM_ACTIVATEAPP = 0x001C;
      const WM_ACTIVATE = 0x0006;
      const WA_ACTIVE = 1;
      emu.callWndProc16(wnd.wndProc, hWnd, WM_SHOWWINDOW, wnd.visible ? 1 : 0, 0);
      if (wnd.visible && hWnd === emu.mainWindow) {
        emu.callWndProc16(wnd.wndProc, hWnd, WM_ACTIVATEAPP, 1, 0);
        emu.callWndProc16(wnd.wndProc, hWnd, WM_ACTIVATE, WA_ACTIVE, 0);
      }

      let { cw, ch } = getClientSize(wnd.style, !!wnd.hMenu, wnd.width, wnd.height, true);
      if (hWnd === emu.mainWindow && emu.canvas) {
        cw = emu.canvas.width;
        ch = emu.canvas.height;
      }
      const WM_SIZE = 0x0005;
      const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
      // Send WM_SIZE synchronously (like real Windows SendMessage) so the
      // window proc can resize children before initialization continues
      emu.callWndProc16(wnd.wndProc, hWnd, WM_SIZE, 0, lParam);
    }
    // Notify control overlays so child controls (EDIT, BUTTON, etc.) get DOM elements
    if (hWnd === emu.mainWindow) emu.notifyControlOverlays();
    return wasVisible ? 1 : 0;
  }, 42);

  // Ordinal 43: CloseWindow(hWnd) — 2 bytes (minimizes the window)
  user.register('CloseWindow', 2, () => {
    const [hWnd] = emu.readPascalArgs16([2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd) wnd.minimized = true;
    return 0;
  }, 43);

  // Ordinal 44: OpenIcon(hWnd) — 2 bytes
  user.register('OpenIcon', 2, () => 1, 44);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 45: BringWindowToTop(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('BringWindowToTop', 2, () => 1, 45);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 46: GetParent(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetParent', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.parent || 0;
  }, 46);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 47: IsWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('IsWindow', 2, () => {
    const hWnd = emu.readArg16(0);
    return emu.handles.getType(hWnd) === 'window' ? 1 : 0;
  }, 47);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 48: IsChild(hWndParent, hWnd) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('IsChild', 4, () => {
    const [hWndParent, hWnd] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.parent === hWndParent ? 1 : 0;
  }, 48);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 49: IsWindowVisible(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('IsWindowVisible', 2, () => {
    const hWnd = emu.readArg16(0);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    return wnd?.visible ? 1 : 0;
  }, 49);

  // Ordinal 50: FindWindow(lpClassName:4, lpWindowName:4) — 8 bytes
  user.register('FindWindow', 8, () => 0, 50);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 53: DestroyWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DestroyWindow', 2, () => {
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
  }, 53);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 56: MoveWindow(hWnd, x, y, w, h, bRepaint) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('MoveWindow', 12, () => {
    const [hWnd, x, y, w, height, bRepaint] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd) {
      let mx = (x << 16 >> 16), my = (y << 16 >> 16);
      // If parent is a CCS control, adjust coordinates: the x86 COMMCTRL code
      // computes positions using GetWindowRect which returns screen coords based on
      // the old CCS position (-100,-100). Apply the stored delta.
      if (wnd.parent) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd) {
          const ox = (parentWnd as any)._ccsChildOffsetX;
          const oy = (parentWnd as any)._ccsChildOffsetY;
          if (ox !== undefined) mx += ox;
          if (oy !== undefined) my = Math.max(0, my + oy);
        }
      }
      wnd.x = mx; wnd.y = my;
      const sizeChanged = wnd.width !== w || wnd.height !== height;
      wnd.width = w; wnd.height = height;
      if (sizeChanged) {
        const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, w, height, true);
        if (hWnd === emu.mainWindow) {
          emu.setupCanvasSize(cw, ch);
          emu.onWindowChange?.(wnd);
        }
        const WM_SIZE = 0x0005;
        const lParam = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
        if (wnd.wndProc) {
          const nest = wnd._wmSizeNest || 0;
          if (nest < 2) {
            wnd._wmSizeNest = nest + 1;
            emu.callWndProc16(wnd.wndProc, hWnd, WM_SIZE, 0, lParam);
            wnd._wmSizeNest = nest;
          }
        }
        // MDICLIENT: resize maximized MDI children to fill new area
        if (wnd.classInfo?.className?.toUpperCase() === 'MDICLIENT' && wnd.childList) {
          for (const childHwnd of wnd.childList) {
            const child = emu.handles.get<WindowInfo>(childHwnd);
            if (child && child.maximized) {
              child.x = 0; child.y = 0;
              child.width = cw; child.height = ch;
              child.needsPaint = true; child.needsErase = true;
              const { cw: ccw, ch: cch } = getClientSize(child.style, !!child.hMenu, cw, ch, true);
              emu.postMessage(childHwnd, WM_SIZE, 2, ((cch & 0xFFFF) << 16) | (ccw & 0xFFFF));
            }
          }
        }
      }
      if (bRepaint) {
        wnd.needsPaint = true;
        wnd.needsErase = true;
      }
      emu.notifyControlOverlays();
    }
    return 1;
  }, 56);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 57: RegisterClass(lpWndClass_ptr) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('RegisterClass', 4, () => {
    const lpWndClass = h.readFarPtr(0);
    if (lpWndClass) {
      const style = emu.memory.readU16(lpWndClass);
      const rawWndProc = emu.memory.readU32(lpWndClass + 2);
      const wndProc = h.resolveFarPtr(rawWndProc);
      const cbClsExtra = emu.memory.readU16(lpWndClass + 6);
      const cbWndExtra = emu.memory.readU16(lpWndClass + 8);
      const hInstance = emu.memory.readU16(lpWndClass + 10);
      const hIcon = emu.memory.readU16(lpWndClass + 12);
      const hCursor = emu.memory.readU16(lpWndClass + 14);
      const hbrBackground = emu.memory.readU16(lpWndClass + 16);
      const lpszMenuName = emu.memory.readU32(lpWndClass + 18);
      const lpszClassName = h.resolveFarPtr(emu.memory.readU32(lpWndClass + 22));

      const className = lpszClassName ? emu.memory.readCString(lpszClassName) : 'UNKNOWN';
      // console.log(`[WIN16] RegisterClass "${className}" wndProc=0x${wndProc.toString(16)} raw=0x${rawWndProc.toString(16)}`);

      emu.windowClasses.set(className.toUpperCase(), {
        className,
        wndProc,
        rawWndProc,
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
  }, 57);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 58: GetClassName(hWnd, lpClassName, nMaxCount) — 8 bytes (2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetClassName', 8, () => {
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
  }, 58);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 59: SetActiveWindow(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetActiveWindow', 2, () => emu.readArg16(0), 59);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 133: GetWindowWord(hWnd, nIndex) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetWindowWord', 4, () => {
    const [hWnd, nIndex] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 2 <= wnd.extraBytes.length) {
      return wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex + 1] << 8);
    }
    // GWW_HINSTANCE = -6
    if (nIndex === 0xFFFA || nIndex === -6) return 1;
    return 0;
  }, 133);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 135: GetWindowLong(hWnd, nIndex) — 4 bytes (2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetWindowLong', 4, () => {
    const [hWnd, nIndex] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const signedIndex = (nIndex << 16) >> 16;
    if (signedIndex === -4 && wnd) {
      const raw = wnd.rawWndProc || wnd.wndProc || 0;
      // Debug: dump thunk bytes at the far pointer
      const off = raw & 0xFFFF;
      const seg = (raw >>> 16) & 0xFFFF;
      if (seg) {
        const base = emu.cpu.segBases.get(seg);
        if (base !== undefined) {
          const lin = base + off;
          const bytes = [];
          for (let i = 0; i < 8; i++) bytes.push(emu.memory.readU8(lin + i).toString(16).padStart(2, '0'));
          const dispatchBytes = [];
          for (let i = 0; i < 32; i++) dispatchBytes.push(emu.memory.readU8(base + i).toString(16).padStart(2, '0'));
          // console.log(`[WIN16] GetWindowLong(0x${hWnd.toString(16)}, GWL_WNDPROC) → 0x${raw.toString(16)} seg=0x${seg.toString(16)} base=0x${base.toString(16)} lin=0x${lin.toString(16)} bytes=[${bytes.join(' ')}] dispatch@+2=[${dispatchBytes.join(' ')}]`);
        } else {
          // console.log(`[WIN16] GetWindowLong(0x${hWnd.toString(16)}, GWL_WNDPROC) → 0x${raw.toString(16)} seg=0x${seg.toString(16)} NO BASE`);
        }
      } else {
        // console.log(`[WIN16] GetWindowLong(0x${hWnd.toString(16)}, GWL_WNDPROC) → 0x${raw.toString(16)}`);
      }
      return raw;
    }
    if (signedIndex === -16 && wnd) return wnd.style || 0;
    if (signedIndex === -20 && wnd) return wnd.exStyle || 0;
    if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 4 <= wnd.extraBytes.length) {
      return wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex+1]<<8) | (wnd.extraBytes[nIndex+2]<<16) | (wnd.extraBytes[nIndex+3]<<24);
    }
    return 0;
  }, 135);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 136: SetWindowLong(hWnd, nIndex, dwNewLong) — 8 bytes (2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetWindowLong', 8, () => {
    const [hWnd, nIndex, dwNewLong] = emu.readPascalArgs16([2, 2, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    const signedIndex = (nIndex << 16) >> 16;
    let old = 0;
    if (signedIndex === -4 && wnd) { old = wnd.rawWndProc || wnd.wndProc || 0; wnd.rawWndProc = dwNewLong; wnd.wndProc = h.resolveFarPtr(dwNewLong); }
    else if (signedIndex === -16 && wnd) { old = wnd.style || 0; wnd.style = dwNewLong; }
    else if (wnd && wnd.extraBytes && nIndex >= 0 && nIndex + 4 <= wnd.extraBytes.length) {
      old = wnd.extraBytes[nIndex] | (wnd.extraBytes[nIndex+1]<<8) | (wnd.extraBytes[nIndex+2]<<16) | (wnd.extraBytes[nIndex+3]<<24);
      wnd.extraBytes[nIndex] = dwNewLong & 0xFF;
      wnd.extraBytes[nIndex+1] = (dwNewLong >> 8) & 0xFF;
      wnd.extraBytes[nIndex+2] = (dwNewLong >> 16) & 0xFF;
      wnd.extraBytes[nIndex+3] = (dwNewLong >> 24) & 0xFF;
    }
    return old;
  }, 136);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 232: SetWindowPos(hWnd, hWndInsertAfter, x, y, cx, cy, uFlags) — 14 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetWindowPos', 14, () => {
    const [hWnd, _hInsertAfter, x, y, cx, cy, uFlags] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) return 0;

    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2;
    const SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80;
    let sizeChanged = false;

    if (!(uFlags & SWP_NOMOVE)) {
      let mx = (x << 16 >> 16), my = (y << 16 >> 16);
      if (wnd.parent) {
        const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
        if (parentWnd) {
          const ox = (parentWnd as any)._ccsChildOffsetX;
          const oy = (parentWnd as any)._ccsChildOffsetY;
          if (ox !== undefined) mx += ox;
          if (oy !== undefined) my = Math.max(0, my + oy);
        }
      }
      wnd.x = mx; wnd.y = my;
    }
    if (!(uFlags & SWP_NOSIZE)) {
      if (wnd.width !== cx || wnd.height !== cy) sizeChanged = true;
      wnd.width = cx; wnd.height = cy;
    }
    const WS_VIS = 0x10000000;
    if (uFlags & SWP_SHOWWINDOW) { wnd.visible = true; wnd.style |= WS_VIS; }
    if (uFlags & SWP_HIDEWINDOW) { wnd.visible = false; wnd.style &= ~WS_VIS; }

    if (sizeChanged) {
      const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height, true);
      if (hWnd === emu.mainWindow) {
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
      const WM_SIZE = 0x0005;
      if (wnd.wndProc) {
        const lp = ((ch & 0xFFFF) << 16) | (cw & 0xFFFF);
        const nest = wnd._wmSizeNest || 0;
        if (nest < 2) {
          wnd._wmSizeNest = nest + 1;
          emu.callWndProc16(wnd.wndProc, hWnd, WM_SIZE, 0, lp);
          wnd._wmSizeNest = nest;
        }
      }
      // MDICLIENT: resize maximized MDI children to fill new area
      if (wnd.classInfo?.className?.toUpperCase() === 'MDICLIENT' && wnd.childList) {
        for (const childHwnd of wnd.childList) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (child && child.maximized) {
            child.x = 0; child.y = 0;
            child.width = cw; child.height = ch;
            child.needsPaint = true; child.needsErase = true;
            const { cw: ccw, ch: cch } = getClientSize(child.style, !!child.hMenu, cw, ch, true);
            emu.postMessage(childHwnd, WM_SIZE, 2, ((cch & 0xFFFF) << 16) | (ccw & 0xFFFF));
          }
        }
      }
    }
    emu.notifyControlOverlays();
    return 1;
  }, 232);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 258: MapWindowPoints(hWndFrom, hWndTo, lpPoints, cPoints) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('MapWindowPoints', 10, () => {
    const [hWndFrom, hWndTo, lpPoints, cPoints] = emu.readPascalArgs16([2, 2, 4, 2]);
    if (!lpPoints || cPoints === 0) return 0;
    const from = h.clientOrigin(hWndFrom);
    const to = h.clientOrigin(hWndTo);
    const dx = from.x - to.x;
    const dy = from.y - to.y;
    for (let i = 0; i < cPoints; i++) {
      const addr = lpPoints + i * 4; // Win16 POINT = 2 x I16 = 4 bytes
      const px = emu.memory.readI16(addr);
      const py = emu.memory.readI16(addr + 2);
      emu.memory.writeU16(addr, (px + dx) & 0xFFFF);
      emu.memory.writeU16(addr + 2, (py + dy) & 0xFFFF);
    }
    return ((dx & 0xFFFF) | ((dy & 0xFFFF) << 16)) >>> 0;
  }, 258);

  // Ordinal 259: BeginDeferWindowPos(nNumWindows) → HDWP
  user.register('BeginDeferWindowPos', 2, () => {
    emu.readPascalArgs16([2]); // nNumWindows (ignored, just consume)
    return emu.handles.alloc('dwp', { entries: [] as { hWnd: number; x: number; y: number; cx: number; cy: number; uFlags: number }[] });
  }, 259);

  // Ordinal 260: DeferWindowPos(hWinPosInfo, hWnd, hWndInsertAfter, x, y, cx, cy, uFlags) — 16 bytes
  user.register('DeferWindowPos', 16, () => {
    const [hWinPosInfo, hWnd, _hInsert, x, y, cx, cy, uFlags] = emu.readPascalArgs16([2, 2, 2, 2, 2, 2, 2, 2]);
    const dwp = emu.handles.get<{ entries: { hWnd: number; x: number; y: number; cx: number; cy: number; uFlags: number }[] }>(hWinPosInfo);
    if (dwp && dwp.entries) {
      dwp.entries.push({ hWnd, x: (x << 16 >> 16), y: (y << 16 >> 16), cx, cy, uFlags });
    }
    return hWinPosInfo;
  }, 260);

  // Ordinal 261: EndDeferWindowPos(hWinPosInfo) — 2 bytes
  user.register('EndDeferWindowPos', 2, () => {
    const [hWinPosInfo] = emu.readPascalArgs16([2]);
    const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_SHOWWINDOW = 0x40, SWP_HIDEWINDOW = 0x80;
    const dwp = emu.handles.get<{ entries: { hWnd: number; x: number; y: number; cx: number; cy: number; uFlags: number }[] }>(hWinPosInfo);
    if (dwp && dwp.entries) {
      for (const e of dwp.entries) {
        const wnd = emu.handles.get<WindowInfo>(e.hWnd);
        if (!wnd) continue;
        if (!(e.uFlags & SWP_NOMOVE)) { wnd.x = e.x; wnd.y = e.y; }
        if (!(e.uFlags & SWP_NOSIZE)) { wnd.width = e.cx; wnd.height = e.cy; }
        if (e.uFlags & SWP_SHOWWINDOW) { wnd.visible = true; wnd.style |= 0x10000000; }
        if (e.uFlags & SWP_HIDEWINDOW) { wnd.visible = false; wnd.style &= ~0x10000000; }
        wnd.needsPaint = true;
      }
      emu.handles.free(hWinPosInfo);
    }
    emu.notifyControlOverlays();
    return 1;
  });

  // Ordinal 262: GetWindow(hWnd, uCmd) — 4 bytes
  user.register('GetWindow', 4, () => {
    const [hWnd, uCmd] = emu.readPascalArgs16([2, 2]);
    const GW_HWNDFIRST = 0, GW_HWNDLAST = 1, GW_HWNDNEXT = 2, GW_HWNDPREV = 3, GW_OWNER = 4, GW_CHILD = 5;
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (!wnd) return 0;
    if (uCmd === GW_CHILD) {
      return wnd.childList?.[0] ?? 0;
    }
    if (uCmd === GW_OWNER) {
      return wnd.parent || 0;
    }
    // For sibling navigation, find in parent's childList
    if (wnd.parent) {
      const parentWnd = emu.handles.get<WindowInfo>(wnd.parent);
      const siblings = parentWnd?.childList;
      if (siblings) {
        const idx = siblings.indexOf(hWnd);
        if (uCmd === GW_HWNDNEXT) return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1] : 0;
        if (uCmd === GW_HWNDPREV) return idx > 0 ? siblings[idx - 1] : 0;
        if (uCmd === GW_HWNDFIRST) return siblings[0] ?? 0;
        if (uCmd === GW_HWNDLAST) return siblings[siblings.length - 1] ?? 0;
      }
    }
    return 0;
  }, 262);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 266: SetMessageQueue(cMsg) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetMessageQueue', 2, () => 1, 266);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 452: CreateWindowEx — 32 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreateWindowEx', 32, () => {
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
    const classNameRaw = emu.readArg16DWord(26);
    const dwExStyle = emu.readArg16DWord(28);

    const className = resolveClassName16(emu, classNameRaw, lpClassName);
    const windowName = lpWindowName ? emu.memory.readCString(lpWindowName) : '';

    // Windows adjusts style: WS_SYSMENU implies WS_CAPTION
    const WS_CAPTION_EX = 0x00C00000;
    const WS_SYSMENU_EX = 0x00080000;
    let adjustedStyleEx = dwStyle;
    if ((dwStyle & WS_SYSMENU_EX) && !(dwStyle & WS_CAPTION_EX)) {
      adjustedStyleEx |= WS_CAPTION_EX;
    }

    const classInfo = emu.windowClasses.get(className.toUpperCase());
    // Sign-extend 16-bit values for positions (can be negative)
    const sx = (x << 16 >> 16);  // signed x
    const sy = (y << 16 >> 16);  // signed y
    const sw = (w << 16 >> 16);  // signed width
    const sh = (height << 16 >> 16); // signed height
    const CW_USEDEFAULT = -0x8000; // 0x8000 sign-extended = -32768
    // MDICLIENT is always visible in practice (container for MDI children)
    const isMDIClient = className.toUpperCase() === 'MDICLIENT';
    const hwnd = emu.handles.alloc('window', {
      classInfo: classInfo || { className, wndProc: 0, rawWndProc: 0, style: 0, hbrBackground: isMDIClient ? 13 : 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: windowName,
      style: adjustedStyleEx,
      exStyle: dwExStyle,
      x: sx === CW_USEDEFAULT ? 0 : sx,
      y: sx === CW_USEDEFAULT ? 0 : sy,
      width: sw === CW_USEDEFAULT ? 320 : (sw < 0 ? 0 : sw),
      height: sw === CW_USEDEFAULT ? 200 : (sh < 0 ? 0 : sh),
      hMenu,
      parent: hWndParent,
      wndProc: classInfo?.wndProc || 0,
      rawWndProc: classInfo?.rawWndProc || 0,
      visible: isMDIClient || !!(dwStyle & 0x10000000),
      extraBytes: new Uint8Array(classInfo?.cbWndExtra || 0),
      children: new Map(),
    });
    { const w = emu.handles.get<WindowInfo>(hwnd); if (w) { w.hwnd = hwnd; if ((dwStyle & 0x10000000) || isMDIClient) { w.needsPaint = true; w.needsErase = true; } } }

    // Register child in parent's childList (mirrors Win32 create-window.ts)
    if (hWndParent) {
      const parentWnd = emu.handles.get<WindowInfo>(hWndParent);
      if (parentWnd) {
        if (!parentWnd.childList) parentWnd.childList = [];
        const wnd = emu.handles.get<WindowInfo>(hwnd);
        if (wnd) {
          const WS_CHILD = 0x40000000;
          if (dwStyle & WS_CHILD) {
            wnd.controlId = hMenu;
            if (!parentWnd.children) parentWnd.children = new Map();
            parentWnd.children.set(hMenu, hwnd);
          }
        }
        parentWnd.childList.push(hwnd);
      }
    }

    if (!emu.mainWindow && hWndParent === 0) {
      const wnd = emu.handles.get<WindowInfo>(hwnd);
      if (wnd) emu.promoteToMainWindow(hwnd, wnd);
    }

    if (classInfo?.wndProc) {
      const savedSP = emu.cpu.reg[4] & 0xFFFF;
      const cs = buildCreateStruct16(emu, emu.readArg16DWord(0), hInstance, hMenu, hWndParent,
        height, w, y, x, dwStyle, emu.readArg16DWord(22), emu.readArg16DWord(26), dwExStyle);
      if (cs) {
        sendCreateMessages16(emu, classInfo.wndProc, hwnd, cs);
      } else {
        emu.callWndProc16(classInfo.wndProc, hwnd, 0x0001, 0, 0);
      }
      emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | savedSP;
    }

    fixCcsPosition(emu, hwnd, hWndParent);

    return hwnd;
  }, 452);
}
