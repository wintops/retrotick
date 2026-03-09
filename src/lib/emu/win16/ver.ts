import type { Emulator } from '../emulator';

// Win16 VER module (VERSION.DLL) — version info APIs
// Reference: https://github.com/wine-mirror/wine/blob/master/dlls/ver.dll16/ver.dll16.spec

export function registerWin16Ver(emu: Emulator): void {
  const ver = emu.registerModule16('VER');

  // Ordinal 2: GetFileResourceSize(lpszFileName, lpszResType, lpszResID, lpdwFileOffset) — 16 bytes
  ver.register('GetFileResourceSize', 16, () => 0, 2);

  // Ordinal 3: GetFileResource(lpszFileName, lpszResType, lpszResID, dwFileOffset, dwResLen, lpData) — 22 bytes
  ver.register('GetFileResource', 22, () => 0, 3);

  // Ordinal 6: GetFileVersionInfoSize(lpszFileName, lpdwHandle) — 8 bytes
  ver.register('GetFileVersionInfoSize', 8, () => 0, 6);

  // Ordinal 7: GetFileVersionInfo(lpszFileName, dwHandle, dwLen, lpData) — 16 bytes
  ver.register('GetFileVersionInfo', 16, () => 0, 7);

  // Ordinal 8: VerFindFile(uFlags, szFileName, szWinDir, szAppDir, szCurDir, lpuCurDirLen, szDestDir, lpuDestDirLen) — 32 bytes
  ver.register('VerFindFile', 32, () => 0, 8);

  // Ordinal 9: VerInstallFile(uFlags, szSrcFileName, szDestFileName, szSrcDir, szDestDir, szCurDir, szTmpFile, lpuTmpFileLen) — 32 bytes
  ver.register('VerInstallFile', 32, () => 0, 9);

  // Ordinal 10: VerLanguageName(wLang, szLang, nSize) — 8 bytes
  ver.register('VerLanguageName', 8, () => 0, 10);

  // Ordinal 11: VerQueryValue(pBlock, lpSubBlock, lplpBuffer, lpuLen) — 16 bytes
  ver.register('VerQueryValue', 16, () => 0, 11);
}
