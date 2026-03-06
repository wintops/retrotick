import type { ComponentChildren } from 'preact';
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'preact/hooks';
import type { PEInfo, MenuResult } from '../lib/pe/types';
import { parsePE, extractMenus, extractIcons } from '../lib/pe';
import { Emulator } from '../lib/emu/emulator';
import type { DialogInfo, DialogControlInfo, ControlOverlay, ProcessRegistry, CommonDialogRequest } from '../lib/emu/emulator';
import type { WindowInfo } from '../lib/emu/win32/user32/index';
import type { TreeViewItem, ListViewItem, ListViewColumn } from '../lib/emu/win32/user32/types';
import { WM_LBUTTONDOWN, WM_LBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_MOUSEMOVE, WM_LBUTTONDBLCLK, WM_RBUTTONDBLCLK, WM_COMMAND, WM_SYSCOMMAND, WM_SIZE, WM_GETMINMAXINFO, WM_KEYDOWN, WM_KEYUP, WM_CHAR, MK_LBUTTON, MK_RBUTTON, SC_MINIMIZE, SC_MAXIMIZE, SC_RESTORE, SC_CLOSE, WS_BORDER, WS_EX_CLIENTEDGE } from '../lib/emu/win32/types';
import { Button } from './win2k/Button';
import { MessageBox, MsgBoxIcon, MB_OK, MB_OKCANCEL, MB_ABORTRETRYIGNORE, MB_YESNOCANCEL, MB_YESNO, MB_RETRYCANCEL, MB_ICONERROR, MB_ICONQUESTION, MB_ICONWARNING, MB_ICONINFORMATION, IDOK, IDCANCEL, IDABORT, IDRETRY, IDIGNORE, IDYES, IDNO } from './win2k/MessageBox';
import { Checkbox } from './win2k/Checkbox';
import { Radio } from './win2k/Radio';
import { GroupBox } from './win2k/GroupBox';
import { Edit } from './win2k/Edit';
import { RichEdit } from './win2k/RichEdit';
import { Trackbar } from './win2k/Trackbar';
import { TabControl } from './win2k/TabControl';
import { MenuBar } from './win2k/MenuBar';
import { Window, WS_DLGFRAME, WS_CAPTION, WS_SYSMENU, WS_THICKFRAME, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, getBorderWidth } from './win2k/Window';
import { Static } from './win2k/Static';
import { AboutDialog } from './win2k/AboutDialog';
import { ConsoleView } from './ConsoleView';
import { formatMnemonic } from '../lib/format';
import { getAllFiles, getFile, addFile, deleteFile } from '../lib/file-store';
import { RegistryStore } from '../lib/registry-store';
import { loadRegistry, saveRegistry } from '../lib/registry-db';
import { detectPELanguageId, langToHtmlLang } from '../lib/lang';
import { loadSettings, getKeyboardLayout, t } from '../lib/regional-settings';

interface EmulatorViewProps {
  arrayBuffer: ArrayBuffer;
  peInfo: PEInfo;
  additionalFiles?: Map<string, ArrayBuffer>;
  exeName: string;
  commandLine?: string;
  onStop: () => void;
  onFocus?: () => void;
  onReady?: () => void;
  onRunExe?: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles?: Map<string, ArrayBuffer>, exeName?: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onSetupEmulator?: (emu: Emulator) => void;
  onTitleChange?: (title: string) => void;
  onIconChange?: (iconUrl: string | null) => void;
  onMinimize?: () => void;
  onRegisterCloseHandler?: (handler: () => void) => void;
  processRegistry?: ProcessRegistry;
  zIndex?: number;
  focused?: boolean;
  minimized?: boolean;
}

function buildMKFlags(e: PointerEvent): number {
  let flags = 0;
  if (e.buttons & 1) flags |= MK_LBUTTON;
  if (e.buttons & 2) flags |= MK_RBUTTON;
  return flags;
}

function makeLParam(x: number, y: number): number {
  return ((y & 0xFFFF) << 16) | (x & 0xFFFF);
}

// Map DOM key codes to Windows virtual key codes (dynamic, based on regional settings)
function getKeyToVK(): Record<string, number> {
  const settings = loadSettings();
  return getKeyboardLayout(settings.keyboardLayout).codeToVK;
}



// --- Control helpers (shared by dialog + overlay rendering) ---

function ctrlFont(ctrl: ControlOverlay): string {
  const size = ctrl.fontHeight ? `${Math.abs(ctrl.fontHeight)}px` : '12px';
  return `${size}/1 "Tahoma", "MS Sans Serif", Arial, sans-serif`;
}

/** Effective class for rendering: use baseClassName (from superclassing) if available */
function effectiveClass(ctrl: ControlOverlay): string {
  return ctrl.baseClassName || ctrl.className;
}

// --- Win2K Dialog ---

function Dialog({ info, emuRef, onDismiss, focused = true, flashTrigger, parentRef, lang }: {
  info: DialogInfo;
  emuRef: { current: Emulator | null };
  onDismiss: (action: number, values: Map<number, string>) => void;
  focused?: boolean;
  flashTrigger?: number;
  parentRef?: { current: HTMLDivElement | null };
  lang?: string;
}) {
  const [pressedControl, setPressedControl] = useState<number | null>(null);
  const [overlays, setOverlays] = useState<ControlOverlay[]>(info.overlays);
  const [initialPos, setInitialPos] = useState<{ x: number; y: number } | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  const handleCancel = () => onDismiss(2, info.controlValues);

  // Redirect mainWindow to dialog hwnd so renderControlOverlay sends WM_COMMAND to the dialog.
  // Also intercept onControlsChanged so notifyControlOverlays updates the dialog's own overlays
  // instead of contaminating the parent window's controlOverlays state.
  const dialogEmuRef = useRef<{ current: Emulator | null }>({ current: null });
  const emu = emuRef?.current ?? null;
  if (emu) {
    dialogEmuRef.current.current = new Proxy(emu, {
      get(target, prop) {
        if (prop === 'mainWindow') return info.hwnd;
        if (prop === 'onControlsChanged') return (controls: ControlOverlay[]) => setOverlays(controls);
        return target[prop as keyof Emulator];
      },
    });
  } else {
    dialogEmuRef.current.current = null;
  }

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const dlgRect = measureRef.current.getBoundingClientRect();
    const parentRect = parentRef?.current?.getBoundingClientRect();
    const cx = parentRect ? parentRect.left + parentRect.width / 2 : window.innerWidth / 2;
    const cy = parentRect ? parentRect.top + parentRect.height / 2 : window.innerHeight / 2;
    setInitialPos({ x: cx - dlgRect.width / 2, y: cy - dlgRect.height / 2 });
  }, []);

  // Show only after Window has applied the position (one render cycle after initialPos is set)
  useEffect(() => {
    if (initialPos) setVisible(true);
  }, [initialPos]);



  return (
    <div ref={measureRef} onClick={(e) => e.stopPropagation()} style={{ visibility: visible ? 'visible' : 'hidden', position: 'absolute', font: '12px/1 "Tahoma",sans-serif' }}>
      <Window
        title={info.title}
        style={info.style | WS_DLGFRAME}
        clientW={info.width}
        clientH={info.height}
        focused={focused}
        draggable
        initialPos={initialPos}
        flashTrigger={flashTrigger}
        lang={lang}
        onClose={handleCancel}
      >
          <div style={{ width: '100%', height: '100%', background: '#D4D0C8' }}>
            {overlays.map((ctrl) => {
              const rendered = renderControlOverlay(ctrl, dialogEmuRef.current, setPressedControl, pressedControl);
              // Wrap OK (id=1) and Cancel (id=2) buttons to also dismiss the dialog
              if (effectiveClass(ctrl) === 'BUTTON' && (ctrl.controlId === 1 || ctrl.controlId === 2)) {
                const action = ctrl.controlId;
                return <div key={ctrl.childHwnd} onClick={() => onDismiss(action, info.controlValues)}>{rendered}</div>;
              }
              return rendered;
            })}
          </div>
        </Window>
    </div>
  );
}

// --- Companion Canvas ---
// A transparent canvas layered on top of a control overlay for custom drawing (WM_DRAWITEM / WM_PAINT).
// pointer-events: none so mouse events pass through to the overlay underneath.

function CompanionCanvas({ ctrl, emuRef }: { ctrl: ControlOverlay; emuRef: { current: Emulator | null } }) {
  const ref = useCallback((el: HTMLCanvasElement | null) => {
    const emu = emuRef.current;
    if (!emu) return;
    const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
    if (!wnd) return;
    if (el) {
      el.width = ctrl.width;
      el.height = ctrl.height;
      wnd.domCanvas = el;
      // Invalidate cached DC so next getWindowDC picks up the new canvas
      const oldDC = emu.windowDCs.get(ctrl.childHwnd);
      if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
      // Mark main window for repaint and wake GetMessage if waiting
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) {
        mainWnd.needsPaint = true;
        // Post WM_NULL to wake GetMessage so it synthesizes WM_PAINT
        if (emu.mainWindow) emu.postMessage(emu.mainWindow, 0, 0, 0);
      }
    } else {
      wnd.domCanvas = undefined;
      const oldDC = emu.windowDCs.get(ctrl.childHwnd);
      if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
    }
  }, [ctrl.childHwnd, ctrl.width, ctrl.height]);

  return (
    <canvas
      ref={ref}
      width={ctrl.width}
      height={ctrl.height}
      style={{
        position: 'absolute', left: 0, top: 0,
        width: `${ctrl.width}px`, height: `${ctrl.height}px`,
        pointerEvents: 'none',
        imageRendering: 'pixelated',
      }}
    />
  );
}

// --- Control Overlay Rendering ---

function renderControlOverlay(
  ctrl: ControlOverlay,
  emuRef: { current: Emulator | null },
  setPressedControl: (id: number | null) => void,
  pressedControl: number | null,
  onResizeStart?: (edge: string, e: PointerEvent) => void,
) {
  const posStyle: Record<string, string | number | undefined> = {
    position: 'absolute',
    left: `${ctrl.x}px`,
    top: `${ctrl.y}px`,
    width: `${ctrl.width}px`,
    height: `${ctrl.height}px`,
    zIndex: 10,
  };

  const postCommand = () => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;

    // Auto-toggle for BS_AUTOCHECKBOX(3) and BS_AUTORADIOBUTTON(9)
    if (effectiveClass(ctrl) === 'BUTTON') {
      const bsType = ctrl.style & 0xF;
      const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (childWnd) {
        if (bsType === 3) {
          // Toggle checkbox
          childWnd.checked = childWnd.checked ? 0 : 1;
        } else if (bsType === 4 || bsType === 9) {
          // Radio button: uncheck siblings in the same WS_GROUP group, then check this.
          // Windows groups radio buttons by WS_GROUP (0x20000): a new group starts at each
          // control that has WS_GROUP set. Find the contiguous run of radio buttons that
          // contains ctrl.childHwnd and uncheck only those.
          const WS_GROUP = 0x00020000;
          const parentWnd = emu.handles.get<WindowInfo>(childWnd.parent);
          if (parentWnd?.childList) {
            const siblings = parentWnd.childList.map(h => ({
              h, w: emu.handles.get<WindowInfo>(h)!
            })).filter(e => e.w);
            // Find index of clicked radio
            const idx = siblings.findIndex(e => e.h === ctrl.childHwnd);
            if (idx !== -1) {
              // Walk backwards to find group start (first control with WS_GROUP or index 0)
              let start = idx;
              while (start > 0 && !(siblings[start].w.style & WS_GROUP)) start--;
              // Walk forwards to find group end (next control with WS_GROUP or end)
              let end = idx + 1;
              while (end < siblings.length && !(siblings[end].w.style & WS_GROUP)) end++;
              // Uncheck all radio buttons in [start, end)
              for (let i = start; i < end; i++) {
                const sib = siblings[i].w;
                const sibType = sib.style & 0xF;
                if (sib.classInfo.className.toUpperCase() === 'BUTTON' && (sibType === 4 || sibType === 9)) {
                  sib.checked = 0;
                }
              }
            }
          }
          childWnd.checked = 1;
        }
      }
    }

    // Trigger immediate repaint so overlays update
    const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (mainWnd) { mainWnd.needsPaint = true; }

    // Immediately refresh control overlays so checkbox/radio state is reflected in React.
    // Must temporarily clear waitingForMessage because notifyControlOverlays may call
    // callWndProc (for WM_CTLCOLORSTATIC), which breaks early if waitingForMessage is true.
    const savedWaiting = emu.waitingForMessage;
    emu.waitingForMessage = false;
    emu.notifyControlOverlays();

    // For modal dialogs, dispatch WM_COMMAND synchronously so the app can update its state.
    // postMessage would sit in the queue until the pump picks it up, but synchronous dispatch
    // ensures immediate visual feedback (e.g. selection highlight on owner-draw buttons).
    const ds = emu.dialogState;
    if (ds && !ds.ended) {
      const WM_COMMAND = 0x0111;
      const dlgWnd = emu.handles.get<WindowInfo>(ds.hwnd);
      const wndProc = dlgWnd?.wndProc || ds.dlgProc;
      if (wndProc) {
        const savedEIP = emu.cpu.eip;
        const savedESP = emu.cpu.reg[4];
        if (emu.isNE) {
          // Win16: wParam = controlId, lParam = MAKELONG(hwndCtl, BN_CLICKED)
          emu.callWndProc16(wndProc, ds.hwnd, WM_COMMAND, ctrl.controlId, ctrl.childHwnd & 0xFFFF);
        } else {
          emu.callWndProc(wndProc, ds.hwnd, WM_COMMAND, ctrl.controlId, ctrl.childHwnd);
        }
        emu.cpu.eip = savedEIP;
        emu.cpu.reg[4] = savedESP;
        // Refresh overlays and trigger owner-draw repaint after state change
        if (!ds.ended) {
          const dlgWndInfo = emu.handles.get<WindowInfo>(ds.hwnd);
          if (dlgWndInfo) dlgWndInfo._ownerDrawPending = true;
          emu.notifyControlOverlays();
        }
      }
      emu.waitingForMessage = savedWaiting;
    } else {
      // Restore waitingForMessage BEFORE posting so the onMessageAvailable
      // callback (triggered by postMessage) can properly transition from waiting→running.
      emu.waitingForMessage = savedWaiting;
      emu.postMessage(emu.mainWindow, WM_COMMAND, ctrl.controlId, ctrl.childHwnd);
    }

    // Ensure AudioContext is running — must be created/resumed during user gesture
    if (!emu.audioContext || emu.audioContext.state === 'suspended') {
      const oldState = emu.audioContext?.state;
      if (emu.audioContext) emu.audioContext.close();
      emu.audioContext = new AudioContext();
      console.log(`[AUDIO] postCommand: replaced ctx (was ${oldState}) → new state=${emu.audioContext.state}`);
    }
  };

  const isDisabled = !!(ctrl.style & 0x08000000); // WS_DISABLED

  if (effectiveClass(ctrl) === 'BUTTON') {
    const bsType = ctrl.style & 0xF;

    // Ownerdraw — Button overlay for clicks + companion canvas on top for custom drawing
    if (bsType === 0xB) {
      const onOwnerDrawMouseDown = (e: PointerEvent) => {
        if (isDisabled) return;
        e.preventDefault();
        setPressedControl(ctrl.childHwnd);
        // Send WM_DRAWITEM with ODS_SELECTED to show pressed state
        const emu = emuRef.current;
        if (emu) {
          const ds = emu.dialogState;
          const dlgWnd = ds ? emu.handles.get<WindowInfo>(ds.hwnd) : null;
          if (dlgWnd) dlgWnd._ownerDrawPending = true;
          const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd) childWnd._odsSelected = true;
        }
      };
      const onOwnerDrawMouseUp = () => {
        if (isDisabled) return;
        setPressedControl(null);
        const emu = emuRef.current;
        if (emu) {
          const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
          if (childWnd) childWnd._odsSelected = false;
        }
        postCommand();
      };
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }}
          onPointerDown={onOwnerDrawMouseDown} onPointerUp={onOwnerDrawMouseUp}>
          <Button fontCSS={ctrlFont(ctrl)} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Button>
          <canvas
            ref={useCallback((el: HTMLCanvasElement | null) => {
              const emu = emuRef.current;
              if (!emu) return;
              const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (!wnd) return;
              if (el) {
                el.width = ctrl.width;
                el.height = ctrl.height;
                wnd.domCanvas = el;
                const oldDC = emu.windowDCs.get(ctrl.childHwnd);
                if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
                const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
                if (mainWnd) { mainWnd.needsPaint = true; if (emu.mainWindow) emu.postMessage(emu.mainWindow, 0, 0, 0); }
              } else {
                wnd.domCanvas = undefined;
                const oldDC = emu.windowDCs.get(ctrl.childHwnd);
                if (oldDC) { emu.handles.free(oldDC); emu.windowDCs.delete(ctrl.childHwnd); }
              }
            }, [ctrl.childHwnd, ctrl.width, ctrl.height])}
            width={ctrl.width}
            height={ctrl.height}
            style={{
              position: 'absolute', left: 0, top: 0,
              width: `${ctrl.width}px`, height: `${ctrl.height}px`,
              pointerEvents: 'none',
              imageRendering: 'pixelated',
              ...(isDisabled ? { filter: 'grayscale(100%) opacity(0.5)' } : {}),
            }}
          />
        </div>
      );
    }

    // GroupBox
    if (bsType === 7) {
      return (
        <div key={ctrl.childHwnd} style={posStyle}>
          <GroupBox label={formatMnemonic(ctrl.title)} fontCSS={ctrlFont(ctrl)}>{null}</GroupBox>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Checkbox (2=checkbox, 3=auto checkbox)
    if (bsType === 2 || bsType === 3) {
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
          <Checkbox fontCSS={ctrlFont(ctrl)} checked={ctrl.checked === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Checkbox>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Radio (4=radiobutton, 9=auto radiobutton)
    if (bsType === 4 || bsType === 9) {
      return (
        <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
          <Radio fontCSS={ctrlFont(ctrl)} checked={ctrl.checked === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Radio>
          <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
        </div>
      );
    }

    // Pushbutton (0) / DefPushbutton (1)
    return (
      <div key={ctrl.childHwnd} style={{ ...posStyle, cursor: 'var(--win2k-cursor)', pointerEvents: isDisabled ? 'none' : 'auto' }} onClick={postCommand}>
        <Button fontCSS={ctrlFont(ctrl)} isDefault={bsType === 1} disabled={isDisabled}>{formatMnemonic(ctrl.title)}</Button>
        <CompanionCanvas ctrl={ctrl} emuRef={emuRef} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'STATIC') {
    const ssType = ctrl.style & 0x1F;
    // SS_ICON (0x03) / SS_BITMAP (0x0E) — resolve live emulator handles to image content
    let imageContent: ComponentChildren = undefined;
    if (ssType === 0x03) {
      const emu = emuRef.current;
      if (emu) {
        const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
        if (wnd?.hImage) {
          const icon = emu.handles.get<{ dataUrl?: string }>(wnd.hImage);
          if (icon?.dataUrl) {
            imageContent = <img src={icon.dataUrl} style={{ imageRendering: 'pixelated' }} />;
          }
        }
      }
    } else if (ssType === 0x0E) {
      const emu = emuRef.current;
      if (emu) {
        const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
        if (wnd?.hImage) {
          const bmp = emu.handles.get<import('../lib/emu/win32/gdi32/types').BitmapInfo>(wnd.hImage);
          if (bmp?.canvas) {
            const canvasRef = (el: HTMLCanvasElement | null) => {
              if (!el) return;
              if (el.width !== bmp.width || el.height !== bmp.height) {
                el.width = bmp.width;
                el.height = bmp.height;
              }
              const ctx2d = el.getContext('2d');
              if (ctx2d) ctx2d.drawImage(bmp.canvas, 0, 0);
            };
            imageContent = <canvas ref={canvasRef} style={{ width: `${bmp.width}px`, height: `${bmp.height}px`, imageRendering: 'pixelated' }} />;
          }
        }
      }
    }
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <Static style={ctrl.style} text={ctrl.title} fontCSS={ctrlFont(ctrl)} bgColor={ctrl.bgColor} imageContent={imageContent} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'EDIT') {
    const multiline = !!(ctrl.style & 0x0004); // ES_MULTILINE
    const password = !!(ctrl.style & 0x0020);   // ES_PASSWORD
    const readonly = !!(ctrl.style & 0x0800);   // ES_READONLY
    console.log(`[EDIT-RENDER] hwnd=0x${ctrl.childHwnd.toString(16)} class=${ctrl.className} style=0x${ctrl.style.toString(16)} readonly=${readonly} title="${ctrl.title}" hasEmuRef=${!!emuRef.current}`);
    const sunken = !!(ctrl.exStyle & WS_EX_CLIENTEDGE);
    const thinBorder = !sunken && !!(ctrl.style & WS_BORDER);
    const onTextChange = (text: string) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (wnd) {
        console.log(`[EDIT] onTextChange hwnd=0x${ctrl.childHwnd.toString(16)} text="${text}"`);
        wnd.title = text;
        // Also update dialog controlValues so GetDlgItemInt/GetDlgItemText see it
        if (emu.dialogState && wnd.controlId !== undefined) {
          emu.dialogState.info.controlValues.set(wnd.controlId, text);
        }
        // Notify parent of EN_CHANGE
        const EN_CHANGE = 0x0300;
        const WM_COMMAND = 0x0111;
        const wParam = ((EN_CHANGE << 16) | (wnd.controlId || 0)) >>> 0;
        emu.postMessage(wnd.parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <Edit fontCSS={ctrlFont(ctrl)} text={ctrl.title} multiline={multiline} password={password} readonly={readonly} sunken={sunken} thinBorder={thinBorder} onTextChange={onTextChange} />
      </div>
    );
  }

  if (['RICHEDIT20W', 'RICHEDIT20A', 'RICHEDIT'].includes(effectiveClass(ctrl))) {
    const readonly = !!(ctrl.style & 0x0800);   // ES_READONLY
    const onTextChange = (text: string) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (wnd) {
        wnd.title = text;
        const EN_CHANGE = 0x0300;
        const WM_COMMAND = 0x0111;
        const wParam = ((EN_CHANGE << 16) | (wnd.controlId || 0)) >>> 0;
        emu.postMessage(wnd.parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <RichEdit fontCSS={ctrlFont(ctrl)} text={ctrl.title} readonly={readonly} onTextChange={onTextChange} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'LISTBOX') {
    const lbItems = ctrl.lbItems || [];
    const LBS_MULTIPLESEL = 0x0008, LBS_EXTENDEDSEL = 0x0800, LBS_NOSEL = 0x4000;
    const isMultiSel = !!(ctrl.style & (LBS_MULTIPLESEL | LBS_EXTENDEDSEL));
    const noSel = !!(ctrl.style & LBS_NOSEL);
    const selIndex = ctrl.lbSelectedIndex ?? -1;
    const selIndices = new Set(ctrl.lbSelectedIndices || []);

    const WM_COMMAND = 0x0111;
    const LBN_SELCHANGE = 1;
    const LBN_DBLCLK = 2;
    const LBN_SELCANCEL = 3;

    const getParentHwnd = (emu: Emulator): number => {
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      return wnd?.parent || emu.mainWindow || 0;
    };

    const sendLBNotify = (emu: Emulator, code: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      const wParam = ((code << 16) | (ctrl.controlId & 0xFFFF)) >>> 0;
      emu.postMessage(parent, WM_COMMAND, wParam, ctrl.childHwnd);
    };

    const onItemClick = (idx: number, e: MouseEvent) => {
      if (noSel) return;
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd || !wnd.lbItems) return;
      if (isMultiSel) {
        if (!wnd.lbSelectedIndices) wnd.lbSelectedIndices = new Set();
        if (e.ctrlKey || (wnd.style & LBS_MULTIPLESEL)) {
          // Toggle individual item
          if (wnd.lbSelectedIndices.has(idx)) wnd.lbSelectedIndices.delete(idx);
          else wnd.lbSelectedIndices.add(idx);
        } else {
          // Extended sel without Ctrl: single select
          wnd.lbSelectedIndices.clear();
          wnd.lbSelectedIndices.add(idx);
        }
      } else {
        wnd.lbSelectedIndex = idx;
      }
      sendLBNotify(emu, LBN_SELCHANGE);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemDblClick = (idx: number, _e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      sendLBNotify(emu, LBN_DBLCLK);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const isSelected = (idx: number): boolean => {
      if (isMultiSel) return selIndices.has(idx);
      return idx === selIndex;
    };

    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: ctrlFont(ctrl) || '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
      }}>
        <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}
          onClick={(e: Event) => {
            if (e.target === e.currentTarget && !noSel) {
              // Clicked empty area — deselect
              const emu = emuRef.current;
              if (!emu) return;
              const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (!wnd) return;
              if (isMultiSel) { wnd.lbSelectedIndices?.clear(); }
              else { wnd.lbSelectedIndex = -1; }
              sendLBNotify(emu, LBN_SELCANCEL);
              const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
              if (mainWnd) mainWnd.needsPaint = true;
            }
          }}>
          {lbItems.map((text: string, i: number) => {
            const selected = isSelected(i);
            return (
              <div key={i}
                onClick={(e: Event) => { e.stopPropagation(); onItemClick(i, e as MouseEvent); }}
                onDblClick={(e: Event) => { e.stopPropagation(); onItemDblClick(i, e as MouseEvent); }}
                style={{
                  height: '16px', padding: '0 2px', display: 'flex', alignItems: 'center',
                  cursor: 'var(--win2k-cursor)', fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden',
                  background: selected ? '#0A246A' : undefined,
                  color: selected ? '#FFF' : undefined,
                }}>{text}</div>
            );
          })}
        </div>
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'COMBOBOX') {
    const cbItems = ctrl.cbItems || [];
    const selIdx = ctrl.cbSelectedIndex ?? -1;

    const onSelChange = (idx: number) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd) return;
      wnd.cbSelectedIndex = idx;
      const parent = wnd.parent || emu.mainWindow || 0;
      if (parent) {
        const WM_COMMAND = 0x0111;
        const CBN_SELCHANGE = 1;
        const wParam = ((CBN_SELCHANGE << 16) | (ctrl.controlId & 0xFFFF)) >>> 0;
        emu.postMessage(parent, WM_COMMAND, wParam, ctrl.childHwnd);
      }
      const parentWnd = emu.handles.get<WindowInfo>(parent);
      if (parentWnd) parentWnd.needsPaint = true;
    };

    // ComboBox display height is always one row; the full height is for the dropdown
    const cbStyle = { ...posStyle, height: 21 };

    return (
      <div key={ctrl.childHwnd} style={{ ...cbStyle, boxSizing: 'border-box' }}>
        <select
          style={{
            width: '100%', height: '100%', boxSizing: 'border-box',
            font: ctrlFont(ctrl) || '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
            border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
            background: '#FFF', padding: '0 2px',
          }}
          value={selIdx >= 0 ? selIdx : ''}
          onChange={(e: Event) => onSelChange(parseInt((e.target as HTMLSelectElement).value, 10))}
        >
          {selIdx < 0 && <option value="">—</option>}
          {cbItems.map((text: string, i: number) => (
            <option key={i} value={i}>{text}</option>
          ))}
        </select>
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSTREEVIEW32') {
    const items = ctrl.treeItems || [];
    const rootItems = items.filter((i: TreeViewItem) => i.parent === 0);
    const TVS_HASBUTTONS = 0x0001, TVS_HASLINES = 0x0002, TVS_LINESATROOT = 0x0004;
    const hasButtons = !!(ctrl.style & TVS_HASBUTTONS);
    const hasLines = !!(ctrl.style & TVS_HASLINES);
    const linesAtRoot = !!(ctrl.style & TVS_LINESATROOT);
    const lineColor = '#808080';
    const dotBg = `url("data:image/svg+xml,${encodeURIComponent(
      `<svg width='2' height='2' xmlns='http://www.w3.org/2000/svg'><rect x='0' y='0' width='1' height='1' fill='${lineColor}'/></svg>`
    )}")`;
    const indent = 15;
    const btnSize = 9;

    const toggleExpand = (item: TreeViewItem) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd?.treeItems) return;
      const treeItem = wnd.treeItems.get(item.id);
      if (treeItem) treeItem.expanded = !treeItem.expanded;
      // Send TVN_ITEMEXPANDEDA notification to parent: WM_NOTIFY with NMTREEVIEW
      const WM_NOTIFY = 0x004E;
      const TVN_ITEMEXPANDEDA = -406;
      const nmhdr = emu.allocHeap(104); // NMTREEVIEWA
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);    // hwndFrom
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId); // idFrom
      emu.memory.writeU32(nmhdr + 8, TVN_ITEMEXPANDEDA & 0xFFFFFFFF); // code
      emu.memory.writeU32(nmhdr + 12, treeItem?.expanded ? 2 : 1); // action: TVE_EXPAND/TVE_COLLAPSE
      // itemNew at offset 56
      emu.memory.writeU32(nmhdr + 56, 0x4); // mask: TVIF_PARAM
      emu.memory.writeU32(nmhdr + 60, item.id); // hItem
      emu.memory.writeU32(nmhdr + 92, item.lParam ?? 0); // lParam
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr);
      // Trigger repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const selectItem = (item: TreeViewItem) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd?.treeItems) return;
      const oldSelected = wnd.treeSelectedItem;
      wnd.treeSelectedItem = item.id;
      // Send TVN_SELCHANGINGA then TVN_SELCHANGEDA notifications
      const WM_NOTIFY = 0x004E;
      const TVN_SELCHANGINGA = -401;
      const TVN_SELCHANGEDA = -402;
      // NMTREEVIEWA: NMHDR(12)+action(4)+itemOld(40)+itemNew(40)+ptDrag(8) = 104 bytes
      const nmhdr = emu.allocHeap(104);
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId);
      // Send TVN_SELCHANGING first
      emu.memory.writeU32(nmhdr + 8, TVN_SELCHANGINGA & 0xFFFFFFFF);
      emu.memory.writeU32(nmhdr + 12, 1); // action: TVC_BYMOUSE
      // itemOld at offset 16: mask(4) hItem(4) state(4) stateMask(4) pszText(4) cchTextMax(4) iImage(4) iSelectedImage(4) cChildren(4) lParam(4)
      if (oldSelected) {
        const oldItem = wnd.treeItems?.get(oldSelected);
        emu.memory.writeU32(nmhdr + 16, 0x4); // mask: TVIF_PARAM
        emu.memory.writeU32(nmhdr + 20, oldSelected); // hItem
        emu.memory.writeU32(nmhdr + 52, oldItem?.lParam ?? 0); // lParam (offset 16+36)
      }
      // itemNew at offset 56
      emu.memory.writeU32(nmhdr + 56, 0x4); // mask: TVIF_PARAM
      emu.memory.writeU32(nmhdr + 60, item.id); // hItem
      emu.memory.writeU32(nmhdr + 92, item.lParam ?? 0); // lParam (offset 56+36)
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr);
      // Send TVN_SELCHANGED
      const nmhdr2 = emu.allocHeap(104);
      for (let i = 0; i < 104; i += 4) emu.memory.writeU32(nmhdr2 + i, emu.memory.readU32(nmhdr + i));
      emu.memory.writeU32(nmhdr2 + 8, TVN_SELCHANGEDA & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow!, WM_NOTIFY, ctrl.controlId, nmhdr2);
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const imageUrls = ctrl.treeImageUrls || [];

    const renderTreeItem = (item: TreeViewItem, depth: number, isLast: boolean, parentLineDepths: number[]): ComponentChildren => {
      const hasChild = item.children && item.children.length > 0;
      const childItems = hasChild ? items.filter((i: TreeViewItem) => item.children.includes(i.id)) : [];
      const effectiveDepth = linesAtRoot ? depth : depth - 1;
      const lineX = (linesAtRoot ? 0 : -indent) + depth * indent + 7;
      const btnLeft = lineX - 4;
      const iconLeft = (linesAtRoot ? 0 : -indent) + depth * indent + indent + 1;
      const selected = item.id === ctrl.treeSelectedItem;
      const imgIdx = selected ? (item.selectedImageIndex ?? item.imageIndex ?? -1) : (item.imageIndex ?? -1);
      const iconUrl = imgIdx >= 0 && imgIdx < imageUrls.length ? imageUrls[imgIdx] : undefined;
      const textLeft = iconUrl ? iconLeft + 18 : iconLeft;

      return (
        <div key={item.id}>
          <div style={{
            position: 'relative', height: '17px',
            display: 'flex', alignItems: 'center',
            whiteSpace: 'nowrap', overflow: 'visible', cursor: 'var(--win2k-cursor)',
          }} onClick={(e) => { e.stopPropagation(); selectItem(item); }}>
            {/* Vertical continuation lines for ancestors */}
            {hasLines && parentLineDepths.map((d) => {
              const lx = (linesAtRoot ? 0 : -indent) + d * indent + 7;
              return <div key={`vl${d}`} style={{
                position: 'absolute', left: `${lx}px`, top: 0,
                width: '1px', height: '100%',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-y',
              }} />;
            })}
            {/* Vertical line from top to center */}
            {hasLines && (effectiveDepth >= 0) && (
              <div style={{
                position: 'absolute', left: `${lineX}px`, top: 0,
                width: '1px', height: isLast ? '9px' : '100%',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-y',
              }} />
            )}
            {/* Horizontal line to icon */}
            {hasLines && (effectiveDepth >= 0) && (
              <div style={{
                position: 'absolute', left: `${lineX}px`, top: '8px',
                width: `${iconLeft - lineX}px`, height: '1px',
                backgroundImage: dotBg, backgroundRepeat: 'repeat-x',
              }} />
            )}
            {/* Expand/collapse button */}
            {hasButtons && hasChild && (
              <div onClick={(e) => { e.stopPropagation(); toggleExpand(item); }} style={{
                position: 'absolute', left: `${btnLeft}px`, top: '4px',
                width: `${btnSize}px`, height: `${btnSize}px`, boxSizing: 'border-box',
                border: '1px solid #808080', background: '#FFF', zIndex: 2,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '9px', lineHeight: '1', color: '#000', fontFamily: 'monospace',
                cursor: 'pointer',
              }}>
                {item.expanded ? '\u2212' : '+'}
              </div>
            )}
            {/* Item icon from ImageList */}
            {iconUrl && <img src={iconUrl} style={{
              position: 'absolute', left: `${iconLeft}px`, top: '1px',
              width: '16px', height: '16px', imageRendering: 'pixelated',
            }} />}
            {/* Selection highlight + text */}
            <span style={{
              marginLeft: `${textLeft}px`, fontSize: '11px', padding: '0 2px',
              background: selected ? '#0A246A' : 'transparent',
              color: selected ? '#FFF' : '#000',
            }}>{item.text}</span>
          </div>
          {item.expanded && childItems.map((c: TreeViewItem, ci: number) =>
            renderTreeItem(c, depth + 1, ci === childItems.length - 1,
              isLast ? parentLineDepths : [...parentLineDepths, depth])
          )}
        </div>
      );
    };
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        padding: '2px 0',
      }}>
        {rootItems.map((item: TreeViewItem, i: number) => renderTreeItem(item, 0, i === rootItems.length - 1, []))}
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSLISTVIEW32') {
    const columns = ctrl.listColumns || [];
    const items = ctrl.listItems || [];
    const LVS_REPORT = 0x0001, LVS_NOCOLUMNHEADER = 0x4000, LVS_SINGLESEL = 0x0004;
    const LVIS_SELECTED = 0x2, LVIS_FOCUSED = 0x1;
    const WM_NOTIFY = 0x004E;
    const LVN_ITEMCHANGING = -100;
    const LVN_ITEMCHANGED = -101;
    const NM_CLICK = -2;
    const NM_DBLCLK = -3;
    const NM_RCLICK = -5;
    const NM_RETURN = -4;
    const LVN_COLUMNCLICK = -108;
    const LVIF_STATE = 0x8;
    const isReport = (ctrl.style & 0x3) === LVS_REPORT;
    const noHeader = !!(ctrl.style & LVS_NOCOLUMNHEADER);
    const singleSel = !!(ctrl.style & LVS_SINGLESEL);
    const showHeader = isReport && !noHeader && columns.length > 0;
    const headerH = showHeader ? 18 : 0;

    const getParentHwnd = (emu: Emulator): number => {
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      return wnd?.parent || emu.mainWindow || 0;
    };

    // Allocate and fill an NMLISTVIEW struct (44 bytes)
    // NMHDR(12) + iItem(4) + iSubItem(4) + uNewState(4) + uOldState(4) + uChanged(4) + ptAction(8) + lParam(4)
    const makeNMListView = (emu: Emulator, code: number, iItem: number, iSubItem: number, uNewState: number, uOldState: number, uChanged: number, lParam: number): number => {
      const nm = emu.allocHeap(44);
      emu.memory.writeU32(nm, ctrl.childHwnd);                 // hwndFrom
      emu.memory.writeU32(nm + 4, ctrl.controlId);             // idFrom
      emu.memory.writeU32(nm + 8, code & 0xFFFFFFFF);          // code
      emu.memory.writeU32(nm + 12, iItem);                     // iItem
      emu.memory.writeU32(nm + 16, iSubItem);                  // iSubItem
      emu.memory.writeU32(nm + 20, uNewState);                 // uNewState
      emu.memory.writeU32(nm + 24, uOldState);                 // uOldState
      emu.memory.writeU32(nm + 28, uChanged);                  // uChanged
      // ptAction at +32 (8 bytes) — left as 0
      emu.memory.writeU32(nm + 40, lParam);                    // lParam
      return nm;
    };

    // Send NMITEMACTIVATE struct for NM_CLICK / NM_DBLCLK / NM_RCLICK
    // NMHDR(12) + iItem(4) + iSubItem(4) + uNewState(4) + uOldState(4) + uChanged(4) + ptAction(8) + lParam(4) + ...
    const sendNMClick = (emu: Emulator, code: number, iItem: number, iSubItem: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      const nm = makeNMListView(emu, code, iItem, iSubItem, 0, 0, 0, 0);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
    };

    const sendItemChanged = (emu: Emulator, idx: number, uNewState: number, uOldState: number, lParam: number) => {
      const parent = getParentHwnd(emu);
      if (!parent) return;
      // Send LVN_ITEMCHANGING first — app can return TRUE to deny
      const nmChanging = makeNMListView(emu, LVN_ITEMCHANGING, idx, 0, uNewState, uOldState, LVIF_STATE, lParam);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nmChanging);
      // Send LVN_ITEMCHANGED
      const nmChanged = makeNMListView(emu, LVN_ITEMCHANGED, idx, 0, uNewState, uOldState, LVIF_STATE, lParam);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nmChanged);
    };

    const onItemClick = (idx: number, e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd || !wnd.listItems) return;
      const item = wnd.listItems[idx];
      if (!item) return;
      const oldState = item.state || 0;
      // Clear selection (unless Ctrl held and multi-select allowed)
      if (singleSel || !e.ctrlKey) {
        for (let i = 0; i < wnd.listItems.length; i++) {
          const it = wnd.listItems[i];
          if (i !== idx && ((it.state || 0) & LVIS_SELECTED)) {
            const prev = it.state || 0;
            it.state = prev & ~(LVIS_SELECTED | LVIS_FOCUSED);
            sendItemChanged(emu, i, it.state, prev, it.lParam || 0);
          }
        }
      }
      // Toggle selection and set focus on clicked item
      const newState = ((oldState ^ LVIS_SELECTED) | LVIS_FOCUSED);
      item.state = newState;
      sendItemChanged(emu, idx, newState, oldState, item.lParam || 0);
      // Send NM_CLICK
      sendNMClick(emu, NM_CLICK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemDblClick = (idx: number, _e: MouseEvent) => {
      const emu = emuRef.current;
      if (!emu) return;
      sendNMClick(emu, NM_DBLCLK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onItemContextMenu = (idx: number, e: MouseEvent) => {
      e.preventDefault();
      const emu = emuRef.current;
      if (!emu) return;
      sendNMClick(emu, NM_RCLICK, idx, 0);
      const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onColumnClick = (colIdx: number) => {
      const emu = emuRef.current;
      if (!emu) return;
      const parent = getParentHwnd(emu);
      if (!parent) return;
      const nm = makeNMListView(emu, LVN_COLUMNCLICK, -1, colIdx, 0, 0, 0, 0);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
      const mainWnd = emu.handles.get<WindowInfo>(parent);
      if (mainWnd) mainWnd.needsPaint = true;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const emu = emuRef.current;
      if (!emu) return;
      const parent = getParentHwnd(emu);
      if (!parent) return;
      // Send NM_RETURN
      const nm = emu.allocHeap(12);
      emu.memory.writeU32(nm, ctrl.childHwnd);
      emu.memory.writeU32(nm + 4, ctrl.controlId);
      emu.memory.writeU32(nm + 8, NM_RETURN & 0xFFFFFFFF);
      emu.postMessage(parent, WM_NOTIFY, ctrl.controlId, nm);
    };
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#FFF', boxSizing: 'border-box',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        overflow: 'hidden', font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        display: 'flex', flexDirection: 'column',
      }}>
        {showHeader && (
          <div style={{ display: 'flex', height: `${headerH}px`, background: '#D4D0C8', flexShrink: 0 }}>
            {columns.map((col: ListViewColumn, i: number) => (
              <div key={i} onClick={() => onColumnClick(i)} style={{
                width: `${col.width}px`, height: '100%', boxSizing: 'border-box',
                border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
                boxShadow: 'inset -1px -1px 0 #808080',
                padding: '0 4px', display: 'flex', alignItems: 'center', cursor: 'pointer',
                whiteSpace: 'nowrap', overflow: 'hidden', fontSize: '11px', flexShrink: 0,
              }}>{col.text}</div>
            ))}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }} tabIndex={0}
          onKeyDown={(e: Event) => onKeyDown(e as KeyboardEvent)}
          onClick={(e: Event) => {
            if (e.target === e.currentTarget) {
              // Clicked empty area — deselect all and send NM_CLICK with iItem=-1
              const emu = emuRef.current;
              if (!emu) return;
              const w = emu.handles.get<WindowInfo>(ctrl.childHwnd);
              if (w?.listItems) {
                for (let i = 0; i < w.listItems.length; i++) {
                  const it = w.listItems[i];
                  if ((it.state || 0) & LVIS_SELECTED) {
                    const prev = it.state || 0;
                    it.state = prev & ~(LVIS_SELECTED | LVIS_FOCUSED);
                    sendItemChanged(emu, i, it.state, prev, it.lParam || 0);
                  }
                }
                sendNMClick(emu, NM_CLICK, -1, 0);
                const mainWnd = emu.handles.get<WindowInfo>(getParentHwnd(emu));
                if (mainWnd) mainWnd.needsPaint = true;
              }
            }
          }}>
          {items.map((item: ListViewItem, i: number) => {
            const selected = !!((item.state || 0) & LVIS_SELECTED);
            return (
              <div key={i}
                onClick={(e: Event) => onItemClick(i, e as MouseEvent)}
                onDblClick={(e: Event) => onItemDblClick(i, e as MouseEvent)}
                onContextMenu={(e: Event) => onItemContextMenu(i, e as MouseEvent)}
                style={{
                  display: 'flex', height: '16px', alignItems: 'center', cursor: 'var(--win2k-cursor)',
                  background: selected ? '#0A246A' : undefined,
                  color: selected ? '#FFF' : undefined,
                }}>
                {columns.length > 0 ? columns.map((col: ListViewColumn, j: number) => (
                  <div key={j} style={{
                    width: `${col.width}px`, padding: '0 4px', fontSize: '11px',
                    overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 0,
                    textAlign: (col.fmt & 0x3) === 1 ? 'right' : (col.fmt & 0x3) === 2 ? 'center' : 'left',
                  }}>{j === 0 ? item.text : (item.subItems?.[j - 1] ?? '')}</div>
                )) : (
                  <div style={{ padding: '0 4px', fontSize: '11px', overflow: 'hidden', whiteSpace: 'nowrap' }}>{item.text}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'SYSTABCONTROL32') {
    const onTabClick = (index: number) => {
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const wnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      if (!wnd) return;
      const oldIdx = wnd.tabSelectedIndex ?? 0;
      if (index === oldIdx) return;

      const WM_NOTIFY = 0x004E;
      const TCN_SELCHANGING = -552;
      const TCN_SELCHANGE = -551;
      // NMHDR: hwndFrom(4) + idFrom(4) + code(4) = 12 bytes
      const nmhdr = emu.allocHeap(12);
      emu.memory.writeU32(nmhdr, ctrl.childHwnd);
      emu.memory.writeU32(nmhdr + 4, ctrl.controlId);

      // Send TCN_SELCHANGING — if wndproc returns TRUE, cancel the switch
      emu.memory.writeU32(nmhdr + 8, TCN_SELCHANGING & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow, WM_NOTIFY, ctrl.controlId, nmhdr);

      // Update the selected index on the control
      wnd.tabSelectedIndex = index;

      // Send TCN_SELCHANGE
      emu.memory.writeU32(nmhdr + 8, TCN_SELCHANGE & 0xFFFFFFFF);
      emu.postMessage(emu.mainWindow, WM_NOTIFY, ctrl.controlId, nmhdr);

      // Trigger repaint
      const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (mainWnd) mainWnd.needsPaint = true;
    };
    return (
      <div key={ctrl.childHwnd} style={posStyle}>
        <TabControl tabs={ctrl.tabItems || []} selectedIndex={ctrl.tabSelectedIndex ?? 0} onTabClick={onTabClick} />
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'MSCTLS_STATUSBAR32') {
    const texts = ctrl.statusTexts || [];
    const SBARS_SIZEGRIP = 0x0100;
    const hasSizeGrip = !!(ctrl.style & SBARS_SIZEGRIP);
    return (
      <div key={ctrl.childHwnd} style={{
        ...posStyle, background: '#D4D0C8', boxSizing: 'border-box',
        display: 'flex', alignItems: 'center',
        font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
        borderTop: '1px solid #FFF',
      }}>
        {texts.map((t: string, i: number) => (
          <div key={i} style={{
            flex: i === 0 ? 1 : undefined, padding: '0 2px', margin: '0 1px',
            border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
            height: 'calc(100% - 2px)', display: 'flex', alignItems: 'center',
            overflow: 'hidden', whiteSpace: 'nowrap', fontSize: '11px',
          }}>{t}</div>
        ))}
        {hasSizeGrip && (
          <svg
            width="13" height="13" viewBox="0 0 13 13"
            style={{ flexShrink: 0, marginLeft: 'auto', marginTop: '3px', cursor: 'se-resize' }}
            onPointerDown={(e: Event) => onResizeStart?.('se', e as PointerEvent)}
          >
            <line x1="11" y1="1" x2="1" y2="11" stroke="#FFF" />
            <line x1="11" y1="2" x2="2" y2="11" stroke="#808080" />
            <line x1="11" y1="5" x2="5" y2="11" stroke="#FFF" />
            <line x1="11" y1="6" x2="6" y2="11" stroke="#808080" />
            <line x1="11" y1="9" x2="9" y2="11" stroke="#FFF" />
            <line x1="11" y1="10" x2="10" y2="11" stroke="#808080" />
          </svg>
        )}
      </div>
    );
  }

  if (effectiveClass(ctrl) === 'MSCTLS_TRACKBAR32') {
    const onTrackMouseDown = (e: PointerEvent) => {
      e.preventDefault();
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const isVert = !!(ctrl.style & 0x02);
      const tMin = ctrl.trackMin ?? 0;
      const tMax = ctrl.trackMax ?? 100;

      const computePos = (ev: PointerEvent) => {
        const frac = isVert
          ? Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height))
          : Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        return Math.round(tMin + frac * (tMax - tMin));
      };

      const childWnd = emu.handles.get<WindowInfo>(ctrl.childHwnd);
      const sendTrack = (pos: number, code: number) => {
        if (childWnd) childWnd.trackPos = pos;
        // WM_HSCROLL=0x114, wParam=MAKELONG(code, pos), lParam=childHwnd
        emu.postMessage(emu.mainWindow!, 0x0114, (pos << 16) | code, ctrl.childHwnd);
        if (childWnd) { const mainWnd = emu.handles.get<WindowInfo>(emu.mainWindow!); if (mainWnd) mainWnd.needsPaint = true; }
      };

      const pos0 = computePos(e);
      sendTrack(pos0, 5); // TB_THUMBTRACK

      const onMove = (ev: PointerEvent) => sendTrack(computePos(ev), 5);
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        sendTrack(computePos(ev), 4); // TB_THUMBPOSITION
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    return (
      <div key={ctrl.childHwnd} style={posStyle} onPointerDown={onTrackMouseDown}>
        <Trackbar style={ctrl.style} width={ctrl.width} height={ctrl.height}
          pos={ctrl.trackPos} min={ctrl.trackMin} max={ctrl.trackMax} />
      </div>
    );
  }

  return null;
}


// --- Main EmulatorView ---

export function EmulatorView({ arrayBuffer, peInfo, additionalFiles, exeName, commandLine, onStop, onFocus, onReady, onRunExe, onSetupEmulator, onTitleChange, onIconChange, onMinimize, onRegisterCloseHandler, processRegistry, zIndex = 100, focused = true, minimized: minimizedProp }: EmulatorViewProps) {
  const exeBaseName = exeName.split(/[/\\]/).pop() || exeName;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emuRef = useRef<Emulator | null>(null);
  const [menus, setMenus] = useState<MenuResult[]>([]);
  const detectedLang = langToHtmlLang(detectPELanguageId(peInfo.resources)) || undefined;
  const [windowTitle, setWindowTitle] = useState('');
  const [windowStyle, setWindowStyle] = useState(0x00CF0000); // WS_OVERLAPPEDWINDOW
  const [canvasSize, setCanvasSize] = useState({ w: 320, h: 240 });
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [dialogInfo, setDialogInfo] = useState<DialogInfo | null>(null);
  const [controlOverlays, setControlOverlays] = useState<ControlOverlay[]>([]);
  const [pressedControl, setPressedControl] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [windowPos, setWindowPos] = useState({ x: 40, y: 10 });
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const windowPosInitialized = useRef(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const mouseIsDown = useRef(false);
  const desktopRef = useRef<HTMLDivElement>(null);
  const [resetCount, setResetCount] = useState(0);
  const [windowReady, setWindowReady] = useState(false);
  const [hasMainWindow, setHasMainWindow] = useState(false);
  const [isConsole, setIsConsole] = useState(false);
  const [crashInfo, setCrashInfo] = useState<{ eip: string; description: string } | null>(null);
  const [messageBoxes, setMessageBoxes] = useState<{ id: number; caption: string; text: string; type: number; isExit?: boolean }[]>([]);
  const [commonDialog, setCommonDialog] = useState<CommonDialogRequest | null>(null);
  const [modalFlashTrigger, setModalFlashTrigger] = useState(0);
  const flashModal = useCallback(() => setModalFlashTrigger(c => c + 1), []);

  // When restored from taskbar, send SC_RESTORE to the emulator
  const prevMinimized = useRef(minimizedProp);
  useEffect(() => {
    if (prevMinimized.current && !minimizedProp) {
      const emu = emuRef.current;
      if (emu?.mainWindow) {
        emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      }
    }
    prevMinimized.current = minimizedProp;
  }, [minimizedProp]);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Reset all UI state on restart
    setMenus([]);
    setControlOverlays([]);
    setDialogInfo(null);
    setWindowTitle('');
    setWindowPos({ x: 40, y: 10 });
    setMinimized(false);
    setMaximized(false);
    setWindowReady(false);
    setHasMainWindow(false);
    setCrashInfo(null);
    setMessageBoxes([]);
    preMaxState.current = null;

    const canvas = canvasRef.current;
    const emu = new Emulator();
    emu.configuredLcid = loadSettings().localeId;

    // Async init for registry, then start emulator
    let regFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const initAndRun = async () => {
      // Set up registry store with IndexedDB persistence
      const regStore = new RegistryStore();
      try {
        const saved = await loadRegistry();
        if (saved) regStore.deserialize(saved);
      } catch (e) {
        console.warn('[REG] Failed to load registry from IndexedDB:', e);
      }
      regStore.onChange = () => {
        if (regFlushTimer !== null) clearTimeout(regFlushTimer);
        regFlushTimer = setTimeout(() => {
          saveRegistry(regStore.serialize()).catch(e =>
            console.warn('[REG] Failed to save registry:', e)
          );
        }, 500);
      };
      emu.registryStore = regStore;
    };

    try {
      const extractedMenus = extractMenus(peInfo, arrayBuffer);
      setMenus(extractedMenus);
      // Expose menu items to emulator for CheckMenuItem/EnableMenuItem
      if (extractedMenus.length > 0) {
        emu.menuItems = extractedMenus[0].menu.items;
      }

      // Extract the first app icon for the title bar
      const icons = extractIcons(peInfo, arrayBuffer);
      if (icons.length > 0) {
        const url = URL.createObjectURL(icons[0].blob);
        setIconUrl(url);
        onIconChange?.(url);
      }

      if (additionalFiles) {
        for (const [name, data] of additionalFiles) {
          emu.additionalFiles.set(name, data);
        }
      }

      if (commandLine) emu.commandLine = commandLine;
      emu.exeName = exeName;
      if (processRegistry) {
        emu.processRegistry = processRegistry;
        processRegistry.register(emu, exeName);
      }
      emu.screenWidth = window.innerWidth;
      emu.screenHeight = window.innerHeight;
      onSetupEmulator?.(emu);

      emu.load(arrayBuffer, peInfo, canvas);
      emuRef.current = emu;
      onRegisterCloseHandler?.(() => {
        if (emu.mainWindow) {
          emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
        } else {
          onStop();
        }
      });

      // Console app detection
      if (emu.isConsole) {
        setIsConsole(true);
        setWindowReady(true);
        if (!emu.consoleTitle) emu.consoleTitle = emu.exePath;
        setWindowTitle(emu.consoleTitle);
        onTitleChange?.(emu.consoleTitle);
        setWindowStyle(WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX);
        setCanvasSize({ w: 640, h: 400 });
        onReady?.();
      }

      emu.onConsoleTitleChange = () => {
        setWindowTitle(emu.consoleTitle);
        onTitleChange?.(emu.consoleTitle);
      };

      // Wire up async file I/O to IndexedDB via FileManager
      emu.fs.onFileRequest = (fileName: string) => getFile(fileName);
      emu.fs.onFileSave = (fileName: string, data: ArrayBuffer) => {
        addFile(fileName, data).then(() => window.dispatchEvent(new Event('desktop-files-changed')));
      };
      emu.fs.onFileDelete = (fileName: string) => {
        deleteFile(fileName).then(() => window.dispatchEvent(new Event('desktop-files-changed')));
      };

      // Wire up browser file picker for GetOpenFileName/GetSaveFileName
      emu.onFileDialog = (type, filter, title) => {
        return new Promise<{ name: string; data: ArrayBuffer } | null>((resolve) => {
          if (type === 'open') {
            const input = document.createElement('input');
            input.type = 'file';
            // Parse filter to extract extensions (e.g. "Text Files|*.txt|All Files|*.*")
            if (filter) {
              const parts = filter.split('|');
              const exts: string[] = [];
              for (let i = 1; i < parts.length; i += 2) {
                const pat = parts[i].trim();
                if (pat && pat !== '*.*' && pat !== '*') {
                  // "*.txt;*.log" → ".txt,.log"
                  pat.split(';').forEach(p => {
                    const m = p.trim().match(/\*(\.\w+)/);
                    if (m) exts.push(m[1]);
                  });
                }
              }
              if (exts.length > 0) input.accept = exts.join(',');
            }
            input.onchange = () => {
              const file = input.files?.[0];
              if (!file) { resolve(null); return; }
              file.arrayBuffer().then(data => resolve({ name: file.name, data }));
            };
            // Handle cancel — input doesn't fire change on cancel, use focus fallback
            const onFocus = () => {
              setTimeout(() => {
                if (!input.files?.length) resolve(null);
                window.removeEventListener('focus', onFocus);
              }, 300);
            };
            window.addEventListener('focus', onFocus);
            input.click();
          } else {
            // Save: prompt for filename
            const defaultName = title || 'untitled.txt';
            const name = prompt('Save file as:', defaultName);
            if (!name) { resolve(null); return; }
            resolve({ name, data: new ArrayBuffer(0) });
          }
        });
      };

      // Wire up browser download for Z:\ file save
      emu.fs.onFileSaveExternal = (name, data) => {
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };

      // Populate virtual filesystem with desktop files (for all app types)
      getAllFiles().then(files => {
        emu.fs.virtualFiles = files.map(f => ({ name: f.name, size: f.data.byteLength }));
      });

      // Listen for window changes from emulator
      emu.onWindowChange = (wnd: WindowInfo) => {
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
        setHasMainWindow(true);
        setWindowTitle(wnd.title);
        onTitleChange?.(wnd.title);
        setWindowStyle(wnd.style);
        setMinimized(!!wnd.minimized);
        setMaximized(!!wnd.maximized);
        // Use emulated window position only for initial mainWindow placement (cascade),
        // not for runtime MoveWindow/SetWindowPos or non-main windows
        if (!windowPosInitialized.current && emu.mainWindow && wnd.hwnd === emu.mainWindow) {
          windowPosInitialized.current = true;
          const x = Math.max(0, Math.min(wnd.x, window.innerWidth - wnd.width));
          const y = Math.max(0, Math.min(wnd.y, window.innerHeight - wnd.height));
          setWindowPos({ x, y });
        }
        if (canvas && !wnd.minimized) {
          setCanvasSize({ w: canvas.width, h: canvas.height });
        }
      };

      emu.onShowDialog = (info: DialogInfo) => {
        setDialogInfo(info);
        // Programs like ssmaze.scr /c show a dialog without creating a main window.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCloseDialog = () => setDialogInfo(null);
      emu.onControlsChanged = (controls: ControlOverlay[]) => setControlOverlays(controls);
      emu.onMenuChanged = () => setMenus(prev => [...prev]);
      emu.onShowCommonDialog = (req) => {
        setCommonDialog(req);
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onShowMessageBox = (id, caption, text, type) => {
        setMessageBoxes(prev => [...prev, { id, caption, text, type }]);
        // Programs like winver.exe show a message box without creating a main window.
        // Ensure the UI becomes visible so the message box can be seen.
        setWindowReady(prev => { if (!prev) onReady?.(); return true; });
      };
      emu.onCrash = (eip: string, description: string) => { setCrashInfo({ eip, description }); onReady?.(); };
      emu.onExit = () => {
        if (emu.isConsole) {
          // Keep window open so user can see output, show a message box like cmd.exe
          const finishedTitle = `Finished - ${emu.consoleTitle || exeBaseName}`;
          emu.consoleTitle = finishedTitle;
          setWindowTitle(finishedTitle);
          onTitleChange?.(finishedTitle);
          setMessageBoxes(prev => [...prev, { id: -1, caption: exeBaseName, text: t().processExited.replace('{0}', String(emu.exitCode)), type: 0 /* MB_OK */, isExit: true }]);
          return;
        }
        onStop();
      };
      emu.onCreateProcess = (childExeName: string, childCmdLine: string) => {
        if (!onRunExe) return;
        const lowerName = childExeName.toLowerCase();
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            const childPe = parsePE(data);
            // Pass all additionalFiles to the child too
            onRunExe(data, childPe, emu.additionalFiles, name, childCmdLine);
            return;
          }
        }
      };

      // Child console process from console parent: run in-process, share console
      emu.onCreateChildConsole = (childExeName: string, childCmdLine: string, hProcess: number) => {
        const lowerName = childExeName.toLowerCase();
        let childData: ArrayBuffer | undefined;
        let childFileName = childExeName;
        for (const [name, data] of emu.additionalFiles) {
          if (name.toLowerCase() === lowerName) {
            childData = data;
            childFileName = name;
            break;
          }
        }
        if (!childData) return;

        const childPeInfo = parsePE(childData);
        const procData = emu.handles.get<Record<string, unknown>>(hProcess);

        // Create child emulator in-process
        const childEmu = new Emulator();
        childEmu.configuredLcid = loadSettings().localeId;
        for (const [name, data] of emu.additionalFiles) {
          childEmu.additionalFiles.set(name, data);
        }
        if (childCmdLine) childEmu.commandLine = childCmdLine;
        if (processRegistry) {
          childEmu.processRegistry = processRegistry;
          processRegistry.register(childEmu, childFileName);
        }
        childEmu.screenWidth = emu.screenWidth;
        childEmu.screenHeight = emu.screenHeight;

        // Share file system, inherit current drive/directory
        childEmu.fs = emu.fs;
        childEmu.currentDrive = emu.currentDrive;
        childEmu.currentDirs = new Map(emu.currentDirs);

        // Store child emu on the process handle
        if (procData) {
          procData.childEmu = childEmu;
          procData.childExited = false;
          procData.childExitCode = 0;
        }

        // Load child (this creates its own consoleBuffer via initConsoleBuffer)
        childEmu.load(childData, childPeInfo, canvas);

        // Share console state AFTER load() so initConsoleBuffer doesn't overwrite
        childEmu.consoleBuffer = emu.consoleBuffer;
        childEmu.consoleCursorX = emu.consoleCursorX;
        childEmu.consoleCursorY = emu.consoleCursorY;
        childEmu.consoleAttr = emu.consoleAttr;
        childEmu.consoleMode = emu.consoleMode;
        childEmu.consoleInputMode = emu.consoleInputMode;
        childEmu.consoleInputBuffer = emu.consoleInputBuffer;

        // Allow child to create GUI windows or spawn its own children
        childEmu.onCreateProcess = emu.onCreateProcess;
        childEmu.onCreateChildConsole = emu.onCreateChildConsole;

        // When child writes to console, sync cursor back to parent and notify UI
        childEmu.onConsoleOutput = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();
        };

        childEmu.onConsoleTitleChange = () => {
          emu.consoleTitle = childEmu.consoleTitle;
          emu.onConsoleTitleChange?.();
        };

        // When child exits, signal the parent's process handle and resume parent
        childEmu.onExit = () => {
          emu.consoleCursorX = childEmu.consoleCursorX;
          emu.consoleCursorY = childEmu.consoleCursorY;
          emu.consoleAttr = childEmu.consoleAttr;
          emu.onConsoleOutput?.();

          if (procData) {
            procData.childExited = true;
            procData.childExitCode = childEmu.exitCode;
          }

          // Resume parent if it was waiting on WaitForSingleObject
          if (emu._childProcessWaiting && emu._childProcessResume) {
            const { stackBytes, retVal, completer } = emu._childProcessResume;
            emu._childProcessWaiting = false;
            emu._childProcessResume = null;
            emu.waitingForMessage = false;
            completer(emu, stackBytes, retVal);
            if (emu.running && !emu.halted) {
              requestAnimationFrame(emu.tick);
            }
          }
        };

        // Start the child
        childEmu.run();
      };

      // Load registry from IndexedDB then start
      initAndRun().then(() => emu.run());
    } catch (err: unknown) {
      console.error('Emulator error:', err);
    }

    return () => {
      if (regFlushTimer !== null) clearTimeout(regFlushTimer);
      if (emuRef.current) {
        if (processRegistry && emuRef.current.pid) {
          processRegistry.unregister(emuRef.current.pid);
        }
        emuRef.current.stop();
        emuRef.current = null;
      }
      if (iconUrl) URL.revokeObjectURL(iconUrl);
    };
  }, [arrayBuffer, peInfo, resetCount]);

  // --- Resize drag handling ---
  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    // Send WM_GETMINMAXINFO so the app can set its min track size (cached on WindowInfo after dispatch)
    const emu = emuRef.current;
    if (emu && emu.mainWindow) {
      const addr = emu.allocHeap(40); // MINMAXINFO = 40 bytes
      emu.postMessage(emu.mainWindow, WM_GETMINMAXINFO, 0, addr);
    }
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: canvasSize.w, startH: canvasSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [canvasSize, windowPos]);

  const applyCanvasToEmu = useCallback((w: number, h: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
    if (!wnd) return;
    emu.setupCanvasSize(w, h);
    const bw = getBorderWidth(wnd.style);
    const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
    const captionH = hasCaption ? 19 : 0;
    const menuH = wnd.hMenu ? 19 : 0;
    wnd.width = w + 2 * bw;
    wnd.height = h + 2 * bw + captionH + menuH;
    emu.postMessage(emu.mainWindow, WM_SIZE, 0, makeLParam(w, h));
    wnd.needsPaint = true;
    wnd.needsErase = true;
  }, []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      // Move drag
      const m = moveDrag.current;
      if (m) {
        setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY });
        return;
      }
      // Resize drag
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH;
      let px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      // Windows SM_CXMINTRACK = 112 at 96 DPI (fits icon + caption buttons + borders)
      const SM_CXMINTRACK = 112;
      let minW = SM_CXMINTRACK, minH = 32;
      const emu = emuRef.current;
      if (emu && emu.mainWindow) {
        const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
        if (wnd && wnd.minTrackWidth) {
          const bw = getBorderWidth(wnd.style);
          const hasCaption = (wnd.style & WS_CAPTION) === WS_CAPTION;
          const captionH = hasCaption ? 19 : 0;
          const menuH = wnd.hMenu ? 19 : 0;
          minW = Math.max(SM_CXMINTRACK, wnd.minTrackWidth - 2 * bw);
          minH = Math.max(32, (wnd.minTrackHeight || 0) - 2 * bw - captionH - menuH);
        }
      }
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setCanvasSize({ w, h });
      setWindowPos({ x: px, y: py });
      applyCanvasToEmu(w, h);
    };
    const onUp = () => {
      if (moveDrag.current) { moveDrag.current = null; return; }
      resizeDrag.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, [canvasSize, applyCanvasToEmu]);

  const handlePointerEvent = useCallback((e: PointerEvent, msg: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    // Block mouse events while a modal dialog/MessageBox is showing
    if (emu.messageBoxes.length > 0) return;
    if (emu.dialogState) return;

    // Ensure AudioContext is running — must be created/resumed during user gesture
    if (!emu.audioContext || emu.audioContext.state === 'suspended') {
      const oldState = emu.audioContext?.state;
      if (emu.audioContext) emu.audioContext.close();
      emu.audioContext = new AudioContext();
      console.log(`[AUDIO] handlePointerEvent: replaced ctx (was ${oldState}) → new state=${emu.audioContext.state}`);
    }

    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) * canvas.width / rect.width);
    const y = Math.round((e.clientY - rect.top) * canvas.height / rect.height);
    const lParam = makeLParam(x, y);
    const wParam = buildMKFlags(e);
    const targetHwnd = emu.capturedWindow || emu.mainWindow;
    emu.postMessage(targetHwnd, msg, wParam, lParam);
  }, []);

  // Document-level mouse listeners for SetCapture support (drag over overlays)
  useEffect(() => {
    const onDocMouseMove = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      handlePointerEvent(e, WM_MOUSEMOVE);
    };
    const onDocMouseUp = (e: PointerEvent) => {
      if (!mouseIsDown.current || !canvasRef.current) return;
      mouseIsDown.current = false;
      handlePointerEvent(e, WM_MOUSEMOVE);
      if (e.button === 0) handlePointerEvent(e, WM_LBUTTONUP);
      else if (e.button === 2) handlePointerEvent(e, WM_RBUTTONUP);
    };
    document.addEventListener('pointermove', onDocMouseMove);
    document.addEventListener('pointerup', onDocMouseUp);
    return () => {
      document.removeEventListener('pointermove', onDocMouseMove);
      document.removeEventListener('pointerup', onDocMouseUp);
    };
  }, [handlePointerEvent]);

  // Keyboard input — post WM_KEYDOWN/WM_KEYUP/WM_CHAR to emulator
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!focused) return;
      // Don't intercept input into HTML form elements
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      // Don't intercept browser shortcuts (Ctrl+T, Ctrl+W, etc.)
      if (e.ctrlKey && !e.altKey && ['KeyT', 'KeyW', 'KeyN', 'KeyR', 'KeyL'].includes(e.code)) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.add(vk);
      // lParam: repeat count (1) | scanCode << 16 | extended << 24 | previous state << 30
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16);
      emu.postMessage(emu.mainWindow, WM_KEYDOWN, vk, lParam);
      // Also send WM_CHAR for printable characters
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey) {
        emu.postMessage(emu.mainWindow, WM_CHAR, e.key.charCodeAt(0), lParam);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!focused) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      const keyToVK = getKeyToVK();
      const vk = keyToVK[e.code];
      if (vk === undefined) return;
      e.preventDefault();
      emu.keyStates.delete(vk);
      const scanCode = e.keyCode & 0xFF;
      const lParam = 1 | (scanCode << 16) | (3 << 30); // transition + previous state
      emu.postMessage(emu.mainWindow, WM_KEYUP, vk, lParam);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [focused]);

  const handleMenuCommand = useCallback((id: number) => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    emu.postMessage(emu.mainWindow, WM_COMMAND, id, 0);
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    // Don't start drag on caption buttons
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    if (maximized) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos, maximized]);

  const handleMinimize = useCallback(() => {
    const emu = emuRef.current;
    if (emu?.mainWindow) {
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MINIMIZE, 0);
    }
    // Don't set minimized on the window — let the taskbar handle hiding via minimizedProp
    onMinimize?.();
  }, [onMinimize]);

  const handleMaximize = useCallback(() => {
    const emu = emuRef.current;
    if (!emu || !emu.mainWindow) return;
    if (maximized) {
      // Restore
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const saved = preMaxState.current;
      if (saved) {
        setWindowPos({ x: saved.x, y: saved.y });
        setCanvasSize({ w: saved.w, h: saved.h });
        preMaxState.current = null;
        // Defer so state settles before applying to emu
        setTimeout(() => applyCanvasToEmu(saved.w, saved.h), 0);
      }
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        if (saved) { wnd.x = saved.x; wnd.y = saved.y; }
        wnd.minimized = false; wnd.maximized = false;
      }
      setMaximized(false);
      setMinimized(false);
    } else {
      // Maximize
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_MAXIMIZE, 0);
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: canvasSize.w, h: canvasSize.h };
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      const hasCaption = wnd ? (wnd.style & WS_CAPTION) === WS_CAPTION : true;
      const captionH = hasCaption ? 21 : 0;
      const menuH = (menus.length > 0) ? 20 : 0;
      const TASKBAR_HEIGHT = 30;
      const dw = window.innerWidth;
      const dh = window.innerHeight - captionH - menuH - TASKBAR_HEIGHT;
      setWindowPos({ x: 0, y: 0 });
      setCanvasSize({ w: dw, h: dh });
      setTimeout(() => applyCanvasToEmu(dw, dh), 0);
      if (wnd) { wnd.x = 0; wnd.y = 0; wnd.maximized = true; wnd.minimized = false; }
      setMaximized(true);
      setMinimized(false);
    }
  }, [maximized, windowPos, canvasSize, menus.length, applyCanvasToEmu]);

  const handleTitleBarDblClick = useCallback(() => {
    if (minimized) {
      const emu = emuRef.current;
      if (!emu || !emu.mainWindow) return;
      emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_RESTORE, 0);
      const wnd = emu.handles.get<WindowInfo>(emu.mainWindow);
      if (wnd) {
        wnd.minimized = false; wnd.maximized = false;
        wnd.needsPaint = true; wnd.needsErase = true;
        emu.onWindowChange?.(wnd);
      }
    } else if (windowStyle & WS_MAXIMIZEBOX) {
      handleMaximize();
    }
  }, [minimized, handleMaximize, windowStyle]);


  if (crashInfo) {
    const crashExeName = windowTitle || exeBaseName;
    return (
      <div onPointerDown={onFocus}>
        <MessageBox
          caption={`${crashExeName} - ${t().applicationError}`}
          text={`${t().crashMessage.replace('{0}', crashExeName)}\n\nReason:  ${crashInfo.description}\nAddress: ${crashInfo.eip}\n\n${t().clickOkToTerminate}`}
          icon={<MsgBoxIcon type={MB_ICONERROR} />}
          onDismiss={onStop}
        />
      </div>
    );
  }

  const hasModalDialog = !!(messageBoxes.length > 0 || dialogInfo || commonDialog);
  const parentFocused = focused && !hasModalDialog;

  // Programs like winver.exe / ssmaze.scr /c have no main window — only show the message box / dialog
  if (!hasMainWindow && !isConsole && windowReady) {
    return (
      <>
        {dialogInfo && (
          <Dialog
            info={dialogInfo}
            emuRef={emuRef}
            focused={focused}
            lang={detectedLang}
            onDismiss={(action, values) => {
              emuRef.current?.dismissDialog(action, values);
              setDialogInfo(null);
            }}
          />
        )}
        {messageBoxes.map(mb => (
          <MessageBox
            key={mb.id}
            caption={mb.caption}
            text={mb.text}
            type={mb.type}
            focused={focused}
            onDismiss={(btnId) => {
              const isExit = mb.isExit;
              emuRef.current?.dismissMessageBox(mb.id, btnId);
              setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
              if (isExit) onStop();
            }}
          />
        ))}
        {commonDialog?.type === 'about' && (
          <AboutDialog
            caption={commonDialog.caption}
            extraInfo={commonDialog.extraInfo}
            otherText={commonDialog.otherText}
            focused={focused}
            flashTrigger={modalFlashTrigger}
            onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
          />
        )}
      </>
    );
  }

  return (
    <div ref={desktopRef} style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, visibility: windowReady ? 'visible' : 'hidden', display: minimizedProp ? 'none' : undefined, touchAction: 'none' }} onPointerDown={onFocus}>
      <Window
        title={windowTitle}
        style={windowStyle}
        clientW={isConsole ? 640 : canvasSize.w}
        clientH={isConsole ? 400 : canvasSize.h}
        iconUrl={iconUrl}
        focused={parentFocused}
        maximized={maximized}
        minimized={false}
        blocked={hasModalDialog}
        onBlockedClick={flashModal}
        menus={<MenuBar menus={menus} onCommand={handleMenuCommand} onFocus={onFocus} />}
        onClose={() => {
          const emu = emuRef.current;
          if (emu?.mainWindow) {
            emu.postMessage(emu.mainWindow, WM_SYSCOMMAND, SC_CLOSE, 0);
          } else {
            onStop();
          }
        }}
        onMinimize={handleMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleTitleBarDblClick}
        onResizeStart={onResizeStart}
        lang={detectedLang}
      >
        <div
          style={{ width: '100%', height: '100%' }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return;
            e.preventDefault();
            mouseIsDown.current = true;
            if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
            else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {isConsole && emuRef.current ? (
            <ConsoleView emu={emuRef.current} focused={focused} />
          ) : (
            <canvas
              ref={canvasRef}
              style={{ imageRendering: 'pixelated', cursor: 'var(--win2k-cursor)', display: 'block', position: 'relative', zIndex: 0 }}
              onPointerDown={(e) => {
                e.preventDefault();
                mouseIsDown.current = true;
                if (e.button === 0) handlePointerEvent(e, e.detail >= 2 ? WM_LBUTTONDBLCLK : WM_LBUTTONDOWN);
                else if (e.button === 2) handlePointerEvent(e, e.detail >= 2 ? WM_RBUTTONDBLCLK : WM_RBUTTONDOWN);
              }}
              onPointerMove={(e) => {
                if (!mouseIsDown.current) handlePointerEvent(e, WM_MOUSEMOVE);
              }}
              onContextMenu={(e) => e.preventDefault()}
            />
          )}
          {!isConsole && controlOverlays.map((ctrl) => renderControlOverlay(ctrl, emuRef, setPressedControl, pressedControl, onResizeStart))}
        </div>
      </Window>
      {dialogInfo && (
        <Dialog
          info={dialogInfo}
          emuRef={emuRef}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          lang={detectedLang}
          onDismiss={(action, values) => {
            emuRef.current?.dismissDialog(action, values);
            setDialogInfo(null);
          }}
        />
      )}
      {messageBoxes.map(mb => (
        <MessageBox
          key={mb.id}
          caption={mb.caption}
          text={mb.text}
          type={mb.type}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={(btnId) => {
            emuRef.current?.dismissMessageBox(mb.id, btnId);
            setMessageBoxes(prev => prev.filter(m => m.id !== mb.id));
          }}
        />
      ))}
      {commonDialog?.type === 'about' && (
        <AboutDialog
          caption={commonDialog.caption}
          extraInfo={commonDialog.extraInfo}
          otherText={commonDialog.otherText}
          focused={focused}
          flashTrigger={modalFlashTrigger}
          parentRef={desktopRef}
          onDismiss={() => { commonDialog.onDismiss(); setCommonDialog(null); }}
        />
      )}
    </div>
  );
}
