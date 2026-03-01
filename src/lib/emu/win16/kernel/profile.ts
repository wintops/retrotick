import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelProfile(kernel: Win16Module, emu: Emulator, _state: KernelState): void {

  function copyDefault(lpDefault: number, lpRetBuf: number, nSize: number): number {
    const src = emu.resolveFarPtr(lpDefault);
    const dst = emu.resolveFarPtr(lpRetBuf);
    if (!dst || nSize === 0) return 0;
    if (!src) {
      emu.memory.writeU8(dst, 0);
      return 0;
    }
    let len = 0;
    while (len < nSize - 1) {
      const ch = emu.memory.readU8(src + len);
      if (ch === 0) break;
      emu.memory.writeU8(dst + len, ch);
      len++;
    }
    emu.memory.writeU8(dst + len, 0);
    return len;
  }

  // --- Ordinal 57: GetProfileInt(str str s_word) — 10 bytes ---
  kernel.register('ord_57', 10, () => {
    const [lpAppName, lpKeyName, nDefault] = emu.readPascalArgs16([4, 4, 2]);
    return nDefault;
  });

  // --- Ordinal 58: GetProfileString(str str str ptr word) — 18 bytes ---
  kernel.register('ord_58', 18, () => {
    const [lpAppName, lpKeyName, lpDefault, lpRetBuf, nSize] = emu.readPascalArgs16([4, 4, 4, 4, 2]);
    return copyDefault(lpDefault, lpRetBuf, nSize);
  });

  // --- Ordinal 59: WriteProfileString(str str str) — 12 bytes ---
  kernel.register('ord_59', 12, () => 1);

  // --- Ordinal 127: GetPrivateProfileInt(str str s_word str) — 14 bytes ---
  kernel.register('ord_127', 14, () => {
    const [lpAppName, lpKeyName, nDefault] = emu.readPascalArgs16([4, 4, 2, 4]);
    return nDefault;
  });

  // --- Ordinal 128: GetPrivateProfileString(str str str ptr word str) — 22 bytes ---
  kernel.register('ord_128', 22, () => {
    const [lpAppName, lpKeyName, lpDefault, lpRetBuf, nSize, lpFileName] = emu.readPascalArgs16([4, 4, 4, 4, 2, 4]);
    return copyDefault(lpDefault, lpRetBuf, nSize);
  });

  // --- Ordinal 129: WritePrivateProfileString(str str str str) — 16 bytes ---
  kernel.register('ord_129', 16, () => 1);
}
