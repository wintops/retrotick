import type { Emulator } from '../emulator';
import type { WindowInfo } from '../win32/user32/types';
import { emuCompleteThunk16 } from '../emu-exec';

// Win16 COMMDLG module — common dialog stubs

export function registerWin16Commdlg(emu: Emulator): void {
  const commdlg = emu.registerModule16('COMMDLG');

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 1: GetOpenFileName(lpOfn) — 4 bytes (segptr)
  // Win16 OPENFILENAME struct offsets:
  //   +24: lpstrFile (4 bytes, far ptr to buffer)
  //   +28: nMaxFile  (4 bytes, DWORD)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('GetOpenFileName', 4, () => {
    const lpOfnRaw = emu.readPascalArgs16([4])[0];
    const lpOfn = emu.resolveFarPtr(lpOfnRaw);
    if (!lpOfn) return 0;

    // Read lpstrFile far ptr and nMaxFile from OPENFILENAME16
    const lpstrFileRaw = emu.memory.readU32(lpOfn + 24);
    const lpstrFile = emu.resolveFarPtr(lpstrFileRaw);
    const nMaxFile = emu.memory.readU32(lpOfn + 28);

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'file-open',
      onResult: (file) => {
        emu.waitingForMessage = false;
        if (file) {
          // Store in externalFiles as Z:\filename
          const upperPath = 'Z:\\' + file.name.toUpperCase();
          emu.fs.externalFiles.set(upperPath, { data: file.data, name: file.name });
          // Write path into lpstrFile buffer
          const path = 'Z:\\' + file.name;
          console.log(`[COMMDLG] GetOpenFileName: storing "${upperPath}" (${file.data.length} bytes), writing path "${path}" to buffer at 0x${lpstrFile.toString(16)}, nMaxFile=${nMaxFile}`);
          if (lpstrFile && nMaxFile > 0) {
            for (let i = 0; i < Math.min(path.length, nMaxFile - 1); i++) {
              emu.memory.writeU8(lpstrFile + i, path.charCodeAt(i) & 0xFF);
            }
            emu.memory.writeU8(lpstrFile + Math.min(path.length, nMaxFile - 1), 0);
          }
          emuCompleteThunk16(emu, 1, stackBytes);
        } else {
          emuCompleteThunk16(emu, 0, stackBytes);
        }
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 1);

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 2: GetSaveFileName(lpOfn) — 4 bytes (segptr)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('GetSaveFileName', 4, () => {
    const lpOfnRaw = emu.readPascalArgs16([4])[0];
    const lpOfn = emu.resolveFarPtr(lpOfnRaw);
    if (!lpOfn) return 0;

    // Read lpstrFile far ptr (current filename)
    const lpstrFileRaw = emu.memory.readU32(lpOfn + 24);
    const lpstrFile = emu.resolveFarPtr(lpstrFileRaw);
    const nMaxFile = emu.memory.readU32(lpOfn + 28);
    const currentName = lpstrFile ? emu.memory.readCString(lpstrFile) : '';

    // Get the default filename (strip path)
    let defaultName = currentName;
    const lastSlash = Math.max(currentName.lastIndexOf('\\'), currentName.lastIndexOf('/'));
    if (lastSlash >= 0) defaultName = currentName.substring(lastSlash + 1);
    if (!defaultName) defaultName = 'untitled.txt';

    // Get text content from the focused EDIT control
    let content = '';
    const focusHwnd = emu.focusedWindow;
    if (focusHwnd) {
      const fw = emu.handles.get<WindowInfo>(focusHwnd);
      if (fw?.classInfo?.className?.toUpperCase() === 'EDIT') {
        content = fw.title || '';
      }
    }
    // Fallback: try to find any EDIT control
    if (!content) {
      for (const [, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (wnd?.classInfo?.className?.toUpperCase() === 'EDIT' && wnd.title) {
          content = wnd.title;
          break;
        }
      }
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'file-save',
      defaultName,
      content,
      onResult: (name) => {
        emu.waitingForMessage = false;
        if (name) {
          // Write chosen filename into lpstrFile buffer
          if (lpstrFile && nMaxFile > 0) {
            for (let i = 0; i < Math.min(name.length, nMaxFile - 1); i++) {
              emu.memory.writeU8(lpstrFile + i, name.charCodeAt(i) & 0xFF);
            }
            emu.memory.writeU8(lpstrFile + Math.min(name.length, nMaxFile - 1), 0);
          }
          emuCompleteThunk16(emu, 1, stackBytes);
        } else {
          emuCompleteThunk16(emu, 0, stackBytes);
        }
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 2);

  // Ordinal 5: ChooseFont(lpCf) — 4 bytes (segptr)
  commdlg.register('ChooseFont', 4, () => 0, 5);

  // ─────────────────────────────────────────────────────────────────────────
  // Ordinal 6: FindText(lpFr) — 4 bytes (segptr)
  // Win16 FINDREPLACE struct:
  //   +0:  lStructSize (4)
  //   +4:  hwndOwner (2)
  //   +6:  hInstance (2)
  //   +8:  Flags (4)
  //   +12: lpstrFindWhat (4, far ptr)
  //   +16: lpstrReplaceWith (4, far ptr)
  //   +20: wFindWhatLen (2)
  //   +22: wReplaceWithLen (2)
  // ─────────────────────────────────────────────────────────────────────────
  commdlg.register('FindText', 4, () => {
    const lpFrRaw = emu.readPascalArgs16([4])[0];
    const lpFr = emu.resolveFarPtr(lpFrRaw);
    if (!lpFr) return 0;

    // Find the EDIT control to search in
    let editHwnd = emu.focusedWindow;
    if (editHwnd) {
      const fw = emu.handles.get<WindowInfo>(editHwnd);
      if (!fw || fw.classInfo?.className?.toUpperCase() !== 'EDIT') editHwnd = 0;
    }
    if (!editHwnd) {
      for (const [handle, wnd] of emu.handles.findByType('window') as [number, WindowInfo][]) {
        if (wnd?.classInfo?.className?.toUpperCase() === 'EDIT') {
          editHwnd = handle;
          break;
        }
      }
    }

    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    emu.onShowCommonDialog?.({
      type: 'find',
      editHwnd,
      onClose: () => {
        emu.waitingForMessage = false;
        emuCompleteThunk16(emu, 0, stackBytes);
        if (emu.running && !emu.halted) requestAnimationFrame(emu.tick);
      },
    });
    return undefined;
  }, 6);

  // Ordinal 7: ReplaceText(lpFr) — 4 bytes (segptr)
  commdlg.register('ReplaceText', 4, () => 0, 7);

  // Ordinal 11: CommDlgExtendedError() — 0 bytes
  commdlg.register('CommDlgExtendedError', 0, () => 0, 11);

  // Ordinal 13: PrintDlg(lpPd) — 4 bytes (segptr)
  // Returns 0 = user cancelled
  commdlg.register('PrintDlg', 4, () => 0, 13);

  // Ordinal 15: ChooseFont(lpCf) — 4 bytes (segptr) — duplicate ordinal 5 alias
  commdlg.register('ChooseFont', 4, () => 0, 15);

  // Ordinal 26: CommDlgExtendedError() — 0 bytes
  // Returns 0 = no error (user cancelled), non-zero = error code
  commdlg.register('CommDlgExtendedError', 0, () => 0, 26);

  // Ordinal 27: ChooseColor — stub (return 0 = cancelled)
  commdlg.register('ChooseColor', 4, () => 0, 27);

  // Ordinal 28: WEP(word) — DLL exit procedure
  commdlg.register('WEP', 2, () => 1, 28);
}
