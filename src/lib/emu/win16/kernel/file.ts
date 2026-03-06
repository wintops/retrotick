import type { Emulator, Win16Module } from '../../emulator';
import type { OpenFile } from '../../file-manager';
import type { KernelState } from './index';

export function registerKernelFile(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  const HFILE_ERROR = -1;
  const OF_READ = 0x0000;
  const OF_WRITE = 0x0001;
  const OF_READWRITE = 0x0002;
  const OF_CREATE = 0x1000;
  const OF_EXIST = 0x4000;
  const OF_DELETE = 0x0200;

  const FILE_BEGIN = 0;
  const FILE_CURRENT = 1;
  const FILE_END = 2;

  const fs = emu.fs;

  function openFileByPath(path: string, access: number): number {
    const resolved = emu.resolvePath(path);
    const existing = fs.findFile(resolved, emu.additionalFiles);
    if (!existing) {
      console.log(`[FILE16] openFileByPath("${path}") → resolved="${resolved}" → NOT FOUND`);
      return HFILE_ERROR;
    }
    let syncData: Uint8Array | null = null;
    const upper = resolved.toUpperCase();
    if (existing.source === 'external') {
      syncData = fs.externalFiles.get(upper)?.data ?? null;
    } else if (existing.source === 'additional') {
      const ab = emu.additionalFiles.get(existing.name);
      if (ab) syncData = new Uint8Array(ab);
    }
    console.log(`[FILE16] openFileByPath("${path}") → resolved="${upper}" source=${existing.source} size=${existing.size} data=${syncData ? syncData.length : 'null'}`);
    return emu.handles.alloc('file', {
      path: upper, access, pos: 0,
      data: syncData, size: existing.size, modified: false,
    } satisfies OpenFile);
  }

  function createFileByPath(path: string): number {
    const resolved = emu.resolvePath(path);
    const upper = resolved.toUpperCase();
    return emu.handles.alloc('file', {
      path: upper, access: 0x40000000, pos: 0,
      data: new Uint8Array(0), size: 0, modified: true,
    } satisfies OpenFile);
  }

  // --- Ordinal 85: _lopen(str word) — 6 bytes (str+word) ---
  kernel.register('_lopen', 6, () => {
    const [lpPathName, wReadWrite] = emu.readPascalArgs16([4, 2]);
    if (!lpPathName) return HFILE_ERROR;
    const path = emu.memory.readCString(emu.resolveFarPtr(lpPathName));
    return openFileByPath(path, wReadWrite);
  }, 85);

  // --- Ordinal 83: _lcreat(str word) — 6 bytes ---
  kernel.register('_lcreat', 6, () => {
    const [lpPathName, wAttr] = emu.readPascalArgs16([4, 2]);
    if (!lpPathName) return HFILE_ERROR;
    const path = emu.memory.readCString(emu.resolveFarPtr(lpPathName));
    return createFileByPath(path);
  }, 83);

  // --- Ordinal 82: _lread(hFile, lpBuffer_segptr, wBytes) — 8 bytes (word+segptr+word) ---
  kernel.register('_lread', 8, () => {
    const [hFile, lpBuffer, wBytes] = emu.readPascalArgs16([2, 4, 2]);
    const file = emu.handles.get<OpenFile>(hFile);
    console.log(`[FILE16] _lread(0x${hFile.toString(16)}, wBytes=${wBytes}) file=${file ? `pos=${file.pos} size=${file.size} data=${file.data ? file.data.length : 'null'}` : 'null'}`);
    if (!file || !file.data) return 0;
    const buf = emu.resolveFarPtr(lpBuffer);
    const avail = Math.min(wBytes, file.size - file.pos);
    for (let i = 0; i < avail; i++) {
      emu.memory.writeU8(buf + i, file.data[file.pos + i]);
    }
    file.pos += avail;
    return avail;
  }, 82);

  // --- Ordinal 86: _lwrite(hFile, lpBuffer_ptr, wBytes) — 8 bytes (word+ptr+word) ---
  kernel.register('_lwrite', 8, () => {
    const [hFile, lpBuffer, wBytes] = emu.readPascalArgs16([2, 4, 2]);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) return 0;
    const buf = emu.resolveFarPtr(lpBuffer);
    const endPos = file.pos + wBytes;
    if (!file.data || endPos > file.data.length) {
      const newBuf = new Uint8Array(Math.max(endPos, (file.data?.length || 0) * 2));
      if (file.data) newBuf.set(file.data);
      file.data = newBuf;
    }
    for (let i = 0; i < wBytes; i++) {
      file.data[file.pos + i] = emu.memory.readU8(buf + i);
    }
    file.pos = endPos;
    if (endPos > file.size) file.size = endPos;
    file.modified = true;
    return wBytes;
  }, 86);

  // --- Ordinal 81: _lclose(hFile) — 2 bytes (word) ---
  kernel.register('_lclose', 2, () => {
    const hFile = emu.readArg16(0);
    const file = emu.handles.get<OpenFile>(hFile);
    if (file) fs.persistOnClose(file);
    emu.handles.free(hFile);
    return 0;
  }, 81);

  // --- Ordinal 84: _llseek(word long word) — 8 bytes (word+long+word) ---
  kernel.register('_llseek', 8, () => {
    const [hFile, lOffset, iOrigin] = emu.readPascalArgs16([2, 4, 2]);
    const file = emu.handles.get<OpenFile>(hFile);
    if (!file) { console.log(`[FILE16] _llseek(0x${hFile.toString(16)}) → file not found!`); return HFILE_ERROR; }
    // lOffset is signed
    const offset = (lOffset | 0);
    if (iOrigin === FILE_BEGIN) file.pos = offset;
    else if (iOrigin === FILE_CURRENT) file.pos += offset;
    else if (iOrigin === FILE_END) file.pos = file.size + offset;
    if (file.pos < 0) file.pos = 0;
    console.log(`[FILE16] _llseek(0x${hFile.toString(16)}, ${offset}, ${iOrigin}) → pos=${file.pos} size=${file.size}`);
    return file.pos;
  }, 84);

  // --- Ordinal 74: OpenFile(lpFileName, lpReOpenBuf, uStyle) — 10 bytes (str+ptr+word) ---
  kernel.register('OpenFile', 10, () => {
    const [lpFileName, lpReOpenBuf, uStyle] = emu.readPascalArgs16([4, 4, 2]);
    const pathAddr = emu.resolveFarPtr(lpFileName);
    const path = pathAddr ? emu.memory.readCString(pathAddr) : '';
    const ofBuf = emu.resolveFarPtr(lpReOpenBuf);

    // Write OFSTRUCT: cBytes at offset 0, nErrCode at offset 2, szPathName at offset 8
    if (ofBuf) {
      emu.memory.writeU8(ofBuf, 136); // cBytes = sizeof(OFSTRUCT)
      // Write path into szPathName (offset 8, max 128 bytes)
      const maxPath = Math.min(path.length, 127);
      for (let i = 0; i < maxPath; i++) {
        emu.memory.writeU8(ofBuf + 8 + i, path.charCodeAt(i));
      }
      emu.memory.writeU8(ofBuf + 8 + maxPath, 0);
    }

    if (uStyle & OF_EXIST) {
      const resolved = emu.resolvePath(path);
      const existing = fs.findFile(resolved, emu.additionalFiles);
      if (!existing) {
        if (ofBuf) emu.memory.writeU16(ofBuf + 2, 2); // nErrCode = file not found
        return HFILE_ERROR;
      }
      if (ofBuf) emu.memory.writeU16(ofBuf + 2, 0);
      return 0; // file exists
    }

    if (uStyle & OF_DELETE) {
      const resolved = emu.resolvePath(path);
      fs.deleteFile(resolved);
      return 0;
    }

    if (uStyle & OF_CREATE) {
      const h = createFileByPath(path);
      if (ofBuf) emu.memory.writeU16(ofBuf + 2, h === HFILE_ERROR ? 2 : 0);
      return h;
    }

    // Default: open for reading
    const access = (uStyle & 0x03);
    const h = openFileByPath(path, access);
    if (ofBuf) emu.memory.writeU16(ofBuf + 2, h === HFILE_ERROR ? 2 : 0);
    return h;
  }, 74);

  // --- Ordinal 97: GetTempFileName(word str word ptr) — 12 bytes (word+str+word+ptr) ---
  kernel.register('GetTempFileName', 12, () => {
    const [drive, prefix, unique, lpTempFileName] = emu.readPascalArgs16([2, 4, 2, 4]);
    if (lpTempFileName) {
      const buf = emu.resolveFarPtr(lpTempFileName);
      const name = 'C:\\TEMP\\~TMP0001.TMP';
      for (let i = 0; i < name.length; i++) {
        emu.memory.writeU8(buf + i, name.charCodeAt(i));
      }
      emu.memory.writeU8(buf + name.length, 0);
    }
    return unique || 1;
  }, 97);

  // --- Ordinal 199: SetHandleCount(word) — 2 bytes ---
  kernel.register('SetHandleCount', 2, () => emu.readArg16(0), 199);
}
