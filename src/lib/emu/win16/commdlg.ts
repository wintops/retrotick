import type { Emulator } from '../emulator';

// Win16 COMMDLG module — common dialog stubs

export function registerWin16Commdlg(emu: Emulator): void {
  const commdlg = emu.registerModule16('COMMDLG');

  // Ordinal 1: GetOpenFileName(lpOfn) — 4 bytes (segptr)
  // Returns 0 = user cancelled
  commdlg.register('ord_1', 4, () => 0);

  // Ordinal 2: GetSaveFileName(lpOfn) — 4 bytes (segptr)
  // Returns 0 = user cancelled
  commdlg.register('ord_2', 4, () => 0);

  // Ordinal 5: ChooseFont(lpCf) — 4 bytes (segptr)
  commdlg.register('ord_5', 4, () => 0);

  // Ordinal 6: FindText(lpFr) — 4 bytes (segptr)
  commdlg.register('ord_6', 4, () => 0);

  // Ordinal 7: ReplaceText(lpFr) — 4 bytes (segptr)
  commdlg.register('ord_7', 4, () => 0);

  // Ordinal 11: CommDlgExtendedError() — 0 bytes
  commdlg.register('ord_11', 0, () => 0);

  // Ordinal 13: PrintDlg(lpPd) — 4 bytes (segptr)
  // Returns 0 = user cancelled
  commdlg.register('ord_13', 4, () => 0);

  // Ordinal 27: ChooseColor — stub (return 0 = cancelled)
  commdlg.register('ord_27', 4, () => 0);
}
