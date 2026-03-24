import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { parsePE, parseCOM, extractIcons } from '../lib/pe';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { getRootItems, addFile, addFolder, deleteFile, deleteFolder, moveFile, renameEntry, isFolder, displayName, type StoredFile, getAllFiles, readDroppedItems } from '../lib/file-store';
import type { Emulator } from '../lib/emu/emulator';
import { DesktopIcon, INTERNAL_MIME } from './DesktopIcon';
import { MenuDropdown } from './win2k/MenuBar';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { Button } from './win2k/Button';
import { t } from '../lib/regional-settings';

interface Props {
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles: Map<string, ArrayBuffer> | undefined, exeName: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onViewResources: (arrayBuffer: ArrayBuffer, fileName?: string) => void;
  onOpenFolder: (path: string) => void;
}

interface DesktopFile {
  name: string;
  iconUrl: string | null;
  isExe: boolean;
  isFolder: boolean;
}

function extractFirstIconUrl(data: ArrayBuffer): string | null {
  try {
    const peInfo = parsePE(data);
    const icons = extractIcons(peInfo, data);
    if (icons.length > 0) return URL.createObjectURL(icons[0].blob);
  } catch {}
  return null;
}

function isExeFile(data: ArrayBuffer, name?: string): { ok: boolean; peInfo?: PEInfo } {
  if (name?.toLowerCase().endsWith('.com')) {
    return { ok: true, peInfo: parseCOM(data) };
  }
  try {
    const peInfo = parsePE(data);
    if (peInfo.isMZ) return { ok: true, peInfo };
    if (peInfo.isNE) return { ok: true, peInfo };
    const isDll = (peInfo.coffHeader.characteristics & 0x2000) !== 0;
    const isI386 = peInfo.coffHeader.machine === 0x014C;
    if (isDll && name?.toLowerCase().endsWith('.cpl') && isI386) return { ok: true, peInfo };
    return { ok: !isDll && isI386, peInfo };
  } catch {
    return { ok: false };
  }
}

export function Desktop({ onRunExe, onViewResources, onOpenFolder }: Props) {
  const [files, setFiles] = useState<DesktopFile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; name: string; isExe: boolean; isScr: boolean; isFolder: boolean } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const iconUrls = useRef<string[]>([]);

  const loadFiles = useCallback(async () => {
    for (const u of iconUrls.current) URL.revokeObjectURL(u);
    iconUrls.current = [];

    const stored = await getRootItems();
    const desktopFiles: DesktopFile[] = stored.map(f => {
      const isFolderEntry = isFolder(f.name);
      let url: string | null = null;
      let isExe = false;
      if (!isFolderEntry) {
        url = extractFirstIconUrl(f.data);
        if (url) iconUrls.current.push(url);
        isExe = isExeFile(f.data, f.name).ok;
      }
      return { name: f.name, iconUrl: url, isExe, isFolder: isFolderEntry };
    });
    desktopFiles.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return 0;
    });
    setFiles(desktopFiles);
  }, []);

  useEffect(() => {
    loadFiles().then(() => {
      const params = new URLSearchParams(window.location.search);
      const autoOpen = params.get('open');
      if (autoOpen) {
        // Remove the param so it doesn't re-trigger on HMR
        window.history.replaceState({}, '', window.location.pathname);
        handleOpen(autoOpen, false);
      }
    });
    const onRefresh = () => { loadFiles(); };
    window.addEventListener('desktop-files-changed', onRefresh);
    return () => window.removeEventListener('desktop-files-changed', onRefresh);
  }, [loadFiles]);

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);

    // Internal drag: move item to desktop root
    const internalPath = e.dataTransfer?.getData(INTERNAL_MIME);
    if (internalPath) {
      const dName = displayName(internalPath);
      const isDir = isFolder(internalPath);
      const newName = isDir ? dName + '/' : dName;
      if (internalPath !== newName) {
        await renameEntry(internalPath, newName);
        await loadFiles();
        window.dispatchEvent(new Event('desktop-files-changed'));
      }
      return;
    }

    // External file/folder drop
    if (!e.dataTransfer) return;
    const items = await readDroppedItems(e.dataTransfer);
    for (const item of items) {
      await addFile(item.path, item.data);
    }
    await loadFiles();
  }

  async function handleInternalDropOnFolder(folderName: string, draggedPath: string) {
    // Don't drop folder into itself
    if (draggedPath === folderName) return;
    const folderPrefix = folderName.endsWith('/') ? folderName : folderName + '/';
    if (draggedPath.startsWith(folderPrefix)) return; // already inside

    const dName = displayName(draggedPath);
    const isDir = isFolder(draggedPath);
    const newName = folderPrefix + dName + (isDir ? '/' : '');
    await renameEntry(draggedPath, newName);
    await loadFiles();
    window.dispatchEvent(new Event('desktop-files-changed'));
  }

  async function handleExternalDropOnFolder(folderName: string, e: DragEvent) {
    if (!e.dataTransfer) return;
    const folderPrefix = folderName.endsWith('/') ? folderName : folderName + '/';
    const items = await readDroppedItems(e.dataTransfer, folderPrefix);
    for (const item of items) {
      await addFile(item.path, item.data);
    }
    await loadFiles();
  }

  async function runExeWithArgs(name: string, commandLine?: string) {
    const stored = await getAllFiles();
    const f = stored.find(s => s.name === name);
    if (!f) return;
    const result = isExeFile(f.data, name);
    if (result.ok && result.peInfo) {
      const additional = new Map<string, ArrayBuffer>();
      for (const s of stored) {
        if (s.name !== name) additional.set(s.name, s.data);
      }
      onRunExe(f.data, result.peInfo, additional, name, commandLine);
    } else {
      // Try to open with a default app based on file extension
      const opened = await openWithDefaultApp(name, stored);
      if (!opened) onViewResources(f.data, name);
    }
  }

  async function openWithDefaultApp(name: string, stored: { name: string; data: ArrayBuffer }[]): Promise<boolean> {
    const ext = name.toLowerCase().split('.').pop();
    const NOTEPAD_EXTS = new Set(['txt', 'ini', 'log', 'nfo', 'diz', '1st']);
    if (!ext || !NOTEPAD_EXTS.has(ext)) return false;
    // Find notepad.exe in stored files
    const notepad = stored.find(s => s.name.toLowerCase().replace(/^.*\//, '') === 'notepad.exe');
    if (!notepad) return false;
    const result = isExeFile(notepad.data, notepad.name);
    if (!result.ok || !result.peInfo) return false;
    const additional = new Map<string, ArrayBuffer>();
    for (const s of stored) {
      if (s.name !== notepad.name) additional.set(s.name, s.data);
    }
    // Pass file path as command line (D:\filename for root files)
    const filePath = 'D:\\' + name.replace(/\//g, '\\');
    onRunExe(notepad.data, result.peInfo, additional, notepad.name, filePath);
    return true;
  }

  async function handleOpen(name: string, fileIsFolder: boolean) {
    if (fileIsFolder) {
      onOpenFolder(name);
      return;
    }
    const isScr = name.toLowerCase().endsWith('.scr');
    await runExeWithArgs(name, isScr ? '/s' : undefined);
  }

  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmFlash, setConfirmFlash] = useState(0);

  async function handleDelete(name: string) {
    if (isFolder(name)) {
      await deleteFolder(name);
    } else {
      await deleteFile(name);
    }
    setConfirmDelete(null);
    setContextMenu(null);
    await loadFiles();
  }

  async function handleViewResources(name: string) {
    setContextMenu(null);
    const stored = await getAllFiles();
    const f = stored.find(s => s.name === name);
    if (f) onViewResources(f.data, name);
  }

  async function handleNewFolder() {
    setBgContextMenu(null);
    let name = t().newFolder;
    let suffix = 0;
    const existingNames = new Set(files.map(f => displayName(f.name)));
    while (existingNames.has(name)) { suffix++; name = `${t().newFolder} (${suffix})`; }
    const fullPath = name + '/';
    await addFolder(fullPath);
    await loadFiles();
    setEditingName(fullPath);
    setSelected(fullPath);
  }

  async function handleRename(oldName: string, newDisplayName: string) {
    setEditingName(null);
    const oldDisplay = displayName(oldName);
    if (newDisplayName === oldDisplay) return;
    const newName = newDisplayName + (isFolder(oldName) ? '/' : '');
    await renameEntry(oldName, newName);
    await loadFiles();
  }

  return (
    <div
      class="w-full select-none"
      style={{ minHeight: '100%' }}
      onClick={() => { if (confirmDelete) return; setSelected(null); setEditingName(null); setContextMenu(null); setBgContextMenu(null); }}
      onContextMenu={(e: MouseEvent) => {
        if (confirmDelete) { e.preventDefault(); return; }
        if (!(e.target as HTMLElement).closest('[data-desktop-icon]')) {
          e.preventDefault();
          setContextMenu(null);
          setBgContextMenu({ x: e.clientX, y: e.clientY });
        }
      }}
      onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Drop overlay — only show for external file drops, not internal drags */}
      {dragOver && (
        <div class="absolute inset-0 z-50 pointer-events-none"
          style={{ background: 'rgba(0,0,0,0.15)' }}>
        </div>
      )}

      {/* Icons grid */}
      <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
        {files.map(f => (
          <DesktopIcon
            key={f.name}
            name={displayName(f.name)}
            storePath={f.name}
            iconUrl={f.iconUrl}
            isFolder={f.isFolder}
            isExe={f.isExe}
            selected={selected === f.name}
            editing={editingName === f.name}
            onSelect={() => setSelected(f.name)}
            onOpen={() => handleOpen(f.name, f.isFolder)}
            onRename={(newName) => handleRename(f.name, newName)}
            onContextMenu={(e: MouseEvent) => { setBgContextMenu(null); setContextMenu({ x: e.clientX, y: e.clientY, name: f.name, isExe: f.isExe, isScr: f.name.toLowerCase().endsWith('.scr'), isFolder: f.isFolder }); }}
            onDropOnIcon={(draggedPath) => handleInternalDropOnFolder(f.name, draggedPath)}
            onDropExternalOnIcon={(e) => handleExternalDropOnFolder(f.name, e)}
          />
        ))}
        <div style={{ position: 'absolute', bottom: '4px', right: '8px', zIndex: 1, font: '11px Tahoma, sans-serif', textAlign: 'right', lineHeight: '1.6' }}>
          <div style={{ pointerEvents: 'none', color: 'rgba(255,255,255,0.25)' }}>
            {t().dropHint}<br />
            {t().rightClickHint}
          </div>
          <a
            href="https://github.com/lqs/retrotick"
            target="_blank"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: '22px',
              padding: '0 8px',
              marginTop: '4px',
              background: '#D4D0C8',
              border: '1px solid',
              borderColor: '#FFF #404040 #404040 #FFF',
              boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
              color: '#000',
              textDecoration: 'none',
              font: 'bold 11px/1 "Tahoma", "MS Sans Serif", sans-serif',
              whiteSpace: 'nowrap',
            }}
          >
            Star on GitHub
          </a>
        </div>
      </div>

      {/* Background context menu */}
      {bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1;
        const CMD_REFRESH = 2;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const items: MenuItem[] = [
          mi(CMD_NEW_FOLDER, t().newFolder),
          { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null },
          mi(CMD_REFRESH, t().refresh),
        ];
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={items}
              x={bgContextMenu.x} y={bgContextMenu.y}
              onCommand={(id) => {
                setBgContextMenu(null);
                if (id === CMD_NEW_FOLDER) handleNewFolder();
                else if (id === CMD_REFRESH) { setFiles([]); setTimeout(loadFiles, 60); }
              }}
              onClose={() => setBgContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* File context menu */}
      {contextMenu && (() => {
        const CMD_OPEN = 1, CMD_CONFIGURE = 2, CMD_VIEW = 3, CMD_DELETE = 4, CMD_RENAME = 5;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const items: MenuItem[] = [];
        if (contextMenu.isFolder) {
          items.push(mi(CMD_OPEN, t().open, { isDefault: true }));
          items.push(mi(CMD_RENAME, t().rename));
          items.push({ id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null });
          items.push(mi(CMD_DELETE, t().delete_));
        } else {
          if (contextMenu.isExe) items.push(mi(CMD_OPEN, t().open, { isDefault: true }));
          if (contextMenu.isScr && contextMenu.isExe) items.push(mi(CMD_CONFIGURE, t().configure));
          items.push(mi(CMD_VIEW, t().viewResources, { isDefault: !contextMenu.isExe }));
          items.push(mi(CMD_RENAME, t().rename));
          items.push({ id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null });
          items.push(mi(CMD_DELETE, t().delete_));
        }
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={items}
              x={contextMenu.x} y={contextMenu.y}
              onCommand={(id) => {
                setContextMenu(null);
                if (id === CMD_OPEN) handleOpen(contextMenu.name, contextMenu.isFolder);
                else if (id === CMD_CONFIGURE) runExeWithArgs(contextMenu.name, '/c');
                else if (id === CMD_VIEW) handleViewResources(contextMenu.name);
                else if (id === CMD_RENAME) { setEditingName(contextMenu.name); setSelected(contextMenu.name); }
                else if (id === CMD_DELETE) { setConfirmDelete(contextMenu.name); setContextMenu(null); }
              }}
              onClose={() => setContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }} onPointerDown={(e) => { e.preventDefault(); setConfirmFlash(c => c + 1); }} onContextMenu={(e: Event) => e.preventDefault()}>
          <div onPointerDown={(e) => e.stopPropagation()} style={{ font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif', minWidth: '280px', maxWidth: '400px' }}>
            <Window title={isFolder(confirmDelete) ? t().confirmFolderDelete : t().confirmFileDelete} style={WS_CAPTION | WS_SYSMENU} focused={true} draggable flashTrigger={confirmFlash} onClose={() => setConfirmDelete(null)}>
              <div style={{ padding: '12px 12px 8px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
                  <circle cx="16" cy="16" r="14" fill="#FFFF00" stroke="#000" stroke-width="1"/>
                  <rect x="14" y="7" width="4" height="12" fill="#000"/>
                  <rect x="14" y="22" width="4" height="4" fill="#000"/>
                </svg>
                <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {isFolder(confirmDelete)
                    ? t().confirmDeleteFolder.replace('{0}', displayName(confirmDelete))
                    : t().confirmDeleteFile.replace('{0}', confirmDelete)}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', padding: '4px 12px 8px' }}>
                <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={() => handleDelete(confirmDelete)}>
                  <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif' isDefault>{t().yes}</Button>
                </div>
                <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={() => setConfirmDelete(null)}>
                  <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif'>{t().no}</Button>
                </div>
              </div>
            </Window>
          </div>
        </div>
      )}
    </div>
  );
}
