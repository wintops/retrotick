import { openDB, REGISTRY_STORE } from './idb';

export async function loadRegistry(): Promise<object | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGISTRY_STORE, 'readonly');
    const store = tx.objectStore(REGISTRY_STORE);
    const req = store.get('data');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRegistry(data: object): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(REGISTRY_STORE, 'readwrite');
    const store = tx.objectStore(REGISTRY_STORE);
    store.put(data, 'data');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
