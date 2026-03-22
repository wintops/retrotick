import type { Emulator } from '../emulator';
import type { WindowInfo } from '../win32/user32/types';
import { getClientSize } from '../win32/user32/_helpers';

// Win16 COMMCTRL module (Common Controls)
// Winfile imports this for toolbar/status bar support

export function registerWin16Commctrl(emu: Emulator): void {
  const cc = emu.registerModule16('COMMCTRL');

  // Ordinal 2: InitCommonControls() — 0 bytes
  cc.register('InitCommonControls', 0, () => 0, 2);

  // Ordinal 4: CreatePropertySheetPage(lppsp) — 4 bytes (ptr)
  cc.register('CreatePropertySheetPage', 4, () => 0, 4);

  // Ordinal 5: CreateStatusWindow(style:4, lpszText:4, hwndParent:2, wID:2) — 12 bytes
  // Win16 PASCAL: pushed right-to-left, cleaned by callee
  cc.register('CreateStatusWindow', 14, () => {
    const [style, lpszText, hwndParent, wID] = emu.readPascalArgs16([4, 4, 2, 2]);
    const text = lpszText ? emu.memory.readCString(lpszText) : '';
    const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
    const parentCh = parentWnd ? getClientSize(parentWnd.style, parentWnd.hMenu !== 0, parentWnd.width, parentWnd.height, true).ch : 240;
    const STATUS_HEIGHT = 20;
    const WS_VISIBLE = 0x10000000;

    // Use registered class from COMMCTRL x86 LibMain (try both names)
    const registeredClass = emu.windowClasses.get('MSCTLS_STATUSBAR') || emu.windowClasses.get('MSCTLS_STATUSBAR32');
    const classInfo = registeredClass
      ? { ...registeredClass }
      : { className: 'MSCTLS_STATUSBAR32', style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0 };
    const cbExtra = Math.max(registeredClass?.cbWndExtra ?? 0, 4);

    const wnd: WindowInfo = {
      hwnd: 0,
      classInfo,
      wndProc: classInfo.wndProc || 0, parent: hwndParent,
      x: 0, y: parentCh - STATUS_HEIGHT, width: parentWnd?.width || 320, height: STATUS_HEIGHT,
      style: style | WS_VISIBLE | 0x40000000, exStyle: 0, title: text, visible: true,
      hMenu: 0, extraBytes: new Uint8Array(cbExtra), userData: 0, controlId: wID,
      statusTexts: text ? [text] : [],
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    if (parentWnd) {
      if (!parentWnd.children) parentWnd.children = new Map();
      parentWnd.children.set(wID, hwnd);
      if (!parentWnd.childList) parentWnd.childList = [];
      parentWnd.childList.push(hwnd);
    }
    return hwnd;
  }, 5);

  // Ordinal 6: CreateToolbar(hwndParent:2, ws:4, wID:2, nBitmaps:2, hBMInst:2, wBMID:2, lpButtons:4, iNumButtons:2)
  // Total stack: 2+4+2+2+2+2+4+2 = 20 bytes (stub declared 28 — extra padding or extended params)
  cc.register('CreateToolbar', 28, () => {
    const [hwndParent, ws, wID, _nBitmaps, _hBMInst, _wBMID, _lpButtons, _iNumButtons] =
      emu.readPascalArgs16([2, 4, 2, 2, 2, 2, 4, 2]);
    const parentWnd = emu.handles.get<WindowInfo>(hwndParent);
    const parentWidth = parentWnd?.width || 320;
    const TOOLBAR_HEIGHT = 27; // standard Win3.1 toolbar height
    const WS_VISIBLE = 0x10000000;

    // Use the class registered by COMMCTRL's x86 LibMain (has correct wndProc + hInstance for DS)
    const registeredClass = emu.windowClasses.get('TOOLBARWINDOW');
    const classInfo = registeredClass
      ? { ...registeredClass }
      : { className: 'ToolbarWindow', style: 0, wndProc: 0, cbClsExtra: 0, cbWndExtra: 0, hInstance: 0, hIcon: 0, hCursor: 0, hbrBackground: 0, menuName: 0 };
    const cbExtra = Math.max(registeredClass?.cbWndExtra ?? 0, 8);

    const wnd: WindowInfo = {
      hwnd: 0,
      classInfo,
      wndProc: classInfo.wndProc || 0, parent: hwndParent,
      x: 0, y: 0, width: parentWidth, height: TOOLBAR_HEIGHT,
      style: ws | WS_VISIBLE | 0x40000000, exStyle: 0, title: '', visible: !!(ws & WS_VISIBLE),
      hMenu: 0, extraBytes: new Uint8Array(cbExtra), userData: 0, controlId: wID,
    };
    const hwnd = emu.handles.alloc('window', wnd);
    wnd.hwnd = hwnd;
    if (parentWnd) {
      if (!parentWnd.children) parentWnd.children = new Map();
      parentWnd.children.set(wID, hwnd);
      if (!parentWnd.childList) parentWnd.childList = [];
      parentWnd.childList.push(hwnd);
    }
    return hwnd;
  }, 6);

  // Ordinal 7: CreateHeaderWindow — 14 bytes
  cc.register('CreateHeaderWindow', 14, () => 0, 7);

  // Ordinal 13: MenuHelp — 18 bytes
  cc.register('MenuHelp', 18, () => 0, 13);

  // Ordinal 14: ShowHideMenuCtl — 8 bytes
  cc.register('ShowHideMenuCtl', 8, () => 0, 14);

  // Ordinal 15: GetEffectiveClientRect(hWnd:2, lpRect:4, lpInfo:4) — 10 bytes
  // Wine algorithm: GetClientRect, then for each control ID in lpInfo,
  // subtract visible child window rects (mapped to client coordinates).
  // lpInfo format: pairs of (BOOL visible, UINT id), terminated by id==0.
  // The function skips the first pair, then processes remaining pairs.
  cc.register('GetEffectiveClientRect', 10, () => {
    const [hWnd, lpRect, lpInfo] = emu.readPascalArgs16([2, 4, 4]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd && lpRect) {
      const { cw, ch } = getClientSize(wnd.style, wnd.hMenu !== 0, wnd.width, wnd.height, true);
      // Start with full client rect
      let left = 0, top = 0, right = cw, bottom = ch;

      if (lpInfo) {
        // Walk the lpInfo array: skip first 2 WORDs, then read pairs
        let ptr = lpInfo;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          ptr += 4; // skip 2 WORDs (visible flag + padding)
          const checkVal = emu.memory.readU16(ptr);
          if (checkVal === 0) break; // terminator
          ptr += 2;
          const controlId = emu.memory.readU16(ptr);
          ptr += 2;
          // Find child by control ID (same as GetDlgItem)
          const childHwnd = wnd.children?.get(controlId) ?? 0;
          if (childHwnd) {
            const child = emu.handles.get<WindowInfo>(childHwnd);
            const WS_VISIBLE = 0x10000000;
            if (child && (child.style & WS_VISIBLE)) {
              // Child coords are already parent-client-relative
              const cl = child.x, ct = child.y;
              const cr = cl + child.width, cb = ct + child.height;
              // SubtractRect: remove child rect from effective rect
              if (cl <= left && cr >= right) {
                // Child spans full width — subtract from top or bottom
                if (ct <= top) top = Math.max(top, cb);
                else if (cb >= bottom) bottom = Math.min(bottom, ct);
              } else if (ct <= top && cb >= bottom) {
                // Child spans full height — subtract from left or right
                if (cl <= left) left = Math.max(left, cr);
                else if (cr >= right) right = Math.min(right, cl);
              }
            }
          }
        }
      }

      emu.memory.writeU16(lpRect, left & 0xFFFF);          // left
      emu.memory.writeU16(lpRect + 2, top & 0xFFFF);       // top
      emu.memory.writeU16(lpRect + 4, right & 0xFFFF);     // right
      emu.memory.writeU16(lpRect + 6, bottom & 0xFFFF);    // bottom
    }
    return 0;
  }, 15);

  // Ordinal 16: DrawStatusText(hDC, lpRect, lpString, uFlags) — 14 bytes
  cc.register('DrawStatusText', 14, () => 0, 16);

  // Ordinal 17: CreateUpDownControl — 24 bytes
  cc.register('CreateUpDownControl', 24, () => 0, 17);
}
