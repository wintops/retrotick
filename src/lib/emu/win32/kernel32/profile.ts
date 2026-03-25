import type { Emulator } from '../../emulator';

const WIN_INI = 'win.ini';

/** Normalize INI filename: strip path, lowercase */
function normFile(name: string): string {
  const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  return (slash >= 0 ? name.substring(slash + 1) : name).toLowerCase();
}

/** Write a double-null-terminated list of strings into a buffer (ANSI) */
function writeDoubleNullListA(emu: Emulator, items: string[], bufPtr: number, bufSize: number): number {
  let pos = 0;
  for (const item of items) {
    if (pos + item.length + 1 >= bufSize - 1) break;
    for (let i = 0; i < item.length; i++) emu.memory.writeU8(bufPtr + pos++, item.charCodeAt(i));
    emu.memory.writeU8(bufPtr + pos++, 0);
  }
  emu.memory.writeU8(bufPtr + pos, 0); // second null terminator
  return pos;
}

/** Write a double-null-terminated list of strings into a buffer (Wide) */
function writeDoubleNullListW(emu: Emulator, items: string[], bufPtr: number, bufSize: number): number {
  let pos = 0;
  for (const item of items) {
    if (pos + item.length + 1 >= bufSize - 1) break;
    for (let i = 0; i < item.length; i++) {
      emu.memory.writeU16(bufPtr + pos * 2, item.charCodeAt(i));
      pos++;
    }
    emu.memory.writeU16(bufPtr + pos * 2, 0);
    pos++;
  }
  emu.memory.writeU16(bufPtr + pos * 2, 0); // second null terminator
  return pos;
}

export function registerProfile(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');
  const ps = () => emu.profileStore;

  // ===== GetProfileInt =====

  kernel32.register('GetProfileIntA', 3, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const nDefault = emu.readArg(2);
    const s = ps();
    if (!s || !sectionPtr || !keyPtr) return nDefault;
    const section = emu.memory.readCString(sectionPtr);
    const key = emu.memory.readCString(keyPtr);
    return s.getInt(WIN_INI, section, key, nDefault);
  });

  kernel32.register('GetProfileIntW', 3, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const nDefault = emu.readArg(2);
    const s = ps();
    if (!s || !sectionPtr || !keyPtr) return nDefault;
    const section = emu.memory.readUTF16String(sectionPtr);
    const key = emu.memory.readUTF16String(keyPtr);
    return s.getInt(WIN_INI, section, key, nDefault);
  });

  // ===== GetProfileString =====

  kernel32.register('GetProfileStringA', 5, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const defaultPtr = emu.readArg(2);
    const bufPtr = emu.readArg(3);
    const bufSize = emu.readArg(4);
    if (!bufPtr || bufSize === 0) return 0;
    const s = ps();

    // section=NULL → enumerate section names
    if (!sectionPtr) {
      const names = s ? s.getSectionNames(WIN_INI) : [];
      return writeDoubleNullListA(emu, names, bufPtr, bufSize);
    }
    const section = emu.memory.readCString(sectionPtr);

    // key=NULL → enumerate keys in section
    if (!keyPtr) {
      const keys = s ? s.getSectionKeys(WIN_INI, section) : [];
      return writeDoubleNullListA(emu, keys, bufPtr, bufSize);
    }
    const key = emu.memory.readCString(keyPtr);
    const defVal = defaultPtr ? emu.memory.readCString(defaultPtr) : '';
    const result = s ? s.getString(WIN_INI, section, key, defVal) : defVal;
    const len = Math.min(result.length, bufSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU8(bufPtr + i, result.charCodeAt(i));
    emu.memory.writeU8(bufPtr + len, 0);
    return len;
  });

  kernel32.register('GetProfileStringW', 5, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const defaultPtr = emu.readArg(2);
    const bufPtr = emu.readArg(3);
    const bufSize = emu.readArg(4);
    if (!bufPtr || bufSize === 0) return 0;
    const s = ps();

    if (!sectionPtr) {
      const names = s ? s.getSectionNames(WIN_INI) : [];
      return writeDoubleNullListW(emu, names, bufPtr, bufSize);
    }
    const section = emu.memory.readUTF16String(sectionPtr);

    if (!keyPtr) {
      const keys = s ? s.getSectionKeys(WIN_INI, section) : [];
      return writeDoubleNullListW(emu, keys, bufPtr, bufSize);
    }
    const key = emu.memory.readUTF16String(keyPtr);
    const defVal = defaultPtr ? emu.memory.readUTF16String(defaultPtr) : '';
    const result = s ? s.getString(WIN_INI, section, key, defVal) : defVal;
    const len = Math.min(result.length, bufSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, result.charCodeAt(i));
    emu.memory.writeU16(bufPtr + len * 2, 0);
    return len;
  });

  // ===== WriteProfileString =====

  kernel32.register('WriteProfileStringA', 3, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const valuePtr = emu.readArg(2);
    const s = ps();
    if (!s || !sectionPtr) return 1;
    const section = emu.memory.readCString(sectionPtr);
    const key = keyPtr ? emu.memory.readCString(keyPtr) : null;
    const value = valuePtr ? emu.memory.readCString(valuePtr) : null;
    s.writeString(WIN_INI, section, key, value);
    return 1;
  });

  kernel32.register('WriteProfileStringW', 3, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const valuePtr = emu.readArg(2);
    const s = ps();
    if (!s || !sectionPtr) return 1;
    const section = emu.memory.readUTF16String(sectionPtr);
    const key = keyPtr ? emu.memory.readUTF16String(keyPtr) : null;
    const value = valuePtr ? emu.memory.readUTF16String(valuePtr) : null;
    s.writeString(WIN_INI, section, key, value);
    return 1;
  });

  // ===== GetPrivateProfileInt =====

  kernel32.register('GetPrivateProfileIntA', 4, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const nDefault = emu.readArg(2);
    const filePtr = emu.readArg(3);
    const s = ps();
    if (!s || !sectionPtr || !keyPtr || !filePtr) return nDefault;
    const section = emu.memory.readCString(sectionPtr);
    const key = emu.memory.readCString(keyPtr);
    const file = emu.memory.readCString(filePtr);
    return s.getInt(file, section, key, nDefault);
  });

  kernel32.register('GetPrivateProfileIntW', 4, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const nDefault = emu.readArg(2);
    const filePtr = emu.readArg(3);
    const s = ps();
    if (!s || !sectionPtr || !keyPtr || !filePtr) return nDefault;
    const section = emu.memory.readUTF16String(sectionPtr);
    const key = emu.memory.readUTF16String(keyPtr);
    const file = emu.memory.readUTF16String(filePtr);
    return s.getInt(file, section, key, nDefault);
  });

  // ===== GetPrivateProfileString =====

  kernel32.register('GetPrivateProfileStringA', 6, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const defaultPtr = emu.readArg(2);
    const bufPtr = emu.readArg(3);
    const bufSize = emu.readArg(4);
    const filePtr = emu.readArg(5);
    if (!bufPtr || bufSize === 0) return 0;
    const file = filePtr ? emu.memory.readCString(filePtr) : WIN_INI;
    const s = ps();

    if (!sectionPtr) {
      const names = s ? s.getSectionNames(file) : [];
      return writeDoubleNullListA(emu, names, bufPtr, bufSize);
    }
    const section = emu.memory.readCString(sectionPtr);

    if (!keyPtr) {
      const keys = s ? s.getSectionKeys(file, section) : [];
      return writeDoubleNullListA(emu, keys, bufPtr, bufSize);
    }
    const key = emu.memory.readCString(keyPtr);
    const defVal = defaultPtr ? emu.memory.readCString(defaultPtr) : '';
    const result = s ? s.getString(file, section, key, defVal) : defVal;
    const len = Math.min(result.length, bufSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU8(bufPtr + i, result.charCodeAt(i));
    emu.memory.writeU8(bufPtr + len, 0);
    return len;
  });

  kernel32.register('GetPrivateProfileStringW', 6, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const defaultPtr = emu.readArg(2);
    const bufPtr = emu.readArg(3);
    const bufSize = emu.readArg(4);
    const filePtr = emu.readArg(5);
    if (!bufPtr || bufSize === 0) return 0;
    const file = filePtr ? emu.memory.readUTF16String(filePtr) : WIN_INI;
    const s = ps();

    if (!sectionPtr) {
      const names = s ? s.getSectionNames(file) : [];
      return writeDoubleNullListW(emu, names, bufPtr, bufSize);
    }
    const section = emu.memory.readUTF16String(sectionPtr);

    if (!keyPtr) {
      const keys = s ? s.getSectionKeys(file, section) : [];
      return writeDoubleNullListW(emu, keys, bufPtr, bufSize);
    }
    const key = emu.memory.readUTF16String(keyPtr);
    const defVal = defaultPtr ? emu.memory.readUTF16String(defaultPtr) : '';
    const result = s ? s.getString(file, section, key, defVal) : defVal;
    const len = Math.min(result.length, bufSize - 1);
    for (let i = 0; i < len; i++) emu.memory.writeU16(bufPtr + i * 2, result.charCodeAt(i));
    emu.memory.writeU16(bufPtr + len * 2, 0);
    return len;
  });

  // ===== WritePrivateProfileString =====

  kernel32.register('WritePrivateProfileStringA', 4, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const valuePtr = emu.readArg(2);
    const filePtr = emu.readArg(3);
    const s = ps();
    if (!s || !sectionPtr) return 1;
    const section = emu.memory.readCString(sectionPtr);
    const key = keyPtr ? emu.memory.readCString(keyPtr) : null;
    const value = valuePtr ? emu.memory.readCString(valuePtr) : null;
    const file = filePtr ? emu.memory.readCString(filePtr) : WIN_INI;
    s.writeString(file, section, key, value);
    return 1;
  });

  kernel32.register('WritePrivateProfileStringW', 4, () => {
    const sectionPtr = emu.readArg(0);
    const keyPtr = emu.readArg(1);
    const valuePtr = emu.readArg(2);
    const filePtr = emu.readArg(3);
    const s = ps();
    if (!s || !sectionPtr) return 1;
    const section = emu.memory.readUTF16String(sectionPtr);
    const key = keyPtr ? emu.memory.readUTF16String(keyPtr) : null;
    const value = valuePtr ? emu.memory.readUTF16String(valuePtr) : null;
    const file = filePtr ? emu.memory.readUTF16String(filePtr) : WIN_INI;
    s.writeString(file, section, key, value);
    return 1;
  });

  // ===== Struct variants =====

  kernel32.register('WritePrivateProfileStructA', 5, () => 1);
  kernel32.register('GetPrivateProfileStructA', 5, () => 0); // fail — key not found

  // ===== GetPrivateProfileSectionNames =====

  kernel32.register('GetPrivateProfileSectionNamesA', 3, () => {
    const bufPtr = emu.readArg(0);
    const bufSize = emu.readArg(1);
    const filePtr = emu.readArg(2);
    if (!bufPtr || bufSize === 0) return 0;
    const file = filePtr ? emu.memory.readCString(filePtr) : WIN_INI;
    const s = ps();
    const names = s ? s.getSectionNames(file) : [];
    return writeDoubleNullListA(emu, names, bufPtr, bufSize);
  });

  kernel32.register('GetPrivateProfileSectionNamesW', 3, () => {
    const bufPtr = emu.readArg(0);
    const bufSize = emu.readArg(1);
    const filePtr = emu.readArg(2);
    if (!bufPtr || bufSize === 0) return 0;
    const file = filePtr ? emu.memory.readUTF16String(filePtr) : WIN_INI;
    const s = ps();
    const names = s ? s.getSectionNames(file) : [];
    return writeDoubleNullListW(emu, names, bufPtr, bufSize);
  });
}
