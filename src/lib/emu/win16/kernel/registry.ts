import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelRegistry(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // --- Ordinal 216: RegEnumKey(long long ptr long) — 16 bytes ---
  kernel.register('RegEnumKey', 16, () => 259, 216);

  // --- Ordinal 217: RegOpenKey(long str ptr) — 12 bytes ---
  kernel.register('RegOpenKey', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(emu.resolveFarPtr(phkResult), 0xBEEF0001);
    return 0;
  }, 217);

  // --- Ordinal 218: RegCreateKey(long str ptr) — 12 bytes ---
  kernel.register('RegCreateKey', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(emu.resolveFarPtr(phkResult), 0xBEEF0002);
    return 0;
  }, 218);

  // --- Ordinal 219: RegDeleteKey(long str) — 8 bytes ---
  kernel.register('RegDeleteKey', 8, () => 0, 219);

  // --- Ordinal 220: RegCloseKey(long) — 4 bytes ---
  kernel.register('RegCloseKey', 4, () => 0, 220);

  // --- Ordinal 221: RegSetValue(long str long ptr long) — 20 bytes ---
  kernel.register('RegSetValue', 20, () => 0, 221);

  // --- Ordinal 222: RegDeleteValue(long str) — 8 bytes ---
  kernel.register('RegDeleteValue', 8, () => 0, 222);

  // --- Ordinal 223: RegEnumValue(long long ptr ptr ptr ptr ptr ptr) — 32 bytes ---
  kernel.register('RegEnumValue', 32, () => 259, 223);

  // --- Ordinal 224: RegQueryValue(long str ptr ptr) — 16 bytes ---
  kernel.register('RegQueryValue', 16, () => 2, 224);

  // --- Ordinal 225: RegQueryValueEx(long str ptr ptr ptr ptr) — 24 bytes ---
  kernel.register('RegQueryValueEx', 24, () => 2, 225);

  // --- Ordinal 226: RegSetValueEx(long str long long ptr long) — 24 bytes ---
  kernel.register('RegSetValueEx', 24, () => 0, 226);

  // --- Ordinal 227: RegFlushKey(long) — 4 bytes ---
  kernel.register('RegFlushKey', 4, () => 0, 227);
}
