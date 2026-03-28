import type { Emulator } from '../emulator';

export function registerUxtheme(emu: Emulator): void {
  const ux = emu.registerDll('UXTHEME.DLL');
  // Theme handle management
  ux.register('OpenThemeData', 2, () => 0); // return NULL = no theme
  ux.register('CloseThemeData', 1, () => 0); // S_OK
  // Theme drawing — all return E_HANDLE (no valid theme)
  const E_HANDLE = 0x80070006 | 0;
  ux.register('DrawThemeBackground', 6, () => E_HANDLE);
  ux.register('DrawThemeBackgroundEx', 7, () => E_HANDLE);
  ux.register('DrawThemeText', 8, () => E_HANDLE);
  ux.register('DrawThemeTextEx', 9, () => E_HANDLE);
  ux.register('DrawThemeEdge', 8, () => E_HANDLE);
  ux.register('DrawThemeIcon', 7, () => E_HANDLE);
  ux.register('DrawThemeParentBackground', 3, () => 0);
  ux.register('DrawThemeParentBackgroundEx', 4, () => 0);
  // Theme metrics / properties
  ux.register('GetThemePartSize', 7, () => E_HANDLE);
  ux.register('GetThemeTextExtent', 8, () => E_HANDLE);
  ux.register('GetThemeBackgroundContentRect', 6, () => E_HANDLE);
  ux.register('GetThemeBackgroundExtent', 6, () => E_HANDLE);
  ux.register('GetThemeBackgroundRegion', 6, () => E_HANDLE);
  ux.register('GetThemeColor', 5, () => E_HANDLE);
  ux.register('GetThemeFont', 6, () => E_HANDLE);
  ux.register('GetThemeInt', 5, () => E_HANDLE);
  ux.register('GetThemeMetric', 6, () => E_HANDLE);
  ux.register('GetThemeBool', 5, () => E_HANDLE);
  ux.register('GetThemeMargins', 7, () => E_HANDLE);
  ux.register('GetThemeString', 6, () => E_HANDLE);
  ux.register('GetThemePosition', 5, () => E_HANDLE);
  ux.register('GetThemeRect', 5, () => E_HANDLE);
  ux.register('GetThemeEnumValue', 5, () => E_HANDLE);
  ux.register('GetThemePropertyOrigin', 5, () => E_HANDLE);
  ux.register('GetThemeFilename', 6, () => E_HANDLE);
  ux.register('GetThemeIntList', 5, () => E_HANDLE);
  // Global theme state
  ux.register('IsThemeActive', 0, () => 0); // FALSE — no theme active
  ux.register('IsAppThemed', 0, () => 0); // FALSE
  ux.register('IsThemePartDefined', 3, () => 0); // FALSE
  ux.register('IsThemeBackgroundPartiallyTransparent', 3, () => 0);
  // System metrics
  ux.register('GetThemeSysColor', 2, () => 0);
  ux.register('GetThemeSysColorBrush', 2, () => 0);
  ux.register('GetThemeSysFont', 3, () => E_HANDLE);
  ux.register('GetThemeSysSize', 2, () => 0);
  ux.register('GetThemeSysInt', 3, () => E_HANDLE);
  ux.register('GetThemeSysBool', 2, () => 0);
  // Window theme
  ux.register('SetWindowTheme', 3, () => 0); // S_OK
  ux.register('GetWindowTheme', 1, () => 0); // NULL
  // DPI
  ux.register('GetThemeDocumentationProperty', 4, () => E_HANDLE);
  ux.register('GetCurrentThemeName', 6, () => E_HANDLE);
  // Misc
  ux.register('EnableThemeDialogTexture', 2, () => 0);
  ux.register('IsThemeDialogTextureEnabled', 1, () => 0);
  ux.register('EnableTheming', 1, () => 0);
  ux.register('HitTestThemeBackground', 9, () => E_HANDLE);
  ux.register('BufferedPaintInit', 0, () => 0);
  ux.register('BufferedPaintUnInit', 0, () => 0);
}
