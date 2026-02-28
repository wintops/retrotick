import type { Emulator, Win16Module, DialogControlInfo } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import { getNonClientMetrics } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';

// Win16 USER module — Dialogs & controls

export function registerWin16UserDialog(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 87: DialogBox(hInst, lpTemplate_ptr, hWndParent, dlgProc_segptr) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_87', 12, () => {
    const [hInst, lpTemplate, hWndParent, dlgProc] = emu.readPascalArgs16([2, 4, 2, 4]);
    return showWin16Dialog(emu, lpTemplate, hWndParent, dlgProc);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 88: EndDialog(hDlg, nResult_sword) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_88', 4, () => {
    const [hDlg, nResult] = emu.readPascalArgs16([2, 2]);
    const wnd = emu.handles.get<WindowInfo>(hDlg);
    if (wnd) {
      const endDialog = (wnd as any)._endDialog as ((r: number) => void) | undefined;
      if (endDialog) endDialog(nResult);
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 90: IsDialogMessage(hDlg, lpMsg) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_90', 6, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 91: GetDlgItem(hDlg, nIDDlgItem) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_91', 4, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 92: SetDlgItemText(hDlg, nIDDlgItem, lpString) — 8 bytes (2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_92', 8, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 94: SetDlgItemInt(hDlg, nID, wValue, bSigned) — 8 bytes (2+2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_94', 8, () => 1);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 96: CheckRadioButton(hDlg, nFirst, nLast, nCheck) — 8 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_96', 8, () => {
    const hDlg = emu.readArg16(0);
    const nFirst = emu.readArg16(2);
    const nLast = emu.readArg16(4);
    const nCheck = emu.readArg16(6);
    const wnd = emu.handles.get<WindowInfo>(hDlg);
    if (wnd?.children) {
      for (const [ctrlId, childHwnd] of wnd.children) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child && ctrlId >= nFirst && ctrlId <= nLast) {
          child.checked = (ctrlId === nCheck) ? 1 : 0;
        }
      }
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 97: CheckDlgButton(hDlg, nID, uCheck) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_97', 6, () => {
    const hDlg = emu.readArg16(0);
    const nID = emu.readArg16(2);
    const uCheck = emu.readArg16(4);
    const wnd = emu.handles.get<WindowInfo>(hDlg);
    if (wnd?.children) {
      for (const [ctrlId, childHwnd] of wnd.children) {
        if (ctrlId === nID) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (child) child.checked = uCheck & 0x3;
        }
      }
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 98: IsDlgButtonChecked(hDlg, nID) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_98', 4, () => {
    const hDlg = emu.readArg16(0);
    const nID = emu.readArg16(2);
    const wnd = emu.handles.get<WindowInfo>(hDlg);
    if (wnd?.children) {
      for (const [ctrlId, childHwnd] of wnd.children) {
        if (ctrlId === nID) {
          const child = emu.handles.get<WindowInfo>(childHwnd);
          if (child) return child.checked ?? 0;
        }
      }
    }
    return 0;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 102: AdjustWindowRect(lpRect_ptr, dwStyle_long, bMenu) — 10 bytes (4+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_102', 10, () => {
    const [lpRect, dwStyle, bMenu] = emu.readPascalArgs16([4, 4, 2]);
    if (lpRect) {
      const { bw, captionH, menuH } = getNonClientMetrics(dwStyle, !!bMenu, true);
      const l = emu.memory.readI16(lpRect) - bw;
      const t = emu.memory.readI16(lpRect + 2) - bw - captionH - menuH;
      const r = emu.memory.readI16(lpRect + 4) + bw;
      const b = emu.memory.readI16(lpRect + 6) + bw;
      emu.memory.writeU16(lpRect, l & 0xFFFF);
      emu.memory.writeU16(lpRect + 2, t & 0xFFFF);
      emu.memory.writeU16(lpRect + 4, r & 0xFFFF);
      emu.memory.writeU16(lpRect + 6, b & 0xFFFF);
    }
    return 1;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 239: DialogBoxParam(hInst, lpTemplate, hWndParent, dlgProc, dwInitParam) — 16 bytes (2+4+2+4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_239', 16, () => 0);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 454: AdjustWindowRectEx(lpRect_ptr, dwStyle_long, bMenu, dwExStyle_long) — 14 bytes (4+4+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('ord_454', 14, () => {
    const [lpRect, dwStyle, bMenu, _dwExStyle] = emu.readPascalArgs16([4, 4, 2, 4]);
    if (lpRect) {
      const { bw, captionH, menuH } = getNonClientMetrics(dwStyle, !!bMenu, true);
      const l = emu.memory.readI16(lpRect) - bw;
      const t = emu.memory.readI16(lpRect + 2) - bw - captionH - menuH;
      const r = emu.memory.readI16(lpRect + 4) + bw;
      const b = emu.memory.readI16(lpRect + 6) + bw;
      emu.memory.writeU16(lpRect, l & 0xFFFF);
      emu.memory.writeU16(lpRect + 2, t & 0xFFFF);
      emu.memory.writeU16(lpRect + 4, r & 0xFFFF);
      emu.memory.writeU16(lpRect + 6, b & 0xFFFF);
    }
    return 1;
  });
}

// Win16 dialog class codes
const DLG_CLASS_BUTTON = 0x80;
const DLG_CLASS_EDIT = 0x81;
const DLG_CLASS_STATIC = 0x82;
const DLG_CLASS_LISTBOX = 0x83;
const DLG_CLASS_SCROLLBAR = 0x84;
const DLG_CLASS_COMBOBOX = 0x85;

const classNames: Record<number, string> = {
  [DLG_CLASS_BUTTON]: 'BUTTON',
  [DLG_CLASS_EDIT]: 'EDIT',
  [DLG_CLASS_STATIC]: 'STATIC',
  [DLG_CLASS_LISTBOX]: 'LISTBOX',
  [DLG_CLASS_SCROLLBAR]: 'SCROLLBAR',
  [DLG_CLASS_COMBOBOX]: 'COMBOBOX',
};

function parseWin16DialogTemplate(data: Uint8Array): {
  style: number; nItems: number; x: number; y: number; cx: number; cy: number;
  title: string; controls: DialogControlInfo[];
} | null {
  if (data.length < 13) return null;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const style = dv.getUint32(0, true);
  const nItems = data[4];
  const x = dv.getUint16(5, true);
  const y = dv.getUint16(7, true);
  const cx = dv.getUint16(9, true);
  const cy = dv.getUint16(11, true);
  let off = 13;

  // Menu: 0 = none, else string or ordinal
  if (data[off] === 0) off++;
  else { while (off < data.length && data[off] !== 0) off++; off++; }

  // Class: 0 = default
  if (data[off] === 0) off++;
  else { while (off < data.length && data[off] !== 0) off++; off++; }

  // Title
  let title = '';
  while (off < data.length && data[off] !== 0) { title += String.fromCharCode(data[off]); off++; }
  off++; // skip null terminator

  // Font (if DS_SETFONT = 0x40 in style)
  if (style & 0x40) {
    off += 2; // font size
    while (off < data.length && data[off] !== 0) off++; off++; // font name
  }

  const controls: DialogControlInfo[] = [];
  for (let i = 0; i < nItems && off + 9 < data.length; i++) {
    const cx2 = dv.getUint16(off, true);
    const cy2 = dv.getUint16(off + 2, true);
    const cw = dv.getUint16(off + 4, true);
    const ch = dv.getUint16(off + 6, true);
    const id = dv.getUint16(off + 8, true);
    const cstyle = dv.getUint32(off + 10, true);
    off += 14;

    // Class
    let className: string;
    if (data[off] >= 0x80 && data[off] <= 0x85) {
      className = classNames[data[off]] || 'STATIC';
      off++;
    } else {
      className = '';
      while (off < data.length && data[off] !== 0) { className += String.fromCharCode(data[off]); off++; }
      off++;
    }

    // Text
    let text = '';
    if (data[off] === 0xFF) {
      // Resource ID reference
      off++;
      const resId = dv.getUint16(off, true);
      text = `#${resId}`;
      off += 2;
    } else {
      while (off < data.length && data[off] !== 0) { text += String.fromCharCode(data[off]); off++; }
      off++;
    }

    // Extra byte count
    if (off < data.length) off += data[off] + 1;
    else off++;

    controls.push({ id, className, text, style: cstyle, x: cx2, y: cy2, width: cw, height: ch });
  }

  return { style, nItems, x, y, cx, cy, title, controls };
}

function showWin16Dialog(emu: Emulator, lpTemplate: number, hWndParent: number, dlgProc: number): number | undefined {
  // lpTemplate is a far pointer to resource name/ID
  // For integer resource IDs, it's typically just the ID value
  const templateId = lpTemplate & 0xFFFF;

  // Find the dialog resource in NE resources
  const res = emu.ne?.resources.find(r => r.typeID === 5 && r.id === templateId);
  if (!res) {
    console.warn(`[WIN16] DialogBox: dialog template ${templateId} not found`);
    return 0;
  }

  // Read template from the original file data (stored in memory by NE loader)
  // NE resources are loaded into memory at known offsets
  const data = new Uint8Array(res.length);
  for (let i = 0; i < res.length; i++) {
    // Read from original array buffer via the NE resource's file offset
    data[i] = new Uint8Array(emu._arrayBuffer!)[res.fileOffset + i];
  }

  const dlg = parseWin16DialogTemplate(data);
  if (!dlg) {
    console.warn(`[WIN16] DialogBox: failed to parse dialog template ${templateId}`);
    return 0;
  }

  console.log(`[WIN16] DialogBox template=${templateId} title="${dlg.title}" ${dlg.cx}x${dlg.cy} controls=${dlg.controls.length}`);

  // Scale from dialog units to pixels (approximate: 1 DLU ≈ 1.5px horizontal, 1.75px vertical)
  const scaleX = 1.5, scaleY = 1.75;
  const pw = Math.round(dlg.cx * scaleX);
  const ph = Math.round(dlg.cy * scaleY);

  // Create dialog window handle
  const hwnd = emu.handles.alloc('window', {
    classInfo: { className: '#32770', wndProc: dlgProc, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
    title: dlg.title,
    style: dlg.style,
    exStyle: 0,
    x: 0, y: 0,
    width: pw, height: ph,
    hMenu: 0,
    parent: hWndParent,
    wndProc: dlgProc,
    dlgProc,
    visible: true,
    extraBytes: new Uint8Array(40),
    children: new Map(),
    childList: [] as number[],
  } as WindowInfo);

  // Create child controls
  for (const ctrl of dlg.controls) {
    const childHwnd = emu.handles.alloc('window', {
      classInfo: { className: ctrl.className, wndProc: 0, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: ctrl.text,
      style: ctrl.style,
      exStyle: 0,
      x: Math.round(ctrl.x * scaleX),
      y: Math.round(ctrl.y * scaleY),
      width: Math.round(ctrl.width * scaleX),
      height: Math.round(ctrl.height * scaleY),
      hMenu: 0,
      parent: hwnd,
      wndProc: 0,
      controlId: ctrl.id,
      visible: true,
      extraBytes: new Uint8Array(0),
      children: new Map(),
    } as WindowInfo);
    const wnd = emu.handles.get<WindowInfo>(hwnd);
    if (wnd) {
      wnd.children!.set(ctrl.id, childHwnd);
      if (!wnd.childList) wnd.childList = [];
      wnd.childList.push(childHwnd);
    }
  }

  // Show dialog using the emulator's dialog display mechanism
  const dialogInfo = {
    title: dlg.title,
    style: dlg.style,
    width: pw,
    height: ph,
    hwnd,
    controls: dlg.controls.map(c => ({
      ...c,
      x: Math.round(c.x * scaleX),
      y: Math.round(c.y * scaleY),
      width: Math.round(c.width * scaleX),
      height: Math.round(c.height * scaleY),
    })),
    overlays: [],
    controlValues: new Map<number, string>(),
  };

  const stackBytes = emu._currentThunkStackBytes;
  emu.waitingForMessage = true;

  // Store endDialog callback
  const endDialog = (result: number) => {
    emu.handles.free(hwnd);
    emu.onCloseDialog?.();
    emu.waitingForMessage = false;
    emuCompleteThunk16(emu, result, stackBytes);
    if (emu.running && !emu.halted) {
      requestAnimationFrame(emu.tick);
    }
  };

  // Store endDialog on the window for EndDialog to find
  const wnd = emu.handles.get<WindowInfo>(hwnd);
  if (wnd) (wnd as any)._endDialog = endDialog;

  emu.onShowDialog?.(dialogInfo);

  return undefined; // async
}
