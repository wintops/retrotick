import { openDB, PROFILES_STORE } from './idb';

export async function loadProfiles(): Promise<object | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, 'readonly');
    const store = tx.objectStore(PROFILES_STORE);
    const req = store.get('data');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProfiles(data: object): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(PROFILES_STORE, 'readwrite');
    const store = tx.objectStore(PROFILES_STORE);
    store.put(data, 'data');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
