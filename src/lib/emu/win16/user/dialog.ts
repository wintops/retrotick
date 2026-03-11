import type { Emulator, Win16Module, DialogControlInfo } from '../../emulator';
import type { WindowInfo } from '../../win32/user32/types';
import type { NEResourceEntry } from '../../ne-loader';
import { getNonClientMetrics } from '../../win32/user32/_helpers';
import type { Win16UserHelpers } from './index';
import { emuCompleteThunk16 } from '../../emu-exec';

// Win16 USER module — Dialogs & controls

export function registerWin16UserDialog(emu: Emulator, user: Win16Module, h: Win16UserHelpers): void {
  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 87: DialogBox(hInst, lpTemplate_ptr, hWndParent, dlgProc_segptr) — 12 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DialogBox', 12, () => {
    const [hInst, lpTemplate, hWndParent, dlgProc] = emu.readPascalArgs16([2, 4, 2, 4]);
    return showWin16Dialog(emu, lpTemplate, hWndParent, dlgProc);
  }, 87);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 88: EndDialog(hDlg, nResult_sword) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('EndDialog', 4, () => {
    const [_hDlg, nResult] = emu.readPascalArgs16([2, 2]);
    if (emu.dialogState) {
      emu.dialogState.result = nResult;
      emu.dialogState.ended = true;
      // Don't call _endDialog here — we're inside callWndProc16 and the stack
      // is in WM_COMMAND state, not DialogBox state. The dialog message pump
      // will detect ds.ended and call _dialogResolve after restoring CPU state.
    }
    return 0;
  }, 88);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 89: CreateDialog(hInst, lpTemplate, hWndParent, dlgProc) — 12 bytes (2+4+2+4)
  // Creates a modeless dialog box. Returns dialog HWND or 0 on failure.
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CreateDialog', 12, () => {
    const [_hInst, _lpTemplate, _hWndParent, _dlgProc] = emu.readPascalArgs16([2, 4, 2, 4]);
    // Stub — modeless dialogs not yet supported
    return 0;
  }, 89);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 90: IsDialogMessage(hDlg, lpMsg) — 6 bytes (2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('IsDialogMessage', 6, () => 0, 90);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 91: GetDlgItem(hDlg, nIDDlgItem) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetDlgItem', 4, () => {
    const [hDlg, nIDDlgItem] = emu.readPascalArgs16([2, 2]);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    const childHwnd = dlgWnd?.children?.get(nIDDlgItem) ?? 0;
    // console.log(`[WIN16] GetDlgItem(0x${hDlg.toString(16)}, ${nIDDlgItem}) → 0x${childHwnd.toString(16)}`);
    return childHwnd;
  }, 91);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 92: SetDlgItemText(hDlg, nIDDlgItem, lpString) — 8 bytes (2+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetDlgItemText', 8, () => {
    const [hDlg, nIDDlgItem, lpString] = emu.readPascalArgs16([2, 2, 4]);
    const dlgWnd = emu.handles.get<WindowInfo>(hDlg);
    if (dlgWnd) {
      const childHwnd = dlgWnd.children?.get(nIDDlgItem);
      if (childHwnd) {
        const child = emu.handles.get<WindowInfo>(childHwnd);
        if (child && lpString) {
          child.title = emu.memory.readCString(lpString);
          // console.log(`[WIN16] SetDlgItemText(dlg=0x${hDlg.toString(16)}, id=${nIDDlgItem}, "${child.title}")`);
        }
      }
    }
    return 1;
  }, 92);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 94: SetDlgItemInt(hDlg, nID, wValue, bSigned) — 8 bytes (2+2+2+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('SetDlgItemInt', 8, () => 1, 94);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 95: GetDlgItemInt(hDlg, nIDDlgItem, lpTranslated, bSigned) — 10 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('GetDlgItemInt', 10, () => {
    const [hDlg, nID, lpTranslated, bSigned] = emu.readPascalArgs16([2, 2, 4, 2]);
    if (lpTranslated) emu.memory.writeU16(lpTranslated, 0); // FALSE = translation failed
    return 0;
  }, 95);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 96: CheckRadioButton(hDlg, nFirst, nLast, nCheck) — 8 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CheckRadioButton', 8, () => {
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
  }, 96);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 97: CheckDlgButton(hDlg, nID, uCheck) — 6 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('CheckDlgButton', 6, () => {
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
  }, 97);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 98: IsDlgButtonChecked(hDlg, nID) — 4 bytes
  // ───────────────────────────────────────────────────────────────────────────
  user.register('IsDlgButtonChecked', 4, () => {
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
  }, 98);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 102: AdjustWindowRect(lpRect_ptr, dwStyle_long, bMenu) — 10 bytes (4+4+2)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AdjustWindowRect', 10, () => {
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
  }, 102);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 239: DialogBoxParam(hInst, lpTemplate, hWndParent, dlgProc, dwInitParam) — 16 bytes (2+4+2+4+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('DialogBoxParam', 16, () => 0, 239);

  // ───────────────────────────────────────────────────────────────────────────
  // Ordinal 454: AdjustWindowRectEx(lpRect_ptr, dwStyle_long, bMenu, dwExStyle_long) — 14 bytes (4+4+2+4)
  // ───────────────────────────────────────────────────────────────────────────
  user.register('AdjustWindowRectEx', 14, () => {
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
  }, 454);
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
  title: string; fontSize: number; controls: DialogControlInfo[];
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
  let fontSize = 8; // default MS Sans Serif 8pt
  if (style & 0x40) {
    fontSize = dv.getUint16(off, true);
    off += 2;
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

  return { style, nItems, x, y, cx, cy, title, fontSize, controls };
}

function showWin16Dialog(emu: Emulator, lpTemplate: number, hWndParent: number, dlgProc: number): number | undefined {
  // lpTemplate is either MAKEINTRESOURCE(id) (high word = 0) or a pointer to string name
  let res;
  let sourceBuffer: ArrayBuffer | undefined = emu._arrayBuffer!;
  const matchRes = (r: NEResourceEntry) => {
    if (r.typeID !== 5) return false;
    if (lpTemplate < 0x10000) return r.id === lpTemplate;
    const templateName = emu.memory.readCString(lpTemplate);
    return r.name?.toUpperCase() === templateName.toUpperCase();
  };
  // Search main EXE resources first
  if (emu.ne) res = emu.ne.resources.find(matchRes);
  // Fall back to DLL resources
  if (!res) {
    for (const dllInfo of emu.neDllResources) {
      res = dllInfo.resources.find(matchRes);
      if (res) { sourceBuffer = dllInfo.arrayBuffer; break; }
    }
  }
  if (!res) {
    console.warn(`[WIN16] DialogBox: dialog template ${lpTemplate < 0x10000 ? lpTemplate : emu.memory.readCString(lpTemplate)} not found`);
    return 0;
  }

  // Read template from the original file data
  const data = new Uint8Array(res.length);
  for (let i = 0; i < res.length; i++) {
    data[i] = new Uint8Array(sourceBuffer!)[res.fileOffset + i];
  }

  const dlg = parseWin16DialogTemplate(data);
  if (!dlg) {
    console.warn(`[WIN16] DialogBox: failed to parse dialog template ${res.name ?? res.id}`);
    return 0;
  }

  // console.log(`[WIN16] DialogBox template=${res.name ?? res.id} title="${dlg.title}" ${dlg.cx}x${dlg.cy} controls=${dlg.controls.length}`);
  // for (const c of dlg.controls) {
  //   console.log(`  [DLG] id=${c.id} class="${c.className}" text="${c.text}" style=0x${c.style.toString(16)} ${c.x},${c.y} ${c.width}x${c.height}`);
  // }

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
    hwnd: 0, // set below
    extraBytes: new Uint8Array(40),
    children: new Map(),
    childList: [] as number[],
  } as WindowInfo);
  { const w = emu.handles.get<WindowInfo>(hwnd); if (w) w.hwnd = hwnd; }

  // Create child controls
  for (const ctrl of dlg.controls) {
    // For SS_ICON controls, load the icon resource
    let hImage: number | undefined;
    const SS_ICON = 0x03;
    if (ctrl.className === 'STATIC' && (ctrl.style & 0x1F) === SS_ICON && ctrl.text.startsWith('#')) {
      const iconId = parseInt(ctrl.text.slice(1), 10);
      if (iconId) hImage = emu.loadIconResource(iconId);
    }
    // SS_ICON controls auto-size to icon dimensions (default 32x32)
    let cw = Math.round(ctrl.width * scaleX);
    let ch = Math.round(ctrl.height * scaleY);
    if (ctrl.className === 'STATIC' && (ctrl.style & 0x1F) === SS_ICON && cw === 0 && ch === 0) {
      if (hImage) {
        const icon = emu.handles.get<{ width?: number; height?: number }>(hImage);
        cw = icon?.width ?? 32;
        ch = icon?.height ?? 32;
      } else {
        cw = 32; ch = 32;
      }
    }
    const childHwnd = emu.handles.alloc('window', {
      classInfo: { className: ctrl.className, wndProc: 0, style: 0, hbrBackground: 0, hIcon: 0, hCursor: 0, cbWndExtra: 0 },
      title: ctrl.text,
      style: ctrl.style,
      exStyle: 0,
      x: Math.round(ctrl.x * scaleX),
      y: Math.round(ctrl.y * scaleY),
      width: cw,
      height: ch,
      hMenu: 0,
      parent: hwnd,
      wndProc: 0,
      controlId: ctrl.id,
      visible: true,
      extraBytes: new Uint8Array(0),
      children: new Map(),
      hImage,
    } as WindowInfo);
    { const cw = emu.handles.get<WindowInfo>(childHwnd); if (cw) cw.hwnd = childHwnd; }
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
    overlays: (emu.handles.get<WindowInfo>(hwnd)?.childList ?? []).map(childHwnd => {
      const child = emu.handles.get<WindowInfo>(childHwnd)!;
      return {
        controlId: child.controlId ?? 0,
        childHwnd,
        className: child.classInfo?.className ?? 'STATIC',
        x: child.x,
        y: child.y,
        width: child.width,
        height: child.height,
        style: child.style,
        exStyle: 0,
        title: child.title ?? '',
        checked: child.checked ?? 0,
        fontHeight: Math.round(dlg.fontSize * 4 / 3),
        trackPos: 0,
        trackMin: 0,
        trackMax: 0,
      };
    }),
    controlValues: new Map<number, string>(),
  };

  const stackBytes = emu._currentThunkStackBytes;
  emu.waitingForMessage = true;

  // Set up dialogState so dismissDialog() and _endDialog() work
  emu.dialogState = { hwnd, dlgProc, info: dialogInfo, result: 0, ended: false };
  emu._dialogResolve = (result: number) => {
    emu.waitingForMessage = false;
    emu._wndProcSetupPending = false;
    if (emu._dialogPumpTimer !== null) { clearInterval(emu._dialogPumpTimer); emu._dialogPumpTimer = null; }
    emu._dialogResolve = null;
    // Free dialog window handle and child controls
    if (emu.dialogState) emu.handles.free(emu.dialogState.hwnd);
    // Pop outer dialog from stack (if any)
    const outer = emu._dialogStack.pop();
    if (outer) {
      emu.dialogState = outer.dialogState;
      emu._dialogResolve = outer.resolve;
      emu._dialogPumpTimer = outer.pumpTimer;
      emu.onShowDialog?.(outer.dialogState.info);
    } else {
      emu.dialogState = null;
      emu.onCloseDialog?.();
    }
    emuCompleteThunk16(emu, result, stackBytes);
    if (emu.running && !emu.halted) {
      requestAnimationFrame(emu.tick);
    }
  };

  // Pump messages to the dialog proc so button clicks (WM_COMMAND) get delivered
  emu._dialogPumpTimer = setInterval(() => {
    const ds = emu.dialogState;
    if (!ds || ds.ended || !emu._dialogResolve) {
      if (emu._dialogPumpTimer !== null) { clearInterval(emu._dialogPumpTimer); emu._dialogPumpTimer = null; }
      return;
    }
    const dlgWnd = emu.handles.get<WindowInfo>(ds.hwnd);
    if (!dlgWnd?.wndProc) return;

    const eipSave = emu.cpu.eip;
    const espSave = emu.cpu.reg[4];
    const savedWaiting = emu.waitingForMessage;
    emu.waitingForMessage = false;

    while (emu.messageQueue.length > 0) {
      const msg = emu.messageQueue.shift()!;
      emu.callWndProc16(dlgWnd.wndProc, msg.hwnd, msg.message, msg.wParam, msg.lParam);
      emu.cpu.eip = eipSave;
      emu.cpu.reg[4] = espSave;
      if (ds.ended) {
        // CPU state restored — now safe to complete the DialogBox thunk
        if (emu._dialogResolve) emu._dialogResolve(ds.result);
        return;
      }
    }

    emu.waitingForMessage = savedWaiting;
  }, 50);

  // Send WM_INITDIALOG to the dialog proc
  // Temporarily clear waitingForMessage so callWndProc16 doesn't exit early
  // when the dialog proc makes API calls (e.g. SetDlgItemText)
  const WM_INITDIALOG = 0x0110;
  if (dlgProc) {
    const eipSave = emu.cpu.eip;
    const espSave = emu.cpu.reg[4];
    emu.waitingForMessage = false;
    emu.callWndProc16(dlgProc, hwnd, WM_INITDIALOG, 0, 0);
    emu.cpu.eip = eipSave;
    emu.cpu.reg[4] = espSave;
    emu.waitingForMessage = true;

    // Rebuild overlays after WM_INITDIALOG so updated titles, listbox items, etc. are reflected
    dialogInfo.overlays = (emu.handles.get<WindowInfo>(hwnd)?.childList ?? []).map(childHwnd => {
      const child = emu.handles.get<WindowInfo>(childHwnd)!;
      const overlay: any = {
        controlId: child.controlId ?? 0,
        childHwnd,
        className: child.classInfo?.className ?? 'STATIC',
        x: child.x,
        y: child.y,
        width: child.width,
        height: child.height,
        style: child.style,
        exStyle: 0,
        title: child.title ?? '',
        checked: child.checked ?? 0,
        fontHeight: Math.round(dlg.fontSize * 4 / 3),
        trackPos: 0,
        trackMin: 0,
        trackMax: 0,
      };
      if (child.lbItems) overlay.lbItems = child.lbItems;
      if (child.lbSelectedIndex !== undefined) overlay.lbSelectedIndex = child.lbSelectedIndex;
      if (child.lbSelectedIndices) overlay.lbSelectedIndices = Array.from(child.lbSelectedIndices);
      if (child.cbItems) overlay.cbItems = child.cbItems;
      if (child.cbSelectedIndex !== undefined) overlay.cbSelectedIndex = child.cbSelectedIndex;
      if (child.hImage) overlay.hImage = child.hImage;
      return overlay;
    });
  }

  emu.onShowDialog?.(dialogInfo);

  return undefined; // async
}
