import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { MenuDropdown } from './win2k/MenuBar';
import { DesktopIcon, INTERNAL_MIME, FOLDER_ICON_16 } from './DesktopIcon';
import {
  getItemsInFolder, addFolder, deleteFolder, deleteFile, renameEntry,
  isFolder, displayName, addFile, getAllFiles, readDroppedItems,
} from '../lib/file-store';
import { parsePE, parseCOM, extractIcons } from '../lib/pe';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { Button } from './win2k/Button';
import { t } from '../lib/regional-settings';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
const CLIENT_W = 500;
const CLIENT_H = 350;

interface FolderItem {
  name: string;
  displayName: string;
  isFolder: boolean;
  iconUrl: string | null;
  isExe: boolean;
}

interface FolderWindowProps {
  folderPath: string;
  onStop: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  onOpenFolder: (path: string) => void;
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles: Map<string, ArrayBuffer> | undefined, exeName: string) => void;
  onViewResources: (arrayBuffer: ArrayBuffer, fileName?: string) => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
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

export function FolderWindow({
  folderPath, onStop, onFocus, onMinimize, onOpenFolder,
  onRunExe, onViewResources, zIndex, focused, minimized,
}: FolderWindowProps) {
  const [items, setItems] = useState<FolderItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FolderItem } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmFlash, setConfirmFlash] = useState(0);
  const iconUrls = useRef<string[]>([]);

  const [windowPos, setWindowPos] = useState({ x: 80 + Math.random() * 60, y: 40 + Math.random() * 40 });
  const [clientSize, setClientSize] = useState({ w: CLIENT_W, h: CLIENT_H });
  const [maximized, setMaximized] = useState(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);

  const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const folderDisplayName = displayName(folderPath);

  const loadItems = useCallback(async () => {
    for (const u of iconUrls.current) URL.revokeObjectURL(u);
    iconUrls.current = [];

    const stored = await getItemsInFolder(prefix);
    const folderItems: FolderItem[] = stored.map(f => {
      const isFolderEntry = isFolder(f.name);
      let iconUrl: string | null = null;
      let isExe = false;
      if (!isFolderEntry) {
        iconUrl = extractFirstIconUrl(f.data);
        if (iconUrl) iconUrls.current.push(iconUrl);
        isExe = isExeFile(f.data, f.name).ok;
      }
      return { name: f.name, displayName: displayName(f.name), isFolder: isFolderEntry, iconUrl, isExe };
    });
    folderItems.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    setItems(folderItems);
  }, [prefix]);

  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => {
    const onRefresh = () => { loadItems(); };
    window.addEventListener('desktop-files-changed', onRefresh);
    return () => window.removeEventListener('desktop-files-changed', onRefresh);
  }, [loadItems]);

  // Window drag/resize
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const m = moveDrag.current;
      if (m) { setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY }); return; }
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH, px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      const minW = 200, minH = 100;
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setClientSize({ w, h });
      setWindowPos({ x: px, y: py });
    };
    const onPointerUp = () => { moveDrag.current = null; resizeDrag.current = null; };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => { document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); };
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    if (maximized) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos, maximized]);

  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: clientSize.w, startH: clientSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [clientSize, windowPos]);

  const handleMaximize = useCallback(() => {
    const TASKBAR_HEIGHT = 30;
    const CAPTION_H = 21;
    if (maximized) {
      const saved = preMaxState.current;
      if (saved) { setWindowPos({ x: saved.x, y: saved.y }); setClientSize({ w: saved.w, h: saved.h }); preMaxState.current = null; }
      setMaximized(false);
    } else {
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: clientSize.w, h: clientSize.h };
      setWindowPos({ x: 0, y: 0 });
      setClientSize({ w: window.innerWidth, h: window.innerHeight - TASKBAR_HEIGHT - CAPTION_H - 1 });
      setMaximized(true);
    }
  }, [maximized, windowPos, clientSize]);

  async function handleOpen(item: FolderItem) {
    if (item.isFolder) {
      onOpenFolder(item.name);
    } else {
      const allFiles = await getAllFiles();
      const f = allFiles.find(s => s.name === item.name);
      if (!f) return;
      const result = isExeFile(f.data, item.name);
      if (result.ok && result.peInfo) {
        const additional = new Map<string, ArrayBuffer>();
        for (const s of allFiles) if (s.name !== item.name) additional.set(s.name, s.data);
        const cleanPath = folderPath.replace(/\/+$/, '').replace(/\\+$/, '');
        const fullPath = cleanPath + '/' + displayName(item.name);
        onRunExe(f.data, result.peInfo, additional, fullPath);
      } else {
        onViewResources(f.data, displayName(item.name));
      }
    }
  }

  async function handleNewFolder() {
    setBgContextMenu(null);
    let name = t().newFolder;
    let suffix = 0;
    const existingNames = new Set(items.map(i => i.displayName));
    while (existingNames.has(name)) { suffix++; name = `${t().newFolder} (${suffix})`; }
    const fullPath = prefix + name + '/';
    await addFolder(fullPath);
    await loadItems();
    setEditingName(fullPath);
    setSelected(fullPath);
  }

  async function handleRename(oldName: string, newDisplayName: string) {
    setEditingName(null);
    const oldDisplay = displayName(oldName);
    if (newDisplayName === oldDisplay) return;
    const newName = prefix + newDisplayName + (isFolder(oldName) ? '/' : '');
    await renameEntry(oldName, newName);
    await loadItems();
    window.dispatchEvent(new Event('desktop-files-changed'));
  }

  async function handleDeleteItem(name: string) {
    if (isFolder(name)) {
      await deleteFolder(name);
    } else {
      await deleteFile(name);
    }
    setConfirmDelete(null);
    setContextMenu(null);
    await loadItems();
    window.dispatchEvent(new Event('desktop-files-changed'));
  }

  // Drop on folder background: move internal item into this folder, or add external files
  async function handleBackgroundDrop(e: DragEvent) {
    e.preventDefault();

    const internalPath = e.dataTransfer?.getData(INTERNAL_MIME);
    if (internalPath) {
      // Already in this folder? skip
      if (internalPath.startsWith(prefix) && !internalPath.slice(prefix.length).includes('/')) return;
      if (isFolder(internalPath) && internalPath.slice(0, -1).startsWith(prefix) && !internalPath.slice(prefix.length, -1).includes('/')) return;

      const dName = displayName(internalPath);
      const isDir = isFolder(internalPath);
      const newName = prefix + dName + (isDir ? '/' : '');
      await renameEntry(internalPath, newName);
      await loadItems();
      window.dispatchEvent(new Event('desktop-files-changed'));
      return;
    }

    if (!e.dataTransfer) return;
    const items = await readDroppedItems(e.dataTransfer, prefix);
    for (const item of items) {
      await addFile(item.path, item.data);
    }
    await loadItems();
  }

  // Drop internal item onto a subfolder icon
  async function handleInternalDropOnSubfolder(subfolderName: string, draggedPath: string) {
    if (draggedPath === subfolderName) return;
    const subPrefix = subfolderName.endsWith('/') ? subfolderName : subfolderName + '/';
    if (draggedPath.startsWith(subPrefix)) return;

    const dName = displayName(draggedPath);
    const isDir = isFolder(draggedPath);
    const newName = subPrefix + dName + (isDir ? '/' : '');
    await renameEntry(draggedPath, newName);
    await loadItems();
    window.dispatchEvent(new Event('desktop-files-changed'));
  }

  async function handleExternalDropOnSubfolder(subfolderName: string, e: DragEvent) {
    if (!e.dataTransfer) return;
    const subPrefix = subfolderName.endsWith('/') ? subfolderName : subfolderName + '/';
    const items = await readDroppedItems(e.dataTransfer, subPrefix);
    for (const item of items) {
      await addFile(item.path, item.data);
    }
    await loadItems();
  }

  const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
    id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
  });

  return (
    <div
      style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, display: minimized ? 'none' : undefined, font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif' }}
      onPointerDown={onFocus}
    >
      <Window
        title={folderDisplayName}
        style={WINDOW_STYLE}
        clientW={clientSize.w}
        clientH={clientSize.h}
        focused={focused}
        maximized={maximized}
        onClose={onStop}
        onMinimize={onMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleMaximize}
        onResizeStart={onResizeStart}
        iconUrl={null}
        iconElement={FOLDER_ICON_16}
      >
        <div
          style={{ width: '100%', height: '100%', overflow: 'auto', background: 'white' }}
          onClick={() => { setSelected(null); setContextMenu(null); setBgContextMenu(null); }}
          onContextMenu={(e: MouseEvent) => {
            if (!(e.target as HTMLElement).closest('[data-desktop-icon]')) {
              e.preventDefault();
              setContextMenu(null);
              setBgContextMenu({ x: e.clientX, y: e.clientY });
            }
          }}
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={handleBackgroundDrop}
        >
          <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
            {items.map(item => (
              <DesktopIcon
                key={item.name}
                name={item.displayName}
                storePath={item.name}
                iconUrl={item.iconUrl}
                isFolder={item.isFolder}
                isExe={item.isExe}
                selected={selected === item.name}
                editing={editingName === item.name}
                onSelect={() => setSelected(item.name)}
                onOpen={() => handleOpen(item)}
                onRename={(newName) => handleRename(item.name, newName)}
                onContextMenu={(e: MouseEvent) => {
                  setBgContextMenu(null);
                  setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                onDropOnIcon={(draggedPath) => handleInternalDropOnSubfolder(item.name, draggedPath)}
                onDropExternalOnIcon={(e) => handleExternalDropOnSubfolder(item.name, e)}
              />
            ))}
            {items.length === 0 && (
              <div class="flex items-center justify-center w-full text-gray-400 text-sm" style={{ minHeight: '200px' }}>
                {t().folderEmpty}
              </div>
            )}
          </div>
        </div>
      </Window>

      {/* Background context menu */}
      {bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1, CMD_REFRESH = 2;
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[mi(CMD_NEW_FOLDER, t().newFolder), mi(CMD_REFRESH, t().refresh)]}
              x={bgContextMenu.x} y={bgContextMenu.y}
              onCommand={(id) => {
                setBgContextMenu(null);
                if (id === CMD_NEW_FOLDER) handleNewFolder();
                else if (id === CMD_REFRESH) { setItems([]); setTimeout(loadItems, 60); }
              }}
              onClose={() => setBgContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* Item context menu */}
      {contextMenu && (() => {
        const CMD_OPEN = 1, CMD_RENAME = 2, CMD_DELETE = 3, CMD_VIEW = 4;
        const { item } = contextMenu;
        const menuItems: MenuItem[] = [
          mi(CMD_OPEN, t().open, { isDefault: true }),
        ];
        if (!item.isFolder) menuItems.push(mi(CMD_VIEW, t().viewResources));
        menuItems.push(mi(CMD_RENAME, t().rename));
        menuItems.push({ id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null });
        menuItems.push(mi(CMD_DELETE, t().delete_));
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={menuItems}
              x={contextMenu.x} y={contextMenu.y}
              onCommand={(id) => {
                setContextMenu(null);
                if (id === CMD_OPEN) handleOpen(item);
                else if (id === CMD_RENAME) { setEditingName(item.name); setSelected(item.name); }
                else if (id === CMD_VIEW && !item.isFolder) {
                  getAllFiles().then(all => {
                    const f = all.find(s => s.name === item.name);
                    if (f) onViewResources(f.data, displayName(item.name));
                  });
                }
                else if (id === CMD_DELETE) setConfirmDelete(item.name);
              }}
              onClose={() => setContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* Delete confirmation */}
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
                    : t().confirmDeleteFile.replace('{0}', displayName(confirmDelete))}
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', padding: '4px 12px 8px' }}>
                <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={() => handleDeleteItem(confirmDelete)}>
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
