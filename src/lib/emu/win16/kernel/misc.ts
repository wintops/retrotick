import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelMisc(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // ---- Equates ----
  // --- Ordinal 113: __AHSHIFT = 3 ---
  kernel.register('__AHSHIFT', 0, () => 3, 113);
  // --- Ordinal 114: __AHINCR = 8 ---
  kernel.register('__AHINCR', 0, () => 8, 114);
  // --- Ordinal 173: __ROMBIOS = 0 ---
  kernel.register('__ROMBIOS', 0, () => 0, 173);
  // --- Ordinal 174: __A000H = 0 ---
  kernel.register('__A000H', 0, () => 0, 174);
  // --- Ordinal 178: __WINFLAGS = 0x413 ---
  kernel.register('__WINFLAGS', 0, () => 0x0413, 178);
  // --- Ordinal 179: __D000H = 0 ---
  kernel.register('__D000H', 0, () => 0, 179);
  // --- Ordinal 181: __B000H = 0 ---
  kernel.register('__B000H', 0, () => 0, 181);
  // --- Ordinal 182: __B800H = 0 ---
  kernel.register('__B800H', 0, () => 0, 182);
  // --- Ordinal 183: __0000H = 0 ---
  kernel.register('__0000H', 0, () => 0, 183);
  // --- Ordinal 190: __E000H = 0 ---
  kernel.register('__E000H', 0, () => 0, 190);
  // --- Ordinal 193: __0040H = 0 ---
  kernel.register('__0040H', 0, () => 0, 193);
  // --- Ordinal 194: __F000H = 0 ---
  kernel.register('__F000H', 0, () => 0, 194);
  // --- Ordinal 195: __C000H = 0 ---
  kernel.register('__C000H', 0, () => 0, 195);

  // ---- Debug/output ----
  // --- Ordinal 115: OutputDebugString(lpString) — 4 bytes (str) ---
  kernel.register('OutputDebugString', 4, () => 0, 115);

  // ---- Pointer validation ----
  // --- Ordinal 334: IsBadReadPtr(segptr word) — 6 bytes ---
  kernel.register('IsBadReadPtr', 6, () => 0, 334);
  // --- Ordinal 335: IsBadWritePtr(segptr word) — 6 bytes ---
  kernel.register('IsBadWritePtr', 6, () => 0, 335);
  // --- Ordinal 336: IsBadCodePtr(segptr) — 4 bytes ---
  kernel.register('IsBadCodePtr', 4, () => 0, 336);
  // --- Ordinal 337: IsBadStringPtr(segptr word) — 6 bytes ---
  kernel.register('IsBadStringPtr', 6, () => 0, 337);
  // --- Ordinal 346: IsBadHugeReadPtr(segptr long) — 8 bytes ---
  kernel.register('IsBadHugeReadPtr', 8, () => 0, 346);
  // --- Ordinal 347: IsBadHugeWritePtr(segptr long) — 8 bytes ---
  kernel.register('IsBadHugeWritePtr', 8, () => 0, 347);

  // ---- Misc stubs ----
  // --- Ordinal 100: ValidateCodeSegments() — 0 bytes ---
  kernel.register('ValidateCodeSegments', 0, () => 0, 100);
  // --- Ordinal 104: GetCodeInfo(segptr ptr) — 8 bytes ---
  kernel.register('GetCodeInfo', 8, () => 0, 104);
  // --- Ordinal 106: SetSwapAreaSize(word) — 2 bytes ---
  kernel.register('SetSwapAreaSize', 2, () => emu.readArg16(0), 106);
  // --- Ordinal 123: KbdRst() — 0 bytes ---
  kernel.register('KbdRst', 0, () => 0, 123);
  // --- Ordinal 124: EnableKernel() — 0 bytes ---
  kernel.register('EnableKernel', 0, () => 0, 124);
  // --- Ordinal 125: DisableKernel() — 0 bytes ---
  kernel.register('DisableKernel', 0, () => 0, 125);
  // --- Ordinal 138: GetHeapSpaces(word) — 2 bytes ---
  kernel.register('GetHeapSpaces', 2, () => (0x2000 << 16) | 0x4000, 138);
  // --- Ordinal 149: GetVersionEx(ptr) — 4 bytes ---
  kernel.register('GetVersionEx', 4, () => 1, 149);
  // --- Ordinal 156: LimitEMSPages(long) — 4 bytes ---
  kernel.register('LimitEMSPages', 4, () => 0, 156);
  // --- Ordinal 157: GetCurPID(long) — 4 bytes ---
  kernel.register('GetCurPID', 4, () => 0, 157);
  // --- Ordinal 158: IsWinOldApTask(word) — 2 bytes ---
  kernel.register('IsWinOldApTask', 2, () => 0, 158);
  // --- Ordinal 165: A20Proc(word) — 2 bytes ---
  kernel.register('A20Proc', 2, () => 0, 165);
  // --- Ordinal 180: LongPtrAdd(long long) — 8 bytes ---
  kernel.register('LongPtrAdd', 8, () => {
    const [ptr, offset] = emu.readPascalArgs16([4, 4]);
    return (ptr + offset) >>> 0;
  }, 180);
  // --- Ordinal 200: ValidateFreeSpaces() — 0 bytes ---
  kernel.register('ValidateFreeSpaces', 0, () => 0, 200);
  // --- Ordinal 207: IsDBCSLeadByte(word) — 2 bytes ---
  kernel.register('IsDBCSLeadByte', 2, () => 0, 207);
  // --- Ordinal 354: GetAppCompatFlags(word) — 2 bytes ---
  kernel.register('GetAppCompatFlags', 2, () => 0, 354);

  // ---- Owner management ----
  // --- Ordinal 403: FarSetOwner(word word) — 4 bytes ---
  kernel.register('FarSetOwner', 4, () => 0, 403);
  // --- Ordinal 404: FarGetOwner(word) — 2 bytes ---
  kernel.register('FarGetOwner', 2, () => 0, 404);

  // ---- Missing ordinal stubs ----
  // --- Ordinal 98: GetLastDiskChange — 0 bytes ---
  kernel.register('GetLastDiskChange', 0, () => 0, 98);
  // --- Ordinal 99: GetLPErrMode — 0 bytes ---
  kernel.register('GetLPErrMode', 0, () => 0, 99);
  // --- Ordinal 101: NoHookDosCall — 0 bytes ---
  kernel.register('NoHookDosCall', 0, () => 0, 101);
  // --- Ordinal 103: NetBIOSCall — 0 bytes ---
  kernel.register('NetBIOSCall', 0, () => 0, 103);
  // --- Ordinal 116: InitLib — 0 bytes ---
  kernel.register('InitLib', 0, () => 0, 116);
  // --- Ordinal 120: UndefDynLink — 0 bytes ---
  kernel.register('UndefDynLink', 0, () => 0, 120);
  // --- Ordinal 126: MemoryFreed — 0 bytes ---
  kernel.register('MemoryFreed', 0, () => 0, 126);
  // --- Ordinal 130: FileCDR — 6 bytes ---
  kernel.register('FileCDR', 6, () => 0, 130);
  // --- Ordinal 141: InitTask1(str ptr) — 8 bytes ---
  kernel.register('InitTask1', 8, () => 0, 141);
  // --- Ordinal 142: GetProfileSectionNames(lpBuffer:ptr, nSize:word) — 6 bytes ---
  kernel.register('GetProfileSectionNames', 6, () => {
    const [lpBufRaw, nSize] = emu.readPascalArgs16([4, 2]);
    const dst = emu.resolveFarPtr(lpBufRaw);
    if (!dst || nSize === 0) return 0;
    const s = emu.profileStore;
    const names = s ? s.getSectionNames('win.ini') : [];
    let pos = 0;
    for (const name of names) {
      if (pos + name.length + 1 >= nSize - 1) break;
      for (let i = 0; i < name.length; i++) emu.memory.writeU8(dst + pos++, name.charCodeAt(i));
      emu.memory.writeU8(dst + pos++, 0);
    }
    emu.memory.writeU8(dst + pos, 0);
    return pos;
  }, 142);
  // --- Ordinal 143: GetPrivateProfileSectionNames(lpBuffer:ptr, nSize:word, lpFileName:str) — 10 bytes ---
  kernel.register('GetPrivateProfileSectionNames', 10, () => {
    const [lpBufRaw, nSize, lpFileNameRaw] = emu.readPascalArgs16([4, 2, 4]);
    const dst = emu.resolveFarPtr(lpBufRaw);
    if (!dst || nSize === 0) return 0;
    const lpFileName = emu.resolveFarPtr(lpFileNameRaw);
    const file = lpFileName ? emu.memory.readCString(lpFileName) : 'win.ini';
    const s = emu.profileStore;
    const names = s ? s.getSectionNames(file) : [];
    let pos = 0;
    for (const name of names) {
      if (pos + name.length + 1 >= nSize - 1) break;
      for (let i = 0; i < name.length; i++) emu.memory.writeU8(dst + pos++, name.charCodeAt(i));
      emu.memory.writeU8(dst + pos++, 0);
    }
    emu.memory.writeU8(dst + pos, 0);
    return pos;
  }, 143);
  // --- Ordinal 144: CreateDirectory(long) — 4 bytes ---
  // (duplicate ordinal for compat; use same as ord_147)
  kernel.register('CreateDirectory', 4, () => 0, 144);
  // --- Ordinal 145: RemoveDirectory() — 0 bytes ---
  kernel.register('RemoveDirectory', 0, () => 0, 145);
  // --- Ordinal 146: DeleteFile(word ptr) — 6 bytes ---
  kernel.register('DeleteFile', 6, () => 0, 146);
  // --- Ordinal 151: WinOldApCall — 0 bytes ---
  kernel.register('WinOldApCall', 0, () => 0, 151);
  // --- Ordinal 160: EMSCopy — 0 bytes ---
  kernel.register('EMSCopy', 0, () => 0, 160);

  // --- Ordinal 158: IsWinOldApTask(hTask) — 2 bytes ---
  kernel.register('IsWinOldApTask', 2, () => 0, 158);
  // --- Ordinal 328: _DebugOutput(sel) — 2 bytes ---
  kernel.register('_DebugOutput', 2, () => 0, 328);

  // ---- WinNT/WOW extensions ----
  // --- Ordinal 262: WOWWaitForMsgAndEvent(word) — 2 bytes ---
  kernel.register('WOWWaitForMsgAndEvent', 2, () => 0, 262);
  // --- Ordinal 263: WOWMsgBox — 0 bytes ---
  kernel.register('WOWMsgBox', 0, () => 0, 263);
  // --- Ordinal 273: K273 — 0 bytes ---
  kernel.register('K273', 0, () => 0, 273);

  // --- Ordinal 274: GetShortPathName(str ptr word) — 10 bytes ---
  kernel.register('GetShortPathName', 10, () => {
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
  }, 274);

  // ---- WinNT 32-bit thunk extensions ----
  // --- Ordinal 513: LoadLibraryEx32W(ptr long long) — 12 bytes ---
  kernel.register('LoadLibraryEx32W', 12, () => 0, 513);
  // --- Ordinal 514: FreeLibrary32W(long) — 4 bytes ---
  kernel.register('FreeLibrary32W', 4, () => 1, 514);
  // --- Ordinal 515: GetProcAddress32W(long str) — 8 bytes ---
  kernel.register('GetProcAddress32W', 8, () => 0, 515);
  // --- Ordinal 516: GetVDMPointer32W(segptr word) — 6 bytes ---
  kernel.register('GetVDMPointer32W', 6, () => 0, 516);
}
