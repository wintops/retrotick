import { useRef, useEffect, useLayoutEffect, useState } from 'preact/hooks';
import type { Emulator, DialogInfo, ControlOverlay } from '../lib/emu/emulator';
import type { WindowInfo } from '../lib/emu/win32/user32/index';
import { WS_DLGFRAME } from './win2k/Window';
import { Window } from './win2k/Window';
import { renderControlOverlay, effectiveClass } from './ControlOverlay';

export function EmulatorDialog({ info, emuRef, onDismiss, focused = true, flashTrigger, parentRef, lang }: {
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

  // Focus the first EDIT control when dialog becomes visible
  useEffect(() => {
    if (!visible || !measureRef.current) return;
    const input = measureRef.current.querySelector('textarea, input') as HTMLElement | null;
    if (input) {
      input.focus();
      if ('select' in input) (input as HTMLInputElement).select();
    }
  }, [visible]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onDismiss(1, info.controlValues); }
    if (e.key === 'Escape') { e.preventDefault(); onDismiss(2, info.controlValues); }
  };

  return (
    <div ref={measureRef} onClick={(e) => e.stopPropagation()} onKeyDownCapture={handleKeyDown} style={{ visibility: visible ? 'visible' : 'hidden', position: 'absolute', font: '12px/1 "Tahoma",sans-serif' }}>
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
              // Wrap OK (id=1) and Cancel (id=2) buttons to also dismiss the dialog.
              // Use onClickCapture to intercept BEFORE ControlOverlay's postCommand fires,
              // so dismissDialog syncs controlValues before sending WM_COMMAND.
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
