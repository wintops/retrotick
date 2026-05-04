import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import {
  addFolder, deleteFolder, deleteFile, renameEntry,
  isFolder, displayName, addFile, listFileMetadata, readDroppedItems,
  dispatchDesktopFilesChanged,
  type StoredFile,
} from '../lib/file-store';
import { extractFirstIconUrlFromParsed, classifyExe } from '../lib/file-utils';
import { parsePE, parseCOM } from '../lib/pe';
import { t } from '../lib/regional-settings';

export interface FileItem {
  name: string;
  displayName: string;
  iconUrl: string | null;
  isExe: boolean;
  isFolder: boolean;
  size: number;
  addedAt: number;
}

export function useFolderTools(prefix: string, fetchItems: () => Promise<StoredFile[]>) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: FileItem } | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [confirmFlash, setConfirmFlash] = useState(0);
  const [propertiesItem, setPropertiesItem] = useState<FileItem | FileItem[] | null>(null);
  const [propsFlash, setPropsFlash] = useState(0);
  const [folderContents, setFolderContents] = useState<{ files: number; folders: number; totalSize: number } | null>(null);
  const iconUrls = useRef<string[]>([]);
  const typeAhead = useRef<{ key: string; matchIdx: number; time: number }>({ key: '', matchIdx: -1, time: 0 });

  function selectOne(name: string) {
    setSelected(new Set([name]));
    setAnchor(name);
    setFocus(name);
  }

  const setSelection = useCallback((names: Set<string>) => {
    setSelected(names);
  }, []);

  function selectToggle(name: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
    setAnchor(name);
    setFocus(name);
  }

  function selectRange(name: string) {
    if (!anchor) { selectOne(name); return; }
    const anchorIdx = items.findIndex(i => i.name === anchor);
    const targetIdx = items.findIndex(i => i.name === name);
    if (anchorIdx === -1 || targetIdx === -1) { selectOne(name); return; }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    const next = new Set<string>();
    for (let i = lo; i <= hi; i++) next.add(items[i].name);
    setSelected(next);
    setFocus(name);
  }

  function selectAll() {
    setSelected(new Set(items.map(i => i.name)));
  }

  function clearSelection() {
    setSelected(new Set());
  }

  /** Select the next item whose displayName starts with the typed key (cycles on repeat). */
  function selectByKey(key: string): string | null {
    if (key.length !== 1) return null;
    const lower = key.toLowerCase();
    const matches = items.filter(i => i.displayName.toLowerCase().startsWith(lower));
    if (matches.length === 0) return null;

    const now = Date.now();
    const ta = typeAhead.current;
    let idx = 0;
    if (ta.key === lower && now - ta.time < 1500) {
      idx = (ta.matchIdx + 1) % matches.length;
    }
    ta.key = lower;
    ta.matchIdx = idx;
    ta.time = now;

    selectOne(matches[idx].name);
    return matches[idx].name;
  }

  const loadItems = useCallback(async () => {
    setIsLoading(true);
    for (const u of iconUrls.current) URL.revokeObjectURL(u);
    iconUrls.current = [];

    const stored = await fetchItems();
    const mapped: FileItem[] = stored.map(f => {
      const isFolderEntry = isFolder(f.name);
      let iconUrl: string | null = null;
      let isExe = false;
      if (!isFolderEntry) {
        // Parse the PE once and reuse the result for both the "is executable"
        // classification and the icon extraction. The previous call chain
        // parsed each file twice (extractFirstIconUrl + isExeFile), which
        // doubled the PE-walk cost for every entry in the folder.
        const lname = f.name.toLowerCase();
        let peInfo;
        try {
          peInfo = lname.endsWith('.com') ? parseCOM(f.data) : parsePE(f.data);
        } catch {
          peInfo = undefined;
        }
        if (peInfo) {
          if (lname.endsWith('.com')) {
            isExe = true;
          } else {
            isExe = classifyExe(peInfo, f.name).ok;
          }
          iconUrl = extractFirstIconUrlFromParsed(peInfo, f.data);
          if (iconUrl) iconUrls.current.push(iconUrl);
        }
      }
      return { name: f.name, displayName: displayName(f.name), isFolder: isFolderEntry, iconUrl, isExe, size: f.data.byteLength, addedAt: f.addedAt };
    });
    mapped.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
    setItems(mapped);
    setIsLoading(false);
  }, [fetchItems]);

  // Refresh on mount + listen for changes
  useEffect(() => { loadItems(); }, [loadItems]);
  useEffect(() => {
    const onRefresh = () => { loadItems(); };
    window.addEventListener('desktop-files-changed', onRefresh);
    return () => window.removeEventListener('desktop-files-changed', onRefresh);
  }, [loadItems]);

  // Compute folder contents for properties dialog
  useEffect(() => {
    if (Array.isArray(propertiesItem) || !propertiesItem?.isFolder) { setFolderContents(null); return; }
    const folderPrefix = propertiesItem.name.endsWith('/') ? propertiesItem.name : propertiesItem.name + '/';
    listFileMetadata().then(all => {
      let files = 0, folders = 0, totalSize = 0;
      for (const f of all) {
        if (!f.name.startsWith(folderPrefix)) continue;
        if (isFolder(f.name)) folders++; else { files++; totalSize += f.size; }
      }
      setFolderContents({ files, folders, totalSize });
    });
  }, [propertiesItem]);

  async function handleDelete(names: string[]) {
    for (const name of names) {
      if (isFolder(name)) await deleteFolder(name); else await deleteFile(name);
    }
    setConfirmDelete(null);
    setContextMenu(null);
    clearSelection();
    await loadItems();
    dispatchDesktopFilesChanged({ source: 'ui', deleted: names });
  }

  async function handleRename(oldName: string, newDisplayName: string) {
    setEditingName(null);
    const oldDisplay = displayName(oldName);
    if (newDisplayName === oldDisplay) return;
    const newName = prefix + newDisplayName + (isFolder(oldName) ? '/' : '');
    await renameEntry(oldName, newName);
    await loadItems();
    dispatchDesktopFilesChanged({ source: 'ui', added: [newName], deleted: [oldName] });
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
    selectOne(fullPath);
  }

  async function handleDropOnFolder(folderName: string, draggedPaths: string[]) {
    const folderPrefix = folderName.endsWith('/') ? folderName : folderName + '/';
    const added: string[] = [];
    const deleted: string[] = [];
    for (const draggedPath of draggedPaths) {
      if (draggedPath === folderName) continue;
      if (draggedPath.startsWith(folderPrefix)) continue;
      const dName = displayName(draggedPath);
      const isDir = isFolder(draggedPath);
      const newName = folderPrefix + dName + (isDir ? '/' : '');
      await renameEntry(draggedPath, newName);
      added.push(newName);
      deleted.push(draggedPath);
    }
    await loadItems();
    dispatchDesktopFilesChanged({ source: 'ui', added, deleted });
  }

  async function handleExternalDropOnFolder(folderName: string, e: DragEvent) {
    if (!e.dataTransfer) return;
    const folderPrefix = folderName.endsWith('/') ? folderName : folderName + '/';
    const droppedItems = await readDroppedItems(e.dataTransfer, folderPrefix);
    for (const item of droppedItems) await addFile(item.path, item.data);
    await loadItems();
  }

  return {
    items, setItems,
    isLoading,
    selected, setSelection, selectOne, selectToggle, selectRange, selectAll, clearSelection,
    anchor, setAnchor,
    focus,
    editingName, setEditingName,
    contextMenu, setContextMenu,
    bgContextMenu, setBgContextMenu,
    confirmDelete, setConfirmDelete, confirmFlash, setConfirmFlash,
    propertiesItem, setPropertiesItem, propsFlash, setPropsFlash,
    folderContents,
    loadItems,
    handleDelete, handleRename, handleNewFolder,
    handleDropOnFolder, handleExternalDropOnFolder,
    selectByKey,
  };
}
