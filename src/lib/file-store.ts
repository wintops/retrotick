import { openDB, FILES_META_STORE as META_STORE, FILES_DATA_STORE as DATA_STORE } from './idb';

export interface StoredFile {
  name: string;
  data: ArrayBuffer;
  addedAt: number;
}

export interface FileMetadata {
  name: string;
  size: number;
  addedAt: number;
}

/** Payload for the `desktop-files-changed` event. Listeners apply targeted
 *  updates instead of re-reading the entire store. `source` distinguishes
 *  emulator-originated saves from user-driven UI mutations: guest saves have
 *  already refreshed the FileManager's in-memory cache, so the emulator
 *  listener must not invalidate those entries. */
export interface DesktopFilesChangedDetail {
  source: 'guest' | 'ui';
  added?: string[];
  deleted?: string[];
}

/** Dispatch a `desktop-files-changed` CustomEvent with targeted payload. */
export function dispatchDesktopFilesChanged(detail: DesktopFilesChangedDetail): void {
  window.dispatchEvent(new CustomEvent('desktop-files-changed', { detail }));
}

/** List every file's name/size/addedAt without transferring ArrayBuffers. */
export async function listFileMetadata(): Promise<FileMetadata[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as FileMetadata[]);
    req.onerror = () => reject(req.error);
  });
}

/** Full file records (name + data + addedAt). Use listFileMetadata() whenever the
 *  caller does not actually need the ArrayBuffer — this function pays the full
 *  structured-clone cost of every stored binary. */
export async function getAllFiles(): Promise<StoredFile[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readonly');
    const metaReq = tx.objectStore(META_STORE).getAll();
    const dataReq = tx.objectStore(DATA_STORE).getAll();
    tx.oncomplete = () => {
      const metas = metaReq.result as FileMetadata[];
      const datas = dataReq.result as { name: string; data: ArrayBuffer }[];
      const byName = new Map<string, ArrayBuffer>();
      for (const d of datas) byName.set(d.name, d.data);
      const out: StoredFile[] = metas.map(m => ({
        name: m.name,
        data: byName.get(m.name) ?? new ArrayBuffer(0),
        addedAt: m.addedAt,
      }));
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function addFile(name: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(META_STORE).put({ name, size: data.byteLength, addedAt: Date.now() } satisfies FileMetadata);
    tx.objectStore(DATA_STORE).put({ name, data });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFile(name: string): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DATA_STORE, 'readonly');
    const req = tx.objectStore(DATA_STORE).get(name);
    req.onsuccess = () => resolve((req.result as { data: ArrayBuffer } | undefined)?.data ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(name);
    tx.objectStore(DATA_STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function isFolder(name: string): boolean {
  return name.endsWith('/');
}

export function displayName(name: string): string {
  // "myfolder/" → "myfolder", "parent/child/" → "child", "parent/file.exe" → "file.exe"
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
}

export async function addFolder(path: string): Promise<void> {
  const folderKey = path.endsWith('/') ? path : path + '/';
  await addFile(folderKey, new ArrayBuffer(0));
}

export async function deleteFolder(path: string): Promise<void> {
  const prefix = path.endsWith('/') ? path : path + '/';
  const metas = await listFileMetadata();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const dataStore = tx.objectStore(DATA_STORE);
    metaStore.delete(prefix);
    dataStore.delete(prefix);
    for (const m of metas) {
      if (m.name.startsWith(prefix)) {
        metaStore.delete(m.name);
        dataStore.delete(m.name);
      }
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveFile(oldName: string, newName: string): Promise<void> {
  const db = await openDB();
  // Read both old records, then in a fresh transaction delete the old pair and
  // insert the new pair. Splitting the read from the write keeps the upgrade
  // behaviour identical to the pre-split implementation.
  const oldMeta: FileMetadata | undefined = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(oldName);
    req.onsuccess = () => resolve(req.result as FileMetadata | undefined);
    req.onerror = () => reject(req.error);
  });
  const oldData: ArrayBuffer | null = await getFile(oldName);
  if (!oldMeta) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(oldName);
    tx.objectStore(DATA_STORE).delete(oldName);
    tx.objectStore(META_STORE).put({ name: newName, size: oldMeta.size, addedAt: oldMeta.addedAt } satisfies FileMetadata);
    tx.objectStore(DATA_STORE).put({ name: newName, data: oldData ?? new ArrayBuffer(0) });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameEntry(oldName: string, newName: string): Promise<void> {
  if (isFolder(oldName)) {
    // Rename folder: rename marker + all descendants
    const oldPrefix = oldName.endsWith('/') ? oldName : oldName + '/';
    const newPrefix = newName.endsWith('/') ? newName : newName + '/';
    const metas = await listFileMetadata();
    const toRename = metas.filter(m => m.name === oldPrefix || m.name.startsWith(oldPrefix));
    // Fetch the data for each renamed record outside the write transaction —
    // IDB transactions auto-commit when the event loop yields, and we need to
    // await a separate data fetch per entry.
    const dataByName = new Map<string, ArrayBuffer>();
    for (const m of toRename) {
      const d = await getFile(m.name);
      dataByName.set(m.name, d ?? new ArrayBuffer(0));
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
      const metaStore = tx.objectStore(META_STORE);
      const dataStore = tx.objectStore(DATA_STORE);
      for (const m of toRename) {
        metaStore.delete(m.name);
        dataStore.delete(m.name);
        const renamed = m.name === oldPrefix ? newPrefix : newPrefix + m.name.slice(oldPrefix.length);
        metaStore.put({ name: renamed, size: m.size, addedAt: m.addedAt } satisfies FileMetadata);
        dataStore.put({ name: renamed, data: dataByName.get(m.name)! });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    await moveFile(oldName, newName);
  }
}

export async function getRootItems(): Promise<StoredFile[]> {
  const all = await getAllFiles();
  return all.filter(f => {
    if (isFolder(f.name)) {
      // Root folder: exactly one slash at the end, e.g. "myfolder/"
      return f.name.indexOf('/') === f.name.length - 1;
    }
    // Root file: no slash at all
    return !f.name.includes('/');
  });
}

/** Read all files from a dropped DataTransfer, traversing folders recursively via webkitGetAsEntry. */
export async function readDroppedItems(dataTransfer: DataTransfer, prefix: string = ''): Promise<{ path: string; data: ArrayBuffer }[]> {
  const results: { path: string; data: ArrayBuffer }[] = [];
  const items = dataTransfer.items;
  if (!items) return results;

  function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
    return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  }

  async function traverse(entry: FileSystemEntry, pathPrefix: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject));
      results.push({ path: pathPrefix + file.name, data: await file.arrayBuffer() });
    } else if (entry.isDirectory) {
      const dirReader = (entry as FileSystemDirectoryEntry).createReader();
      const folderPath = pathPrefix + entry.name + '/';
      // Add folder marker
      results.push({ path: folderPath, data: new ArrayBuffer(0) });
      // Read all entries (readEntries may return partial results)
      let entries: FileSystemEntry[] = [];
      for (;;) {
        const batch = await readEntries(dirReader);
        if (batch.length === 0) break;
        entries = entries.concat(batch);
      }
      for (const child of entries) {
        await traverse(child, folderPath);
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) {
      await traverse(entry, prefix);
    } else {
      // Fallback for browsers without webkitGetAsEntry
      const file = items[i].getAsFile();
      if (file) {
        results.push({ path: prefix + file.name, data: await file.arrayBuffer() });
      }
    }
  }
  return results;
}

export async function copyEntry(sourceName: string, destName: string): Promise<void> {
  if (isFolder(sourceName)) {
    const oldPrefix = sourceName.endsWith('/') ? sourceName : sourceName + '/';
    const newPrefix = destName.endsWith('/') ? destName : destName + '/';
    const metas = await listFileMetadata();
    const toCopy = metas.filter(m => m.name === oldPrefix || m.name.startsWith(oldPrefix));
    const dataByName = new Map<string, ArrayBuffer>();
    for (const m of toCopy) {
      const d = await getFile(m.name);
      dataByName.set(m.name, d ?? new ArrayBuffer(0));
    }
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([META_STORE, DATA_STORE], 'readwrite');
      const metaStore = tx.objectStore(META_STORE);
      const dataStore = tx.objectStore(DATA_STORE);
      for (const m of toCopy) {
        const newName = m.name === oldPrefix ? newPrefix : newPrefix + m.name.slice(oldPrefix.length);
        const buf = dataByName.get(m.name)!;
        metaStore.put({ name: newName, size: buf.byteLength, addedAt: Date.now() } satisfies FileMetadata);
        dataStore.put({ name: newName, data: buf.slice(0) });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    const buf = await getFile(sourceName);
    if (!buf) return;
    await addFile(destName, buf.slice(0));
  }
}

export async function getItemsInFolder(prefix: string): Promise<StoredFile[]> {
  // Scan only entries whose key starts with `prefix` using a bounded key range.
  // The previous implementation called getAllFiles() and transferred every
  // file's ArrayBuffer to the main thread just to filter by name, which is
  // O(total store size) per folder open — noticeable once the store holds
  // many large EXEs.
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, DATA_STORE], 'readonly');
    const metaStore = tx.objectStore(META_STORE);
    const dataStore = tx.objectStore(DATA_STORE);
    // IDBKeyRange.bound(prefix, prefix + '\uffff') selects every key whose
    // string sort order falls between prefix and the highest BMP code point,
    // i.e. every entry whose name starts with prefix.
    const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
    const metaReq = metaStore.getAll(range);
    const dataReq = dataStore.getAll(range);
    tx.oncomplete = () => {
      const metas = metaReq.result as FileMetadata[];
      const datas = dataReq.result as { name: string; data: ArrayBuffer }[];
      const byName = new Map<string, ArrayBuffer>();
      for (const d of datas) byName.set(d.name, d.data);
      const out: StoredFile[] = [];
      for (const m of metas) {
        const rest = m.name.slice(prefix.length);
        if (!rest) continue; // the folder marker itself
        if (isFolder(m.name)) {
          // Direct child folder: rest is "name/" (no additional slash before the trailing one)
          if (rest.indexOf('/') === rest.length - 1) {
            out.push({ name: m.name, data: byName.get(m.name) ?? new ArrayBuffer(0), addedAt: m.addedAt });
          }
        } else if (!rest.includes('/')) {
          out.push({ name: m.name, data: byName.get(m.name) ?? new ArrayBuffer(0), addedAt: m.addedAt });
        }
      }
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}
