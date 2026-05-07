/**
 * Helpers for "Download" right-click actions on desktop / folder items.
 *
 * Single non-folder file → blob download with the original name.
 * Folder, multi-selection or any combination → zipped bundle (fflate level 6),
 * with progress events the UI can wire into the existing ProgressDialog.
 */

import { zip, zipSync, type AsyncZipOptions, type ZipOptions } from 'fflate';
import { listFileMetadata, getFile, isFolder, displayName, type FileMetadata } from './file-store';
import type { WorkbenchProgress } from './workbench';

/** Reuse the workbench progress shape — the phases we report (reading,
 *  compressing, finalizing) are a strict subset, so the same ProgressDialog
 *  rendering handles both flows. */
export type DownloadProgress = Extract<WorkbenchProgress,
  { phase: 'reading' } | { phase: 'compressing' } | { phase: 'finalizing' }>;

export type DownloadProgressCallback = (p: DownloadProgress) => void;

/** Item descriptor shared by Desktop and FolderWindow context menus. */
export interface DownloadItem {
  /** Full IDB key (e.g. "MyFolder/sub/file.exe" or "MyFolder/" for a folder). */
  name: string;
  isFolder: boolean;
}

const ZIP_LEVEL = 6;

function isOOM(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'DataCloneError') return true;
  return /cannot be cloned|out of memory/i.test(err.message);
}

function zipAsync(data: Record<string, Uint8Array>, opts: AsyncZipOptions): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(data, opts, (err, output) => {
      if (err) reject(err);
      else resolve(output);
    });
  });
}

/** Try fflate's worker-backed `zip`; on OOM during postMessage, fall back to
 *  the synchronous variant so the operation still completes. */
async function zipWithFallback(data: Record<string, Uint8Array>): Promise<Uint8Array> {
  try {
    return await zipAsync(data, { level: ZIP_LEVEL });
  } catch (err) {
    if (!isOOM(err)) throw err;
    return zipSync(data, { level: ZIP_LEVEL } satisfies ZipOptions);
  }
}

/** Trigger a browser download for a Blob/Uint8Array with the given filename. */
export function triggerDownload(data: Uint8Array | Blob, fileName: string): void {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Sanitize a string for use as a filename (strip path separators and reserved chars). */
function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'download';
}

/** Resolve every concrete file (no folder markers) under the given items.
 *  Folder items expand to all their descendants. The returned `relPath` is
 *  the path relative to the user's current view, used as the entry name in
 *  the produced ZIP. */
async function expandToFiles(items: DownloadItem[]): Promise<{ idbKey: string; relPath: string }[]> {
  const allMeta = await listFileMetadata();
  const out: { idbKey: string; relPath: string }[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (!item.isFolder) {
      if (seen.has(item.name)) continue;
      seen.add(item.name);
      out.push({ idbKey: item.name, relPath: displayName(item.name) });
      continue;
    }
    // Folder: include every descendant. Strip the folder's parent prefix so
    // the zip preserves the folder structure starting at the folder name.
    const folderKey = item.name.endsWith('/') ? item.name : item.name + '/';
    const folderRoot = folderKey.replace(/\/$/, '');
    const lastSlash = folderRoot.lastIndexOf('/');
    const stripPrefix = lastSlash >= 0 ? folderRoot.slice(0, lastSlash + 1) : '';
    for (const m of allMeta) {
      if (!m.name.startsWith(folderKey) || isFolder(m.name)) continue;
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      out.push({ idbKey: m.name, relPath: m.name.slice(stripPrefix.length) });
    }
  }
  return out;
}

/** Download a single file directly with its display name. */
export async function downloadSingleFile(name: string): Promise<void> {
  const buf = await getFile(name);
  if (!buf) throw new Error(`File not found: ${name}`);
  triggerDownload(new Uint8Array(buf), displayName(name));
}

/** Bundle a set of items (files and/or folders) into a ZIP and trigger a download.
 *  The archive name is derived: a single folder uses its name, a single file
 *  the file's name with `.zip` appended; a multi-selection uses
 *  `retrotick-selection.zip`. */
export async function downloadItemsAsZip(
  items: DownloadItem[],
  onProgress?: DownloadProgressCallback,
): Promise<void> {
  if (items.length === 0) return;

  onProgress?.({ phase: 'reading', current: 0, total: 1 });
  const files = await expandToFiles(items);
  if (files.length === 0) {
    // Empty folder(s): produce an empty zip so the user still gets feedback.
  }
  onProgress?.({ phase: 'reading', current: 0, total: files.length });

  const archive: Record<string, Uint8Array> = {};
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const buf = await getFile(f.idbKey);
    archive[f.relPath] = buf ? new Uint8Array(buf) : new Uint8Array(0);
    onProgress?.({ phase: 'reading', current: i + 1, total: files.length });
  }

  onProgress?.({ phase: 'compressing' });
  const zipped = await zipWithFallback(archive);
  onProgress?.({ phase: 'finalizing' });

  const archiveName = pickArchiveName(items);
  triggerDownload(zipped, archiveName);
}

function pickArchiveName(items: DownloadItem[]): string {
  if (items.length === 1) {
    const only = items[0];
    const base = safeFileName(displayName(only.name));
    return `${base}.zip`;
  }
  return 'retrotick-selection.zip';
}

/** Decide whether the selection should download as a single raw file or a ZIP.
 *  Single non-folder file → raw; anything else → ZIP. */
export function shouldDownloadAsZip(items: DownloadItem[]): boolean {
  if (items.length !== 1) return true;
  return items[0].isFolder;
}

/** Reuse-only: re-expose for tests / future use. */
export type { FileMetadata };
