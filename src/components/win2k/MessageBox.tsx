import { useState, useEffect, useRef } from 'preact/hooks';
import { useLayoutEffect } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Window, WS_CAPTION, WS_SYSMENU } from './Window';
import { Button } from './Button';
import { t } from '../../lib/regional-settings';

// --- Constants ---
export const MB_OK = 0x00;
export const MB_OKCANCEL = 0x01;
export const MB_ABORTRETRYIGNORE = 0x02;
export const MB_YESNOCANCEL = 0x03;
export const MB_YESNO = 0x04;
export const MB_RETRYCANCEL = 0x05;

export const MB_ICONERROR = 0x10;
export const MB_ICONQUESTION = 0x20;
export const MB_ICONWARNING = 0x30;
export const MB_ICONINFORMATION = 0x40;

export const IDOK = 1;
export const IDCANCEL = 2;
export const IDABORT = 3;
export const IDRETRY = 4;
export const IDIGNORE = 5;
export const IDYES = 6;
export const IDNO = 7;

// --- Icons ---
export function MsgBoxIcon({ type }: { type: number }) {
  const icon = type & 0xF0;
  if (icon === MB_ICONERROR) {
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
        <circle cx="16" cy="16" r="14" fill="#FF0000" stroke="#800000" stroke-width="1" />
        <path d="M10 10L22 22M22 10L10 22" stroke="white" stroke-width="3" stroke-linecap="round" />
      </svg>
    );
  }
  if (icon === MB_ICONWARNING) {
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
        <path d="M16 2L1 29h30L16 2z" fill="#FFD700" stroke="#808000" stroke-width="1" />
        <text x="16" y="26" text-anchor="middle" font-size="22" font-weight="bold" fill="#000">!</text>
      </svg>
    );
  }
  if (icon === MB_ICONQUESTION) {
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
        <circle cx="16" cy="16" r="14" fill="#0000FF" stroke="#000080" stroke-width="1" />
        <text x="16" y="23" text-anchor="middle" font-size="22" font-weight="bold" fill="white">?</text>
      </svg>
    );
  }
  if (icon === MB_ICONINFORMATION) {
    return (
      <svg width="32" height="32" viewBox="0 0 32 32" style={{ flexShrink: 0 }}>
        <circle cx="16" cy="16" r="14" fill="#0000FF" stroke="#000080" stroke-width="1" />
        <text x="16" y="23" text-anchor="middle" font-size="22" font-weight="bold" fill="white">i</text>
      </svg>
    );
  }
  return null;
}

// --- Button configs ---
function getMsgBoxButtons(type: number): { label: string; id: number }[] {
  const s = t();
  const buttons = type & 0x0F;
  switch (buttons) {
    case MB_OK: return [{ label: s.ok, id: IDOK }];
    case MB_OKCANCEL: return [{ label: s.ok, id: IDOK }, { label: s.cancel, id: IDCANCEL }];
    case MB_YESNO: return [{ label: s.yes, id: IDYES }, { label: s.no, id: IDNO }];
    case MB_YESNOCANCEL: return [{ label: s.yes, id: IDYES }, { label: s.no, id: IDNO }, { label: s.cancel, id: IDCANCEL }];
    case MB_ABORTRETRYIGNORE: return [{ label: s.abort, id: IDABORT }, { label: s.retry, id: IDRETRY }, { label: s.ignore, id: IDIGNORE }];
    case MB_RETRYCANCEL: return [{ label: s.retry, id: IDRETRY }, { label: s.cancel, id: IDCANCEL }];
    default: return [{ label: s.ok, id: IDOK }];
  }
}

const FONT = '11px/1 "Tahoma", "MS Sans Serif", sans-serif';

// --- MessageBox Component ---
export function MessageBox({ caption, text, type, icon, onDismiss, focused = true, flashTrigger, parentRef }: {
  caption: string;
  text: string;
  type?: number;
  icon?: ComponentChildren;
  onDismiss: (id: number) => void;
  focused?: boolean;
  flashTrigger?: number;
  parentRef?: { current: HTMLDivElement | null };
}) {
  const buttons = type != null ? getMsgBoxButtons(type) : [{ label: t().ok, id: IDOK }];
  const defaultId = buttons[0].id;
  const [initialPos, setInitialPos] = useState<{ x: number; y: number } | undefined>(undefined);
  const [visible, setVisible] = useState(false);
  const measureRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const dlgRect = measureRef.current.getBoundingClientRect();
    const parentRect = parentRef?.current?.getBoundingClientRect();
    const cx = parentRect ? parentRect.left + parentRect.width / 2 : window.innerWidth / 2;
    const cy = parentRect ? parentRect.top + parentRect.height / 2 : window.innerHeight / 2;
    setInitialPos({ x: cx - dlgRect.width / 2, y: cy - dlgRect.height / 2 });
  }, []);

  useEffect(() => {
    if (initialPos) setVisible(true);
  }, [initialPos]);

  return (
    <div ref={measureRef} style={{ visibility: visible ? 'visible' : 'hidden', position: 'absolute', font: FONT, minWidth: '280px', maxWidth: '450px' }}>
      <Window
        title={caption}
        style={WS_CAPTION | WS_SYSMENU}
        focused={focused}
        draggable
        initialPos={initialPos}
        flashTrigger={flashTrigger}
        onClose={() => onDismiss(IDCANCEL)}
      >
        {/* Body */}
        <div style={{ padding: '12px 12px 8px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          {icon ?? (type != null ? <MsgBoxIcon type={type} /> : null)}
          <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</div>
        </div>
        {/* Buttons */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', padding: '4px 12px 8px' }}>
          {buttons.map((btn) => (
            <div key={btn.id} style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={() => onDismiss(btn.id)}>
              <Button fontCSS={FONT} isDefault={btn.id === defaultId}>{btn.label}</Button>
            </div>
          ))}
        </div>
      </Window>
    </div>
  );
}
