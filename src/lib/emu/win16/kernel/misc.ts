import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelMisc(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // ---- Equates ----
  // --- Ordinal 113: __AHSHIFT = 3 ---
  kernel.register('ord_113', 0, () => 3);
  // --- Ordinal 114: __AHINCR = 8 ---
  kernel.register('ord_114', 0, () => 8);
  // --- Ordinal 173: __ROMBIOS = 0 ---
  kernel.register('ord_173', 0, () => 0);
  // --- Ordinal 174: __A000H = 0 ---
  kernel.register('ord_174', 0, () => 0);
  // --- Ordinal 178: __WINFLAGS = 0x413 ---
  kernel.register('ord_178', 0, () => 0x0413);
  // --- Ordinal 179: __D000H = 0 ---
  kernel.register('ord_179', 0, () => 0);
  // --- Ordinal 181: __B000H = 0 ---
  kernel.register('ord_181', 0, () => 0);
  // --- Ordinal 182: __B800H = 0 ---
  kernel.register('ord_182', 0, () => 0);
  // --- Ordinal 183: __0000H = 0 ---
  kernel.register('ord_183', 0, () => 0);
  // --- Ordinal 190: __E000H = 0 ---
  kernel.register('ord_190', 0, () => 0);
  // --- Ordinal 193: __0040H = 0 ---
  kernel.register('ord_193', 0, () => 0);
  // --- Ordinal 194: __F000H = 0 ---
  kernel.register('ord_194', 0, () => 0);
  // --- Ordinal 195: __C000H = 0 ---
  kernel.register('ord_195', 0, () => 0);

  // ---- Debug/output ----
  // --- Ordinal 115: OutputDebugString(lpString) — 4 bytes (str) ---
  kernel.register('ord_115', 4, () => 0);

  // ---- Pointer validation ----
  // --- Ordinal 334: IsBadReadPtr(segptr word) — 6 bytes ---
  kernel.register('ord_334', 6, () => 0);
  // --- Ordinal 335: IsBadWritePtr(segptr word) — 6 bytes ---
  kernel.register('ord_335', 6, () => 0);
  // --- Ordinal 336: IsBadCodePtr(segptr) — 4 bytes ---
  kernel.register('ord_336', 4, () => 0);
  // --- Ordinal 337: IsBadStringPtr(segptr word) — 6 bytes ---
  kernel.register('ord_337', 6, () => 0);
  // --- Ordinal 346: IsBadHugeReadPtr(segptr long) — 8 bytes ---
  kernel.register('ord_346', 8, () => 0);
  // --- Ordinal 347: IsBadHugeWritePtr(segptr long) — 8 bytes ---
  kernel.register('ord_347', 8, () => 0);

  // ---- Misc stubs ----
  // --- Ordinal 100: ValidateCodeSegments() — 0 bytes ---
  kernel.register('ord_100', 0, () => 0);
  // --- Ordinal 104: GetCodeInfo(segptr ptr) — 8 bytes ---
  kernel.register('ord_104', 8, () => 0);
  // --- Ordinal 106: SetSwapAreaSize(word) — 2 bytes ---
  kernel.register('ord_106', 2, () => emu.readArg16(0));
  // --- Ordinal 123: KbdRst() — 0 bytes ---
  kernel.register('ord_123', 0, () => 0);
  // --- Ordinal 124: EnableKernel() — 0 bytes ---
  kernel.register('ord_124', 0, () => 0);
  // --- Ordinal 125: DisableKernel() — 0 bytes ---
  kernel.register('ord_125', 0, () => 0);
  // --- Ordinal 138: GetHeapSpaces(word) — 2 bytes ---
  kernel.register('ord_138', 2, () => (0x2000 << 16) | 0x4000);
  // --- Ordinal 149: GetVersionEx(ptr) — 4 bytes ---
  kernel.register('ord_149', 4, () => 1);
  // --- Ordinal 156: LimitEMSPages(long) — 4 bytes ---
  kernel.register('ord_156', 4, () => 0);
  // --- Ordinal 157: GetCurPID(long) — 4 bytes ---
  kernel.register('ord_157', 4, () => 0);
  // --- Ordinal 158: IsWinOldApTask(word) — 2 bytes ---
  kernel.register('ord_158', 2, () => 0);
  // --- Ordinal 165: A20Proc(word) — 2 bytes ---
  kernel.register('ord_165', 2, () => 0);
  // --- Ordinal 180: LongPtrAdd(long long) — 8 bytes ---
  kernel.register('ord_180', 8, () => {
    const [ptr, offset] = emu.readPascalArgs16([4, 4]);
    return (ptr + offset) >>> 0;
  });
  // --- Ordinal 200: ValidateFreeSpaces() — 0 bytes ---
  kernel.register('ord_200', 0, () => 0);
  // --- Ordinal 207: IsDBCSLeadByte(word) — 2 bytes ---
  kernel.register('ord_207', 2, () => 0);
  // --- Ordinal 354: GetAppCompatFlags(word) — 2 bytes ---
  kernel.register('ord_354', 2, () => 0);

  // ---- Owner management ----
  // --- Ordinal 403: FarSetOwner(word word) — 4 bytes ---
  kernel.register('ord_403', 4, () => 0);
  // --- Ordinal 404: FarGetOwner(word) — 2 bytes ---
  kernel.register('ord_404', 2, () => 0);

  // ---- Missing ordinal stubs ----
  // --- Ordinal 98: GetLastDiskChange — 0 bytes ---
  kernel.register('ord_98', 0, () => 0);
  // --- Ordinal 99: GetLPErrMode — 0 bytes ---
  kernel.register('ord_99', 0, () => 0);
  // --- Ordinal 101: NoHookDosCall — 0 bytes ---
  kernel.register('ord_101', 0, () => 0);
  // --- Ordinal 103: NetBIOSCall — 0 bytes ---
  kernel.register('ord_103', 0, () => 0);
  // --- Ordinal 116: InitLib — 0 bytes ---
  kernel.register('ord_116', 0, () => 0);
  // --- Ordinal 120: UndefDynLink — 0 bytes ---
  kernel.register('ord_120', 0, () => 0);
  // --- Ordinal 126: MemoryFreed — 0 bytes ---
  kernel.register('ord_126', 0, () => 0);
  // --- Ordinal 130: FileCDR — 6 bytes ---
  kernel.register('ord_130', 6, () => 0);
  // --- Ordinal 141: CreateDirectory(str ptr) — 8 bytes ---
  kernel.register('ord_141', 8, () => 0);
  // --- Ordinal 142: RemoveDirectory(str) — 4 bytes ---
  kernel.register('ord_142', 4, () => 0);
  // --- Ordinal 143: DeleteFile(str) — 4 bytes ---
  kernel.register('ord_143', 4, () => 0);
  // --- Ordinal 144: SetLastError(long) — 4 bytes ---
  // (duplicate ordinal for compat; use same as ord_147)
  kernel.register('ord_144', 4, () => 0);
  // --- Ordinal 145: GetLastError() — 0 bytes ---
  kernel.register('ord_145', 0, () => 0);
  // --- Ordinal 146: GetCurrentDirectory(word ptr) — 6 bytes ---
  kernel.register('ord_146', 6, () => 0);
  // --- Ordinal 151: WinOldApCall — 0 bytes ---
  kernel.register('ord_151', 0, () => 0);
  // --- Ordinal 160: EMSCopy — 0 bytes ---
  kernel.register('ord_160', 0, () => 0);

  // ---- WinNT/WOW extensions ----
  // --- Ordinal 262: WOWWaitForMsgAndEvent(word) — 2 bytes ---
  kernel.register('ord_262', 2, () => 0);
  // --- Ordinal 263: WOWMsgBox — 0 bytes ---
  kernel.register('ord_263', 0, () => 0);
  // --- Ordinal 273: K273 — 0 bytes ---
  kernel.register('ord_273', 0, () => 0);

  // --- Ordinal 274: GetShortPathName(str ptr word) — 10 bytes ---
  kernel.register('ord_274', 10, () => {
    const [lpszLongPath, lpszShortPath, cchBuffer] = emu.readPascalArgs16([4, 4, 2]);
    const src = emu.resolveFarPtr(lpszLongPath);
    const dst = emu.resolveFarPtr(lpszShortPath);
    if (src && dst && cchBuffer > 0) {
      let i = 0;
      while (i < cchBuffer - 1) {
        const ch = emu.memory.readU8(src + i);
        emu.memory.writeU8(dst + i, ch);
        if (ch === 0) return i;
        i++;
      }
      emu.memory.writeU8(dst + i, 0);
      return i;
    }
    return 0;
  });

  // ---- WinNT 32-bit thunk extensions ----
  // --- Ordinal 513: LoadLibraryEx32W(ptr long long) — 12 bytes ---
  kernel.register('ord_513', 12, () => 0);
  // --- Ordinal 514: FreeLibrary32W(long) — 4 bytes ---
  kernel.register('ord_514', 4, () => 1);
  // --- Ordinal 515: GetProcAddress32W(long str) — 8 bytes ---
  kernel.register('ord_515', 8, () => 0);
  // --- Ordinal 516: GetVDMPointer32W(segptr word) — 6 bytes ---
  kernel.register('ord_516', 6, () => 0);
}
