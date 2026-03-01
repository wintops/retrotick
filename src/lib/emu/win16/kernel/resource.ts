import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelResource(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // --- Ordinal 60: FindResource(hInst, lpName, lpType) — 10 bytes (word+str+str) ---
  kernel.register('ord_60', 10, () => {
    const [hInst, lpName, lpType] = emu.readPascalArgs16([2, 4, 4]);
    const nameSeg = (lpName >>> 16) & 0xFFFF;
    const nameOff = lpName & 0xFFFF;
    const resId = (nameSeg === 0) ? nameOff : 0;
    const typeSeg = (lpType >>> 16) & 0xFFFF;
    const typeOff = lpType & 0xFFFF;
    const typeId = (typeSeg === 0) ? typeOff : 0;
    return ((typeId & 0xFF) << 8) | (resId & 0xFF) || 1;
  });

  // --- Ordinal 61: LoadResource(hInst, hResInfo) — 4 bytes (word+word) ---
  kernel.register('ord_61', 4, () => {
    const [hInst, hResInfo] = emu.readPascalArgs16([2, 2]);
    return hResInfo || 1;
  });

  // --- Ordinal 62: LockResource(hResData) — 2 bytes (word) ---
  kernel.register('ord_62', 2, () => emu.readArg16(0));

  // --- Ordinal 63: FreeResource(hResData) — 2 bytes (word) ---
  kernel.register('ord_63', 2, () => 0);

  // --- Ordinal 64: AccessResource(word word) — 4 bytes ---
  kernel.register('ord_64', 4, () => -1);

  // --- Ordinal 65: SizeofResource(word word) — 4 bytes ---
  kernel.register('ord_65', 4, () => 0);

  // --- Ordinal 66: AllocResource(word word long) — 8 bytes (word+word+long) ---
  kernel.register('ord_66', 8, () => 0);

  // --- Ordinal 67: SetResourceHandler(word str segptr) — 10 bytes (word+str+segptr) ---
  kernel.register('ord_67', 10, () => 0);
}
