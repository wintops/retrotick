export interface StoredFile {
  name: string;
  data: ArrayBuffer;
  addedAt: number;
}

const DB_NAME = 'exeviewer';
const STORE_NAME = 'files';
const DB_VERSION = 3;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('registry')) {
        db.createObjectStore('registry');
      }
      if (!db.objectStoreNames.contains('profiles')) {
        db.createObjectStore('profiles');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllFiles(): Promise<StoredFile[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function addFile(name: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ name, data, addedAt: Date.now() } satisfies StoredFile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getFile(name: string): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(name);
    req.onsuccess = () => resolve(req.result?.data ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteFile(name: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(name);
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
  const all = await getAllFiles();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Delete the folder marker and all descendants
    store.delete(prefix);
    for (const f of all) {
      if (f.name.startsWith(prefix)) store.delete(f.name);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveFile(oldName: string, newName: string): Promise<void> {
  const db = await openDB();
  const data: StoredFile | undefined = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(oldName);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!data) return;
  const db2 = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db2.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(oldName);
    store.put({ name: newName, data: data.data, addedAt: data.addedAt } satisfies StoredFile);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function renameEntry(oldName: string, newName: string): Promise<void> {
  if (isFolder(oldName)) {
    // Rename folder: rename marker + all descendants
    const oldPrefix = oldName.endsWith('/') ? oldName : oldName + '/';
    const newPrefix = newName.endsWith('/') ? newName : newName + '/';
    const all = await getAllFiles();
    const toRename = all.filter(f => f.name === oldPrefix || f.name.startsWith(oldPrefix));
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const f of toRename) {
        store.delete(f.name);
        const renamed = f.name === oldPrefix ? newPrefix : newPrefix + f.name.slice(oldPrefix.length);
        store.put({ name: renamed, data: f.data, addedAt: f.addedAt } satisfies StoredFile);
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
  const all = await getAllFiles();
  if (isFolder(sourceName)) {
    const oldPrefix = sourceName.endsWith('/') ? sourceName : sourceName + '/';
    const newPrefix = destName.endsWith('/') ? destName : destName + '/';
    const toCopy = all.filter(f => f.name === oldPrefix || f.name.startsWith(oldPrefix));
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const f of toCopy) {
        const newName = f.name === oldPrefix ? newPrefix : newPrefix + f.name.slice(oldPrefix.length);
        store.put({ name: newName, data: f.data.slice(0), addedAt: Date.now() } satisfies StoredFile);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } else {
    const f = all.find(s => s.name === sourceName);
    if (!f) return;
    await addFile(destName, f.data.slice(0));
  }
}

export async function getItemsInFolder(prefix: string): Promise<StoredFile[]> {
  const all = await getAllFiles();
  return all.filter(f => {
    if (!f.name.startsWith(prefix)) return false;
    const rest = f.name.slice(prefix.length);
    if (!rest) return false;
    if (isFolder(f.name)) {
      // Direct child folder: rest is "name/" (no additional slash before the trailing one)
      return rest.indexOf('/') === rest.length - 1;
    }
    // Direct child file: no slash in rest
    return !rest.includes('/');
  });
}
