import { useRef, useEffect, useState } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { t } from '../lib/regional-settings';

const btnStyle = {
  minWidth: '86px', height: '23px', whiteSpace: 'nowrap' as const,
  background: '#D4D0C8', cursor: 'var(--win2k-cursor)',
  border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
  boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
  fontFamily: '"Tahoma", "MS Sans Serif", sans-serif', fontSize: '11px',
};

const inputStyle = {
  flex: 1, height: '21px', border: '1px solid #7f9db9',
  padding: '1px 4px', fontFamily: 'inherit', fontSize: 'inherit', background: '#FFF',
};

const fontStyle = { fontFamily: '"Tahoma", "MS Sans Serif", sans-serif', fontSize: '11px' };

export function FindDialog({ findTerm, onTermChange, onFindNext, onClose, focused, parentRef }: {
  findTerm: string;
  onTermChange: (v: string) => void;
  onFindNext: () => void;
  onClose: () => void;
  focused?: boolean;
  parentRef?: { current: HTMLDivElement | null };
}) {
  const s = t();
  const inputRef = useRef<HTMLInputElement>(null);
  const [initPos] = useState<{ x: number; y: number }>(() => {
    const p = parentRef?.current?.getBoundingClientRect();
    const cx = p ? p.left + p.width / 2 : window.innerWidth / 2;
    const cy = p ? p.top + 60 : 80;
    return { x: Math.max(0, cx - 175), y: cy };
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onFindNext(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div style={{ position: 'fixed', left: '0', top: '0', zIndex: 10000 }}>
      <Window
        title={s.findTitle}
        style={WS_CAPTION | WS_SYSMENU}
        clientW={410}
        clientH={56}
        focused={focused}
        onClose={onClose}
        draggable
        initialPos={initPos}
      >
        <div style={{ padding: '8px', display: 'flex', gap: '8px', alignItems: 'center', ...fontStyle }}>
          <label style={{ whiteSpace: 'nowrap' }}>{s.findWhat}</label>
          <input
            ref={inputRef}
            tabIndex={1}
            type="text"
            value={findTerm}
            onInput={(e) => onTermChange((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            style={inputStyle}
          />
          <button tabIndex={2} onClick={onFindNext} disabled={!findTerm} style={btnStyle}>{s.findNext}</button>
          <button tabIndex={3} onClick={onClose} style={btnStyle}>{s.cancel}</button>
        </div>
      </Window>
    </div>
  );
}

export function FindReplaceDialog({ findTerm, replaceTerm, onFindChange, onReplaceChange,
  onFindNext, onReplace, onReplaceAll, onClose, focused, parentRef }: {
  findTerm: string;
  replaceTerm: string;
  onFindChange: (v: string) => void;
  onReplaceChange: (v: string) => void;
  onFindNext: () => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  focused?: boolean;
  parentRef?: { current: HTMLDivElement | null };
}) {
  const s = t();
  const inputRef = useRef<HTMLInputElement>(null);
  const [initPos] = useState<{ x: number; y: number }>(() => {
    const p = parentRef?.current?.getBoundingClientRect();
    const cx = p ? p.left + p.width / 2 : window.innerWidth / 2;
    const cy = p ? p.top + 60 : 80;
    return { x: Math.max(0, cx - 175), y: cy };
  });

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onFindNext(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const labelW = { width: '90px', whiteSpace: 'nowrap' as const, textAlign: 'right' as const };

  return (
    <div style={{ position: 'fixed', left: '0', top: '0', zIndex: 10000 }}>
      <Window
        title={s.replaceTitle}
        style={WS_CAPTION | WS_SYSMENU}
        clientW={400}
        clientH={100}
        focused={focused}
        onClose={onClose}
        draggable
        initialPos={initPos}
      >
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px', ...fontStyle }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={labelW}>{s.findWhat}</label>
            <input
              ref={inputRef}
              tabIndex={1}
              type="text"
              value={findTerm}
              onInput={(e) => onFindChange((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              style={inputStyle}
            />
            <button tabIndex={3} onClick={onFindNext} disabled={!findTerm} style={btnStyle}>{s.findNext}</button>
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <label style={labelW}>{s.replaceWith}</label>
            <input
              tabIndex={2}
              type="text"
              value={replaceTerm}
              onInput={(e) => onReplaceChange((e.target as HTMLInputElement).value)}
              onKeyDown={handleKeyDown}
              style={inputStyle}
            />
            <button tabIndex={4} onClick={onReplace} disabled={!findTerm} style={btnStyle}>{s.replaceBtn}</button>
          </div>
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button tabIndex={5} onClick={onReplaceAll} disabled={!findTerm} style={btnStyle}>{s.replaceAll}</button>
            <button tabIndex={6} onClick={onClose} style={btnStyle}>{s.cancel}</button>
          </div>
        </div>
      </Window>
    </div>
  );
}
