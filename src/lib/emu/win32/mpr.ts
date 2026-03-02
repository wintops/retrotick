import type { Emulator } from '../emulator';

export function registerMpr(emu: Emulator): void {
  const mpr = emu.registerDll('MPR.DLL');
  mpr.register('WNetGetConnectionA', 3, () => 0x000004B0); // ERROR_NOT_CONNECTED (1200)
}
