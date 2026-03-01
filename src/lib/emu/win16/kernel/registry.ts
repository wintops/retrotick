import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelRegistry(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // --- Ordinal 216: RegEnumKey(long long ptr long) — 16 bytes ---
  kernel.register('ord_216', 16, () => 259);

  // --- Ordinal 217: RegOpenKey(long str ptr) — 12 bytes ---
  kernel.register('ord_217', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(emu.resolveFarPtr(phkResult), 0xBEEF0001);
    return 0;
  });

  // --- Ordinal 218: RegCreateKey(long str ptr) — 12 bytes ---
  kernel.register('ord_218', 12, () => {
    const [hKey, lpSubKey, phkResult] = emu.readPascalArgs16([4, 4, 4]);
    if (phkResult) emu.memory.writeU32(emu.resolveFarPtr(phkResult), 0xBEEF0002);
    return 0;
  });

  // --- Ordinal 219: RegDeleteKey(long str) — 8 bytes ---
  kernel.register('ord_219', 8, () => 0);

  // --- Ordinal 220: RegCloseKey(long) — 4 bytes ---
  kernel.register('ord_220', 4, () => 0);

  // --- Ordinal 221: RegSetValue(long str long ptr long) — 20 bytes ---
  kernel.register('ord_221', 20, () => 0);

  // --- Ordinal 222: RegDeleteValue(long str) — 8 bytes ---
  kernel.register('ord_222', 8, () => 0);

  // --- Ordinal 223: RegEnumValue(long long ptr ptr ptr ptr ptr ptr) — 32 bytes ---
  kernel.register('ord_223', 32, () => 259);

  // --- Ordinal 224: RegQueryValue(long str ptr ptr) — 16 bytes ---
  kernel.register('ord_224', 16, () => 2);

  // --- Ordinal 225: RegQueryValueEx(long str ptr ptr ptr ptr) — 24 bytes ---
  kernel.register('ord_225', 24, () => 2);

  // --- Ordinal 226: RegSetValueEx(long str long long ptr long) — 24 bytes ---
  kernel.register('ord_226', 24, () => 0);

  // --- Ordinal 227: RegFlushKey(long) — 4 bytes ---
  kernel.register('ord_227', 4, () => 0);
}
