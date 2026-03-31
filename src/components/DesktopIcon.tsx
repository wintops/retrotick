import { useState, useRef, useEffect } from 'preact/hooks';
import { fileIcon32, FOLDER_ICON_16, EXE_ICON_16 } from './win2k/file-icons';

const INTERNAL_MIME = 'application/x-exeviewer-path';

interface Props {
  name: string;
  storePath: string;  // full IndexedDB key (e.g. "myfolder/test.exe")
  iconUrl: string | null;
  isFolder?: boolean;
  isExe?: boolean;
  selected: boolean;
  editing?: boolean;
  /** Use dark text (black, no shadow) for light backgrounds like folder windows */
  darkText?: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onContextMenu: (e: MouseEvent) => void;
  onRename?: (newName: string) => void;
  onDropOnIcon?: (storePath: string) => void;  // internal item dropped onto this folder icon
  onDropExternalOnIcon?: (e: DragEvent) => void;  // OS file dropped onto this folder icon
}

export { INTERNAL_MIME, FOLDER_ICON_16, EXE_ICON_16 };

export function DesktopIcon({ name, storePath, iconUrl, isFolder, isExe, selected, editing, darkText, onSelect, onOpen, onContextMenu, onRename, onDropOnIcon, onDropExternalOnIcon }: Props) {
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
      data-store-path={storePath}
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
        {fileIcon32(name, { isFolder, iconUrl })}
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
            color: darkText ? '#000' : '#FFF',
            textShadow: darkText ? 'none' : '1px 1px 0 #000',
            ...(selected ? { background: '#0A246A', color: '#FFF', textShadow: 'none', outline: '1px dotted #FFF', outlineOffset: '0px', margin: '0 -1px', padding: '0 1px' } : {}),
          }}
        >
          {name}
        </span>
      )}
    </div>
  );
}
