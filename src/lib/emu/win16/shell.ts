import type { Emulator } from '../emulator';

// Win16 SHELL module — API stubs by ordinal

export function registerWin16Shell(emu: Emulator): void {
  const shell = emu.registerModule16('SHELL');

  // Ordinal 9: DragAcceptFiles(hWnd, fAccept) — 4 bytes
  shell.register('ord_9', 4, () => 0);

  // Ordinal 22: ShellAbout(hwnd, szApp, szOtherStuff, hIcon) — 14 bytes
  shell.register('ord_22', 12, () => 1);

  // Ordinal 11: FindExecutable — 12 bytes
  shell.register('ord_11', 12, () => 0);

  // Ordinal 12: ShellExecute — 20 bytes
  shell.register('ord_12', 20, () => 33); // > 32 = success

  // Named import: SHELLABOUT (same as ord_22)
  shell.register('SHELLABOUT', 12, () => 1);
}
