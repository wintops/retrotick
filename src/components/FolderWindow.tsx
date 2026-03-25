import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { MenuDropdown } from './win2k/MenuBar';
import { DesktopIcon, INTERNAL_MIME, FOLDER_ICON_16 } from './DesktopIcon';
import {
  getItemsInFolder, addFile, renameEntry,
  isFolder, displayName, getAllFiles, readDroppedItems,
} from '../lib/file-store';
import { isExeFile, openWithDefaultApp } from '../lib/file-utils';
import { useFolderTools } from '../hooks/useFolderTools';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { PropertiesDialog } from './PropertiesDialog';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { t } from '../lib/regional-settings';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
const CLIENT_W = 500;
const CLIENT_H = 350;

interface FolderWindowProps {
  folderPath: string;
  onStop: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  onOpenFolder: (path: string) => void;
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles: Map<string, ArrayBuffer> | undefined, exeName: string, commandLine?: string) => void;
  onViewResources: (arrayBuffer: ArrayBuffer, fileName?: string) => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

export function FolderWindow({
  folderPath, onStop, onFocus, onMinimize, onOpenFolder,
  onRunExe, onViewResources, zIndex, focused, minimized,
}: FolderWindowProps) {
  const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const folderDisplayName = displayName(folderPath);
  const fetchItems = useCallback(() => getItemsInFolder(prefix), [prefix]);
  const fm = useFolderTools(prefix, fetchItems);

  const [windowPos, setWindowPos] = useState({ x: 80 + Math.random() * 60, y: 40 + Math.random() * 40 });
  const [clientSize, setClientSize] = useState({ w: CLIENT_W, h: CLIENT_H });
  const [maximized, setMaximized] = useState(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);

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

  async function handleOpen(item: { name: string; isFolder: boolean }) {
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
        const opened = await openWithDefaultApp(item.name, allFiles, onRunExe);
        if (!opened) onViewResources(f.data, displayName(item.name));
      }
    }
  }

  async function handleBackgroundDrop(e: DragEvent) {
    e.preventDefault();
    const internalPath = e.dataTransfer?.getData(INTERNAL_MIME);
    if (internalPath) {
      if (internalPath.startsWith(prefix) && !internalPath.slice(prefix.length).includes('/')) return;
      if (isFolder(internalPath) && internalPath.slice(0, -1).startsWith(prefix) && !internalPath.slice(prefix.length, -1).includes('/')) return;
      const dName = displayName(internalPath);
      const isDir = isFolder(internalPath);
      const newName = prefix + dName + (isDir ? '/' : '');
      await renameEntry(internalPath, newName);
      await fm.loadItems();
      window.dispatchEvent(new Event('desktop-files-changed'));
      return;
    }
    if (!e.dataTransfer) return;
    const droppedItems = await readDroppedItems(e.dataTransfer, prefix);
    for (const item of droppedItems) await addFile(item.path, item.data);
    await fm.loadItems();
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
          onClick={() => { fm.setSelected(null); fm.setContextMenu(null); fm.setBgContextMenu(null); }}
          onContextMenu={(e: MouseEvent) => {
            if (!(e.target as HTMLElement).closest('[data-desktop-icon]')) {
              e.preventDefault();
              fm.setContextMenu(null);
              fm.setBgContextMenu({ x: e.clientX, y: e.clientY });
            }
          }}
          onDragOver={(e: DragEvent) => e.preventDefault()}
          onDrop={handleBackgroundDrop}
        >
          <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
            {fm.items.map(item => (
              <DesktopIcon
                key={item.name}
                name={item.displayName}
                storePath={item.name}
                iconUrl={item.iconUrl}
                isFolder={item.isFolder}
                isExe={item.isExe}
                selected={fm.selected === item.name}
                editing={fm.editingName === item.name}
                onSelect={() => fm.setSelected(item.name)}
                onOpen={() => handleOpen(item)}
                onRename={(newName) => fm.handleRename(item.name, newName)}
                onContextMenu={(e: MouseEvent) => {
                  fm.setBgContextMenu(null);
                  fm.setContextMenu({ x: e.clientX, y: e.clientY, item });
                }}
                onDropOnIcon={(draggedPath) => fm.handleDropOnFolder(item.name, draggedPath)}
                onDropExternalOnIcon={(e) => fm.handleExternalDropOnFolder(item.name, e)}
              />
            ))}
            {fm.items.length === 0 && (
              <div class="flex items-center justify-center w-full text-gray-400 text-sm" style={{ minHeight: '200px' }}>
                {t().folderEmpty}
              </div>
            )}
          </div>
        </div>
      </Window>

      {/* Background context menu */}
      {fm.bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1, CMD_REFRESH = 2;
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[mi(CMD_NEW_FOLDER, t().newFolder), mi(CMD_REFRESH, t().refresh)]}
              x={fm.bgContextMenu.x} y={fm.bgContextMenu.y}
              onCommand={(id) => {
                fm.setBgContextMenu(null);
                if (id === CMD_NEW_FOLDER) fm.handleNewFolder();
                else if (id === CMD_REFRESH) { fm.setItems([]); setTimeout(fm.loadItems, 60); }
              }}
              onClose={() => fm.setBgContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* Item context menu */}
      {fm.contextMenu && (() => {
        const { item } = fm.contextMenu;
        const CMD_OPEN = 1, CMD_RENAME = 2, CMD_DELETE = 3, CMD_VIEW = 4, CMD_PROPS = 5;
        const menuItems: MenuItem[] = [
          mi(CMD_OPEN, t().open, { isDefault: true }),
        ];
        if (!item.isFolder) menuItems.push(mi(CMD_VIEW, t().viewResources));
        menuItems.push(mi(CMD_RENAME, t().rename));
        menuItems.push({ id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null });
        menuItems.push(mi(CMD_DELETE, t().delete_));
        menuItems.push({ id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null });
        menuItems.push(mi(CMD_PROPS, t().properties));
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={menuItems}
              x={fm.contextMenu.x} y={fm.contextMenu.y}
              onCommand={(id) => {
                fm.setContextMenu(null);
                if (id === CMD_OPEN) handleOpen(item);
                else if (id === CMD_RENAME) { fm.setEditingName(item.name); fm.setSelected(item.name); }
                else if (id === CMD_VIEW && !item.isFolder) {
                  getAllFiles().then(all => {
                    const f = all.find(s => s.name === item.name);
                    if (f) onViewResources(f.data, displayName(item.name));
                  });
                }
                else if (id === CMD_DELETE) fm.setConfirmDelete(item.name);
                else if (id === CMD_PROPS) fm.setPropertiesItem(item);
              }}
              onClose={() => fm.setContextMenu(null)}
            />
          </div>
        );
      })()}

      {fm.confirmDelete && (
        <DeleteConfirmDialog
          name={fm.confirmDelete}
          flashTrigger={fm.confirmFlash}
          onConfirm={() => fm.handleDelete(fm.confirmDelete!)}
          onCancel={() => fm.setConfirmDelete(null)}
          onFlash={() => fm.setConfirmFlash(c => c + 1)}
        />
      )}

      {fm.propertiesItem && (
        <div onPointerDown={() => fm.setPropsFlash(c => c + 1)}>
          <PropertiesDialog
            info={{
              displayName: fm.propertiesItem.displayName,
              isFolder: fm.propertiesItem.isFolder,
              isExe: fm.propertiesItem.isExe,
              iconUrl: fm.propertiesItem.iconUrl,
              size: fm.propertiesItem.size,
              addedAt: fm.propertiesItem.addedAt,
              location: folderPath,
              folderContents: fm.folderContents,
            }}
            flashTrigger={fm.propsFlash}
            onClose={() => fm.setPropertiesItem(null)}
          />
        </div>
      )}
    </div>
  );
}
