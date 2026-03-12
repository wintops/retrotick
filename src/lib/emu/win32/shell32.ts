import type { Emulator } from '../emulator';
import { emuCompleteThunk } from '../emu-exec';

function shellAbout(emu: Emulator, isWide: boolean): number | undefined {
  const _hwnd = emu.readArg(0);
  const titlePtr = emu.readArg(1);
  const textPtr = emu.readArg(2);
  // arg 3 is hIcon, ignored

  const read = isWide
    ? (p: number) => emu.memory.readUTF16String(p)
    : (p: number) => emu.memory.readCString(p);

  const title = titlePtr ? read(titlePtr) : '';
  const otherText = textPtr ? read(textPtr) : '';

  // title may contain "AppName#ExtraInfo" — split on '#'
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
      emuCompleteThunk(emu, 1, stackBytes);
      if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
    },
  });
  return undefined;
}

export function registerShell32(emu: Emulator): void {
  const shell32 = emu.registerDll('SHELL32.DLL');

  shell32.register('ShellAboutA', 4, () => shellAbout(emu, false));
  shell32.register('ShellAboutW', 4, () => shellAbout(emu, true));
  shell32.register('DragAcceptFiles', 2, () => 0);
  shell32.register('DragQueryFileW', 4, () => 0);
  shell32.register('DragFinish', 1, () => 0);
  shell32.register('ShellExecuteW', 6, () => 33); // SE_ERR_NOASSOC > 32 = success
  shell32.register('SHGetFileInfoW', 5, () => 0);
  shell32.register('ShellExecuteA', 6, () => 33); // > 32 = success
  shell32.register('Shell_NotifyIconW', 2, () => 1);
  shell32.register('ord_61', 2, () => 0); // RunFileDlg - no-op
  shell32.register('ord_100', 1, () => 0); // IsExeTSAware - return false

  shell32.register('CommandLineToArgvW', 2, () => {
    const lpCmdLine = emu.readArg(0);
    const pNumArgs = emu.readArg(1);
    // Simple: return array with just the command line as one arg
    const cmdLine = lpCmdLine ? emu.memory.readUTF16String(lpCmdLine) : '';
    const args = cmdLine ? [cmdLine] : [''];
    if (pNumArgs) emu.memory.writeU32(pNumArgs, args.length);
    const arr = emu.allocHeap((args.length + 1) * 4);
    for (let i = 0; i < args.length; i++) {
      const s = emu.allocHeap((args[i].length + 1) * 2);
      emu.memory.writeUTF16String(s, args[i]);
      emu.memory.writeU32(arr + i * 4, s);
    }
    emu.memory.writeU32(arr + args.length * 4, 0);
    return arr;
  });

  shell32.register('ExtractIconW', 3, () => 0); // return NULL (no icon)
  shell32.register('Shell_NotifyIconA', 2, () => 1); // success
  shell32.register('SHGetMalloc', 1, () => 0x80004001); // E_NOTIMPL
  shell32.register('DragQueryPoint', 2, () => 0);
  shell32.register('DragQueryFileA', 4, () => 0);
  shell32.register('SHBrowseForFolderA', 1, () => 0); // cancelled
  shell32.register('SHGetPathFromIDListA', 2, () => 0); // fail
  shell32.register('ShellExecuteExW', 1, () => 1); // success

  // DoEnvironmentSubstW(pszSrc, cchSrc) → DWORD
  // Expands %VAR% references in-place. Return: HIWORD=success, LOWORD=length
  shell32.register('DoEnvironmentSubstW', 2, () => {
    const pszSrc = emu.readArg(0);
    const cchSrc = emu.readArg(1);
    if (!pszSrc || !cchSrc) return cchSrc & 0xFFFF;

    const src = emu.memory.readUTF16String(pszSrc);
    // Expand %VAR% using the same env vars as GetEnvironmentVariableW
    const envMap: Record<string, string> = {
      COMSPEC: 'C:\\WINDOWS\\SYSTEM32\\CMD.EXE',
      PATH: 'C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS',
      SYSTEMROOT: 'C:\\WINDOWS', WINDIR: 'C:\\WINDOWS',
      SYSTEMDRIVE: 'C:', HOMEDRIVE: 'D:', HOMEPATH: '\\',
      PROMPT: '$P$G', PATHEXT: '.COM;.EXE;.BAT;.CMD',
      TEMP: 'C:\\TEMP', TMP: 'C:\\TEMP',
    };
    const expanded = src.replace(/%([^%]+)%/g, (_m, name: string) => {
      return envMap[name.toUpperCase()] ?? `%${name}%`;
    });

    if (expanded.length + 1 > cchSrc) {
      // Buffer too small — leave unchanged, return HIWORD=0, LOWORD=cchSrc
      return cchSrc & 0xFFFF;
    }
    emu.memory.writeUTF16String(pszSrc, expanded);
    // HIWORD=1 (success), LOWORD=length including null
    const len = expanded.length + 1;
    return ((1 << 16) | (len & 0xFFFF)) >>> 0;
  });

  // RealShellExecuteW(hwnd, lpOperation, lpFile, lpParameters, lpDirectory,
  //                   lpReturn, lpTitle, lpReserved, nShowCmd, lpProcess) → HINSTANCE
  // Undocumented internal API, similar to ShellExecuteW. Return >32 = success.
  shell32.register('RealShellExecuteW', 10, () => 33);

  // Path utility functions (re-exported from SHLWAPI)
  shell32.register('PathIsRelativeA', 1, () => {
    const pszPath = emu.readArg(0);
    if (!pszPath) return 1; // NULL path is relative
    const path = emu.memory.readCString(pszPath);
    // A path is absolute if it starts with drive letter + colon or backslash
    if (path.length >= 2 && path[1] === ':') return 0;
    if (path.startsWith('\\')) return 0;
    return 1;
  });
  shell32.register('PathBuildRootA', 2, () => {
    const pszRoot = emu.readArg(0);
    const iDrive = emu.readArg(1);
    if (pszRoot && iDrive >= 0 && iDrive <= 25) {
      const letter = String.fromCharCode(0x41 + iDrive); // 'A' + iDrive
      emu.memory.writeU8(pszRoot, letter.charCodeAt(0));
      emu.memory.writeU8(pszRoot + 1, 0x3A); // ':'
      emu.memory.writeU8(pszRoot + 2, 0x5C); // '\\'
      emu.memory.writeU8(pszRoot + 3, 0);
      return pszRoot;
    }
    return 0;
  });
  shell32.register('PathAppendA', 2, () => {
    const pszPath = emu.readArg(0);
    const pszMore = emu.readArg(1);
    if (pszPath && pszMore) {
      const base = emu.memory.readCString(pszPath);
      const more = emu.memory.readCString(pszMore);
      const combined = base.endsWith('\\') ? base + more : base + '\\' + more;
      for (let i = 0; i < combined.length; i++) {
        emu.memory.writeU8(pszPath + i, combined.charCodeAt(i) & 0xFF);
      }
      emu.memory.writeU8(pszPath + combined.length, 0);
    }
    return 1;
  });
  shell32.register('PathFileExistsA', 1, () => 0); // file doesn't exist in emulator
  shell32.register('PathRemoveBlanksA', 1, () => 0); // no-op
  // ShellMessageBoxA is WINAPIV (cdecl, caller cleans stack) so stackBytes=0 is correct
  shell32.register('ShellMessageBoxA', 0, () => 1); // return IDOK

  // ExtractIconExW(lpszFile, nIconIndex, phiconLarge, phiconSmall, nIcons) — 5 args
  shell32.register('ExtractIconExW', 5, () => 0);

  // SHFormatDrive(hwnd, drive, fmtID, options) — 4 args
  shell32.register('SHFormatDrive', 4, () => -1); // SHFMT_ERROR

  // ord_42 = SHFileOperationW (undocumented ordinal) — 1 arg (pointer to SHFILEOPSTRUCT)
  shell32.register('ord_42', 1, () => 0);

  // ord_66 = SHDefExtractIconW — 6 args
  shell32.register('ord_66', 6, () => 1); // S_FALSE = no icon

  // ord_680 = IsUserAnAdmin — 0 args
  shell32.register('ord_680', 0, () => 1); // yes, admin

  shell32.register('FindExecutableA', 3, () => 31); // SE_ERR_NOASSOC (failure)
  shell32.register('SHFree', 1, () => 0);
}
