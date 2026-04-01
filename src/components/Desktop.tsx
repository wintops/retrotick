import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { getRootItems, addFile, renameEntry, isFolder, displayName, getAllFiles, readDroppedItems } from '../lib/file-store';
import type { Emulator } from '../lib/emu/emulator';
import { isExeFile, openWithDefaultApp } from '../lib/file-utils';
import { useFolderTools } from '../hooks/useFolderTools';
import type { ClipboardState } from '../hooks/useClipboard';
import { useRubberBand } from '../hooks/useRubberBand';
import { DesktopIcon, INTERNAL_MIME } from './DesktopIcon';
import { MenuDropdown } from './win2k/MenuBar';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { PropertiesDialog } from './PropertiesDialog';
import { t } from '../lib/regional-settings';

interface Props {
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles: Map<string, ArrayBuffer> | undefined, exeName: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onViewResources: (arrayBuffer: ArrayBuffer, fileName?: string) => void;
  onOpenFolder: (path: string) => void;
  onShowDisplayProperties?: () => void;
  clipboard: ClipboardState | null;
  onCut: (items: string[], prefix: string) => void;
  onCopy: (items: string[], prefix: string) => void;
  onPaste: (prefix: string) => Promise<void>;
}

export function Desktop({ onRunExe, onViewResources, onOpenFolder, onShowDisplayProperties, clipboard, onCut, onCopy, onPaste }: Props) {
  const fetchItems = useCallback(() => getRootItems(), []);
  const fm = useFolderTools('', fetchItems);
  const [dragOver, setDragOver] = useState(false);
  const desktopRef = useRef<HTMLDivElement>(null);

  const selectedArray = [...fm.selected];

  const { rect: rubberRect, onPointerDown: onRubberBandDown, consumeDrag } = useRubberBand(
    desktopRef,
    useCallback((names: Set<string>) => fm.setSelection(names), [fm.setSelection]),
  );

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
      onCut([...fm.selected], '');
      return;
    }
    if (e.ctrlKey && key === 'c' && fm.selected.size > 0) {
      e.preventDefault();
      onCopy([...fm.selected], '');
      return;
    }
    if (e.ctrlKey && key === 'v') {
      e.preventDefault();
      onPaste('').then(() => fm.loadItems());
      return;
    }
    if (key === 'Enter' && fm.selected.size === 1) {
      e.preventDefault();
      const name = [...fm.selected][0];
      const item = fm.items.find(i => i.name === name);
      if (item) handleOpen(item.name, item.isFolder);
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
      const anchor = fm.anchor || [...fm.selected][0];
      const idx = fm.items.findIndex(i => i.name === anchor);
      if (idx === -1) { fm.selectOne(fm.items[0].name); return; }
      const el = desktopRef.current;
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
    }
  }

  // Focus desktop on mount so arrow keys work immediately
  useEffect(() => { desktopRef.current?.focus(); }, []);

  // Auto-open from URL param on first load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autoOpen = params.get('open');
    if (autoOpen) {
      window.history.replaceState({}, '', window.location.pathname);
      handleOpen(autoOpen, false);
    }
  }, []);

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);

    const raw = e.dataTransfer?.getData(INTERNAL_MIME);
    if (raw) {
      let paths: string[];
      try { paths = JSON.parse(raw); } catch { paths = [raw]; }
      for (const internalPath of paths) {
        const dName = displayName(internalPath);
        const isDir = isFolder(internalPath);
        const newName = isDir ? dName + '/' : dName;
        if (internalPath !== newName) {
          await renameEntry(internalPath, newName);
        }
      }
      await fm.loadItems();
      window.dispatchEvent(new Event('desktop-files-changed'));
      return;
    }

    if (!e.dataTransfer) return;
    const items = await readDroppedItems(e.dataTransfer);
    for (const item of items) await addFile(item.path, item.data);
    await fm.loadItems();
  }

  async function runExeWithArgs(name: string, commandLine?: string) {
    const stored = await getAllFiles();
    const f = stored.find(s => s.name === name);
    if (!f) return;
    const result = isExeFile(f.data, name);
    if (result.ok && result.peInfo) {
      const additional = new Map<string, ArrayBuffer>();
      for (const s of stored) if (s.name !== name && !s.name.includes('/')) additional.set(s.name, s.data);
      onRunExe(f.data, result.peInfo, additional, name, commandLine);
    } else {
      const opened = await openWithDefaultApp(name, stored, onRunExe);
      if (!opened) onViewResources(f.data, name);
    }
  }

  async function handleOpen(name: string, fileIsFolder: boolean) {
    if (fileIsFolder) { onOpenFolder(name); return; }
    const isScr = name.toLowerCase().endsWith('.scr');
    await runExeWithArgs(name, isScr ? '/s' : undefined);
  }

  async function handleViewResources(name: string) {
    fm.setContextMenu(null);
    const stored = await getAllFiles();
    const f = stored.find(s => s.name === name);
    if (f) onViewResources(f.data, name);
  }

  const isCutSource = clipboard?.mode === 'cut' && clipboard.sourcePrefix === '';
  const cutSet = isCutSource ? new Set(clipboard!.items) : null;

  return (
    <div
      ref={desktopRef}
      tabIndex={-1}
      class="w-full select-none"
      style={{ minHeight: '100%', outline: 'none' }}
      onClick={() => { if (fm.confirmDelete || consumeDrag()) return; fm.clearSelection(); fm.setEditingName(null); fm.setContextMenu(null); fm.setBgContextMenu(null); }}
      onPointerDown={onRubberBandDown}
      onKeyDown={handleKeyDown}
      onContextMenu={(e: MouseEvent) => {
        if (fm.confirmDelete) { e.preventDefault(); return; }
        if (!(e.target as HTMLElement).closest('[data-desktop-icon]')) {
          e.preventDefault();
          fm.setContextMenu(null);
          fm.setBgContextMenu({ x: e.clientX, y: e.clientY });
        }
      }}
      onDragOver={(e: DragEvent) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div class="absolute inset-0 z-50 pointer-events-none" style={{ background: 'rgba(0,0,0,0.15)' }} />
      )}
      {rubberRect && (
        <div class="pointer-events-none" style={{ position: 'absolute', left: rubberRect.x, top: rubberRect.y, width: rubberRect.w, height: rubberRect.h, border: '1px dotted #FFF', background: 'rgba(0,0,128,0.2)', zIndex: 40 }} />
      )}

      <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
        {fm.items.map(f => (
          <DesktopIcon
            key={f.name}
            name={f.displayName}
            storePath={f.name}
            iconUrl={f.iconUrl}
            isFolder={f.isFolder}
            isExe={f.isExe}
            selected={fm.selected.has(f.name)}
            editing={fm.editingName === f.name}
            isCut={cutSet?.has(f.name)}
            selectedPaths={selectedArray}
            onSelect={(e) => {
              if (e.ctrlKey) fm.selectToggle(f.name);
              else if (e.shiftKey) fm.selectRange(f.name);
              else fm.selectOne(f.name);
              desktopRef.current?.focus();
            }}
            onOpen={() => handleOpen(f.name, f.isFolder)}
            onRename={(newName) => fm.handleRename(f.name, newName)}
            onContextMenu={(e: MouseEvent) => {
              fm.setBgContextMenu(null);
              if (!fm.selected.has(f.name)) fm.selectOne(f.name);
              fm.setContextMenu({ x: e.clientX, y: e.clientY, item: f });
            }}
            onDropOnIcon={(paths) => fm.handleDropOnFolder(f.name, paths)}
            onDropExternalOnIcon={(e) => fm.handleExternalDropOnFolder(f.name, e)}
          />
        ))}
        <div style={{ position: 'absolute', bottom: '4px', right: '8px', zIndex: 1, font: '11px Tahoma, sans-serif', textAlign: 'right', lineHeight: '1.6' }}>
          <div style={{ pointerEvents: 'none', color: 'rgba(255,255,255,0.25)' }}>
            {t().dropHint}<br />
            {t().rightClickHint}
          </div>
        </div>
      </div>

      {/* Background context menu */}
      {fm.bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1, CMD_PASTE = 2, CMD_REFRESH = 3, CMD_PROPERTIES = 4;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const sep: MenuItem = { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null };
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[
                mi(CMD_NEW_FOLDER, t().newFolder),
                sep,
                mi(CMD_PASTE, t().paste, { isGrayed: !clipboard }),
                sep,
                mi(CMD_REFRESH, t().refresh),
                { ...sep },
                mi(CMD_PROPERTIES, t().properties),
              ]}
              x={fm.bgContextMenu.x} y={fm.bgContextMenu.y}
              onCommand={(id) => {
                fm.setBgContextMenu(null);
                if (id === CMD_NEW_FOLDER) fm.handleNewFolder();
                else if (id === CMD_PASTE) onPaste('').then(() => fm.loadItems());
                else if (id === CMD_REFRESH) { fm.setItems([]); setTimeout(fm.loadItems, 60); }
                else if (id === CMD_PROPERTIES) onShowDisplayProperties?.();
              }}
              onClose={() => fm.setBgContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* File context menu */}
      {fm.contextMenu && (() => {
        const { item } = fm.contextMenu;
        const multi = fm.selected.size > 1;
        const isScr = item.name.toLowerCase().endsWith('.scr');
        const CMD_OPEN = 1, CMD_CONFIGURE = 2, CMD_VIEW = 3, CMD_CUT = 4, CMD_COPY = 5, CMD_DELETE = 6, CMD_RENAME = 7, CMD_PROPS = 8;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const sep: MenuItem = { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null };
        const menuItems: MenuItem[] = [];
        if (item.isFolder) {
          menuItems.push(mi(CMD_OPEN, t().open, { isDefault: true, isGrayed: multi }));
          menuItems.push(sep);
          menuItems.push(mi(CMD_CUT, t().cut));
          menuItems.push(mi(CMD_COPY, t().copy_));
          menuItems.push(sep);
          menuItems.push(mi(CMD_DELETE, t().delete_));
          menuItems.push(mi(CMD_RENAME, t().rename, { isGrayed: multi }));
        } else {
          if (item.isExe) menuItems.push(mi(CMD_OPEN, t().open, { isDefault: true, isGrayed: multi }));
          if (isScr && item.isExe) menuItems.push(mi(CMD_CONFIGURE, t().configure, { isGrayed: multi }));
          menuItems.push(mi(CMD_VIEW, t().viewResources, { isDefault: !item.isExe, isGrayed: multi }));
          menuItems.push(sep);
          menuItems.push(mi(CMD_CUT, t().cut));
          menuItems.push(mi(CMD_COPY, t().copy_));
          menuItems.push(sep);
          menuItems.push(mi(CMD_DELETE, t().delete_));
          menuItems.push(mi(CMD_RENAME, t().rename, { isGrayed: multi }));
        }
        menuItems.push({ ...sep });
        menuItems.push(mi(CMD_PROPS, t().properties, { isGrayed: multi }));
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={menuItems}
              x={fm.contextMenu.x} y={fm.contextMenu.y}
              onCommand={(id) => {
                fm.setContextMenu(null);
                if (id === CMD_OPEN) handleOpen(item.name, item.isFolder);
                else if (id === CMD_CONFIGURE) runExeWithArgs(item.name, '/c');
                else if (id === CMD_VIEW) handleViewResources(item.name);
                else if (id === CMD_CUT) onCut([...fm.selected], '');
                else if (id === CMD_COPY) onCopy([...fm.selected], '');
                else if (id === CMD_RENAME) { fm.setEditingName(item.name); fm.selectOne(item.name); }
                else if (id === CMD_DELETE) { fm.setConfirmDelete([...fm.selected]); fm.setContextMenu(null); }
                else if (id === CMD_PROPS) fm.setPropertiesItem(item);
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
            info={{
              displayName: fm.propertiesItem.displayName,
              isFolder: fm.propertiesItem.isFolder,
              isExe: fm.propertiesItem.isExe,
              iconUrl: fm.propertiesItem.iconUrl,
              size: fm.propertiesItem.size,
              addedAt: fm.propertiesItem.addedAt,
              location: 'D:\\',
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
