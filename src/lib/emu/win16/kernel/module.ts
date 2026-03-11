import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelModule(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 27: GetModuleName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('GetModuleName', 8, () => 0, 27);

  // --- Ordinal 45: LoadModule(str ptr) — 8 bytes (long+long) ---
  kernel.register('LoadModule', 8, () => 2, 45);

  // --- Ordinal 46: FreeModule(word) — 2 bytes ---
  kernel.register('FreeModule', 2, () => 1, 46);

  // --- Ordinal 47: GetModuleHandle(lpModuleName_ptr) — 4 bytes (segstr) ---
  kernel.register('GetModuleHandle', 4, () => {
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
  }, 47);

  // --- Ordinal 48: GetModuleUsage(hModule) — 2 bytes (word) ---
  kernel.register('GetModuleUsage', 2, () => 1, 48);

  // --- Ordinal 49: GetModuleFileName(hModule, lpFilename, nSize) — 8 bytes (word+ptr+s_word) ---
  kernel.register('GetModuleFileName', 8, () => {
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
  }, 49);

  // --- Ordinal 50: GetProcAddress(hModule, lpProcName_str) — 6 bytes (word+dword) ---
  kernel.register('GetProcAddress', 6, () => {
    const [hModule, lpProcName] = emu.readPascalArgs16([2, 4]);
    // lpProcName can be a far pointer to a string OR MAKEINTRESOURCE (high word = 0 → ordinal)
    const seg = (lpProcName >>> 16) & 0xFFFF;
    const off = lpProcName & 0xFFFF;
    let name = '';
    let ordinal = 0;
    if (seg === 0) {
      // Integer ordinal
      ordinal = off;
    } else {
      const linear = emu.resolveFarPtr(lpProcName);
      name = emu.memory.readCString(linear);
    }
    // Look up in loaded NE DLLs
    if (emu.ne) {
      for (const seg2 of emu.ne.segments) {
        // Check if this segment belongs to the module with handle hModule
      }
      // Search entry points for the ordinal/name
      if (ordinal > 0) {
        for (const [addr, info] of emu.ne.apiMap) {
          if (info.ordinal === ordinal) {
            // This is a thunk address, return it as a far pointer
            return addr;
          }
        }
      }
    }
    return 0;
  }, 50);

  // --- Ordinal 51: MakeProcInstance(lpProc_segptr, hInstance) — 6 bytes (segptr+word) ---
  kernel.register('MakeProcInstance', 6, () => {
    const [lpProc] = emu.readPascalArgs16([4, 2]);
    return lpProc;
  }, 51);

  // --- Ordinal 52: FreeProcInstance(lpProc_segptr) — 4 bytes (segptr) ---
  kernel.register('FreeProcInstance', 4, () => 0, 52);

  // --- Ordinal 53: CallProcInstance — 4 bytes, return arg ---
  kernel.register('CallProcInstance', 4, () => emu.readArg16DWord(0), 53);

  // --- Ordinal 54: GetInstanceData(hInstance, pData, nCount) — 6 bytes (word+word+word) ---
  kernel.register('GetInstanceData', 6, () => 0, 54);

  // --- Ordinal 93: GetCodeHandle(lpProc) — 4 bytes (segptr) ---
  kernel.register('GetCodeHandle', 4, () => {
    const lpProc = emu.readArg16DWord(0);
    return (lpProc >>> 16) & 0xFFFF;
  }, 93);

  // --- Ordinal 94: DefineHandleTable(wOffset) — 2 bytes (word) ---
  kernel.register('DefineHandleTable', 2, () => 1, 94);

  // --- Ordinal 95: LoadLibrary(lpLibFileName) — 4 bytes (str) ---
  kernel.register('LoadLibrary', 4, () => {
    const lpLibFileName = emu.readArg16DWord(0);
    const name = lpLibFileName ? emu.memory.readCString(emu.resolveFarPtr(lpLibFileName)) : '';
    console.log(`[KERNEL16] LoadLibrary("${name}") → stub`);
    return 32;
  }, 95);

  // --- Ordinal 96: FreeLibrary(hLibModule) — 2 bytes (word) ---
  kernel.register('FreeLibrary', 2, () => 0, 96);

  // --- Ordinal 133: GetExePtr(word) — 2 bytes ---
  kernel.register('GetExePtr', 2, () => emu.readArg16(0), 133);

  // --- Ordinal 166: WinExec(lpCmdLine, uCmdShow) — 6 bytes (str+word) ---
  kernel.register('WinExec', 6, () => 33, 166);
}
