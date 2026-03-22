import { useState, useRef, useEffect } from 'preact/hooks';
import { disabledTextStyle } from './styles';
import type { MenuResult, MenuItem } from '../../lib/pe/types';
import { formatMnemonic } from '../../lib/format';

export function MenuDropdown({ items, onCommand, onClose, isSubmenu, x, y }: {
  items: MenuItem[];
  onCommand: (id: number) => void;
  onClose: () => void;
  isSubmenu?: boolean;
  x?: number;
  y?: number;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) setFlipX(true);
    if (rect.bottom > window.innerHeight) setFlipY(true);
  }, []);

  const hasAbsPos = x !== undefined && y !== undefined;
  const posStyle = hasAbsPos
    ? { left: flipX ? undefined : x, right: flipX ? (window.innerWidth - x) : undefined, top: flipY ? undefined : y, bottom: flipY ? (window.innerHeight - y) : undefined }
    : isSubmenu
      ? { ...(flipX ? { right: '100%' } : { left: '100%' }), ...(flipY ? { bottom: 0 } : { top: 0 }) }
      : { left: 0, ...(flipY ? { bottom: '100%' } : { top: '100%' }) };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
      style={{
        position: hasAbsPos ? 'fixed' : 'absolute',
        ...posStyle,
        zIndex: 10000,
        background: '#D4D0C8', minWidth: '160px',
        border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
        boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080, 2px 2px 4px rgba(0,0,0,0.25)',
        padding: '2px', font: '12px/1 "Tahoma",sans-serif', color: '#000', touchAction: 'none',
      }}
    >
      {items.map((child, j) => {
        const highlighted = !child.isGrayed && (hoverIdx === j || openSub === j);
        return child.isSeparator ? (
          <div key={j} style={{
            height: 0, margin: '3px 2px',
            borderTop: '1px solid #808080', borderBottom: '1px solid #FFF',
          }} />
        ) : (
          <div
            key={j}
            style={{
              display: 'flex', alignItems: 'center',
              padding: '5px 6px 5px 22px', cursor: 'var(--win2k-cursor)', whiteSpace: 'nowrap',
              position: 'relative',
              background: highlighted ? '#0A246A' : undefined,
              ...(child.isGrayed ? disabledTextStyle : highlighted ? { color: '#FFF' } : {}),
              fontWeight: child.isDefault ? 'bold' : undefined,
            }}
            onPointerEnter={() => {
              setHoverIdx(j);
              setOpenSub(child.children ? j : null);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              setHoverIdx(j);
              if (child.children) {
                setOpenSub(j);
              } else if (!child.isGrayed) {
                onCommand(child.id);
                onClose();
              }
            }}
            onPointerLeave={() => {
              if (openSub !== j) setHoverIdx(null);
            }}
          >
            {child.isChecked && (
              <span style={{ position: 'absolute', left: '6px', width: '14px', textAlign: 'center' }}>{'\u2713'}</span>
            )}
            <span style={{ flex: 1 }}>{formatMnemonic(child.text.split('\t')[0])}</span>
            {child.text.includes('\t') && (
              <span style={{ marginLeft: '16px', opacity: 0.7 }}>{child.text.split('\t')[1]}</span>
            )}
            {child.children && (
              <span style={{ marginLeft: '8px', fontSize: '8px', flexShrink: 0 }}>{'\u25BA'}</span>
            )}
            {openSub === j && child.children && (
              <MenuDropdown items={child.children} onCommand={onCommand} onClose={onClose} isSubmenu />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function MenuBar({ menus, onCommand, onFocus }: { menus: MenuResult[]; onCommand: (id: number) => void; onFocus?: () => void }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  useEffect(() => {
    if (openIdx === null) return;
    const close = () => setOpenIdx(null);
    const timer = setTimeout(() => document.addEventListener('pointerdown', close), 0);
    return () => { clearTimeout(timer); document.removeEventListener('pointerdown', close); };
  }, [openIdx]);

  if (menus.length === 0) return null;
  const menu = menus[0].menu;

  return (
    <div
      onPointerDown={(e) => { onFocus?.(); e.stopPropagation(); e.preventDefault(); }}
      style={{
        display: 'flex', flexWrap: 'wrap', background: '#D4D0C8', padding: '1px',
        userSelect: 'none', touchAction: 'none',
        font: '12px/1 "Tahoma",sans-serif', color: '#000',
      }}
    >
      {menu.items.map((item, i) => (
        <div key={i} style={{ position: 'relative' }}>
          <div
            style={{
              padding: '4px 6px', cursor: 'var(--win2k-cursor)', whiteSpace: 'nowrap',
              ...(openIdx === i ? { background: '#0A246A', color: '#FFF' } : {}),
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (item.children) {
                setOpenIdx(openIdx === i ? null : i);
              }
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              if (!item.children) {
                onCommand(item.id);
                setOpenIdx(null);
              }
            }}
            onPointerEnter={() => { if (openIdx !== null) setOpenIdx(i); }}
          >
            {formatMnemonic(item.text)}
          </div>
          {openIdx === i && item.children && (
            <MenuDropdown
              items={item.children}
              onCommand={onCommand}
              onClose={() => setOpenIdx(null)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
