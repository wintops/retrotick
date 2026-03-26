import { useState, useEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

/**
 * Interactive ComboBox (CBS_DROPDOWNLIST style).
 * Renders a sunken text area + raised dropdown button + custom dropdown list.
 *
 * Two usage modes:
 * - Interactive: pass items/selectedIndex/onSelect for full dropdown behavior
 * - Display-only: pass just text/fontCSS for static rendering (DialogDisplay, etc.)
 *
 * For custom rendering (e.g. items with icons), pass renderItem/renderSelected.
 */

interface ComboBoxProps {
  // Interactive mode
  items?: string[];
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  onOpen?: () => void;
  font?: string;
  disabled?: boolean;
  /** Custom renderer for dropdown list items. Receives (index, text). */
  renderItem?: (index: number, text: string) => ComponentChildren;
  /** Custom renderer for the selected value display. Receives (index, text). */
  renderSelected?: (index: number, text: string) => ComponentChildren;
  // Display-only mode (backward compat with DialogDisplay/DelphiFormDisplay)
  text?: string;
  fontCSS?: string;
  fontColor?: string | null;
}

export function ComboBox({ items, selectedIndex = -1, onSelect, onOpen, font, disabled, text, fontCSS, fontColor, renderItem, renderSelected }: ComboBoxProps) {
  // Display-only mode: no items, just show text
  if (!items || items.length === 0) {
    const displayFont = font || fontCSS || '11px/1 "Tahoma", "MS Sans Serif", sans-serif';
    return (
      <div style={{ display: 'flex', width: '100%', height: '100%' }}>
        <div style={{
          flex: 1, background: '#FFF', boxSizing: 'border-box',
          border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
          boxShadow: 'inset 1px 1px 0 #404040',
          padding: '1px 2px', font: displayFont,
          ...(fontColor ? { color: fontColor } : {}),
          overflow: 'hidden', whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center',
        }}>
          {text || ''}
        </div>
        <div style={{
          width: 16, background: '#D4D0C8', flexShrink: 0, boxSizing: 'border-box',
          border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
          boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '8px', color: '#000',
        }}>
          {'\u25BC'}
        </div>
      </div>
    );
  }

  // Interactive mode
  const [open, setOpen] = useState(false);
  const [hoverIdx, setHoverIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handler, true);
    return () => document.removeEventListener('pointerdown', handler, true);
  }, [open]);

  // Scroll selected item into view when dropdown opens
  useEffect(() => {
    if (open && listRef.current && selectedIndex >= 0) {
      const child = listRef.current.children[selectedIndex] as HTMLElement | undefined;
      if (child) child.scrollIntoView({ block: 'nearest' });
    }
  }, [open, selectedIndex]);

  const fontStyle = font || fontCSS || '11px/1 "Tahoma", "MS Sans Serif", sans-serif';
  const selectedText = selectedIndex >= 0 && selectedIndex < items.length
    ? items[selectedIndex] : '';

  const toggleOpen = () => {
    if (disabled) return;
    const wasOpen = open;
    setOpen(v => !v);
    setHoverIdx(-1);
    if (!wasOpen && onOpen) onOpen();
  };

  const selectItem = (idx: number) => {
    setOpen(false);
    if (idx !== selectedIndex && onSelect) {
      onSelect(idx);
    }
  };

  const arrowColor = disabled ? '#808080' : '#000';

  return (
    <div ref={containerRef} style={{
      position: 'relative', width: '100%', height: '100%',
    }}>
      {/* Outer sunken container — the whole combobox shares one border */}
      <div
        style={{
          display: 'flex', width: '100%', height: '100%',
          boxSizing: 'border-box',
          border: '1px solid',
          borderColor: '#808080 #FFF #FFF #808080',
          boxShadow: 'inset 1px 1px 0 #404040',
          background: disabled ? '#C0C0C0' : '#FFF',
          cursor: 'default', userSelect: 'none',
        }}
        onClick={toggleOpen}
      >
        {/* Text area — no border, sits inside the sunken container */}
        <div style={{
          flex: 1, minWidth: 0,
          padding: '0 2px',
          font: fontStyle,
          ...(fontColor ? { color: fontColor } : {}),
          overflow: 'hidden', whiteSpace: 'nowrap',
          display: 'flex', alignItems: 'center',
        }}>
          {renderSelected && selectedIndex >= 0 ? renderSelected(selectedIndex, selectedText) : selectedText}
        </div>
        {/* Dropdown button — raised 3D, inside the sunken container */}
        <div style={{
          width: 18, flexShrink: 0, boxSizing: 'border-box',
          background: '#D4D0C8',
          border: '1px solid',
          borderColor: open
            ? '#808080 #FFF #FFF #808080'
            : '#FFF #808080 #808080 #FFF',
          boxShadow: open
            ? 'inset 1px 1px 0 #404040'
            : 'inset -1px -1px 0 #404040',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '1px',
        }}>
          {/* CSS triangle */}
          <div style={{
            width: 0, height: 0,
            borderLeft: '3px solid transparent',
            borderRight: '3px solid transparent',
            borderTop: `4px solid ${arrowColor}`,
            marginTop: open ? 1 : 0,
          }} />
        </div>
      </div>

      {open && items.length > 0 && (
        <div
          ref={listRef}
          style={{
            position: 'absolute', top: '100%', left: 0,
            width: '100%', maxHeight: 160,
            overflowY: items.length > 10 ? 'scroll' : 'auto',
            border: '1px solid #000',
            background: '#FFF',
            zIndex: 10000,
            boxSizing: 'border-box',
          }}
        >
          {items.map((itemText, i) => {
            const isSelected = i === selectedIndex;
            const isHover = i === hoverIdx;
            const highlight = isSelected || isHover;
            return (
              <div
                key={i}
                onPointerDown={(e: PointerEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  selectItem(i);
                }}
                onPointerEnter={() => setHoverIdx(i)}
                onPointerLeave={() => setHoverIdx(-1)}
                style={{
                  padding: '1px 3px', font: fontStyle,
                  background: highlight ? '#000080' : '#FFF',
                  color: highlight ? '#FFF' : '#000',
                  cursor: 'default', userSelect: 'none',
                }}
              >
                {renderItem ? renderItem(i, itemText) : itemText}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
