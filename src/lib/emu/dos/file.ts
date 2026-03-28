import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import type { DirEntry, FileInfo, FileManager, OpenFile } from '../file-manager';
import { dosResolvePath, isDosValidDrive } from './path';
import { teletypeOutput } from './video';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;
const CF = 0x001;

/** Read a NUL-terminated string from DS:DX. */
function readDsDxString(cpu: CPU, maxLen = 128): string {
  const dsBase = cpu.segBase(cpu.ds);
  const dx = cpu.getReg16(EDX);
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const ch = cpu.mem.readU8(dsBase + dx + i);
    if (ch === 0) break;
    s += String.fromCharCode(ch);
  }
  return s;
}

/** Allocate the lowest available DOS file handle (recycles closed handles). */
function allocDosHandle(emu: Emulator): number {
  if (emu._dosFreedHandles.length > 0) {
    // Return the smallest freed handle (DOS returns lowest available)
    emu._dosFreedHandles.sort((a, b) => a - b);
    return emu._dosFreedHandles.shift()!;
  }
  return emu._dosNextHandle++;
}

// ---- INT 21h file handlers ----

/** 0x1A: Set DTA address (DS:DX) */
export function dosSetDTA(cpu: CPU, emu: Emulator): void {
  const dsBase = cpu.segBase(cpu.ds);
  emu._dosDTA = dsBase + cpu.getReg16(EDX);
  // Save segment:offset pair for GetDTA (needed in protected mode)
  emu._dosDtaSeg = cpu.ds;
  emu._dosDtaOfs = cpu.getReg16(EDX);
}

/** 0x2F: Get DTA → ES:BX */
export function dosGetDTA(cpu: CPU, emu: Emulator): void {
  if (emu._dosDtaSeg !== undefined) {
    // Protected mode: return saved selector:offset pair
    cpu.es = emu._dosDtaSeg;
    cpu.setReg16(EBX, emu._dosDtaOfs!);
  } else {
    // Real mode fallback
    const dta = emu._dosDTA || 0;
    cpu.setReg16(EBX, dta & 0xFFFF);
    cpu.es = (dta >>> 4) & 0xFFFF;
  }
}

/** 0x3C: Create file (CX=attributes, DS:DX=filename) */
export function dosCreateFile(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  const resolved = dosResolvePath(emu, name);
  const handle = allocDosHandle(emu);
  const emptyData = new Uint8Array(0);
  emu.handles.set(handle, 'file', { path: resolved, access: 0x40000000, pos: 0, data: emptyData, size: 0, modified: true } as OpenFile);
  emu._dosFiles.set(handle, { data: emptyData, pos: 0, name });
  // Register in virtual FS so the file is visible
  const fs = emu.fs;
  if (resolved.toUpperCase().startsWith('D:\\')) {
    const storeName = resolved.substring(3).replace(/\\/g, '/');
    fs.saveVirtualFile(storeName, emptyData);
  }
  cpu.setReg16(EAX, handle);
  cpu.setFlag(CF, false);
}

/** Try to get file data synchronously (additionalFiles / externalFiles / cached virtual). */
export function getSyncFileData(fs: FileManager, fileInfo: FileInfo, emu: Emulator, resolved: string): Uint8Array | null {
  if (fileInfo.source === 'additional') {
    const ab = emu.additionalFiles.get(fileInfo.name);
    return ab ? new Uint8Array(ab) : null;
  }
  if (fileInfo.source === 'external') {
    const ext = fs.externalFiles.get(resolved.toUpperCase());
    if (ext) return ext.data;
  }
  if (fileInfo.source === 'virtual') {
    // Check in-memory cache (populated by prior fetchFileData / saveVirtualFile)
    const dfm = fs as { virtualFileCache?: Map<string, ArrayBuffer> };
    if (dfm.virtualFileCache) {
      const cached = dfm.virtualFileCache.get(fileInfo.name.toUpperCase());
      if (cached) return new Uint8Array(cached);
    }
  }
  return null;
}

/** Open a file by resolved path. Shared by 0x3D and 0x6C. */
function openFileByPath(cpu: CPU, emu: Emulator, name: string, resolved: string): void {
  const fs = emu.fs;
  const fileInfo = fs.findFile(resolved, emu.additionalFiles);
  if (fileInfo) {
    // Try synchronous path first (additionalFiles / externalFiles are in memory)
    const syncData = getSyncFileData(fs, fileInfo, emu, resolved);
    if (syncData) {
      const handle = allocDosHandle(emu);
      const data = syncData;
      emu._dosFiles.set(handle, { data, pos: 0, name });
      emu.handles.set(handle, 'file', { path: resolved, access: 0x80000000, pos: 0, data, size: data.length, modified: false });
      cpu.setReg16(EAX, handle);
      cpu.setFlag(CF, false);
      return;
    }
    // Before going async, check if additionalFiles has a sync copy under a different key
    // (e.g., "SECOND.EXE" in additionalFiles vs "2nd_real/SECOND.EXE" in virtual FS)
    const baseName2 = resolved.replace(/^.*[\\\/]/, '').toUpperCase();
    for (const [key, buf] of emu.additionalFiles) {
      if (key.toUpperCase() === baseName2 || key.toUpperCase().endsWith('\\' + baseName2) || key.toUpperCase().endsWith('/' + baseName2)) {
        const handle = allocDosHandle(emu);
        const data = new Uint8Array(buf);
        emu._dosFiles.set(handle, { data, pos: 0, name });
        emu.handles.set(handle, 'file', { path: resolved, access: 0x80000000, pos: 0, data, size: data.length, modified: false });
        cpu.setReg16(EAX, handle);
        cpu.setFlag(CF, false);
        return;
      }
    }

    // Async path: fetch data into cache, then rewind EIP to replay the INT 21h
    const fileNameForCache = fileInfo.name;
    fs.fetchFileData(fileInfo, emu.additionalFiles, resolved).then(() => {
      // Data is now in virtualFileCache (fetchFileData caches it).
      // Resume CPU — the INT 21h will re-execute and hit the sync path.
      if (emu._dosFileOpenPending) {
        emu._dosFileOpenPending = false;
        emu.waitingForMessage = false;
        if (emu.running && !emu.halted) {
          requestAnimationFrame(emu.tick);
        }
      }
    });
    // Rewind EIP to before the INT 21h instruction (CD 21 = 2 bytes)
    cpu.eip -= 2;
    // Pause CPU until async fetch completes
    emu._dosFileOpenPending = true;
    emu.waitingForMessage = true;
    return;
  }
  cpu.setFlag(CF, true);
  cpu.setReg16(EAX, 2); // file not found
}

/** 0x3D: Open file (AL=mode, DS:DX=filename) */
export function dosOpenFile(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  // DOS device driver detection: EMMXXXX0 (EMS), NUL, CON, etc.
  const baseName = name.replace(/^[*\\\/]*/, '').toUpperCase();
  if (baseName === 'EMMXXXX0') {
    // EMS driver present — return a dummy handle
    const handle = allocDosHandle(emu);
    emu._dosFiles.set(handle, { data: new Uint8Array(0), pos: 0, name: 'EMMXXXX0' });
    cpu.setReg16(EAX, handle);
    cpu.setFlag(CF, false);
    console.log(`[DOS] Open "${name}" -> CF=0 AX=0x${handle.toString(16)} (EMS device)`);
    return;
  }
  const resolved = dosResolvePath(emu, name);
  openFileByPath(cpu, emu, name, resolved);
}

/** 0x3E: Close file */
export function dosCloseFile(cpu: CPU, emu: Emulator): void {
  const h = cpu.getReg16(EBX);
  const f = emu._dosFiles.get(h);
  emu._dosFiles.delete(h);
  const of = emu.handles.get<OpenFile>(h);
  if (of) emu.fs.persistOnClose(of);
  emu.handles.free(h);
  if (h >= 5) emu._dosFreedHandles.push(h);
  cpu.setFlag(CF, false);
}

/** 0x3F: Read file (BX=handle, CX=count, DS:DX=buffer) */
export function dosReadFile(cpu: CPU, emu: Emulator): void {
  const h = cpu.getReg16(EBX);
  const count = cpu.getReg16(ECX);
  const dsBase = cpu.segBase(cpu.ds);
  const bufAddr = dsBase + cpu.getReg16(EDX);
  if (h <= 2) {
    cpu.setReg16(EAX, 0);
    cpu.setFlag(CF, false);
  } else {
    const f = emu._dosFiles.get(h);
    if (f) {
      const avail = Math.min(count, f.data.length - f.pos);
      for (let i = 0; i < avail; i++) {
        cpu.mem.writeU8(bufAddr + i, f.data[f.pos + i]);
      }
      f.pos += avail;
      cpu.setReg16(EAX, avail);
      cpu.setFlag(CF, false);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 6); // invalid handle
    }
  }
}

/** 0x40: Write to file handle (BX=handle, CX=count, DS:DX=buffer) */
export function dosWriteFile(cpu: CPU, emu: Emulator): void {
  const handle = cpu.getReg16(EBX);
  const count = cpu.getReg16(ECX);
  const dsBase = cpu.segBase(cpu.ds);
  const bufAddr = dsBase + cpu.getReg16(EDX);
  if (handle === 1 || handle === 2) {
    // stdout/stderr → console
    for (let i = 0; i < count; i++) {
      teletypeOutput(cpu, emu, cpu.mem.readU8(bufAddr + i));
    }
    cpu.setReg16(EAX, count);
    cpu.setFlag(CF, false);
  } else {
    const f = emu._dosFiles.get(handle);
    if (f) {
      const needed = f.pos + count;
      if (needed > f.data.length) {
        const newData = new Uint8Array(needed);
        newData.set(f.data);
        f.data = newData;
      }
      for (let i = 0; i < count; i++) {
        f.data[f.pos + i] = cpu.mem.readU8(bufAddr + i);
      }
      f.pos += count;
      const of = emu.handles.get<OpenFile>(handle);
      if (of) {
        of.data = f.data;
        of.pos = f.pos;
        of.size = f.data.length;
        of.modified = true;
      }
      cpu.setReg16(EAX, count);
      cpu.setFlag(CF, false);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 6); // invalid handle
    }
  }
}

/** 0x41: Delete file (DS:DX=filename) */
export function dosDeleteFile(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  const resolved = dosResolvePath(emu, name);
  emu.fs.deleteFile(resolved);
  cpu.setFlag(CF, false);
}

/** 0x42: Seek file (BX=handle, AL=origin, CX:DX=offset) */
export function dosSeekFile(cpu: CPU, emu: Emulator): void {
  const h = cpu.getReg16(EBX);
  const origin = cpu.reg[EAX] & 0xFF;
  const offset = (cpu.getReg16(ECX) << 16) | cpu.getReg16(EDX);
  const f = emu._dosFiles.get(h);
  if (f) {
    if (origin === 0) f.pos = offset;           // SEEK_SET
    else if (origin === 1) f.pos += offset;      // SEEK_CUR
    else if (origin === 2) f.pos = f.data.length + offset; // SEEK_END
    f.pos = Math.max(0, Math.min(f.pos, f.data.length));
    const of = emu.handles.get<OpenFile>(h);
    if (of) of.pos = f.pos;
    cpu.setReg16(EDX, (f.pos >>> 16) & 0xFFFF);
    cpu.setReg16(EAX, f.pos & 0xFFFF);
    cpu.setFlag(CF, false);
  } else {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 6);
  }
}

/** 0x43: Get/Set file attributes */
export function dosFileAttributes(cpu: CPU, emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF;
  if (al === 0x00) {
    // Get file attributes
    const name = readDsDxString(cpu);
    const resolved = dosResolvePath(emu, name);
    const attrs = emu.fs.getFileAttributes(resolved, emu.additionalFiles);
    const INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    if (attrs === INVALID_FILE_ATTRIBUTES) {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 2); // file not found
    } else {
      cpu.setReg16(ECX, attrs);
      cpu.setFlag(CF, false);
    }
  } else {
    // Set file attributes — succeed
    cpu.setFlag(CF, false);
  }
}

/** 0x44: IOCTL */
export function dosIoctl(cpu: CPU, emu: Emulator): void {
  const subFunc = cpu.reg[EAX] & 0xFF;
  if (subFunc === 0x00) {
    const handle = cpu.getReg16(EBX);
    if (handle <= 4) {
      cpu.setReg16(EDX, 0x80D3); // character device
      cpu.setFlag(CF, false);
    } else if (emu._dosFiles.has(handle) || emu.handles.getType(handle) === 'file') {
      cpu.setReg16(EDX, 0x0000); // disk file
      cpu.setFlag(CF, false);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 6);
    }
  } else if (subFunc === 0x01) {
    cpu.setFlag(CF, false);
  } else if (subFunc === 0x08) {
    // Check if block device is removable: AX=0 removable, AX=1 fixed
    const drv08 = cpu.reg[EBX] & 0xFF; // BL = drive number (0=default, 1=A, 2=B, 3=C...)
    const drvIdx08 = drv08 === 0 ? (emu.currentDrive.charCodeAt(0) - 0x41) : (drv08 - 1);
    if (!isDosValidDrive(drvIdx08)) {
      cpu.setReg16(EAX, 0x0F); // invalid drive
      cpu.setFlag(CF, true);
    } else {
      cpu.setReg16(EAX, 1); // fixed (hard drive)
      cpu.setFlag(CF, false);
    }
  } else if (subFunc === 0x09) {
    // Check if block device is remote: DX bit 12=1 remote, 0=local
    const drv09 = cpu.reg[EBX] & 0xFF;
    const drvIdx09 = drv09 === 0 ? (emu.currentDrive.charCodeAt(0) - 0x41) : (drv09 - 1);
    if (!isDosValidDrive(drvIdx09)) {
      cpu.setReg16(EAX, 0x0F); // invalid drive
      cpu.setFlag(CF, true);
    } else {
      cpu.setReg16(EDX, 0); // local
      cpu.setFlag(CF, false);
    }
  } else if (subFunc === 0x0D) {
    // Generic IOCTL (block device): CH=category, CL=function
    const cl = cpu.reg[ECX] & 0xFF;
    const drive = cpu.reg[EBX] & 0xFF;
    if (cl === 0x60 && (drive === 3 || drive === 0)) {
      // Get Device Parameters for C: — fill BPB-like structure at DS:DX
      const addr = cpu.segBase(cpu.ds) + (cpu.reg[EDX] & 0xFFFF);
      cpu.mem.writeU8(addr + 0, 0x00);  // special functions
      cpu.mem.writeU8(addr + 1, 0x05);  // device type: hard disk
      cpu.mem.writeU16(addr + 2, 0x0001); // device attributes: non-removable
      cpu.mem.writeU16(addr + 4, 0x0001); // cylinders (fake)
      cpu.mem.writeU8(addr + 6, 0x00);  // media type (0=default)
      // BPB at offset 7: 512 bytes/sector, 8 sectors/cluster, etc.
      cpu.mem.writeU16(addr + 7, 512);   // bytes per sector
      cpu.mem.writeU8(addr + 9, 7);      // sectors per cluster - 1 (8 sectors)
      cpu.mem.writeU16(addr + 10, 1);    // reserved sectors
      cpu.mem.writeU8(addr + 12, 2);     // number of FATs
      cpu.mem.writeU16(addr + 13, 512);  // root dir entries
      cpu.mem.writeU16(addr + 15, 0);    // total sectors (0 = use 32-bit field)
      cpu.mem.writeU8(addr + 17, 0xF8);  // media descriptor (hard disk)
      cpu.mem.writeU16(addr + 18, 100);  // sectors per FAT
      cpu.setFlag(CF, false);
    } else if (cl === 0x66 && (drive === 3 || drive === 0)) {
      // Get Media ID for C:
      const addr = cpu.segBase(cpu.ds) + (cpu.reg[EDX] & 0xFFFF);
      cpu.mem.writeU16(addr + 0, 0);     // info level
      cpu.mem.writeU32(addr + 2, 0x12345678); // serial number
      // Volume label (11 bytes)
      const label = 'RETROTICK   ';
      for (let i = 0; i < 11; i++) cpu.mem.writeU8(addr + 6 + i, label.charCodeAt(i));
      // File system type (8 bytes)
      const fsType = 'FAT16   ';
      for (let i = 0; i < 8; i++) cpu.mem.writeU8(addr + 17 + i, fsType.charCodeAt(i));
      cpu.setFlag(CF, false);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 0x0F); // invalid drive
    }
  } else {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 1); // invalid function
  }
}

/** 0x45: Duplicate file handle (BX=handle) → AX=new handle */
export function dosDupHandle(cpu: CPU, emu: Emulator): void {
  const srcH = cpu.getReg16(EBX);
  const srcFile = emu.handles.get<OpenFile>(srcH);
  if (srcFile) {
    const newH = emu.handles.alloc('file', { ...srcFile });
    const dosF = emu._dosFiles.get(srcH);
    if (dosF) emu._dosFiles.set(newH, { data: dosF.data, pos: dosF.pos, name: dosF.name });
    cpu.setReg16(EAX, newH);
    cpu.setFlag(CF, false);
  } else {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 6);
  }
}

/** 0x46: Force duplicate handle (BX=src, CX=dst) */
export function dosForceDupHandle(cpu: CPU, emu: Emulator): void {
  const srcH = cpu.getReg16(EBX);
  const dstH = cpu.getReg16(ECX);
  const srcFile = emu.handles.get<OpenFile>(srcH);
  if (srcFile) {
    const dstFile = emu.handles.get<OpenFile>(dstH);
    if (dstFile) emu.fs.persistOnClose(dstFile);
    emu.handles.set(dstH, 'file', { ...srcFile });
    const dosF = emu._dosFiles.get(srcH);
    if (dosF) emu._dosFiles.set(dstH, { data: dosF.data, pos: dosF.pos, name: dosF.name });
    cpu.setFlag(CF, false);
  } else {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 6);
  }
}

/** 0x4E: FindFirst (CX=attributes, DS:DX=filespec) */
export function dosFindFirst(cpu: CPU, emu: Emulator): void {
  const spec = readDsDxString(cpu);
  // Reject paths with wildcards in directory components (matches real DOS behavior).
  // e.g. "D:\DIR\*.BAS\..\*.BAS" is invalid because "*.BAS" is not a directory.
  const rawNorm = spec.replace(/\//g, '\\');
  const rawLastSlash = rawNorm.lastIndexOf('\\');
  const rawDirPart = rawLastSlash >= 0 ? rawNorm.substring(0, rawLastSlash) : '';
  if (rawDirPart.includes('*') || rawDirPart.includes('?')) {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 3); // path not found
    return;
  }
  const resolvedSpec = dosResolvePath(emu, spec);
  const attrMask = cpu.getReg16(ECX);
  const allEntries = emu.fs.getVirtualDirListing(resolvedSpec, emu.additionalFiles);
  // DOS FindFirst attribute filtering:
  // Normal files (attr 0x00/0x20) always match. Directory (0x10), hidden (0x02),
  // system (0x04) entries only match if the corresponding bit is set in CX.
  const FILE_ATTR_DIRECTORY = 0x10;
  const entries = allEntries.filter(e => {
    if (e.isDir) return !!(attrMask & FILE_ATTR_DIRECTORY);
    return true; // normal/archive files always match
  });
  console.log(`[DOS] FindFirst: spec="${spec}" resolved="${resolvedSpec}" CX=0x${attrMask.toString(16)} entries=${entries.length}/${allEntries.length} DTA=0x${(emu._dosDTA||0).toString(16)}`, entries.map(e => `${e.name}${e.isDir?'/':''}`));
  if (entries.length > 0) {
    emu._dosFindState = { entries, index: 0, pattern: spec };
    writeDtaEntry(cpu, emu, entries[0]);
    cpu.setFlag(CF, false);
  } else {
    emu._dosFindState = null;
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 18); // no more files
  }
}

/** 0x4F: FindNext */
export function dosFindNext(cpu: CPU, emu: Emulator): void {
  if (emu._dosFindState) {
    emu._dosFindState.index++;
    if (emu._dosFindState.index < emu._dosFindState.entries.length) {
      writeDtaEntry(cpu, emu, emu._dosFindState.entries[emu._dosFindState.index]);
      cpu.setFlag(CF, false);
    } else {
      emu._dosFindState = null;
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 18);
    }
  } else {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 18);
  }
}

/** 0x56: Rename file (DS:DX=old, ES:DI=new) */
export function dosRenameFile(cpu: CPU, emu: Emulator): void {
  const oldName = readDsDxString(cpu);
  const esBase = cpu.segBase(cpu.es);
  const di = cpu.getReg16(EDI);
  let newName = '';
  for (let i = 0; i < 128; i++) {
    const ch = cpu.mem.readU8(esBase + di + i);
    if (ch === 0) break;
    newName += String.fromCharCode(ch);
  }
  const oldResolved = dosResolvePath(emu, oldName);
  const newResolved = dosResolvePath(emu, newName);
  const fs = emu.fs;
  // Try to find and move the file in virtual FS
  const fileInfo = fs.findFile(oldResolved, emu.additionalFiles);
  if (fileInfo && fileInfo.source === 'virtual') {
    // Read old data, save under new name, delete old
    fs.fetchFileData(fileInfo, emu.additionalFiles, oldResolved).then((buf) => {
      if (buf && newResolved.toUpperCase().startsWith('D:\\')) {
        const newStoreName = newResolved.substring(3).replace(/\\/g, '/');
        fs.saveVirtualFile(newStoreName, new Uint8Array(buf));
      }
      const oldRelPath = oldResolved.toUpperCase().substring(3);
      fs.removeVirtualFile(oldRelPath, fileInfo.name);
    });
    cpu.setFlag(CF, false);
  } else {
    // Non-virtual files or not found — succeed silently
    cpu.setFlag(CF, false);
  }
}

/** 0x57: Get/set file date and time (BX=handle) */
export function dosFileDateTime(cpu: CPU, _emu: Emulator): void {
  const al = cpu.reg[EAX] & 0xFF;
  if (al === 0x00) {
    const DOS_TIME = (12 << 11) | (0 << 5) | 0; // 12:00:00
    const DOS_DATE = ((2000 - 1980) << 9) | (1 << 5) | 1; // 2000-01-01
    cpu.setReg16(ECX, DOS_TIME);
    cpu.setReg16(EDX, DOS_DATE);
    cpu.setFlag(CF, false);
  } else {
    cpu.setFlag(CF, false);
  }
}

/** 0x39: Create subdirectory (mkdir) DS:DX=path */
export function dosMkdir(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  const resolved = dosResolvePath(emu, name);
  emu.fs.createDirectory(resolved);
  cpu.setFlag(CF, false);
}

/** 0x3A: Remove subdirectory (rmdir) DS:DX=path */
export function dosRmdir(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  const resolved = dosResolvePath(emu, name);
  emu.fs.removeDirectory(resolved);
  cpu.setFlag(CF, false);
}

/** 0x5A: Create temporary file (CX=attr, DS:DX=path prefix) */
export function dosCreateTempFile(cpu: CPU, emu: Emulator): void {
  const dsBase = cpu.segBase(cpu.ds);
  const prefixAddr = dsBase + cpu.getReg16(EDX);
  let prefix = '';
  for (let i = 0; i < 128; i++) {
    const ch = cpu.mem.readU8(prefixAddr + i);
    if (ch === 0) break;
    prefix += String.fromCharCode(ch);
  }
  const tmpName = prefix + 'TMP' + ((Date.now() & 0xFFFF).toString(16)).toUpperCase() + '.TMP';
  const resolved = dosResolvePath(emu, tmpName);
  const handle = allocDosHandle(emu);
  const emptyData = new Uint8Array(0);
  emu.handles.set(handle, 'file', { path: resolved, access: 0x40000000, pos: 0, data: emptyData, size: 0, modified: true } as OpenFile);
  emu._dosFiles.set(handle, { data: emptyData, pos: 0, name: tmpName });
  if (resolved.toUpperCase().startsWith('D:\\')) {
    const storeName = resolved.substring(3).replace(/\\/g, '/');
    emu.fs.saveVirtualFile(storeName, emptyData);
  }
  for (let i = 0; i < tmpName.length; i++) {
    cpu.mem.writeU8(prefixAddr + i, tmpName.charCodeAt(i));
  }
  cpu.mem.writeU8(prefixAddr + tmpName.length, 0);
  cpu.setReg16(EAX, handle);
  cpu.setFlag(CF, false);
}

/** 0x5B: Create new file (fail if exists) CX=attr, DS:DX=filename */
export function dosCreateNewFile(cpu: CPU, emu: Emulator): void {
  const name = readDsDxString(cpu);
  const resolved = dosResolvePath(emu, name);
  const existing = emu.fs.findFile(resolved, emu.additionalFiles);
  if (existing) {
    cpu.setFlag(CF, true);
    cpu.setReg16(EAX, 80); // ERROR_FILE_EXISTS
  } else {
    const handle = allocDosHandle(emu);
    const emptyData = new Uint8Array(0);
    emu.handles.set(handle, 'file', { path: resolved, access: 0x40000000, pos: 0, data: emptyData, size: 0, modified: true } as OpenFile);
    emu._dosFiles.set(handle, { data: emptyData, pos: 0, name });
    if (resolved.toUpperCase().startsWith('D:\\')) {
      const storeName = resolved.substring(3).replace(/\\/g, '/');
      emu.fs.saveVirtualFile(storeName, emptyData);
    }
    cpu.setReg16(EAX, handle);
    cpu.setFlag(CF, false);
  }
}

/** 0x5C: Lock/unlock file region — no-op */
export function dosLockFile(cpu: CPU, _emu: Emulator): void {
  cpu.setFlag(CF, false);
}

/** 0x67: Set handle count — no-op */
export function dosSetHandleCount(cpu: CPU, _emu: Emulator): void {
  cpu.setFlag(CF, false);
}

/** 0x68: Flush buffer (BX=handle) */
export function dosFlushBuffer(cpu: CPU, emu: Emulator): void {
  const h = cpu.getReg16(EBX);
  const of = emu.handles.get<OpenFile>(h);
  if (of && of.modified) {
    emu.fs.persistOnClose(of);
  }
  cpu.setFlag(CF, false);
}

/** 0x6C: Extended open/create (DOS 4.0+) */
export function dosExtendedOpen(cpu: CPU, emu: Emulator): void {
  const dsBase = cpu.segBase(cpu.ds);
  const nameAddr = dsBase + cpu.getReg16(ESI);
  let name = '';
  for (let i = 0; i < 128; i++) {
    const ch = cpu.mem.readU8(nameAddr + i);
    if (ch === 0) break;
    name += String.fromCharCode(ch);
  }
  const resolved = dosResolvePath(emu, name);
  const action = cpu.getReg16(EDX);
  const existing = emu.fs.findFile(resolved, emu.additionalFiles);

  const ACTION_OPEN = 0x01;
  const ACTION_REPLACE = 0x02;
  const ACTION_CREATE = 0x10;

  if (existing) {
    if (action & ACTION_REPLACE) {
      const handle = allocDosHandle(emu);
      const emptyData = new Uint8Array(0);
      emu.handles.set(handle, 'file', { path: resolved, access: cpu.getReg16(EBX) & 0xFF, pos: 0, data: emptyData, size: 0, modified: true } as OpenFile);
      emu._dosFiles.set(handle, { data: emptyData, pos: 0, name });
      cpu.setReg16(EAX, handle);
      cpu.setReg16(ECX, 3); // file existed, was replaced
      cpu.setFlag(CF, false);
    } else if (action & ACTION_OPEN) {
      // Open existing
      openFileByPath(cpu, emu, name, resolved);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 80); // ERROR_FILE_EXISTS
    }
  } else {
    if (action & ACTION_CREATE) {
      const handle = allocDosHandle(emu);
      const emptyData = new Uint8Array(0);
      emu.handles.set(handle, 'file', { path: resolved, access: cpu.getReg16(EBX) & 0xFF, pos: 0, data: emptyData, size: 0, modified: true } as OpenFile);
      emu._dosFiles.set(handle, { data: emptyData, pos: 0, name });
      if (resolved.toUpperCase().startsWith('D:\\')) {
        const storeName = resolved.substring(3).replace(/\\/g, '/');
        emu.fs.saveVirtualFile(storeName, emptyData);
      }
      cpu.setReg16(EAX, handle);
      cpu.setReg16(ECX, 2); // file did not exist, was created
      cpu.setFlag(CF, false);
    } else {
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 2); // ERROR_FILE_NOT_FOUND
    }
  }
}

/** Write a DOS DTA entry for FindFirst/FindNext results.
 *  DTA layout (43 bytes): offset 0x00-0x14=reserved, 0x15=attr, 0x16-0x17=time,
 *  0x18-0x19=date, 0x1A-0x1D=size, 0x1E-0x2A=filename (13 bytes, null-terminated) */
function writeDtaEntry(_cpu: CPU, emu: Emulator, entry: DirEntry): void {
  const dta = emu._dosDTA;
  if (!dta) return;
  const mem = emu.memory;
  for (let i = 0; i < 43; i++) mem.writeU8(dta + i, 0);
  const FILE_ATTR_DIRECTORY = 0x10;
  const FILE_ATTR_ARCHIVE = 0x20;
  mem.writeU8(dta + 0x15, entry.isDir ? FILE_ATTR_DIRECTORY : FILE_ATTR_ARCHIVE);
  mem.writeU16(dta + 0x16, 0);
  const DOS_DATE_2000 = ((2000 - 1980) << 9) | (1 << 5) | 1;
  mem.writeU16(dta + 0x18, DOS_DATE_2000);
  mem.writeU32(dta + 0x1A, entry.size);
  const name = entry.name.toUpperCase().substring(0, 12);
  for (let i = 0; i < name.length; i++) {
    mem.writeU8(dta + 0x1E + i, name.charCodeAt(i));
  }
  mem.writeU8(dta + 0x1E + name.length, 0);
}
