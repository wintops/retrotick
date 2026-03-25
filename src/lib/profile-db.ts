const DB_NAME = 'exeviewer';
const DB_VERSION = 3;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'name' });
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

export async function loadProfiles(): Promise<object | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profiles', 'readonly');
    const store = tx.objectStore('profiles');
    const req = store.get('data');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProfiles(data: object): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profiles', 'readwrite');
    const store = tx.objectStore('profiles');
    store.put(data, 'data');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
