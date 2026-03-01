import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelModule(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 27: GetModuleName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('ord_27', 8, () => 0);

  // --- Ordinal 45: LoadModule(str ptr) — 8 bytes (long+long) ---
  kernel.register('ord_45', 8, () => 2);

  // --- Ordinal 46: FreeModule(word) — 2 bytes ---
  kernel.register('ord_46', 2, () => 1);

  // --- Ordinal 47: GetModuleHandle(lpModuleName_ptr) — 4 bytes (segstr) ---
  kernel.register('ord_47', 4, () => {
    const lpName = emu.readArg16DWord(0);
    if (!lpName) return 0;
    const addr = emu.resolveFarPtr(lpName);
    const name = addr ? emu.memory.readCString(addr).toUpperCase() : '';
    // Check known modules
    const handle = state.moduleHandles.get(name);
    if (handle !== undefined) return handle;
    // Strip extension and try again
    const baseName = name.replace(/\.\w+$/, '');
    const h2 = state.moduleHandles.get(baseName);
    if (h2 !== undefined) return h2;
    // Return fake handle for KERNEL, USER, GDI etc.
    if (baseName === 'KERNEL' || baseName === 'USER' || baseName === 'GDI') return 1;
    return 0;
  });

  // --- Ordinal 48: GetModuleUsage(hModule) — 2 bytes (word) ---
  kernel.register('ord_48', 2, () => 1);

  // --- Ordinal 49: GetModuleFileName(hModule, lpFilename, nSize) — 8 bytes (word+ptr+s_word) ---
  kernel.register('ord_49', 8, () => {
    const [hModule, lpFilename, nSize] = emu.readPascalArgs16([2, 4, 2]);
    const name = emu.exePath;
    const buf = emu.resolveFarPtr(lpFilename);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(name.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(buf + i, name.charCodeAt(i));
      }
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 50: GetProcAddress(hModule, lpProcName_str) — 6 bytes (word+str) ---
  kernel.register('ord_50', 6, () => 0);

  // --- Ordinal 51: MakeProcInstance(lpProc_segptr, hInstance) — 6 bytes (segptr+word) ---
  kernel.register('ord_51', 6, () => {
    const [lpProc] = emu.readPascalArgs16([4, 2]);
    return lpProc;
  });

  // --- Ordinal 52: FreeProcInstance(lpProc_segptr) — 4 bytes (segptr) ---
  kernel.register('ord_52', 4, () => 0);

  // --- Ordinal 53: CallProcInstance — 4 bytes, return arg ---
  kernel.register('ord_53', 4, () => emu.readArg16DWord(0));

  // --- Ordinal 54: GetInstanceData(hInstance, pData, nCount) — 6 bytes (word+word+word) ---
  kernel.register('ord_54', 6, () => 0);

  // --- Ordinal 93: GetCodeHandle(lpProc) — 4 bytes (segptr) ---
  kernel.register('ord_93', 4, () => {
    const lpProc = emu.readArg16DWord(0);
    return (lpProc >>> 16) & 0xFFFF;
  });

  // --- Ordinal 94: DefineHandleTable(wOffset) — 2 bytes (word) ---
  kernel.register('ord_94', 2, () => 1);

  // --- Ordinal 95: LoadLibrary(lpLibFileName) — 4 bytes (str) ---
  kernel.register('ord_95', 4, () => {
    const lpLibFileName = emu.readArg16DWord(0);
    const name = lpLibFileName ? emu.memory.readCString(emu.resolveFarPtr(lpLibFileName)) : '';
    console.log(`[KERNEL16] LoadLibrary("${name}") → stub`);
    return 32;
  });

  // --- Ordinal 96: FreeLibrary(hLibModule) — 2 bytes (word) ---
  kernel.register('ord_96', 2, () => 0);

  // --- Ordinal 133: GetExePtr(word) — 2 bytes ---
  kernel.register('ord_133', 2, () => emu.readArg16(0));

  // --- Ordinal 166: WinExec(lpCmdLine, uCmdShow) — 6 bytes (str+word) ---
  kernel.register('ord_166', 6, () => 33);
}
