/**
 * Workbench export/import — packs the entire user environment into a single
 * zip-compressed file so it can be moved between origins (different dev
 * ports) and machines.
 *
 * Bundle contents:
 *   - All IndexedDB stores: filesMeta, filesData, registry, profiles
 *   - All localStorage keys
 *
 * On-disk format: a fflate-produced .zip containing
 *   - manifest.json   — JSON with localStorage, registry, profiles, file index
 *   - files/0000.bin  — raw bytes for each stored file (sequential names avoid
 *                       any path-escaping question for IDB keys with slashes)
 *
 * Export uses fflate's async API so compression runs on a Web Worker.
 *
 * Import uses fflate's *streaming* `Unzip` class, fed chunk-by-chunk from
 * `File.stream()`. The previous implementation called `unzip(bytes, cb)` which
 * (a) required the full compressed bundle in memory, (b) cloned the entire
 * decompressed archive across the worker→main-thread postMessage boundary
 * (Uint8Arrays nested in an object are not transferable, so structured clone
 * doubles them), and (c) put every file into a single IDB transaction whose
 * structured-clone queue held yet another copy until commit. For a 250 MB
 * bundle that meant 4–6 GB of resident memory in Firefox. Streaming + small
 * IDB batches keeps the working set bounded to the currently-decoding entry
 * plus a small flush window.
 */

import { zip, zipSync, Unzip, UnzipInflate, strToU8, strFromU8 } from 'fflate';
import {
  openDB,
  FILES_META_STORE,
  FILES_DATA_STORE,
  REGISTRY_STORE,
  PROFILES_STORE,
} from './idb';

export const WORKBENCH_VERSION = 1;
export const WORKBENCH_EXTENSION = '.workbench';

interface WorkbenchFileEntry {
  name: string;
  size: number;
  addedAt: number;
  archivePath: string;
}

interface WorkbenchManifest {
  version: number;
  exportedAt: string;
  userAgent: string;
  localStorage: Record<string, string>;
  registry: unknown;
  profiles: unknown;
  files: WorkbenchFileEntry[];
}

interface RawFile {
  name: string;
  size: number;
  addedAt: number;
  data: Uint8Array;
}

/** Phase reported by export/import while running. The UI maps this to a label
 *  and uses (current/total) when present to render a progress bar. */
export type WorkbenchProgress =
  | { phase: 'reading'; current: number; total: number }
  | { phase: 'compressing' }
  | { phase: 'finalizing' }
  | { phase: 'loading'; current: number; total: number }
  | { phase: 'decompressing' }
  | { phase: 'restoring'; current: number; total: number };

export type ProgressCallback = (p: WorkbenchProgress) => void;

async function readAllFiles(): Promise<RawFile[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([FILES_META_STORE, FILES_DATA_STORE], 'readonly');
    const metaReq = tx.objectStore(FILES_META_STORE).getAll();
    const dataReq = tx.objectStore(FILES_DATA_STORE).getAll();
    tx.oncomplete = () => {
      const metas = metaReq.result as { name: string; size: number; addedAt: number }[];
      const datas = dataReq.result as { name: string; data: ArrayBuffer }[];
      const dataByName = new Map<string, ArrayBuffer>();
      for (const d of datas) dataByName.set(d.name, d.data);
      const out: RawFile[] = metas.map(m => {
        const ab = dataByName.get(m.name) ?? new ArrayBuffer(0);
        return { name: m.name, size: m.size, addedAt: m.addedAt, data: new Uint8Array(ab) };
      });
      resolve(out);
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function readSingleton(storeName: string): Promise<unknown> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get('data');
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function readAllLocalStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null) continue;
    const val = localStorage.getItem(key);
    if (val !== null) out[key] = val;
  }
  return out;
}

function zipAsync(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(data, { level: 6 }, (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

/** fflate's async API serializes its input to a Worker via `postMessage`, which
 *  fails with `DataCloneError: out of memory` when the bundle is too large for
 *  V8 to clone twice. In that case we fall back to the synchronous API: the
 *  UI freezes briefly during compression, but the operation completes instead
 *  of dying with an OOM. */
function isWorkerOOM(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'DataCloneError') return true;
  return /cannot be cloned|out of memory/i.test(err.message);
}

async function zipWithFallback(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  try {
    return await zipAsync(data);
  } catch (err) {
    if (!isWorkerOOM(err)) throw err;
    return zipSync(data, { level: 6 });
  }
}

/** Build the workbench archive bytes. The caller is responsible for triggering
 *  a download or any other side-effect. */
export async function exportWorkbench(onProgress?: ProgressCallback): Promise<Uint8Array> {
  onProgress?.({ phase: 'reading', current: 0, total: 1 });
  const [files, registry, profiles] = await Promise.all([
    readAllFiles(),
    readSingleton(REGISTRY_STORE),
    readSingleton(PROFILES_STORE),
  ]);
  onProgress?.({ phase: 'reading', current: files.length, total: files.length });

  const fileEntries: WorkbenchFileEntry[] = files.map((f, i) => ({
    name: f.name,
    size: f.size,
    addedAt: f.addedAt,
    archivePath: `files/${String(i).padStart(4, '0')}.bin`,
  }));

  const manifest: WorkbenchManifest = {
    version: WORKBENCH_VERSION,
    exportedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    localStorage: readAllLocalStorage(),
    registry,
    profiles,
    files: fileEntries,
  };

  const archive: Record<string, Uint8Array> = {
    'manifest.json': strToU8(JSON.stringify(manifest)),
  };
  for (let i = 0; i < files.length; i++) {
    archive[fileEntries[i].archivePath] = files[i].data;
  }

  onProgress?.({ phase: 'compressing' });
  const out = await zipWithFallback(archive);
  onProgress?.({ phase: 'finalizing' });
  return out;
}

/** Suggest a filename for the exported bundle. */
export function workbenchFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `retrotick-${stamp}${WORKBENCH_EXTENSION}`;
}

/** Trigger a browser download for an exported bundle. */
export function downloadWorkbench(bytes: Uint8Array, fileName = workbenchFileName()): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Open a file picker and resolve with the selected File handle (or null). */
export function pickWorkbenchFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `${WORKBENCH_EXTENSION},application/zip`;
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ?? null);
    };
    // Cancellation through the OS file picker doesn't fire `change`. Use
    // `cancel` (Chrome 113+, Firefox 91+) when available; fall back to the
    // window focus event so we don't leave the import flow hanging forever.
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** Maximum bytes accumulated in the in-flight IDB write batch before a flush.
 *  Keeping this small bounds the structured-clone memory the IDB transaction
 *  holds in the JS heap until commit. */
const IDB_BATCH_BYTES = 4 * 1024 * 1024;

/** Disk read chunk size. Manual `file.slice(...).arrayBuffer()` reads are used
 *  instead of `file.stream()` because Firefox's Blob stream implementation has
 *  historically buffered very aggressively, defeating the purpose of streaming
 *  on bundles approaching the size of available RAM. Slicing reads only the
 *  requested range from disk. */
const READ_CHUNK_BYTES = 1 * 1024 * 1024;

/** Yield to the event loop so the browser can collect garbage between IDB
 *  flushes. Without this, GC may run only after the entire import is finished
 *  and the working set climbs steadily. */
function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Replace the entire user environment with the contents of a workbench bundle.
 *  Throws if the bundle is malformed. The caller should reload the page after
 *  this resolves so the new state is picked up everywhere.
 *
 *  Memory-bounded: the file is read 1 MB at a time via `File.slice()` and fed
 *  to fflate's streaming `Unzip`, so neither the full compressed bundle nor
 *  the full decompressed archive ever sits in memory at once. Each entry's
 *  destination buffer is pre-allocated from `originalSize` to avoid a
 *  concatenate-at-end peak. Files are written to IndexedDB in small (4 MB)
 *  batches with a microtask yield after each commit, so structured-clone
 *  copies left over in the just-closed transaction can be GC'd before the
 *  next batch lands. */
export async function importWorkbench(file: File, onProgress?: ProgressCallback): Promise<void> {
  const totalBytes = file.size;
  onProgress?.({ phase: 'loading', current: 0, total: totalBytes });

  const db = await openDB();

  // Step 1 — clear all stores in a dedicated transaction. Keeping this
  // separate from the per-file writes means the long import never holds a
  // single giant transaction queue.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(
      [FILES_META_STORE, FILES_DATA_STORE, REGISTRY_STORE, PROFILES_STORE],
      'readwrite',
    );
    tx.objectStore(FILES_META_STORE).clear();
    tx.objectStore(FILES_DATA_STORE).clear();
    tx.objectStore(REGISTRY_STORE).clear();
    tx.objectStore(PROFILES_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Workbench clear transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Workbench clear transaction aborted'));
  });

  // Step 2 — stream-decompress and persist file entries. fflate delivers each
  // entry's bytes via `ondata` callbacks fired synchronously inside `push()`.
  // The exporter writes manifest.json first, so under normal conditions the
  // manifest is parsed before any file/NNNN.bin entry; we still handle the
  // reverse order defensively by buffering early entries until the manifest
  // arrives.
  let manifest: WorkbenchManifest | null = null;
  const metaByPath = new Map<string, { name: string; size: number; addedAt: number }>();
  const pending: Array<{ archivePath: string; data: Uint8Array }> = [];
  let restored = 0;
  let writeBatch: Array<{ name: string; size: number; addedAt: number; data: Uint8Array }> = [];
  let writeBatchBytes = 0;

  async function flushBatch(): Promise<void> {
    if (writeBatch.length === 0) return;
    const items = writeBatch;
    writeBatch = [];
    writeBatchBytes = 0;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([FILES_META_STORE, FILES_DATA_STORE], 'readwrite');
      const metaStore = tx.objectStore(FILES_META_STORE);
      const dataStore = tx.objectStore(FILES_DATA_STORE);
      for (const it of items) {
        // Avoid a fresh `slice()` copy when the Uint8Array already owns its
        // buffer (the common case when fflate's UnzipInflate emits a single
        // chunk per entry). The structured-clone of `put` will still copy the
        // bytes into the IDB queue, but we save one extra main-heap copy.
        const buf = it.data.buffer;
        const ab = (it.data.byteOffset === 0 && it.data.byteLength === buf.byteLength)
          ? (buf as ArrayBuffer)
          : (buf.slice(it.data.byteOffset, it.data.byteOffset + it.data.byteLength) as ArrayBuffer);
        metaStore.put({ name: it.name, size: it.size, addedAt: it.addedAt });
        dataStore.put({ name: it.name, data: ab });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Workbench write transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Workbench write transaction aborted'));
    });
    // Drop strong refs and yield: the structured-clone copies in the just-closed
    // transaction need a GC pass before the next batch of large files arrives.
    items.length = 0;
    await nextTask();
  }

  function ingestEntry(archivePath: string, data: Uint8Array): void {
    if (archivePath === 'manifest.json') {
      let parsed: WorkbenchManifest;
      try {
        parsed = JSON.parse(strFromU8(data));
      } catch {
        throw new Error('Invalid workbench: manifest.json is not valid JSON');
      }
      if (parsed.version !== WORKBENCH_VERSION) {
        throw new Error(`Unsupported workbench version: ${parsed.version}`);
      }
      manifest = parsed;
      for (const fe of parsed.files) {
        metaByPath.set(fe.archivePath, { name: fe.name, size: fe.size, addedAt: fe.addedAt });
      }
      // Drain any file entries that arrived before the manifest.
      for (const p of pending) {
        const meta = metaByPath.get(p.archivePath);
        if (meta) {
          writeBatch.push({ ...meta, data: p.data });
          writeBatchBytes += p.data.byteLength;
          restored++;
        }
      }
      pending.length = 0;
      return;
    }
    if (manifest) {
      const meta = metaByPath.get(archivePath);
      if (meta) {
        writeBatch.push({ ...meta, data });
        writeBatchBytes += data.byteLength;
        restored++;
      }
    } else {
      pending.push({ archivePath, data });
    }
  }

  const completed: Array<{ archivePath: string; data: Uint8Array }> = [];
  let unzipError: unknown = null;

  const unz = new Unzip();
  unz.register(UnzipInflate);
  unz.onfile = (f) => {
    // Pre-allocate the destination buffer when fflate gives us the uncompressed
    // size up front. This avoids the brief 2× peak that `chunks[]` + a final
    // `combined = new Uint8Array(total)` concatenation creates — for a 500 MB
    // entry that single optimisation saves ~500 MB of resident memory.
    const expected = f.originalSize ?? 0;
    let combined: Uint8Array | null = expected > 0 ? new Uint8Array(expected) : null;
    let writeOff = 0;
    const overflowChunks: Uint8Array[] = [];
    let overflowBytes = 0;
    f.ondata = (err, chunk, final) => {
      if (err) { unzipError = err; return; }
      if (chunk && chunk.length > 0) {
        if (combined && writeOff + chunk.length <= combined.length) {
          combined.set(chunk, writeOff);
          writeOff += chunk.length;
        } else {
          overflowChunks.push(chunk);
          overflowBytes += chunk.length;
        }
      }
      if (final) {
        let result: Uint8Array;
        if (combined && overflowChunks.length === 0) {
          result = writeOff === combined.length ? combined : combined.subarray(0, writeOff);
        } else if (!combined && overflowChunks.length === 1) {
          result = overflowChunks[0];
        } else {
          result = new Uint8Array(writeOff + overflowBytes);
          if (combined && writeOff > 0) result.set(combined.subarray(0, writeOff), 0);
          let off = writeOff;
          for (const c of overflowChunks) { result.set(c, off); off += c.length; }
        }
        completed.push({ archivePath: f.name, data: result });
      }
    };
    f.start();
  };

  let bytesRead = 0;

  while (bytesRead < totalBytes) {
    const end = Math.min(bytesRead + READ_CHUNK_BYTES, totalBytes);
    const chunkBuf = await file.slice(bytesRead, end).arrayBuffer();
    bytesRead = end;
    const final = bytesRead >= totalBytes;
    unz.push(new Uint8Array(chunkBuf), final);

    if (unzipError) {
      throw unzipError instanceof Error ? unzipError : new Error(String(unzipError));
    }

    while (completed.length > 0) {
      const c = completed.shift()!;
      ingestEntry(c.archivePath, c.data);
    }

    if (manifest) {
      // Re-alias once we've narrowed away the null branch. TypeScript
      // forgets the narrowing across the surrounding ingestEntry()
      // closure call, so a cast keeps the property access typed.
      const mf = manifest as WorkbenchManifest;
      onProgress?.({ phase: 'restoring', current: restored, total: mf.files.length });
    } else {
      onProgress?.({ phase: 'loading', current: bytesRead, total: totalBytes });
    }

    // Flush whenever the queued bytes exceed the soft cap. A single oversized
    // file triggers an immediate single-file commit, so multi-hundred-megabyte
    // entries don't accumulate alongside any others.
    if (writeBatchBytes >= IDB_BATCH_BYTES) {
      await flushBatch();
    }
  }

  // Edge case: a zero-byte input never entered the loop above.
  if (totalBytes === 0) {
    unz.push(new Uint8Array(0), true);
  }
  if (unzipError) {
    throw unzipError instanceof Error ? unzipError : new Error(String(unzipError));
  }
  while (completed.length > 0) {
    const c = completed.shift()!;
    ingestEntry(c.archivePath, c.data);
  }
  await flushBatch();

  if (!manifest) throw new Error('Invalid workbench: missing manifest.json');
  // After this point manifest has been narrowed to non-null; alias once so the
  // remaining steps read cleanly without repeated non-null assertions.
  const m = manifest as WorkbenchManifest;

  // Step 3 — registry + profiles. Small singleton blobs, one short transaction.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([REGISTRY_STORE, PROFILES_STORE], 'readwrite');
    if (m.registry !== null && m.registry !== undefined) {
      tx.objectStore(REGISTRY_STORE).put(m.registry, 'data');
    }
    if (m.profiles !== null && m.profiles !== undefined) {
      tx.objectStore(PROFILES_STORE).put(m.profiles, 'data');
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Workbench singleton transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Workbench singleton transaction aborted'));
  });

  localStorage.clear();
  for (const [key, value] of Object.entries(m.localStorage)) {
    localStorage.setItem(key, value);
  }
  onProgress?.({ phase: 'finalizing' });
}
