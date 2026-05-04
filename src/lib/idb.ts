/**
 * Centralized IndexedDB opener shared by every module that persists to the
 * `exeviewer` database. Before this module existed, file-store, registry-db
 * and profile-db each called `indexedDB.open(DB_NAME, N)` with their own
 * DB_VERSION and their own `onupgradeneeded` handler. Any time one of them
 * bumped the version, the others would throw `VersionError` on next open
 * because IDB refuses to open a database at a lower version than the one
 * currently on disk — and whichever module happened to open first also got
 * to decide which migration logic ran, which is obviously unsafe.
 *
 * All schema changes must go through this file.
 */

const DB_NAME = 'exeviewer';
export const DB_VERSION = 4;

export const FILES_META_STORE = 'filesMeta';
export const FILES_DATA_STORE = 'filesData';
export const REGISTRY_STORE = 'registry';
export const PROFILES_STORE = 'profiles';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const tx = req.transaction!;

      if (!db.objectStoreNames.contains(REGISTRY_STORE)) {
        db.createObjectStore(REGISTRY_STORE);
      }
      if (!db.objectStoreNames.contains(PROFILES_STORE)) {
        db.createObjectStore(PROFILES_STORE);
      }

      const needsMeta = !db.objectStoreNames.contains(FILES_META_STORE);
      const needsData = !db.objectStoreNames.contains(FILES_DATA_STORE);
      if (needsMeta) db.createObjectStore(FILES_META_STORE, { keyPath: 'name' });
      if (needsData) db.createObjectStore(FILES_DATA_STORE, { keyPath: 'name' });

      // v3 had a monolithic `files` store holding {name, data, addedAt}.
      // Split it into filesMeta + filesData so syncing the virtual file
      // listing at emulator launch no longer pays the structured-clone cost
      // of every stored binary.
      const prev = ev.oldVersion;
      const hadOldStore = db.objectStoreNames.contains('files');
      if (prev > 0 && prev < 4 && hadOldStore) {
        const oldStore = tx.objectStore('files');
        const metaStore = tx.objectStore(FILES_META_STORE);
        const dataStore = tx.objectStore(FILES_DATA_STORE);
        oldStore.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const rec = cursor.value as { name: string; data: ArrayBuffer; addedAt: number };
            const size = rec.data?.byteLength ?? 0;
            metaStore.put({ name: rec.name, size, addedAt: rec.addedAt ?? Date.now() });
            dataStore.put({ name: rec.name, data: rec.data ?? new ArrayBuffer(0) });
            cursor.continue();
          } else if (db.objectStoreNames.contains('files')) {
            db.deleteObjectStore('files');
          }
        };
      } else if (hadOldStore) {
        db.deleteObjectStore('files');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB open blocked'));
    };
  });
  return dbPromise;
}
