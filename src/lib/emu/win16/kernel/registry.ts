import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';
import { ERROR_SUCCESS, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_MORE_DATA } from '../../win32/types';

const ERROR_BADKEY = 2;
const REG_SZ = 1;

export function registerKernelRegistry(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  const store = () => emu.registryStore;

  // --- Ordinal 216: RegEnumKey(hKey:long, dwIndex:long, lpName:ptr, cbName:long) — 16 bytes ---
  kernel.register('RegEnumKey', 16, () => {
    const [hKey, dwIndex, lpNameRaw, cbName] = emu.readPascalArgs16([4, 4, 4, 4]);
    const lpName = emu.resolveFarPtr(lpNameRaw);
    const s = store();
    if (!s) return ERROR_BADKEY;
    const name = s.enumKey(hKey, dwIndex);
    if (name === null) return ERROR_NO_MORE_ITEMS;
    if (lpName) {
      const len = Math.min(name.length, cbName - 1);
      for (let i = 0; i < len; i++) emu.memory.writeU8(lpName + i, name.charCodeAt(i));
      emu.memory.writeU8(lpName + len, 0);
    }
    return ERROR_SUCCESS;
  }, 216);

  // --- Ordinal 217: RegOpenKey(hKey:long, lpSubKey:ptr, phkResult:ptr) — 12 bytes ---
  kernel.register('RegOpenKey', 12, () => {
    const [hKey, lpSubKeyRaw, phkResultRaw] = emu.readPascalArgs16([4, 4, 4]);
    const lpSubKey = emu.resolveFarPtr(lpSubKeyRaw);
    const phkResult = emu.resolveFarPtr(phkResultRaw);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const s = store();
    if (!s) {
      if (phkResult) emu.memory.writeU32(phkResult, 0x2000);
      return ERROR_SUCCESS;
    }
    const h = s.openKey(hKey, subKey);
    if (h !== null) {
      if (phkResult) emu.memory.writeU32(phkResult, h);
      return ERROR_SUCCESS;
    }
    return ERROR_FILE_NOT_FOUND;
  }, 217);

  // --- Ordinal 218: RegCreateKey(hKey:long, lpSubKey:ptr, phkResult:ptr) — 12 bytes ---
  kernel.register('RegCreateKey', 12, () => {
    const [hKey, lpSubKeyRaw, phkResultRaw] = emu.readPascalArgs16([4, 4, 4]);
    const lpSubKey = emu.resolveFarPtr(lpSubKeyRaw);
    const phkResult = emu.resolveFarPtr(phkResultRaw);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const s = store();
    if (!s) {
      if (phkResult) emu.memory.writeU32(phkResult, 0x2000);
      return ERROR_SUCCESS;
    }
    const r = s.createKey(hKey, subKey);
    if (r) {
      if (phkResult) emu.memory.writeU32(phkResult, r.handle);
      return ERROR_SUCCESS;
    }
    return ERROR_BADKEY;
  }, 218);

  // --- Ordinal 219: RegDeleteKey(hKey:long, lpSubKey:ptr) — 8 bytes ---
  kernel.register('RegDeleteKey', 8, () => {
    const [hKey, lpSubKeyRaw] = emu.readPascalArgs16([4, 4]);
    const lpSubKey = emu.resolveFarPtr(lpSubKeyRaw);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const s = store();
    if (!s) return ERROR_BADKEY;
    return s.deleteKey(hKey, subKey) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
  }, 219);

  // --- Ordinal 220: RegCloseKey(hKey:long) — 4 bytes ---
  kernel.register('RegCloseKey', 4, () => {
    const hKey = emu.readArg16DWord(0);
    const s = store();
    if (s) s.closeKey(hKey);
    return ERROR_SUCCESS;
  }, 220);

  // --- Ordinal 221: RegSetValue(hKey:long, lpSubKey:ptr, dwType:long, lpData:ptr, cbData:long) — 20 bytes ---
  kernel.register('RegSetValue', 20, () => {
    const [hKey, lpSubKeyRaw, _dwType, lpDataRaw, cbData] = emu.readPascalArgs16([4, 4, 4, 4, 4]);
    const lpSubKey = emu.resolveFarPtr(lpSubKeyRaw);
    const lpData = emu.resolveFarPtr(lpDataRaw);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const s = store();
    if (!s) return ERROR_SUCCESS;
    // Open or create the subkey, then set its default value
    const r = s.createKey(hKey, subKey);
    if (r && lpData) {
      const data = new Uint8Array(cbData + 1);
      for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(lpData + i);
      data[cbData] = 0;
      s.setValue(r.handle, '', REG_SZ, data);
    }
    return ERROR_SUCCESS;
  }, 221);

  // --- Ordinal 222: RegDeleteValue(hKey:long, lpValueName:ptr) — 8 bytes ---
  kernel.register('RegDeleteValue', 8, () => {
    const [hKey, lpNameRaw] = emu.readPascalArgs16([4, 4]);
    const lpName = emu.resolveFarPtr(lpNameRaw);
    const name = lpName ? emu.memory.readCString(lpName) : '';
    const s = store();
    if (!s) return ERROR_BADKEY;
    return s.deleteValue(hKey, name) ? ERROR_SUCCESS : ERROR_FILE_NOT_FOUND;
  }, 222);

  // --- Ordinal 223: RegEnumValue(hKey:long, dwIndex:long, lpValueName:ptr, lpcbValueName:ptr, lpReserved:ptr, lpType:ptr, lpData:ptr, lpcbData:ptr) — 32 bytes ---
  kernel.register('RegEnumValue', 32, () => {
    const [hKey, dwIndex, lpNameRaw, lpcbNameRaw, _lpReserved, lpTypeRaw, lpDataRaw, lpcbDataRaw] =
      emu.readPascalArgs16([4, 4, 4, 4, 4, 4, 4, 4]);
    const lpName = emu.resolveFarPtr(lpNameRaw);
    const lpcbName = emu.resolveFarPtr(lpcbNameRaw);
    const lpType = emu.resolveFarPtr(lpTypeRaw);
    const lpData = emu.resolveFarPtr(lpDataRaw);
    const lpcbData = emu.resolveFarPtr(lpcbDataRaw);
    const s = store();
    if (!s) return ERROR_BADKEY;
    const val = s.enumValue(hKey, dwIndex);
    if (!val) return ERROR_NO_MORE_ITEMS;

    // Write value name
    if (lpName && lpcbName) {
      const maxLen = emu.memory.readU32(lpcbName);
      const len = Math.min(val.name.length, maxLen);
      for (let i = 0; i < len; i++) emu.memory.writeU8(lpName + i, val.name.charCodeAt(i));
      emu.memory.writeU8(lpName + len, 0);
      emu.memory.writeU32(lpcbName, len);
    }
    // Write type
    if (lpType) emu.memory.writeU32(lpType, val.type);
    // Write data
    if (lpData && lpcbData) {
      const maxData = emu.memory.readU32(lpcbData);
      const dataLen = Math.min(val.data.length, maxData);
      for (let i = 0; i < dataLen; i++) emu.memory.writeU8(lpData + i, val.data[i]);
      emu.memory.writeU32(lpcbData, val.data.length);
      if (val.data.length > maxData) return ERROR_MORE_DATA;
    }
    return ERROR_SUCCESS;
  }, 223);

  // --- Ordinal 224: RegQueryValue(hKey:long, lpSubKey:ptr, lpValue:ptr, lpcbValue:ptr) — 16 bytes ---
  kernel.register('RegQueryValue', 16, () => {
    const [hKey, lpSubKeyRaw, lpValueRaw, lpcbValueRaw] = emu.readPascalArgs16([4, 4, 4, 4]);
    const lpSubKey = emu.resolveFarPtr(lpSubKeyRaw);
    const lpValue = emu.resolveFarPtr(lpValueRaw);
    const lpcbValue = emu.resolveFarPtr(lpcbValueRaw);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const s = store();
    if (!s) return ERROR_FILE_NOT_FOUND;
    // Open subkey if specified
    let key = hKey;
    if (subKey) {
      const h = s.openKey(hKey, subKey);
      if (h === null) return ERROR_FILE_NOT_FOUND;
      key = h;
    }
    const val = s.queryValue(key, '');
    if (!val) return ERROR_FILE_NOT_FOUND;
    if (lpValue && lpcbValue) {
      const bufSize = emu.memory.readU32(lpcbValue);
      const len = Math.min(val.data.length, bufSize);
      for (let i = 0; i < len; i++) emu.memory.writeU8(lpValue + i, val.data[i]);
      emu.memory.writeU32(lpcbValue, val.data.length);
    }
    return ERROR_SUCCESS;
  }, 224);

  // --- Ordinal 225: RegQueryValueEx(hKey:long, lpValueName:ptr, lpReserved:ptr, lpType:ptr, lpData:ptr, lpcbData:ptr) — 24 bytes ---
  kernel.register('RegQueryValueEx', 24, () => {
    const [hKey, lpNameRaw, _lpReserved, lpTypeRaw, lpDataRaw, lpcbDataRaw] =
      emu.readPascalArgs16([4, 4, 4, 4, 4, 4]);
    const lpName = emu.resolveFarPtr(lpNameRaw);
    const lpType = emu.resolveFarPtr(lpTypeRaw);
    const lpData = emu.resolveFarPtr(lpDataRaw);
    const lpcbData = emu.resolveFarPtr(lpcbDataRaw);
    const name = lpName ? emu.memory.readCString(lpName) : '';
    const s = store();
    if (!s) return ERROR_FILE_NOT_FOUND;
    const val = s.queryValue(hKey, name);
    if (!val) return ERROR_FILE_NOT_FOUND;
    if (lpType) emu.memory.writeU32(lpType, val.type);
    if (lpcbData) {
      const maxData = emu.memory.readU32(lpcbData);
      if (lpData) {
        const len = Math.min(val.data.length, maxData);
        for (let i = 0; i < len; i++) emu.memory.writeU8(lpData + i, val.data[i]);
      }
      emu.memory.writeU32(lpcbData, val.data.length);
      if (val.data.length > maxData && lpData) return ERROR_MORE_DATA;
    }
    return ERROR_SUCCESS;
  }, 225);

  // --- Ordinal 226: RegSetValueEx(hKey:long, lpValueName:ptr, dwReserved:long, dwType:long, lpData:ptr, cbData:long) — 24 bytes ---
  kernel.register('RegSetValueEx', 24, () => {
    const [hKey, lpNameRaw, _dwReserved, dwType, lpDataRaw, cbData] =
      emu.readPascalArgs16([4, 4, 4, 4, 4, 4]);
    const lpName = emu.resolveFarPtr(lpNameRaw);
    const lpData = emu.resolveFarPtr(lpDataRaw);
    const name = lpName ? emu.memory.readCString(lpName) : '';
    const s = store();
    if (!s) return ERROR_BADKEY;
    const data = new Uint8Array(cbData);
    if (lpData) {
      for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(lpData + i);
    }
    s.setValue(hKey, name, dwType, data);
    return ERROR_SUCCESS;
  }, 226);

  // --- Ordinal 227: RegFlushKey(hKey:long) — 4 bytes ---
  kernel.register('RegFlushKey', 4, () => ERROR_SUCCESS, 227);
}
