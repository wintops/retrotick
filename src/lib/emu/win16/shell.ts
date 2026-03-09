import type { Emulator } from '../emulator';
import { emuCompleteThunk16 } from '../emu-exec';
import { ERROR_SUCCESS, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS } from '../win32/types';

// Win16 SHELL module — API stubs by ordinal
// Reference: https://github.com/wine-mirror/wine/blob/master/dlls/shell.dll16/shell.dll16.spec

export function registerWin16Shell(emu: Emulator): void {
  const shell = emu.registerModule16('SHELL');

  const store = () => emu.registryStore;

  // --- Registry APIs ---

  // RegOpenKey(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult)
  shell.register('RegOpenKey', 12, () => {
    const hKey = emu.readArg16DWord(0);
    const lpSubKey = emu.readArg16FarPtr(4);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const phkResult = emu.readArg16FarPtr(8);
    const s = store();
    if (s) {
      const h = s.openKey(hKey, subKey);
      if (h !== null) {
        if (phkResult) emu.memory.writeU32(phkResult, h);
        return ERROR_SUCCESS;
      }
      return ERROR_FILE_NOT_FOUND;
    }
    if (phkResult) emu.memory.writeU32(phkResult, 0x2000);
    return ERROR_SUCCESS;
  }, 1);

  // RegCreateKey(HKEY hKey, LPCSTR lpSubKey, PHKEY phkResult)
  shell.register('RegCreateKey', 12, () => {
    const hKey = emu.readArg16DWord(0);
    const lpSubKey = emu.readArg16FarPtr(4);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const phkResult = emu.readArg16FarPtr(8);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        if (phkResult) emu.memory.writeU32(phkResult, r.handle);
        return ERROR_SUCCESS;
      }
    }
    if (phkResult) emu.memory.writeU32(phkResult, 0x2000);
    return ERROR_SUCCESS;
  }, 2);

  // RegCloseKey(HKEY hKey)
  shell.register('RegCloseKey', 4, () => {
    const hKey = emu.readArg16DWord(0);
    const s = store();
    if (s) s.closeKey(hKey);
    return ERROR_SUCCESS;
  }, 3);

  // RegDeleteKey(HKEY hKey, LPCSTR lpSubKey)
  shell.register('RegDeleteKey', 8, () => ERROR_SUCCESS, 4);

  // RegSetValue(HKEY hKey, LPCSTR lpSubKey, DWORD dwType, LPCSTR lpData, DWORD cbData)
  shell.register('RegSetValue', 20, () => {
    const hKey = emu.readArg16DWord(0);
    const lpSubKey = emu.readArg16FarPtr(4);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    // dwType at offset 8 (always REG_SZ for RegSetValue)
    const lpData = emu.readArg16FarPtr(12);
    const cbData = emu.readArg16DWord(16);
    const s = store();
    if (s) {
      const r = s.createKey(hKey, subKey);
      if (r) {
        const REG_SZ = 1;
        const data = new Uint8Array(cbData + 1);
        for (let i = 0; i < cbData; i++) data[i] = emu.memory.readU8(lpData + i);
        data[cbData] = 0;
        s.setValue(r.handle, '', REG_SZ, data);
      }
    }
    return ERROR_SUCCESS;
  }, 5);

  // RegQueryValue(HKEY hKey, LPCSTR lpSubKey, LPSTR lpValue, LONG FAR* lpcbValue)
  shell.register('RegQueryValue', 16, () => {
    const hKey = emu.readArg16DWord(0);
    const lpSubKey = emu.readArg16FarPtr(4);
    const subKey = lpSubKey ? emu.memory.readCString(lpSubKey) : '';
    const lpValue = emu.readArg16FarPtr(8);
    const lpcbValue = emu.readArg16FarPtr(12);
    const s = store();
    if (s) {
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
    }
    return ERROR_SUCCESS;
  }, 6);

  // RegEnumKey(HKEY hKey, DWORD dwIndex, LPSTR lpName, DWORD cbName)
  shell.register('RegEnumKey', 16, () => ERROR_NO_MORE_ITEMS, 7);

  // --- Drag & Drop ---

  // DragAcceptFiles(hWnd, fAccept)
  shell.register('DragAcceptFiles', 4, () => 0, 9);

  // DragQueryFile(hDrop, iFile, lpszFile, cch)
  shell.register('DragQueryFile', 10, () => 0, 11);

  // DragFinish(hDrop)
  shell.register('DragFinish', 2, () => 0, 12);

  // DragQueryPoint(hDrop, lpPoint)
  shell.register('DragQueryPoint', 6, () => 0, 13);

  // --- Shell functions ---

  // ShellExecute(hwnd, lpOperation, lpFile, lpParameters, lpDirectory, nShowCmd)
  shell.register('ShellExecute', 20, () => 33, 20); // > 32 = success

  // FindExecutable(lpFile, lpDirectory, lpResult)
  shell.register('FindExecutable', 12, () => 0, 21);

  // ShellAbout(hwnd, szApp, szOtherStuff, hIcon) — 12 bytes (2+4+4+2)
  shell.register('ShellAbout', 12, () => {
    const [_hwnd, szAppRaw, szOtherRaw, _hIcon] = emu.readPascalArgs16([2, 4, 4, 2]);
    const szApp = emu.resolveFarPtr(szAppRaw);
    const szOther = emu.resolveFarPtr(szOtherRaw);
    const title = szApp ? emu.memory.readCString(szApp) : '';
    const otherText = szOther ? emu.memory.readCString(szOther) : '';

    let caption = title;
    let extraInfo = '';
    const hashIdx = title.indexOf('#');
    if (hashIdx >= 0) {
      caption = title.substring(0, hashIdx);
      extraInfo = title.substring(hashIdx + 1);
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'about',
      caption,
      extraInfo,
      otherText,
      onDismiss: () => {
        emu.waitingForMessage = false;
        emuCompleteThunk16(emu, 1, stackBytes);
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 22);

  // ExtractIcon(hInst, lpszExeFileName, nIconIndex)
  shell.register('ExtractIcon', 8, () => 0, 34);

  // DoEnvironmentSubst(lpSrc, cchSrc) — 8 bytes (ptr+word) — returns DWORD
  shell.register('DoEnvironmentSubst', 8, () => 0, 37);

  // FindEnvironmentString(lpszEnvVar, lpResult, cbResult) — 12 bytes (ptr+ptr+word)
  shell.register('FindEnvironmentString', 12, () => 0, 38);
}
