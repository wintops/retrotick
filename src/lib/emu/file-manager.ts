/**
 * FileManager — pluggable virtual file system for the x86 emulator.
 *
 * Drive mapping:
 *   C:\ = system DLLs (additionalFiles on Emulator, read-only from FileManager's perspective)
 *   D:\ = desktop files (IndexedDB-backed via callbacks)
 *   Z:\ = browser file picker (external files)
 */

// ---- Public types ----

export interface FileInfo {
  name: string;
  size: number;
  source: 'virtual' | 'additional' | 'external';
}

export interface DirEntry {
  name: string;
  size: number;
  isDir: boolean;
}

export interface OpenFile {
  path: string;          // resolved uppercase path
  access: number;        // GENERIC_READ / GENERIC_WRITE
  pos: number;           // current file pointer
  data: Uint8Array | null; // null = not yet loaded from IndexedDB
  size: number;          // known size
  modified: boolean;     // written to?
}

// ---- Interface ----

export interface FileManager {
  /** Virtual files visible in D:\ (IndexedDB-backed metadata) */
  virtualFiles: { name: string; size: number }[];
  /** External files from browser file picker, mapped to Z:\ paths (uppercase key) */
  externalFiles: Map<string, { data: Uint8Array; name: string }>;
  /** Current drive letter (uppercase, e.g. 'D') */
  currentDrive: string;
  /** Per-drive current directory (drive letter → path, e.g. 'D' → 'D:\') */
  currentDirs: Map<string, string>;

  // ---- Callbacks (set by UI layer) ----
  onFileRequest?: (fileName: string) => Promise<ArrayBuffer | null>;
  onFileSave?: (fileName: string, data: ArrayBuffer) => void;
  onFileDelete?: (fileName: string) => void;
  onFileSaveExternal?: (name: string, data: ArrayBuffer) => void;

  /** Called when a modified file handle is closed — persists data */
  persistOnClose(file: OpenFile): void;

  // ---- Path operations ----
  resolvePath(input: string): string;
  normalizePath(path: string): string;

  /** Look up a file by resolved path. additionalFiles is passed for C:\ lookups. */
  findFile(resolved: string, additionalFiles: Map<string, ArrayBuffer>): FileInfo | null;

  /** Async fetch file data. */
  fetchFileData(file: FileInfo, additionalFiles: Map<string, ArrayBuffer>, resolvedPath?: string): Promise<ArrayBuffer | null>;

  /** Get WIN32 file attributes for a path. */
  getFileAttributes(pathStr: string, additionalFiles: Map<string, ArrayBuffer>): number;

  /** Get directory listing matching a glob pattern. */
  getVirtualDirListing(pattern: string, additionalFiles: Map<string, ArrayBuffer>): DirEntry[];

  // ---- File system mutations ----
  deleteFile(resolved: string): boolean;
  createDirectory(resolved: string): boolean;
  removeDirectory(resolved: string): boolean;

  /** Save a file to D:\ (updates virtualFiles + triggers onFileSave). */
  saveVirtualFile(storeName: string, data: Uint8Array): void;

  /** Remove a file from D:\ virtualFiles and trigger onFileDelete. */
  removeVirtualFile(srcRelPath: string, srcName: string): void;

  // ---- Helpers ----
  vfToRelPath(name: string): string;
  vfIsFolder(name: string): boolean;
}

// ---- Constants ----

const FILE_ATTRIBUTE_ARCHIVE = 0x20;
const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

const KNOWN_DIRS = new Set([
  'C:\\', 'C:\\WINDOWS', 'C:\\WINDOWS\\SYSTEM32', 'C:\\WINDOWS\\SYSTEM',
  'C:\\WINDOWS\\FONTS', 'C:\\WINDOWS\\TEMP', 'C:\\TEMP',
  'C:\\PROGRAM FILES', 'C:\\PROGRAM FILES\\COMMON FILES',
  'D:\\',
]);

// ---- Default implementation ----

export class DefaultFileManager implements FileManager {
  virtualFiles: { name: string; size: number }[] = [];
  externalFiles = new Map<string, { data: Uint8Array; name: string }>();
  /** In-memory cache for virtual file data (key = store name uppercase) */
  virtualFileCache = new Map<string, ArrayBuffer>();
  currentDrive = 'D';
  currentDirs = new Map<string, string>([['C', 'C:\\WINDOWS\\SYSTEM32'], ['D', 'D:\\']]);

  onFileRequest?: (fileName: string) => Promise<ArrayBuffer | null>;
  onFileSave?: (fileName: string, data: ArrayBuffer) => void;
  onFileDelete?: (fileName: string) => void;
  onFileSaveExternal?: (name: string, data: ArrayBuffer) => void;

  persistOnClose(file: OpenFile): void {
    // If file was modified and on D:\, save back via callback
    if (file.modified && file.data && file.path.startsWith('D:\\') && this.onFileSave) {
      const relPath = file.path.substring(3);
      const vf = this.virtualFiles.find(f => this.vfToRelPath(f.name) === relPath);
      const name = vf ? vf.name : relPath.replace(/\\/g, '/');
      if (vf) vf.size = file.data.length;
      const ab = file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer;
      this.virtualFileCache.set(name.toUpperCase(), ab);
      this.onFileSave(name, ab);
    }

    // If file was modified and on Z:\, update externalFiles and trigger browser download
    if (file.modified && file.data && file.path.startsWith('Z:\\')) {
      const ext = this.externalFiles.get(file.path);
      const name = ext ? ext.name : file.path.substring(3);
      this.externalFiles.set(file.path, { data: file.data, name });
      if (this.onFileSaveExternal) {
        this.onFileSaveExternal(name, file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer);
      }
    }
  }

  // ---- Path operations ----

  normalizePath(path: string): string {
    const drive = path.substring(0, 2);
    const rest = path.substring(2);
    const parts = rest.split('\\').filter(Boolean);
    const result: string[] = [];
    for (const part of parts) {
      if (part === '.') continue;
      if (part === '..') { if (result.length > 0) result.pop(); }
      else result.push(part);
    }
    return drive + '\\' + result.join('\\');
  }

  resolvePath(input: string): string {
    let p = input.replace(/\//g, '\\');
    p = p.replace(/(?!^)\\\\+/g, '\\');
    let resolved: string;
    if (/^[A-Za-z]:\\/.test(p)) {
      resolved = p;
    } else if (/^[A-Za-z]:$/.test(p)) {
      const drive = p[0].toUpperCase();
      resolved = this.currentDirs.get(drive) || (drive + ':\\');
    } else if (/^[A-Za-z]:/.test(p) && p[2] !== '\\') {
      const drive = p[0].toUpperCase();
      const rel = p.substring(2);
      const base = this.currentDirs.get(drive) || (drive + ':\\');
      resolved = base.endsWith('\\') ? base + rel : base + '\\' + rel;
    } else if (p.startsWith('\\')) {
      resolved = this.currentDrive + ':' + p;
    } else {
      const base = this.currentDirs.get(this.currentDrive) || (this.currentDrive + ':\\');
      resolved = base.endsWith('\\') ? base + p : base + '\\' + p;
    }
    if (resolved.includes('\\.') || resolved.includes('..')) {
      resolved = this.normalizePath(resolved);
    }
    return resolved;
  }

  // ---- Helpers ----

  vfToRelPath(name: string): string {
    let p = name.replace(/\//g, '\\').toUpperCase();
    if (p.endsWith('\\')) p = p.slice(0, -1);
    return p;
  }

  vfIsFolder(name: string): boolean {
    return name.endsWith('/');
  }

  // ---- File lookup ----

  findFile(resolved: string, additionalFiles: Map<string, ArrayBuffer>): FileInfo | null {
    const upper = resolved.toUpperCase();
    if (upper.startsWith('Z:\\')) {
      const ext = this.externalFiles.get(upper);
      if (ext) return { name: ext.name, size: ext.data.length, source: 'external' };
    }
    if (upper.startsWith('D:\\')) {
      const relPath = upper.substring(3);
      if (relPath) {
        for (const vf of this.virtualFiles) {
          if (this.vfIsFolder(vf.name)) continue;
          if (this.vfToRelPath(vf.name) === relPath) {
            return { name: vf.name, size: vf.size, source: 'virtual' };
          }
        }
        const baseName = relPath.includes('\\') ? relPath.substring(relPath.lastIndexOf('\\') + 1) : relPath;
        for (const [name, data] of additionalFiles) {
          const nameNorm = name.toUpperCase().replace(/\//g, '\\');
          const nameBase = nameNorm.includes('\\') ? nameNorm.substring(nameNorm.lastIndexOf('\\') + 1) : nameNorm;
          if (nameNorm === relPath || nameBase === baseName) return { name, size: data.byteLength, source: 'additional' };
        }
      }
    }
    for (const prefix of ['C:\\WINDOWS\\SYSTEM32\\', 'C:\\WINDOWS\\']) {
      if (upper.startsWith(prefix)) {
        const subPath = upper.substring(prefix.length);
        if (subPath) {
          const baseName = subPath.includes('\\') ? subPath.substring(subPath.lastIndexOf('\\') + 1) : subPath;
          for (const [name, data] of additionalFiles) {
            const nameNorm = name.toUpperCase().replace(/\//g, '\\');
            const nameBase = nameNorm.includes('\\') ? nameNorm.substring(nameNorm.lastIndexOf('\\') + 1) : nameNorm;
            if (nameNorm === subPath || nameBase === baseName) return { name, size: data.byteLength, source: 'additional' };
          }
        }
      }
    }
    return null;
  }

  fetchFileData(file: FileInfo, additionalFiles: Map<string, ArrayBuffer>, resolvedPath?: string): Promise<ArrayBuffer | null> {
    if (file.source === 'additional') {
      const data = additionalFiles.get(file.name);
      return Promise.resolve(data ?? null);
    }
    if (file.source === 'external' && resolvedPath) {
      const ext = this.externalFiles.get(resolvedPath.toUpperCase());
      if (ext) return Promise.resolve(ext.data.buffer.slice(ext.data.byteOffset, ext.data.byteOffset + ext.data.byteLength) as ArrayBuffer);
    }
    // Check in-memory cache first
    const cached = this.virtualFileCache.get(file.name.toUpperCase());
    if (cached) return Promise.resolve(cached);
    if (this.onFileRequest) {
      return this.onFileRequest(file.name).then(buf => {
        if (buf) this.virtualFileCache.set(file.name.toUpperCase(), buf);
        return buf;
      });
    }
    return Promise.resolve(null);
  }

  // ---- File attributes ----

  getFileAttributes(pathStr: string, additionalFiles: Map<string, ArrayBuffer>): number {
    let resolved = this.resolvePath(pathStr).toUpperCase();
    if (resolved.length > 3 && resolved.endsWith('\\')) resolved = resolved.slice(0, -1);
    if (/^[A-Z]:\\?$/.test(resolved)) return FILE_ATTRIBUTE_DIRECTORY;
    if (KNOWN_DIRS.has(resolved)) return FILE_ATTRIBUTE_DIRECTORY;
    if (resolved.startsWith('Z:\\')) {
      if (this.externalFiles.has(resolved)) return FILE_ATTRIBUTE_ARCHIVE;
    }
    if (resolved.startsWith('D:\\')) {
      const relPath = resolved.substring(3);
      if (relPath) {
        const folderStore = relPath.replace(/\\/g, '/') + '/';
        if (this.virtualFiles.some(f => f.name.toUpperCase() === folderStore)) {
          return FILE_ATTRIBUTE_DIRECTORY;
        }
        const dirPrefix = relPath.replace(/\\/g, '/') + '/';
        if (this.virtualFiles.some(f => f.name.toUpperCase().startsWith(dirPrefix) && f.name.toUpperCase() !== dirPrefix)) {
          return FILE_ATTRIBUTE_DIRECTORY;
        }
        for (const vf of this.virtualFiles) {
          if (this.vfIsFolder(vf.name)) continue;
          if (this.vfToRelPath(vf.name) === relPath) return FILE_ATTRIBUTE_ARCHIVE;
        }
      }
    }
    for (const prefix of ['C:\\WINDOWS\\SYSTEM32\\', 'C:\\WINDOWS\\']) {
      if (resolved.startsWith(prefix)) {
        const baseName = resolved.substring(prefix.length);
        if (baseName && !baseName.includes('\\')) {
          for (const [name] of additionalFiles) {
            if (name.toUpperCase() === baseName) return FILE_ATTRIBUTE_ARCHIVE;
          }
        }
      }
    }
    return INVALID_FILE_ATTRIBUTES;
  }

  // ---- Directory listing ----

  private matchesPattern(name: string, pattern: string): boolean {
    const pat = pattern.toUpperCase();
    const uName = name.toUpperCase();
    if (pat === '*.*' || pat === '*') return true;
    // Convert DOS wildcard pattern to regex: * = any chars, ? = any single char
    const regexStr = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`).test(uName);
  }

  getVirtualDirListing(pattern: string, additionalFiles: Map<string, ArrayBuffer>): DirEntry[] {
    const resolved = this.resolvePath(pattern).toUpperCase();
    const lastSlash = resolved.lastIndexOf('\\');
    const dirPart = lastSlash >= 0 ? resolved.substring(0, lastSlash + 1) : '';
    const filePat = lastSlash >= 0 ? resolved.substring(lastSlash + 1) : resolved;

    const results: DirEntry[] = [];

    if (dirPart.startsWith('D:\\')) {
      const dirRel = dirPart.substring(3);
      const storePrefix = dirRel.replace(/\\/g, '/');

      const seen = new Set<string>();
      for (const vf of this.virtualFiles) {
        const nameUpper = vf.name.toUpperCase();
        const nameSlash = nameUpper.replace(/\\/g, '/');
        if (!nameSlash.startsWith(storePrefix.toUpperCase())) continue;
        const rest = nameSlash.substring(storePrefix.length);
        if (!rest) continue;

        if (this.vfIsFolder(vf.name)) {
          const trimmed = rest.endsWith('/') ? rest.slice(0, -1) : rest;
          if (trimmed.includes('/')) continue;
          if (seen.has(trimmed)) continue;
          seen.add(trimmed);
          if (this.matchesPattern(trimmed, filePat)) {
            results.push({ name: trimmed, size: 0, isDir: true });
          }
        } else {
          if (rest.includes('/')) continue;
          const origRest = vf.name.replace(/\\/g, '/');
          const displayPart = origRest.substring(storePrefix.length);
          if (seen.has(rest)) continue;
          seen.add(rest);
          if (this.matchesPattern(rest, filePat)) {
            results.push({ name: displayPart, size: vf.size, isDir: false });
          }
        }
      }
    }

    if (dirPart === 'C:\\WINDOWS\\SYSTEM32\\' || dirPart === 'C:\\WINDOWS\\') {
      for (const [name, data] of additionalFiles) {
        if (this.matchesPattern(name, filePat)) {
          results.push({ name, size: data.byteLength, isDir: false });
        }
      }
    }

    // Also search additionalFiles for D:\ listings — these are companion files
    // loaded alongside the exe (e.g. .DAT files in the same directory)
    if (dirPart.startsWith('D:\\')) {
      const dirRel = dirPart.substring(3); // relative dir under D:\
      const seen = new Set(results.map(e => e.name.toUpperCase()));
      for (const [name, data] of additionalFiles) {
        const nameNorm = name.toUpperCase().replace(/\//g, '\\');
        // Check if this file is in the target directory
        const lastSep = nameNorm.lastIndexOf('\\');
        const fileDir = lastSep >= 0 ? nameNorm.substring(0, lastSep + 1) : '';
        const fileName = lastSep >= 0 ? nameNorm.substring(lastSep + 1) : nameNorm;
        if (fileDir !== dirRel.toUpperCase()) continue;
        if (seen.has(fileName)) continue;
        seen.add(fileName);
        if (this.matchesPattern(fileName, filePat)) {
          const displayName = lastSep >= 0 ? name.substring(lastSep + 1) : name;
          results.push({ name: displayName, size: data.byteLength, isDir: false });
        }
      }
    }

    // Synthesize subdirectory entries for known C:\ paths
    if (dirPart.startsWith('C:\\')) {
      const dirNorm = dirPart.endsWith('\\') ? dirPart.slice(0, -1) : dirPart;
      for (const kd of KNOWN_DIRS) {
        if (kd === dirNorm) continue; // skip self
        const parent = kd.substring(0, kd.lastIndexOf('\\'));
        if (parent === dirNorm) {
          const childName = kd.substring(kd.lastIndexOf('\\') + 1);
          if (childName && this.matchesPattern(childName, filePat)) {
            if (!results.some(e => e.name.toUpperCase() === childName.toUpperCase())) {
              results.push({ name: childName, size: 0, isDir: true });
            }
          }
        }
      }
    }

    // Always include "." and ".." for wildcard directory listings
    if (filePat === '*.*' || filePat === '*') {
      const hasDot = results.some(e => e.name === '.');
      const hasDotDot = results.some(e => e.name === '..');
      if (!hasDot) results.unshift({ name: '.', size: 0, isDir: true });
      if (!hasDotDot) results.splice(1, 0, { name: '..', size: 0, isDir: true });
    }

    return results;
  }

  // ---- File system mutations ----

  deleteFile(resolved: string): boolean {
    const upper = resolved.toUpperCase();
    if (!upper.startsWith('D:\\')) return false;
    const relPath = upper.substring(3);
    if (!relPath) return false;

    const idx = this.virtualFiles.findIndex(f => !this.vfIsFolder(f.name) && this.vfToRelPath(f.name) === relPath);
    if (idx < 0) return false;

    const name = this.virtualFiles[idx].name;
    this.virtualFiles.splice(idx, 1);
    this.virtualFileCache.delete(name.toUpperCase());
    if (this.onFileDelete) this.onFileDelete(name);
    return true;
  }

  createDirectory(resolved: string): boolean {
    let upper = resolved.toUpperCase();
    if (upper.endsWith('\\')) upper = upper.slice(0, -1);
    if (!upper.startsWith('D:\\')) return true; // pretend success for other drives
    const relPath = upper.substring(3);
    if (!relPath) return false;
    const storeName = relPath.replace(/\\/g, '/') + '/';
    if (this.virtualFiles.some(f => f.name.toUpperCase() === storeName)) return false;
    const name = storeName.toLowerCase();
    this.virtualFiles.push({ name, size: 0 });
    // Persist folder marker to IndexedDB
    if (this.onFileSave) this.onFileSave(name, new ArrayBuffer(0));
    return true;
  }

  removeDirectory(resolved: string): boolean {
    let upper = resolved.toUpperCase();
    if (upper.endsWith('\\')) upper = upper.slice(0, -1);
    if (!upper.startsWith('D:\\')) return true;
    const relPath = upper.substring(3);
    if (!relPath) return false;
    const storeName = relPath.replace(/\\/g, '/') + '/';
    const idx = this.virtualFiles.findIndex(f => f.name.toUpperCase() === storeName.toUpperCase());
    if (idx < 0) return false;
    const name = this.virtualFiles[idx].name;
    this.virtualFiles.splice(idx, 1);
    // Remove folder marker from IndexedDB
    if (this.onFileDelete) this.onFileDelete(name);
    return true;
  }

  saveVirtualFile(storeName: string, data: Uint8Array): void {
    const existing = this.virtualFiles.find(f => f.name.toUpperCase() === storeName.toUpperCase());
    if (existing) {
      existing.size = data.length;
    } else {
      this.virtualFiles.push({ name: storeName, size: data.length });
    }
    // Update in-memory cache
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    this.virtualFileCache.set(storeName.toUpperCase(), ab);
    if (this.onFileSave) {
      this.onFileSave(storeName, ab);
    }
  }

  removeVirtualFile(srcRelPath: string, srcName: string): void {
    const idx = this.virtualFiles.findIndex(f => !this.vfIsFolder(f.name) && this.vfToRelPath(f.name) === srcRelPath);
    if (idx >= 0) {
      this.virtualFileCache.delete(this.virtualFiles[idx].name.toUpperCase());
      this.virtualFiles.splice(idx, 1);
    }
    if (this.onFileDelete) this.onFileDelete(srcName);
  }
}
