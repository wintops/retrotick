import type { Emulator } from '../emulator';

// Win16 SCONFIG module — Winfile configuration module
// This is a Winfile-specific DLL; register the module so its imports
// get proper stackBytes instead of defaulting to 0.

export function registerWin16Sconfig(emu: Emulator): void {
  const sc = emu.registerModule16('SCONFIG');

  // Ordinal 12: unknown function — likely a config query
  // 4 bytes is a safe estimate (single ptr or dword argument)
  sc.register('ord_12', 4, () => 0, 12);
}
