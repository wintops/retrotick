import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

const WIN_INI = 'win.ini';

/** Write a double-null-terminated list of strings into a far pointer buffer (ANSI) */
function writeDoubleNullList16(emu: Emulator, items: string[], dstAddr: number, maxSize: number): number {
  let pos = 0;
  for (const item of items) {
    if (pos + item.length + 1 >= maxSize - 1) break;
    for (let i = 0; i < item.length; i++) emu.memory.writeU8(dstAddr + pos++, item.charCodeAt(i));
    emu.memory.writeU8(dstAddr + pos++, 0);
  }
  emu.memory.writeU8(dstAddr + pos, 0); // second null terminator
  return pos;
}

export function registerKernelProfile(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  const ps = () => emu.profileStore;

  // --- Ordinal 57: GetProfileInt(lpAppName:str, lpKeyName:str, nDefault:s_word) — 10 bytes ---
  kernel.register('GetProfileInt', 10, () => {
    const [lpAppNameRaw, lpKeyNameRaw, nDefault] = emu.readPascalArgs16([4, 4, 2]);
    const s = ps();
    if (!s) return nDefault;
    const lpAppName = emu.resolveFarPtr(lpAppNameRaw);
    const lpKeyName = emu.resolveFarPtr(lpKeyNameRaw);
    if (!lpAppName || !lpKeyName) return nDefault;
    const section = emu.memory.readCString(lpAppName);
    const key = emu.memory.readCString(lpKeyName);
    return s.getInt(WIN_INI, section, key, nDefault);
  }, 57);

  // --- Ordinal 58: GetProfileString(lpAppName:str, lpKeyName:str, lpDefault:str, lpRetBuf:ptr, nSize:word) — 18 bytes ---
  kernel.register('GetProfileString', 18, () => {
    const [lpAppNameRaw, lpKeyNameRaw, lpDefaultRaw, lpRetBufRaw, nSize] = emu.readPascalArgs16([4, 4, 4, 4, 2]);
    const dst = emu.resolveFarPtr(lpRetBufRaw);
    if (!dst || nSize === 0) return 0;
    const s = ps();

    // section=NULL → enumerate section names
    if (!lpAppNameRaw) {
      const names = s ? s.getSectionNames(WIN_INI) : [];
      return writeDoubleNullList16(emu, names, dst, nSize);
    }
    const section = emu.memory.readCString(emu.resolveFarPtr(lpAppNameRaw));

    // key=NULL → enumerate keys in section
    if (!lpKeyNameRaw) {
      const keys = s ? s.getSectionKeys(WIN_INI, section) : [];
      return writeDoubleNullList16(emu, keys, dst, nSize);
    }
    const key = emu.memory.readCString(emu.resolveFarPtr(lpKeyNameRaw));
    const lpDefault = emu.resolveFarPtr(lpDefaultRaw);
    const defVal = lpDefault ? emu.memory.readCString(lpDefault) : '';
    const result = s ? s.getString(WIN_INI, section, key, defVal) : defVal;
    const len = Math.min(result.length, nSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU8(dst + i, result.charCodeAt(i));
    emu.memory.writeU8(dst + len, 0);
    return len;
  }, 58);

  // --- Ordinal 59: WriteProfileString(lpAppName:str, lpKeyName:str, lpString:str) — 12 bytes ---
  kernel.register('WriteProfileString', 12, () => {
    const [lpAppNameRaw, lpKeyNameRaw, lpStringRaw] = emu.readPascalArgs16([4, 4, 4]);
    const s = ps();
    if (!s || !lpAppNameRaw) return 1;
    const section = emu.memory.readCString(emu.resolveFarPtr(lpAppNameRaw));
    const key = lpKeyNameRaw ? emu.memory.readCString(emu.resolveFarPtr(lpKeyNameRaw)) : null;
    const value = lpStringRaw ? emu.memory.readCString(emu.resolveFarPtr(lpStringRaw)) : null;
    s.writeString(WIN_INI, section, key, value);
    return 1;
  }, 59);

  // --- Ordinal 127: GetPrivateProfileInt(lpAppName:str, lpKeyName:str, nDefault:s_word, lpFileName:str) — 14 bytes ---
  kernel.register('GetPrivateProfileInt', 14, () => {
    const [lpAppNameRaw, lpKeyNameRaw, nDefault, lpFileNameRaw] = emu.readPascalArgs16([4, 4, 2, 4]);
    const s = ps();
    if (!s) return nDefault;
    const lpAppName = emu.resolveFarPtr(lpAppNameRaw);
    const lpKeyName = emu.resolveFarPtr(lpKeyNameRaw);
    const lpFileName = emu.resolveFarPtr(lpFileNameRaw);
    if (!lpAppName || !lpKeyName || !lpFileName) return nDefault;
    const section = emu.memory.readCString(lpAppName);
    const key = emu.memory.readCString(lpKeyName);
    const file = emu.memory.readCString(lpFileName);
    return s.getInt(file, section, key, nDefault);
  }, 127);

  // --- Ordinal 128: GetPrivateProfileString(lpAppName:str, lpKeyName:str, lpDefault:str, lpRetBuf:ptr, nSize:word, lpFileName:str) — 22 bytes ---
  kernel.register('GetPrivateProfileString', 22, () => {
    const [lpAppNameRaw, lpKeyNameRaw, lpDefaultRaw, lpRetBufRaw, nSize, lpFileNameRaw] =
      emu.readPascalArgs16([4, 4, 4, 4, 2, 4]);
    const dst = emu.resolveFarPtr(lpRetBufRaw);
    if (!dst || nSize === 0) return 0;
    const lpFileName = emu.resolveFarPtr(lpFileNameRaw);
    const file = lpFileName ? emu.memory.readCString(lpFileName) : WIN_INI;
    const s = ps();

    if (!lpAppNameRaw) {
      const names = s ? s.getSectionNames(file) : [];
      return writeDoubleNullList16(emu, names, dst, nSize);
    }
    const section = emu.memory.readCString(emu.resolveFarPtr(lpAppNameRaw));

    if (!lpKeyNameRaw) {
      const keys = s ? s.getSectionKeys(file, section) : [];
      return writeDoubleNullList16(emu, keys, dst, nSize);
    }
    const key = emu.memory.readCString(emu.resolveFarPtr(lpKeyNameRaw));
    const lpDefault = emu.resolveFarPtr(lpDefaultRaw);
    const defVal = lpDefault ? emu.memory.readCString(lpDefault) : '';
    const result = s ? s.getString(file, section, key, defVal) : defVal;
    const len = Math.min(result.length, nSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU8(dst + i, result.charCodeAt(i));
    emu.memory.writeU8(dst + len, 0);
    return len;
  }, 128);

  // --- Ordinal 129: WritePrivateProfileString(lpAppName:str, lpKeyName:str, lpString:str, lpFileName:str) — 16 bytes ---
  kernel.register('WritePrivateProfileString', 16, () => {
    const [lpAppNameRaw, lpKeyNameRaw, lpStringRaw, lpFileNameRaw] = emu.readPascalArgs16([4, 4, 4, 4]);
    const s = ps();
    if (!s || !lpAppNameRaw) return 1;
    const section = emu.memory.readCString(emu.resolveFarPtr(lpAppNameRaw));
    const key = lpKeyNameRaw ? emu.memory.readCString(emu.resolveFarPtr(lpKeyNameRaw)) : null;
    const value = lpStringRaw ? emu.memory.readCString(emu.resolveFarPtr(lpStringRaw)) : null;
    const lpFileName = emu.resolveFarPtr(lpFileNameRaw);
    const file = lpFileName ? emu.memory.readCString(lpFileName) : WIN_INI;
    s.writeString(file, section, key, value);
    return 1;
  }, 129);
}
