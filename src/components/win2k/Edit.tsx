import { useRef, useEffect } from 'preact/hooks';

interface EditProps {
  text?: string;
  fontCSS: string;
  fontColor?: string | null;
  multiline?: boolean;
  password?: boolean;
  readonly?: boolean;
  sunken?: boolean;
  thinBorder?: boolean;
  bgColor?: string | null;
  onTextChange?: (text: string) => void;
  onRef?: (el: HTMLTextAreaElement | HTMLInputElement | null) => void;
}

export function Edit({ text, fontCSS, fontColor, multiline, password, readonly, sunken, thinBorder, bgColor, onTextChange, onRef }: EditProps) {
  const bg = bgColor || (readonly ? '#D4D0C8' : '#FFF');
  const borderStyle = sunken
    ? { border: '1px solid', borderColor: '#808080 #FFF #FFF #808080', boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8' }
    : thinBorder
    ? { border: '1px solid #808080' }
    : { border: 'none' };

  const commonStyle = {
    appearance: 'none' as const, display: 'block' as const,
    width: '100%', height: '100%', background: bg, boxSizing: 'border-box' as const,
    ...borderStyle,
    font: fontCSS,
    ...(fontColor ? { color: fontColor } : {}),
    padding: '4px 2px', resize: 'none' as const, outline: 'none',
  };

  const editable = !readonly && !!onTextChange;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ref = multiline ? textareaRef : inputRef;
  const userEditing = useRef(false);

  // Sync emulator text to DOM only when user is not actively editing
  useEffect(() => {
    if (ref.current && !userEditing.current) {
      ref.current.value = text || '';
    }
  }, [text]);

  // Auto-focus editable Edit controls on mount and select all text
  useEffect(() => {
    if (editable && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, []);

  // Expose DOM element to parent via onRef callback
  useEffect(() => {
    if (onRef) onRef(ref.current);
    return () => { if (onRef) onRef(null); };
  }, []);

  const onInput = editable ? (e: Event) => {
    onTextChange((e.target as HTMLTextAreaElement | HTMLInputElement).value);
  } : undefined;

  const onFocus = editable ? () => { userEditing.current = true; } : undefined;
  const onBlur = editable ? () => { userEditing.current = false; } : undefined;

  if (multiline) {
    return <textarea ref={textareaRef} readOnly={!editable} onInput={onInput}
      onFocus={onFocus} onBlur={onBlur} style={commonStyle} />;
  }

  return (
    <input ref={inputRef}
      type={password ? 'password' : 'text'}
      readOnly={!editable}
      onInput={onInput}
      onFocus={onFocus} onBlur={onBlur}
      style={commonStyle}
    />
  );
}
