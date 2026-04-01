import type { Emulator } from '../../emulator';
import type { WindowInfo } from './types';

export function registerFocus(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  let focusedHwnd = 0;

  user32.register('GetFocus', 0, () => {
    // If focus is on a child window, return it directly
    if (focusedHwnd) {
      const wnd = emu.handles.get<WindowInfo>(focusedHwnd);
      if (wnd && (wnd.style & 0x40000000)) return focusedHwnd; // WS_CHILD
    }
    // If focus is on a top-level window or not set, return the first visible child
    // (in real Windows, SetFocus on a parent propagates to a child)
    const parentHwnd = focusedHwnd || emu.mainWindow;
    const parentWnd = emu.handles.get<WindowInfo>(parentHwnd);
    if (parentWnd?.childList) {
      for (const childHwnd of parentWnd.childList) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child?.visible) return childHwnd;
      }
    }
    return focusedHwnd;
  });

  user32.register('SetFocus', 1, () => {
    const hwnd = emu.readArg(0);
    const prev = focusedHwnd;
    focusedHwnd = hwnd;
    return prev;
  });

  user32.register('GetActiveWindow', 0, () => emu.mainWindow || 0);
  user32.register('SetActiveWindow', 1, () => emu.readArg(0));
  user32.register('GetForegroundWindow', 0, () => emu.mainWindow || 0);
  user32.register('SetForegroundWindow', 1, () => 1);
}
