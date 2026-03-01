import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelDos(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  const fs = emu.fs;

  // --- Ordinal 3: GetVersion() — 0 bytes ---
  kernel.register('ord_3', 0, () => 0x0A03);

  // --- Ordinal 39: GetTickCount() — 0 bytes ---
  kernel.register('ord_39', 0, () => Date.now() & 0xFFFFFFFF);

  // --- Ordinal 41: EnableDos() — 0 bytes ---
  kernel.register('ord_41', 0, () => 0);

  // --- Ordinal 42: DisableDos() — 0 bytes ---
  kernel.register('ord_42', 0, () => 0);

  // --- Ordinal 92: GetTempDrive(word) — 2 bytes ---
  kernel.register('ord_92', 2, () => 0x43); // 'C'

  // --- Ordinal 102: DOS3Call() — 0 bytes, register-based ---
  kernel.register('ord_102', 0, () => {
    const ah = (emu.cpu.reg[0] >>> 8) & 0xFF;
    if (ah === 0x25 || ah === 0x35) {
      if (ah === 0x35) {
        emu.cpu.es = 0;
        emu.cpu.setReg16(3, 0);
      }
      return 0;
    }
    if (ah === 0x4C) {
      emu.halted = true;
    } else if (ah === 0x2A) {
      const now = new Date();
      emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | now.getFullYear();
      emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | ((now.getMonth() + 1) << 8) | now.getDate();
      emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFFFF00) | now.getDay();
    } else if (ah === 0x2C) {
      const now = new Date();
      emu.cpu.reg[1] = (emu.cpu.reg[1] & 0xFFFF0000) | (now.getHours() << 8) | now.getMinutes();
      emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | (now.getSeconds() << 8) | Math.floor(now.getMilliseconds() / 10);
    } else if (ah === 0x30) {
      emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 0x0A03;
    } else if (ah === 0x3D) {
      // Open file: DS:DX = path, AL = access mode
      const pathAddr = (emu.cpu.segBases.get(emu.cpu.ds) ?? 0) + (emu.cpu.reg[2] & 0xFFFF);
      const path = emu.memory.readCString(pathAddr);
      const resolved = emu.resolvePath(path);
      const existing = fs.findFile(resolved, emu.additionalFiles);
      if (!existing) {
        emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 2;
      } else {
        const upper = resolved.toUpperCase();
        let syncData: Uint8Array | null = null;
        if (existing.source === 'external') {
          syncData = fs.externalFiles.get(upper)?.data ?? null;
        } else if (existing.source === 'additional') {
          const ab = emu.additionalFiles.get(existing.name);
          if (ab) syncData = new Uint8Array(ab);
        }
        const handle = emu.handles.alloc('file', {});
        fs.openFile(handle, { path: upper, access: emu.cpu.reg[0] & 0xFF, pos: 0, data: syncData, size: existing.size, modified: false });
        emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | (handle & 0xFFFF);
      }
    } else if (ah === 0x3E) {
      // Close file
      const handle = emu.cpu.reg[3] & 0xFFFF; // BX = handle
      fs.closeFile(handle);
      fs.deleteOpenFile(handle);
      emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001);
    } else if (ah === 0x3F) {
      // Read file: BX=handle, CX=count, DS:DX=buffer
      const handle = emu.cpu.reg[3] & 0xFFFF;
      const count = emu.cpu.reg[1] & 0xFFFF;
      const bufAddr = (emu.cpu.segBases.get(emu.cpu.ds) ?? 0) + (emu.cpu.reg[2] & 0xFFFF);
      const file = fs.getOpenFile(handle);
      if (!file || !file.data) {
        emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 6;
      } else {
        const avail = Math.min(count, file.size - file.pos);
        for (let i = 0; i < avail; i++) {
          emu.memory.writeU8(bufAddr + i, file.data[file.pos + i]);
        }
        file.pos += avail;
        emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | (avail & 0xFFFF);
      }
    } else if (ah === 0x40) {
      // Write file: BX=handle, CX=count, DS:DX=buffer
      const handle = emu.cpu.reg[3] & 0xFFFF;
      const count = emu.cpu.reg[1] & 0xFFFF;
      const bufAddr = (emu.cpu.segBases.get(emu.cpu.ds) ?? 0) + (emu.cpu.reg[2] & 0xFFFF);
      const file = fs.getOpenFile(handle);
      if (!file) {
        emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 6;
      } else {
        const endPos = file.pos + count;
        if (!file.data || endPos > file.data.length) {
          const newBuf = new Uint8Array(Math.max(endPos, (file.data?.length || 0) * 2));
          if (file.data) newBuf.set(file.data);
          file.data = newBuf;
        }
        for (let i = 0; i < count; i++) {
          file.data[file.pos + i] = emu.memory.readU8(bufAddr + i);
        }
        file.pos = endPos;
        if (endPos > file.size) file.size = endPos;
        file.modified = true;
        emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | (count & 0xFFFF);
      }
    } else if (ah === 0x42) {
      // Seek: BX=handle, CX:DX=offset, AL=origin
      const handle = emu.cpu.reg[3] & 0xFFFF;
      const offset = ((emu.cpu.reg[1] & 0xFFFF) << 16) | (emu.cpu.reg[2] & 0xFFFF);
      const origin = emu.cpu.reg[0] & 0xFF;
      const file = fs.getOpenFile(handle);
      if (!file) {
        emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001);
        emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFFFF) | 6;
      } else {
        if (origin === 0) file.pos = offset;
        else if (origin === 1) file.pos += offset;
        else if (origin === 2) file.pos = file.size + offset;
        if (file.pos < 0) file.pos = 0;
        emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0001);
        emu.cpu.reg[2] = (emu.cpu.reg[2] & ~0xFFFF) | (file.pos & 0xFFFF);
        emu.cpu.reg[1] = (emu.cpu.reg[1] & ~0xFFFF) | ((file.pos >>> 16) & 0xFFFF);
      }
    } else if (ah === 0x4E || ah === 0x4F) {
      // FindFirst/FindNext — not found
      emu.cpu.setFlags(emu.cpu.getFlags() | 0x0001);
      emu.cpu.reg[0] = (emu.cpu.reg[0] & ~0xFF) | 2;
    } else {
      console.warn(`[DOS3Call] Unhandled AH=0x${ah.toString(16)}`);
    }
    return 0;
  });

  // --- Ordinal 105: GetExeVersion() — 0 bytes ---
  kernel.register('ord_105', 0, () => 0x030A);

  // --- Ordinal 131: GetDOSEnvironment() — 0 bytes ---
  kernel.register('ord_131', 0, () => {
    const envAddr = emu.allocHeap(4);
    emu.memory.writeU8(envAddr, 0);
    emu.memory.writeU8(envAddr + 1, 0);
    const seg = emu.cpu.ds;
    emu.cpu.setReg16(2, seg);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (envAddr & 0xFFFF);
    return (seg << 16) | (envAddr & 0xFFFF);
  });

  // --- Ordinal 132: GetWinFlags() — 0 bytes ---
  kernel.register('ord_132', 0, () => 0x0413);

  // --- Ordinal 134: GetWindowsDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_134', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 135: GetSystemDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('ord_135', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS\\SYSTEM';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  });

  // --- Ordinal 136: GetDriveType(nDrive) — 2 bytes (word) ---
  kernel.register('ord_136', 2, () => 3); // DRIVE_FIXED

  // --- Ordinal 167: GetExpWinVer(word) — 2 bytes ---
  kernel.register('ord_167', 2, () => 0x030A);
}
