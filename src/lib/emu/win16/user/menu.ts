import type { Emulator, Win16Module } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { findMenuItemById } from './index';
import type { Win16UserHelpers } from './index';
import { extractMenus } from '../../../pe/extract-menu';
import { getClientSize } from '../../win32/user32/_helpers';

// Win16 USER module — Menu operations

export function registerWin16UserMenu(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 150: LoadMenu(hInstance, lpMenuName_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('LoadMenu', 6, () => {
    const [hInstance, lpMenuName] = emu.readPascalArgs16([2, 4]);
    // Extract menu resource ID from lpMenuName (MAKEINTRESOURCE or string)
    const seg = (lpMenuName >>> 16) & 0xFFFF;
    const menuId = seg === 0 ? (lpMenuName & 0xFFFF) : 0;
    // Populate emu.menuItems from NE resources if not yet done
    if (!emu.menuItems && emu.peInfo && emu._arrayBuffer) {
      const menus = extractMenus(emu.peInfo, emu._arrayBuffer);
      if (menuId > 0) {
        const match = menus.find(m => m.id === menuId);
        if (match) emu.menuItems = match.menu.items;
      }
      if (!emu.menuItems && menus.length > 0) {
        emu.menuItems = menus[0].menu.items;
      }
    }
    return 1;
  }, 150);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 151: CreateMenu() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreateMenu', 0, () => emu.handles.alloc('menu', { items: [] }), 151);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 154: CheckMenuItem(hMenu, uIDCheckItem, uCheck) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CheckMenuItem', 6, () => {
    const [hMenu, uIDCheckItem, uCheck] = emu.readPascalArgs16([2, 2, 2]);
    if (!emu.menuItems) return -1;
    const MF_BYPOSITION = 0x400;
    const MF_CHECKED = 0x8;
    const byPos = !!(uCheck & MF_BYPOSITION);
    const item = byPos ? null : findMenuItemById(emu.menuItems, uIDCheckItem);
    if (!item) return -1;
    const prev = item.isChecked ? MF_CHECKED : 0;
    item.isChecked = !!(uCheck & MF_CHECKED);
    emu.onMenuChanged?.();
    return prev;
  }, 154);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 155: EnableMenuItem(hMenu, uIDEnableItem, uEnable) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('EnableMenuItem', 6, () => {
    const [_hMenu, uIDEnableItem, uEnable] = emu.readPascalArgs16([2, 2, 2]);
    if (!emu.menuItems) return -1;
    const MF_BYPOSITION = 0x400;
    const MF_GRAYED = 0x1;
    const byPos = !!(uEnable & MF_BYPOSITION);
    const item = byPos ? null : findMenuItemById(emu.menuItems, uIDEnableItem);
    if (!item) return -1;
    const prev = item.isGrayed ? MF_GRAYED : 0;
    item.isGrayed = !!(uEnable & MF_GRAYED);
    emu.onMenuChanged?.();
    return prev;
  }, 155);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 157: GetMenu(hWnd) — 2 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetMenu', 2, () => 0, 157);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 158: SetMenu(hWnd, hMenu) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetMenu', 4, () => {
    const [hWnd, hMenu] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hWnd);
    if (wnd) {
      const hadMenu = wnd.hMenu !== 0;
      wnd.hMenu = hMenu;
      // Resize canvas if menu presence changed on the main window
      if (hWnd === emu.mainWindow && (!!hMenu !== hadMenu)) {
        const { cw, ch } = getClientSize(wnd.style, !!hMenu, wnd.width, wnd.height, true);
        emu.setupCanvasSize(cw, ch);
        emu.onWindowChange?.(wnd);
      }
    }
    return 1;
  }, 158);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 159: GetSubMenu(hMenu, nPos) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetSubMenu', 4, () => 0, 159);

  // Ordinal 160: DrawMenuBar(hWnd) — 2 bytes
  user.register('DrawMenuBar', 2, () => 0, 160);

  // Ordinal 263: GetMenuItemCount(hMenu) — 2 bytes
  user.register('GetMenuItemCount', 2, () => 0, 263);

  // Ordinal 410: InsertMenu — 12 bytes
  user.register('InsertMenu', 12, () => 1, 410);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 411: AppendMenu(hMenu, uFlags, uIDNewItem, lpNewItem) — 10 bytes (2+2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AppendMenu', 10, () => 1, 411);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 412: RemoveMenu(hMenu, uPosition, uFlags) — 6 bytes (2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('RemoveMenu', 6, () => 1, 412);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 413: DeleteMenu(hMenu, uPosition, uFlags) — 6 bytes (2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DeleteMenu', 6, () => 1, 413);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 415: CreatePopupMenu() — 0 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreatePopupMenu', 0, () => emu.handles.alloc('menu', { items: [] }), 415);

  // Ordinal 417: GetMenuCheckMarkDimensions() — 0 bytes → 16x16
  user.register('GetMenuCheckMarkDimensions', 0, () => ((16 << 16) | 16), 417);

  // Ordinal 418: SetMenuItemBitmaps — 10 bytes
  user.register('SetMenuItemBitmaps', 10, () => 1, 418);
}
