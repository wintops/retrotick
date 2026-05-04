import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { MenuDropdown } from './win2k/MenuBar';
import { DesktopIcon, INTERNAL_MIME, FOLDER_ICON_16 } from './DesktopIcon';
import {
  getItemsInFolder, addFile, renameEntry,
  isFolder, displayName, getFile, listFileMetadata, readDroppedItems,
  dispatchDesktopFilesChanged,
} from '../lib/file-store';
import { isExeFile, openWithDefaultApp } from '../lib/file-utils';
import { useFolderTools } from '../hooks/useFolderTools';
import type { ClipboardState } from '../hooks/useClipboard';
import { useRubberBand } from '../hooks/useRubberBand';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { PropertiesDialog } from './PropertiesDialog';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { t } from '../lib/regional-settings';
import type { FileItem } from '../hooks/useFolderTools';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;

function formatSizeShort(bytes: number, strings: { sizeKB: string; sizeMB: string; sizeGB: string }): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024).toLocaleString()} ${strings.sizeKB}`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} ${strings.sizeMB}`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ${strings.sizeGB}`;
}

function statusBar(items: FileItem[], selected: Set<string>) {
  const strings = t();
  let text: string;
  let size: number;
  if (selected.size > 0) {
    text = strings.statusSelected.replace('{0}', String(selected.size));
    size = 0;
    for (const item of items) {
      if (selected.has(item.name) && !item.isFolder) size += item.size;
    }
  } else {
    text = strings.statusObjects.replace('{0}', String(items.length));
    size = 0;
    for (const item of items) {
      if (!item.isFolder) size += item.size;
    }
  }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      height: '20px', padding: '0 4px', background: '#D4D0C8', flexShrink: 0,
      borderTop: '1px solid #808080',
      font: '11px "Tahoma", "MS Sans Serif", sans-serif',
    }}>
      <div style={{
        flex: 1, padding: '0 2px', overflow: 'hidden', whiteSpace: 'nowrap',
        borderRight: '1px solid #fff',
        boxShadow: 'inset 1px 1px 0 #808080, inset -1px -1px 0 #fff',
        lineHeight: '18px', paddingLeft: '4px',
      }}>
        {text}
      </div>
      {size > 0 && (
        <div style={{
          padding: '0 6px', whiteSpace: 'nowrap',
          boxShadow: 'inset 1px 1px 0 #808080, inset -1px -1px 0 #fff',
          lineHeight: '18px', marginLeft: '2px',
        }}>
          {formatSizeShort(size, strings)}
        </div>
      )}
    </div>
  );
}
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
  clipboard: ClipboardState | null;
  onCut: (items: string[], prefix: string) => void;
  onCopy: (items: string[], prefix: string) => void;
  onPaste: (prefix: string) => Promise<void>;
}

export function FolderWindow({
  folderPath, onStop, onFocus, onMinimize, onOpenFolder,
  onRunExe, onViewResources, zIndex, focused, minimized,
  clipboard, onCut, onCopy, onPaste,
}: FolderWindowProps) {
  const prefix = folderPath.endsWith('/') ? folderPath : folderPath + '/';
  const folderDisplayName = displayName(folderPath);
  const fetchItems = useCallback(() => getItemsInFolder(prefix), [prefix]);
  const fm = useFolderTools(prefix, fetchItems);

  const contentRef = useRef<HTMLDivElement>(null);

  const selectedArray = [...fm.selected];

  const { rect: rubberRect, onPointerDown: onRubberBandDown, consumeDrag } = useRubberBand(
    contentRef,
    useCallback((names: Set<string>) => fm.setSelection(names), [fm.setSelection]),
  );

  // Focus content area when the window becomes focused
  useEffect(() => {
    if (focused && !minimized) contentRef.current?.focus();
  }, [focused, minimized]);

  function handleKeyDown(e: KeyboardEvent) {
    if (fm.editingName || fm.confirmDelete || fm.propertiesItem || fm.contextMenu || fm.bgContextMenu) return;
    const { key } = e;

    if (e.ctrlKey && key === 'a') {
      e.preventDefault();
      fm.selectAll();
      return;
    }
    if (e.ctrlKey && key === 'x' && fm.selected.size > 0) {
      e.preventDefault();
      onCut([...fm.selected], prefix);
      return;
    }
    if (e.ctrlKey && key === 'c' && fm.selected.size > 0) {
      e.preventDefault();
      onCopy([...fm.selected], prefix);
      return;
    }
    if (e.ctrlKey && key === 'v') {
      e.preventDefault();
      onPaste(prefix).then(() => fm.loadItems());
      return;
    }
    if (key === 'Enter' && e.altKey && fm.selected.size >= 1) {
      e.preventDefault();
      if (fm.selected.size === 1) {
        const item = fm.items.find(i => i.name === [...fm.selected][0]);
        if (item) fm.setPropertiesItem(item);
      } else {
        const items = fm.items.filter(i => fm.selected.has(i.name));
        if (items.length > 0) fm.setPropertiesItem(items);
      }
      return;
    }
    if (key === 'Enter' && fm.selected.size === 1) {
      e.preventDefault();
      const name = [...fm.selected][0];
      const item = fm.items.find(i => i.name === name);
      if (item) handleOpen(item);
      return;
    }
    if (key === 'F2' && fm.selected.size === 1) {
      e.preventDefault();
      fm.setEditingName([...fm.selected][0]);
      return;
    }
    if (key === 'Delete' && fm.selected.size > 0) {
      e.preventDefault();
      fm.setConfirmDelete([...fm.selected]);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
      e.preventDefault();
      if (fm.items.length === 0) return;
      if (fm.selected.size === 0) { fm.selectOne(fm.items[0].name); return; }
      const current = (e.shiftKey ? fm.focus : fm.anchor) || [...fm.selected][0];
      const idx = fm.items.findIndex(i => i.name === current);
      if (idx === -1) { fm.selectOne(fm.items[0].name); return; }
      const el = contentRef.current;
      const cols = el ? Math.max(1, Math.floor((el.clientWidth - 12) / 79)) : 1;
      let next = idx;
      if (key === 'ArrowLeft') next = Math.max(0, idx - 1);
      else if (key === 'ArrowRight') next = Math.min(fm.items.length - 1, idx + 1);
      else if (key === 'ArrowUp') next = Math.max(0, idx - cols);
      else if (key === 'ArrowDown') next = Math.min(fm.items.length - 1, idx + cols);
      if (e.shiftKey) {
        fm.selectRange(fm.items[next].name);
      } else {
        fm.selectOne(fm.items[next].name);
      }
      const icon = contentRef.current?.querySelector(`[data-store-path="${CSS.escape(fm.items[next].name)}"]`);
      icon?.scrollIntoView({ block: 'nearest' });
      return;
    }
    // Type-ahead: press a letter/digit to jump to matching item
    if (key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const matched = fm.selectByKey(key);
      if (matched) {
        e.preventDefault();
        const icon = contentRef.current?.querySelector(`[data-store-path="${CSS.escape(matched)}"]`);
        icon?.scrollIntoView({ block: 'nearest' });
      }
    }
  }

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
      const data = await getFile(item.name);
      if (!data) return;
      const result = isExeFile(data, item.name);
      if (result.ok && result.peInfo) {
        // Only pre-load sibling DLLs (not all files) — everything else is lazy-loaded via onFileRequest
        const metas = await listFileMetadata();
        const dllExts = new Set(['dll', 'ocx', 'drv', 'vxd', 'cpl']);
        const siblingDlls = metas.filter(m =>
          m.name !== item.name && m.name.startsWith(prefix) &&
          dllExts.has((m.name.split('.').pop() ?? '').toLowerCase()));
        const additional = new Map<string, ArrayBuffer>();
        await Promise.all(siblingDlls.map(async m => {
          const buf = await getFile(m.name);
          if (buf) additional.set(m.name, buf);
        }));
        const cleanPath = folderPath.replace(/\/+$/, '').replace(/\\+$/, '');
        const fullPath = cleanPath + '/' + displayName(item.name);
        onRunExe(data, result.peInfo, additional.size > 0 ? additional : undefined, fullPath);
      } else {
        const metas = await listFileMetadata();
        const opened = await openWithDefaultApp(item.name, metas, onRunExe, getFile);
        if (!opened) onViewResources(data, displayName(item.name));
      }
    }
  }

  async function handleBackgroundDrop(e: DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer?.getData(INTERNAL_MIME);
    if (raw) {
      let paths: string[];
      try { paths = JSON.parse(raw); } catch { paths = [raw]; }
      const added: string[] = [];
      const deleted: string[] = [];
      for (const internalPath of paths) {
        if (internalPath.startsWith(prefix) && !internalPath.slice(prefix.length).includes('/')) continue;
        if (isFolder(internalPath) && internalPath.slice(0, -1).startsWith(prefix) && !internalPath.slice(prefix.length, -1).includes('/')) continue;
        const dName = displayName(internalPath);
        const isDir = isFolder(internalPath);
        const newName = prefix + dName + (isDir ? '/' : '');
        await renameEntry(internalPath, newName);
        added.push(newName);
        deleted.push(internalPath);
      }
      await fm.loadItems();
      dispatchDesktopFilesChanged({ source: 'ui', added, deleted });
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
  const sep: MenuItem = { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null };

  const isCutSource = clipboard?.mode === 'cut' && clipboard.sourcePrefix === prefix;
  const cutSet = isCutSource ? new Set(clipboard!.items) : null;

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
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
          <div
            ref={contentRef}
            tabIndex={-1}
            style={{ flex: 1, overflow: 'auto', background: 'white', outline: 'none', position: 'relative' }}
            onClick={() => { if (consumeDrag()) return; fm.clearSelection(); fm.setContextMenu(null); fm.setBgContextMenu(null); }}
            onPointerDown={onRubberBandDown}
            onKeyDown={handleKeyDown}
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
            {rubberRect && (
              <div class="pointer-events-none" style={{ position: 'absolute', left: rubberRect.x, top: rubberRect.y, width: rubberRect.w, height: rubberRect.h, border: '1px dotted #000', background: 'rgba(0,0,128,0.15)', zIndex: 40 }} />
            )}
            <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
              {fm.items.map(item => (
                <DesktopIcon
                  key={item.name}
                  name={item.displayName}
                  storePath={item.name}
                  iconUrl={item.iconUrl}
                  isFolder={item.isFolder}
                  isExe={item.isExe}
                  darkText
                  selected={fm.selected.has(item.name)}
                  editing={fm.editingName === item.name}
                  isCut={cutSet?.has(item.name)}
                  selectedPaths={selectedArray}
                  onSelect={(e) => {
                    if (e.ctrlKey) fm.selectToggle(item.name);
                    else if (e.shiftKey) fm.selectRange(item.name);
                    else fm.selectOne(item.name);
                    contentRef.current?.focus();
                  }}
                  onOpen={() => handleOpen(item)}
                  onRename={(newName) => fm.handleRename(item.name, newName)}
                  onContextMenu={(e: MouseEvent) => {
                    fm.setBgContextMenu(null);
                    if (!fm.selected.has(item.name)) fm.selectOne(item.name);
                    fm.setContextMenu({ x: e.clientX, y: e.clientY, item });
                  }}
                  onDropOnIcon={(paths) => fm.handleDropOnFolder(item.name, paths)}
                  onDropExternalOnIcon={(e) => fm.handleExternalDropOnFolder(item.name, e)}
                />
              ))}
              {fm.items.length === 0 && (
                <div class="flex items-center justify-center w-full text-gray-400 text-sm" style={{ minHeight: '200px' }}>
                  {fm.isLoading ? t().folderLoading : t().folderEmpty}
                </div>
              )}
            </div>
          </div>
          {statusBar(fm.items, fm.selected)}
        </div>
      </Window>

      {/* Background context menu */}
      {fm.bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1, CMD_PASTE = 2, CMD_REFRESH = 3;
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[
                mi(CMD_NEW_FOLDER, t().newFolder),
                sep,
                mi(CMD_PASTE, t().paste, { isGrayed: !clipboard }),
                sep,
                mi(CMD_REFRESH, t().refresh),
              ]}
              x={fm.bgContextMenu.x} y={fm.bgContextMenu.y}
              onCommand={(id) => {
                fm.setBgContextMenu(null);
                if (id === CMD_NEW_FOLDER) fm.handleNewFolder();
                else if (id === CMD_PASTE) onPaste(prefix).then(() => fm.loadItems());
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
        const multi = fm.selected.size > 1;
        const CMD_OPEN = 1, CMD_RENAME = 2, CMD_DELETE = 3, CMD_VIEW = 4, CMD_PROPS = 5, CMD_CUT = 6, CMD_COPY = 7;
        const menuItems: MenuItem[] = [
          mi(CMD_OPEN, t().open, { isDefault: true, isGrayed: multi }),
        ];
        if (!item.isFolder) menuItems.push(mi(CMD_VIEW, t().viewResources, { isGrayed: multi }));
        menuItems.push(sep);
        menuItems.push(mi(CMD_CUT, t().cut));
        menuItems.push(mi(CMD_COPY, t().copy_));
        menuItems.push(sep);
        menuItems.push(mi(CMD_DELETE, t().delete_));
        menuItems.push(mi(CMD_RENAME, t().rename, { isGrayed: multi }));
        menuItems.push({ ...sep });
        menuItems.push(mi(CMD_PROPS, t().properties));
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={menuItems}
              x={fm.contextMenu.x} y={fm.contextMenu.y}
              onCommand={(id) => {
                fm.setContextMenu(null);
                if (id === CMD_OPEN) handleOpen(item);
                else if (id === CMD_CUT) onCut([...fm.selected], prefix);
                else if (id === CMD_COPY) onCopy([...fm.selected], prefix);
                else if (id === CMD_RENAME) { fm.setEditingName(item.name); fm.selectOne(item.name); }
                else if (id === CMD_VIEW && !item.isFolder) {
                  getFile(item.name).then(buf => {
                    if (buf) onViewResources(buf, displayName(item.name));
                  });
                }
                else if (id === CMD_DELETE) fm.setConfirmDelete([...fm.selected]);
                else if (id === CMD_PROPS) {
                  if (multi) {
                    const items = fm.items.filter(i => fm.selected.has(i.name));
                    fm.setPropertiesItem(items);
                  } else {
                    fm.setPropertiesItem(item);
                  }
                }
              }}
              onClose={() => fm.setContextMenu(null)}
            />
          </div>
        );
      })()}

      {fm.confirmDelete && (
        <DeleteConfirmDialog
          names={fm.confirmDelete}
          flashTrigger={fm.confirmFlash}
          onConfirm={() => fm.handleDelete(fm.confirmDelete!)}
          onCancel={() => fm.setConfirmDelete(null)}
          onFlash={() => fm.setConfirmFlash(c => c + 1)}
        />
      )}

      {fm.propertiesItem && (
        <div onPointerDown={() => fm.setPropsFlash(c => c + 1)}>
          <PropertiesDialog
            info={Array.isArray(fm.propertiesItem)
              ? {
                  displayName: t().propMultiObjects.replace('{0}', String(fm.propertiesItem.length)),
                  isFolder: false, isExe: false, iconUrl: null,
                  size: fm.propertiesItem.reduce((s, i) => s + i.size, 0),
                  addedAt: 0, location: folderPath,
                  multiCount: fm.propertiesItem.length,
                }
              : {
                  displayName: fm.propertiesItem.displayName,
                  isFolder: fm.propertiesItem.isFolder,
                  isExe: fm.propertiesItem.isExe,
                  iconUrl: fm.propertiesItem.iconUrl,
                  size: fm.propertiesItem.size,
                  addedAt: fm.propertiesItem.addedAt,
                  location: folderPath,
                  folderContents: fm.folderContents,
                }
            }
            flashTrigger={fm.propsFlash}
            onClose={() => fm.setPropertiesItem(null)}
          />
        </div>
      )}
    </div>
  );
}
