import type { Emulator } from '../emulator';

// Win16 COMMCTRL module (Common Controls) — minimal stubs
// Winfile imports this for toolbar/status bar support

export function registerWin16Commctrl(emu: Emulator): void {
  const cc = emu.registerModule16('COMMCTRL');

  // Ordinal 2: InitCommonControls() — 0 bytes
  cc.register('InitCommonControls', 0, () => 0, 2);

  // Ordinal 4: CreatePropertySheetPage(lppsp) — 4 bytes (ptr)
  cc.register('CreatePropertySheetPage', 4, () => 0, 4);

  // Ordinal 5: CreateStatusWindow(style, lpszText, hwndParent, wID) — 14 bytes (4+4+2+2 + padding)
  cc.register('CreateStatusWindow', 14, () => 0, 5);

  // Ordinal 6: CreateToolbar — stub
  cc.register('CreateToolbar', 28, () => 0, 6);

  // Ordinal 7: CreateHeaderWindow — 14 bytes
  cc.register('CreateHeaderWindow', 14, () => 0, 7);

  // Ordinal 13: MenuHelp — 18 bytes
  cc.register('MenuHelp', 18, () => 0, 13);

  // Ordinal 14: ShowHideMenuCtl — 8 bytes
  cc.register('ShowHideMenuCtl', 8, () => 0, 14);

  // Ordinal 15: GetEffectiveClientRect — 10 bytes
  cc.register('GetEffectiveClientRect', 10, () => 0, 15);

  // Ordinal 16: DrawStatusText(hDC, lpRect, lpString, uFlags) — 14 bytes
  cc.register('DrawStatusText', 14, () => 0, 16);

  // Ordinal 17: CreateUpDownControl — 24 bytes
  cc.register('CreateUpDownControl', 24, () => 0, 17);
}
