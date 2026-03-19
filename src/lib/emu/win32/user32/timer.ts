import type { Emulator } from '../../emulator';
import { WM_TIMER } from '../types';

export function registerTimer(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  user32.register('SetTimer', 4, () => {
    const hwnd = emu.readArg(0);
    const timerId = emu.readArg(1);
    const elapse = emu.readArg(2);
    const timerFunc = emu.readArg(3);
    console.log(`[TIMER] SetTimer hwnd=0x${hwnd.toString(16)} id=${timerId} elapse=${elapse} timerFunc=0x${timerFunc.toString(16)}`);

    // Clear existing timer with same ID
    emu.clearWin32Timer(hwnd, timerId);

    const jsTimer = globalThis.setInterval(() => {
      // lParam = timerFunc so DispatchMessage can call the callback
      emu.postMessage(hwnd, WM_TIMER, timerId, timerFunc);
    }, elapse);

    emu.setWin32Timer(hwnd, timerId, jsTimer);
    return timerId;
  });

  user32.register('KillTimer', 2, () => {
    const hwnd = emu.readArg(0);
    const timerId = emu.readArg(1);
    emu.clearWin32Timer(hwnd, timerId);
    return 1;
  });
}
