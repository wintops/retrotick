import type { Emulator } from '../emulator';

export function registerMsimg32(emu: Emulator): void {
  const msimg32 = emu.registerDll('MSIMG32.DLL');
  msimg32.register('TransparentBlt', 11, () => 1);
  msimg32.register('AlphaBlend', 11, () => 1);
}
