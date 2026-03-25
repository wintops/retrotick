import { useState, useEffect, useCallback } from 'preact/hooks';
import type { PEInfo } from '../lib/pe';
import type { MenuItem } from '../lib/pe/types';
import { getRootItems, addFile, renameEntry, isFolder, displayName, getAllFiles, readDroppedItems } from '../lib/file-store';
import type { Emulator } from '../lib/emu/emulator';
import { isExeFile, openWithDefaultApp } from '../lib/file-utils';
import { useFolderTools } from '../hooks/useFolderTools';
import { DesktopIcon, INTERNAL_MIME } from './DesktopIcon';
import { MenuDropdown } from './win2k/MenuBar';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { PropertiesDialog } from './PropertiesDialog';
import { t } from '../lib/regional-settings';

interface Props {
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo, additionalFiles: Map<string, ArrayBuffer> | undefined, exeName: string, commandLine?: string, onSetupEmulator?: (emu: Emulator) => void) => void;
  onViewResources: (arrayBuffer: ArrayBuffer, fileName?: string) => void;
  onOpenFolder: (path: string) => void;
}

export function Desktop({ onRunExe, onViewResources, onOpenFolder }: Props) {
  const fetchItems = useCallback(() => getRootItems(), []);
  const fm = useFolderTools('', fetchItems);
  const [dragOver, setDragOver] = useState(false);

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

    const internalPath = e.dataTransfer?.getData(INTERNAL_MIME);
    if (internalPath) {
      const dName = displayName(internalPath);
      const isDir = isFolder(internalPath);
      const newName = isDir ? dName + '/' : dName;
      if (internalPath !== newName) {
        await renameEntry(internalPath, newName);
        await fm.loadItems();
        window.dispatchEvent(new Event('desktop-files-changed'));
      }
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
      for (const s of stored) if (s.name !== name) additional.set(s.name, s.data);
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

  return (
    <div
      class="w-full select-none"
      style={{ minHeight: '100%' }}
      onClick={() => { if (fm.confirmDelete) return; fm.setSelected(null); fm.setEditingName(null); fm.setContextMenu(null); fm.setBgContextMenu(null); }}
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

      <div class="flex flex-wrap content-start gap-1 p-2" style={{ minHeight: '100%' }}>
        {fm.items.map(f => (
          <DesktopIcon
            key={f.name}
            name={f.displayName}
            storePath={f.name}
            iconUrl={f.iconUrl}
            isFolder={f.isFolder}
            isExe={f.isExe}
            selected={fm.selected === f.name}
            editing={fm.editingName === f.name}
            onSelect={() => fm.setSelected(f.name)}
            onOpen={() => handleOpen(f.name, f.isFolder)}
            onRename={(newName) => fm.handleRename(f.name, newName)}
            onContextMenu={(e: MouseEvent) => { fm.setBgContextMenu(null); fm.setContextMenu({ x: e.clientX, y: e.clientY, item: f }); }}
            onDropOnIcon={(draggedPath) => fm.handleDropOnFolder(f.name, draggedPath)}
            onDropExternalOnIcon={(e) => fm.handleExternalDropOnFolder(f.name, e)}
          />
        ))}
        <div style={{ position: 'absolute', bottom: '4px', right: '8px', zIndex: 1, font: '11px Tahoma, sans-serif', textAlign: 'right', lineHeight: '1.6' }}>
          <div style={{ pointerEvents: 'none', color: 'rgba(255,255,255,0.25)' }}>
            {t().dropHint}<br />
            {t().rightClickHint}
          </div>
          <a href="https://github.com/lqs/retrotick" target="_blank"
            style={{ display: 'inline-flex', alignItems: 'center', height: '22px', padding: '0 8px', marginTop: '4px', background: '#D4D0C8', border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF', boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080', color: '#000', textDecoration: 'none', font: 'bold 11px/1 "Tahoma", "MS Sans Serif", sans-serif', whiteSpace: 'nowrap' }}>
            Star on GitHub
          </a>
        </div>
      </div>

      {/* Background context menu */}
      {fm.bgContextMenu && (() => {
        const CMD_NEW_FOLDER = 1, CMD_REFRESH = 2;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        return (
          <div onClick={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[
                mi(CMD_NEW_FOLDER, t().newFolder),
                { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null },
                mi(CMD_REFRESH, t().refresh),
              ]}
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

      {/* File context menu */}
      {fm.contextMenu && (() => {
        const { item } = fm.contextMenu;
        const isScr = item.name.toLowerCase().endsWith('.scr');
        const CMD_OPEN = 1, CMD_CONFIGURE = 2, CMD_VIEW = 3, CMD_DELETE = 4, CMD_RENAME = 5, CMD_PROPS = 6;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const sep: MenuItem = { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null };
        const menuItems: MenuItem[] = [];
        if (item.isFolder) {
          menuItems.push(mi(CMD_OPEN, t().open, { isDefault: true }));
          menuItems.push(mi(CMD_RENAME, t().rename));
          menuItems.push(sep);
          menuItems.push(mi(CMD_DELETE, t().delete_));
        } else {
          if (item.isExe) menuItems.push(mi(CMD_OPEN, t().open, { isDefault: true }));
          if (isScr && item.isExe) menuItems.push(mi(CMD_CONFIGURE, t().configure));
          menuItems.push(mi(CMD_VIEW, t().viewResources, { isDefault: !item.isExe }));
          menuItems.push(mi(CMD_RENAME, t().rename));
          menuItems.push(sep);
          menuItems.push(mi(CMD_DELETE, t().delete_));
        }
        menuItems.push({ ...sep });
        menuItems.push(mi(CMD_PROPS, t().properties));
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
                else if (id === CMD_RENAME) { fm.setEditingName(item.name); fm.setSelected(item.name); }
                else if (id === CMD_DELETE) { fm.setConfirmDelete(item.name); fm.setContextMenu(null); }
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
