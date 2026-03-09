import type { Emulator } from '../emulator';

export function registerWin16Lzexpand(emu: Emulator): void {
  const lz = emu.registerModule16('LZEXPAND');

  const LZERROR_BADINHANDLE = -1;

  // Ordinal 1: LZCopy(hfSource, hfDest) — 4 bytes (word+word)
  // Copies (and decompresses) source to dest. Return bytes written or error.
  lz.register('LZCopy', 4, () => {
    const [hfSource, hfDest] = emu.readPascalArgs16([2, 2]);
    // Stub: return 0 bytes copied
    return 0;
  }, 1);

  // Ordinal 2: LZOpenFile(lpFileName, lpReOpenBuf, wStyle) — 10 bytes (ptr+ptr+word)
  // Opens a file (possibly compressed). Returns file handle or error.
  lz.register('LZOpenFile', 10, () => {
    const [lpFileName, lpReOpenBuf, wStyle] = emu.readPascalArgs16([4, 4, 2]);
    const pathAddr = emu.resolveFarPtr(lpFileName);
    const path = pathAddr ? emu.memory.readCString(pathAddr) : '';

    // Write OFSTRUCT at lpReOpenBuf
    const ofBuf = emu.resolveFarPtr(lpReOpenBuf);
    if (ofBuf) {
      emu.memory.writeU8(ofBuf, 136); // cBytes
      emu.memory.writeU16(ofBuf + 2, 0); // nErrCode
      const maxPath = Math.min(path.length, 127);
      for (let i = 0; i < maxPath; i++) emu.memory.writeU8(ofBuf + 8 + i, path.charCodeAt(i));
      emu.memory.writeU8(ofBuf + 8 + maxPath, 0);
    }

    // Try to open via the file system
    const resolved = emu.resolvePath(path);
    const existing = emu.fs.findFile(resolved, emu.additionalFiles);
    if (!existing) {
      if (ofBuf) emu.memory.writeU16(ofBuf + 2, 2); // file not found
      return LZERROR_BADINHANDLE;
    }

    // Allocate a file handle
    let syncData: Uint8Array | null = null;
    const upper = resolved.toUpperCase();
    if (existing.source === 'external') {
      syncData = emu.fs.externalFiles.get(upper)?.data ?? null;
    } else if (existing.source === 'additional') {
      const ab = emu.additionalFiles.get(existing.name);
      if (ab) syncData = new Uint8Array(ab);
    }
    return emu.handles.alloc('file', {
      path: upper, access: 0, pos: 0,
      data: syncData, size: existing.size, modified: false,
    });
  }, 2);

  // Ordinal 4: GetExpandedName(lpszSource, lpszBuffer) — 8 bytes (ptr+ptr)
  // Gets the original name of a compressed file.
  lz.register('GetExpandedName', 8, () => {
    const [lpszSource, lpszBuffer] = emu.readPascalArgs16([4, 4]);
    const srcAddr = emu.resolveFarPtr(lpszSource);
    const dstAddr = emu.resolveFarPtr(lpszBuffer);
    const name = srcAddr ? emu.memory.readCString(srcAddr) : '';
    // Just copy the source name as-is (no decompression)
    if (dstAddr) {
      for (let i = 0; i < name.length; i++) emu.memory.writeU8(dstAddr + i, name.charCodeAt(i));
      emu.memory.writeU8(dstAddr + name.length, 0);
    }
    return 1;
  }, 4);

  // Ordinal 5: LZSeek(hFile, lOffset, iOrigin) — 8 bytes (word+long+word)
  lz.register('LZSeek', 8, () => {
    const [hFile, lOffset, iOrigin] = emu.readPascalArgs16([2, 4, 2]);
    const file = emu.handles.get<{ pos: number; size: number }>(hFile);
    if (!file) return LZERROR_BADINHANDLE;
    const offset = lOffset | 0;
    if (iOrigin === 0) file.pos = offset;
    else if (iOrigin === 1) file.pos += offset;
    else if (iOrigin === 2) file.pos = file.size + offset;
    if (file.pos < 0) file.pos = 0;
    return file.pos;
  }, 5);

  // Ordinal 6: LZRead(hFile, lpBuffer, cbRead) — 8 bytes (word+ptr+word)
  lz.register('LZRead', 8, () => {
    const [hFile, lpBuffer, cbRead] = emu.readPascalArgs16([2, 4, 2]);
    const file = emu.handles.get<{ pos: number; size: number; data: Uint8Array | null }>(hFile);
    if (!file || !file.data) return LZERROR_BADINHANDLE;
    const buf = emu.resolveFarPtr(lpBuffer);
    const avail = Math.min(cbRead, file.size - file.pos);
    for (let i = 0; i < avail; i++) {
      emu.memory.writeU8(buf + i, file.data[file.pos + i]);
    }
    file.pos += avail;
    return avail;
  }, 6);
}
