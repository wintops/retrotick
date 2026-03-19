import { useState, useRef, useEffect } from 'preact/hooks';

const INTERNAL_MIME = 'application/x-exeviewer-path';

interface Props {
  name: string;
  storePath: string;  // full IndexedDB key (e.g. "myfolder/test.exe")
  iconUrl: string | null;
  isFolder?: boolean;
  isExe?: boolean;
  selected: boolean;
  editing?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onRename?: (newName: string) => void;
  onDropOnIcon?: (storePath: string) => void;  // internal item dropped onto this folder icon
  onDropExternalOnIcon?: (e: DragEvent) => void;  // OS file dropped onto this folder icon
}

const GENERIC_ICON = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 0h18l8 8v23a1 1 0 01-1 1H3a1 1 0 01-1-1V1a1 1 0 011-1z" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <path d="M21 0v7a1 1 0 001 1h7" fill="#e0e0e0" stroke="#808080" stroke-width="1"/>
  </svg>
);

const EXE_ICON = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="2" width="32" height="28" rx="1" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <rect x="1" y="3" width="30" height="4" fill="#000080"/>
    <rect x="24" y="3" width="4" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="28" y="3" width="3" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="3" y="4" width="10" height="2" fill="#ffffff"/>
    <rect x="2" y="9" width="28" height="19" fill="#ffffff" stroke="#808080" stroke-width="0.5"/>
  </svg>
);

const FOLDER_ICON = (
  <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 7h14l2-4h16v3H16l-2 4H0z" fill="#C4A000"/>
    <rect x="0" y="9" width="32" height="21" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
    <rect x="0" y="7" width="14" height="3" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
  </svg>
);

const FOLDER_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 7h14l2-4h16v3H16l-2 4H0z" fill="#C4A000"/>
    <rect x="0" y="9" width="32" height="21" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
    <rect x="0" y="7" width="14" height="3" rx="1" fill="#EDD400" stroke="#C4A000" stroke-width="1"/>
  </svg>
);

const EXE_ICON_16 = (
  <svg width="16" height="16" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="2" width="32" height="28" rx="1" fill="#c0c0c0" stroke="#808080" stroke-width="1"/>
    <rect x="1" y="3" width="30" height="4" fill="#000080"/>
    <rect x="24" y="3" width="4" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="28" y="3" width="3" height="4" fill="#c0c0c0" stroke="#808080" stroke-width="0.5"/>
    <rect x="3" y="4" width="10" height="2" fill="#ffffff"/>
    <rect x="2" y="9" width="28" height="19" fill="#ffffff" stroke="#808080" stroke-width="0.5"/>
  </svg>
);

export { INTERNAL_MIME, FOLDER_ICON_16, EXE_ICON_16 };

export function DesktopIcon({ name, storePath, iconUrl, isFolder, isExe, selected, editing, onSelect, onOpen, onContextMenu, onRename, onDropOnIcon, onDropExternalOnIcon }: Props) {
  const [lastClick, setLastClick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [editValue, setEditValue] = useState(name);
  const [folderDragOver, setFolderDragOver] = useState(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      setEditValue(name);
      inputRef.current.focus();
      const dotIdx = name.lastIndexOf('.');
      inputRef.current.setSelectionRange(0, dotIdx > 0 && !isFolder ? dotIdx : name.length);
    }
  }, [editing]);

  function commitRename() {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name && onRename) {
      onRename(trimmed);
    } else if (onRename) {
      onRename(name);
    }
  }

  function handleClick(e: MouseEvent) {
    e.stopPropagation();
    if (editing) return;
    const now = Date.now();
    if (now - lastClick < 400) {
      onOpen();
    } else {
      onSelect();
    }
    setLastClick(now);
  }

  function handleDragStart(e: DragEvent) {
    if (editing) { e.preventDefault(); return; }
    e.dataTransfer!.setData(INTERNAL_MIME, storePath);
    e.dataTransfer!.effectAllowed = 'move';
  }

  function handleDragOver(e: DragEvent) {
    if (!isFolder) return;
    // Accept internal drags and external file drops
    const hasInternal = e.dataTransfer!.types.includes(INTERNAL_MIME);
    const hasFiles = e.dataTransfer!.types.includes('Files');
    if (!hasInternal && !hasFiles) return;
    // Don't allow dropping a folder onto itself
    e.preventDefault();
    e.stopPropagation();
    setFolderDragOver(true);
  }

  function handleDrop(e: DragEvent) {
    if (!isFolder) return;
    e.preventDefault();
    e.stopPropagation();
    setFolderDragOver(false);

    const internalPath = e.dataTransfer!.getData(INTERNAL_MIME);
    if (internalPath) {
      // Don't drop onto self or into own subtree
      if (internalPath === storePath) return;
      if (storePath.startsWith(internalPath)) return;
      onDropOnIcon?.(internalPath);
    } else {
      onDropExternalOnIcon?.(e);
    }
  }

  return (
    <div
      data-desktop-icon
      class="flex flex-col items-center w-[75px] p-1 cursor-default select-none"
      draggable={!editing}
      onClick={handleClick}
      onDragStart={handleDragStart}
      onContextMenu={(e: Event) => { e.preventDefault(); onSelect(); onContextMenu(e as MouseEvent); }}
      onDragOver={handleDragOver}
      onDragLeave={() => setFolderDragOver(false)}
      onDrop={handleDrop}
    >
      <div class="w-[32px] h-[32px] flex items-center justify-center mb-1"
        style={(selected || folderDragOver) ? { filter: 'brightness(0.7) saturate(0.3) contrast(0.8)' } : undefined}
      >
        {isFolder ? FOLDER_ICON : iconUrl ? <img src={iconUrl} width={32} height={32} draggable={false} style={{ imageRendering: 'pixelated' }} /> : (isExe && /\.(exe|com)$/i.test(name)) ? EXE_ICON : GENERIC_ICON}
      </div>
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onInput={(e: Event) => setEditValue((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') onRename?.(name);
          }}
          onBlur={() => commitRename()}
          onClick={(e: Event) => e.stopPropagation()}
          class="text-[11px] text-center w-full bg-white text-black border border-[#000080] outline-none px-0.5"
          style={{ maxWidth: '73px' }}
        />
      ) : (
        <span
          class="text-[11px] leading-tight text-center break-all"
          style={{
            color: '#000',
            textShadow: 'none',
            ...(selected ? { background: '#C0C0C0', outline: '1px dotted #000', outlineOffset: '0px', margin: '0 -1px', padding: '0 1px' } : {}),
          }}
        >
          {name}
        </span>
      )}
    </div>
  );
}
