import type { Emulator, Win16Module } from '../../emulator';
import type { Win16UserHelpers } from './index';

// Win16 USER module — Resource loading

export function registerWin16UserResource(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 173: LoadCursor(hInstance, lpCursorName_ptr) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  const idcToCss: Record<number, string> = {
    32512: 'default',      // IDC_ARROW
    32513: 'text',          // IDC_IBEAM
    32514: 'wait',          // IDC_WAIT
    32515: 'crosshair',     // IDC_CROSS
    32516: 'n-resize',      // IDC_UPARROW
    32642: 'nwse-resize',   // IDC_SIZENWSE
    32643: 'nesw-resize',   // IDC_SIZENESW
    32644: 'ew-resize',     // IDC_SIZEWE
    32645: 'ns-resize',     // IDC_SIZENS
    32646: 'move',          // IDC_SIZEALL
    32648: 'not-allowed',   // IDC_NO
    32649: 'pointer',       // IDC_HAND
    32650: 'progress',      // IDC_APPSTARTING
    32651: 'help',          // IDC_HELP
  };
  user.register('LoadCursor', 6, () => {
    const [hInstance, lpCursorName] = emu.readPascalArgs16([2, 4]);
    let css = 'default';
    if (hInstance === 0 && lpCursorName < 0x10000) {
      css = idcToCss[lpCursorName] || 'default';
    }
    return emu.handles.alloc('cursor', { css });
  }, 173);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 174: LoadIcon(hInstance, lpIconName_ptr) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('LoadIcon', 6, () => {
    const [hInstance, lpIconName] = emu.readPascalArgs16([2, 4]);
    const iconId = lpIconName < 0x10000 ? lpIconName : 0;
    if (iconId) {
      const hIcon = emu.loadIconResource(iconId);
      if (hIcon) return hIcon;
    }
    return 1; // fallback handle
  }, 174);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 175: LoadBitmap(hInstance, lpBitmapName_ptr) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('LoadBitmap', 6, () => {
    const [hInstance, lpBitmapName] = emu.readPascalArgs16([2, 4]);
    const seg = (lpBitmapName >>> 16) & 0xFFFF;
    const off = lpBitmapName & 0xFFFF;
    if (seg === 0) {
      // Integer resource ID
      // console.log(`[WIN16] LoadBitmap hInst=0x${hInstance.toString(16)} id=${off}`);
      return emu.loadBitmapResource(off) || off || 1;
    } else {
      // Far pointer to string name
      const linear = emu.resolveFarPtr(lpBitmapName);
      const name = emu.memory.readCString(linear);
      // Try string name first, then try parsing trailing number as integer resource ID
      let result = emu.loadBitmapResourceByName(name);
      if (!result) {
        const match = name.match(/\d+$/);
        if (match) result = emu.loadBitmapResource(parseInt(match[0], 10));
      }
      return result || 1;
    }
  }, 175);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 176: LoadString(hInstance, uID, lpBuffer_ptr, nBufferMax) — 10 bytes (2+2+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('LoadString', 10, () => {
    const [hInstance, uID, lpBuffer, nBufferMax] = emu.readPascalArgs16([2, 2, 4, 2]);
    const str = emu.loadNEString(uID);
    // console.log(`[WIN16] LoadString id=${uID} → "${str}" (maxLen=${nBufferMax})`);
    if (lpBuffer && nBufferMax > 0) {
      const maxCopy = Math.min(str.length, nBufferMax - 1);
      for (let i = 0; i < maxCopy; i++) {
        emu.memory.writeU8(lpBuffer + i, str.charCodeAt(i));
      }
      emu.memory.writeU8(lpBuffer + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  }, 176);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 177: LoadAccelerators(hInstance, lpTableName) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('LoadAccelerators', 6, () => 1, 177);
}
