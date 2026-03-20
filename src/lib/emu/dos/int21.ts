import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { dosResolvePath } from './path';
import { dumpInstrTrace } from '../x86/dispatch';
import { teletypeOutput } from './video';
import {
  dosSetDTA, dosGetDTA,
  dosCreateFile, dosOpenFile, dosCloseFile, dosReadFile, dosWriteFile,
  dosDeleteFile, dosSeekFile, dosFileAttributes, dosIoctl,
  dosDupHandle, dosForceDupHandle,
  dosFindFirst, dosFindNext,
  dosRenameFile, dosFileDateTime,
  dosMkdir, dosRmdir,
  dosCreateTempFile, dosCreateNewFile,
  dosLockFile, dosSetHandleCount, dosFlushBuffer, dosExtendedOpen,
} from './file';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;
const CF = 0x001;
const ZF = 0x040;


/** Return from child to parent after EXEC. Returns true if handled (child was running). */
function dosExecReturn(cpu: CPU, emu: Emulator, exitCode: number): boolean {
  if (emu._dosExecStack.length === 0) return false;

  // Free child's MCB
  const childPsp = emu._dosPSP;
  const childMcbLin = (childPsp - 1) * 16;
  const mcbType = cpu.mem.readU8(childMcbLin);
  if (mcbType === 0x4D || mcbType === 0x5A) {
    cpu.mem.writeU16(childMcbLin + 1, 0x0000); // mark free
  }

  const parent = emu._dosExecStack.pop()!;
  emu._dosPSP = parent.psp;
  emu._dosDTA = parent.dta;
  emu._dosExitCode = exitCode;
  cpu.reg.set(parent.regs);
  cpu.cs = parent.cs;
  cpu.ds = parent.ds;
  cpu.es = parent.es;
  cpu.ss = parent.ss;
  cpu.eip = parent.eip;
  cpu.setFlags(parent.flags);
  // EXEC returns with CF=0 on success
  cpu.setFlag(CF, false);
  console.log(`[INT 21h] Child exit code=${exitCode}, returning to parent PSP=${parent.psp.toString(16)}`);
  return true;
}

/** Handle INT 21h (DOS services). Exported for use by Win16 DOS3Call. */
export function handleInt21(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  const al = cpu.reg[EAX] & 0xFF;
  switch (ah) {
    case 0x00: // Old-style terminate (same as INT 20h)
      if (dosExecReturn(cpu, emu, 0)) break;
      emu.halted = true;
      cpu.halted = true;
      break;

    case 0x01: { // Read character with echo (blocking)
      if (emu._dosExtKeyPending !== undefined) {
        cpu.setReg8(EAX, emu._dosExtKeyPending);
        emu._dosExtKeyPending = undefined;
      } else if (emu.dosKeyBuffer.length > 0) {
        const key = emu.dosKeyBuffer.shift()!;
        const ascii = key.ascii === 0xE0 ? 0 : key.ascii;
        cpu.setReg8(EAX, ascii);
        if (ascii === 0) {
          emu._dosExtKeyPending = key.scan;
        } else {
          teletypeOutput(cpu, emu, ascii);
        }
      } else {
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }

    case 0x02: { // Write character to stdout
      const ch = cpu.reg[EDX] & 0xFF;
      teletypeOutput(cpu, emu, ch);
      break;
    }

    case 0x07: // Direct char input without echo (blocking, no Ctrl-C check)
    case 0x08: { // Char input without echo (blocking, Ctrl-C check)
      if (emu._dosExtKeyPending !== undefined) {
        // Second call after extended key: return the scan code
        cpu.setReg8(EAX, emu._dosExtKeyPending);
        emu._dosExtKeyPending = undefined;
      } else if (emu.dosKeyBuffer.length > 0) {
        const key = emu.dosKeyBuffer.shift()!;
        const ascii = key.ascii === 0xE0 ? 0 : key.ascii;
        cpu.setReg8(EAX, ascii);
        if (ascii === 0) {
          emu._dosExtKeyPending = key.scan;
        }
      } else {
        // Also check BDA keyboard buffer (keys from INT 09h / injectHwKey)
        const BDA = 0x400;
        const head = cpu.mem.readU16(BDA + 0x1A);
        const tail = cpu.mem.readU16(BDA + 0x1C);
        if (head !== tail) {
          const keyWord = cpu.mem.readU16(BDA + head);
          let ascii2 = keyWord & 0xFF;
          const scan2 = (keyWord >> 8) & 0xFF;
          // Advance BDA head
          const bufStart = cpu.mem.readU16(BDA + 0x80);
          const bufEnd = cpu.mem.readU16(BDA + 0x82);
          let newHead = head + 2;
          if (newHead >= bufEnd) newHead = bufStart;
          cpu.mem.writeU16(BDA + 0x1A, newHead);
          // Convert E0 prefix to 0 for legacy callers
          if (ascii2 === 0xE0) ascii2 = 0;
          cpu.setReg8(EAX, ascii2);
          if (ascii2 === 0) {
            emu._dosExtKeyPending = scan2;
          }
          break;
        }
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }

    case 0x06: { // Direct console I/O
      const dl = cpu.reg[EDX] & 0xFF;
      if (dl === 0xFF) {
        // Input: check for keystroke
        if (emu.dosKeyBuffer.length > 0) {
          const key = emu.dosKeyBuffer.shift()!;
          cpu.setReg8(EAX, key.ascii);
          cpu.setFlag(ZF, false);
        } else {
          cpu.setReg8(EAX, 0);
          cpu.setFlag(ZF, true);
        }
      } else {
        // Output
        teletypeOutput(cpu, emu, dl);
      }
      break;
    }

    case 0x09: { // Write '$'-terminated string (DS:DX)
      const dsBase = cpu.segBase(cpu.ds);
      const dx = cpu.getReg16(EDX);
      let addr = dsBase + dx;
      for (let i = 0; i < 65536; i++) {
        const ch = cpu.mem.readU8(addr);
        if (ch === 0x24) break; // '$'
        teletypeOutput(cpu, emu, ch);
        addr++;
      }
      break;
    }

    case 0x0A: { // Buffered input (DS:DX → buffer)
      // Block for input — simplified: we'll treat this as blocking
      emu._dosWaitingForKey = 'read';
      emu.waitingForMessage = true;
      break;
    }

    case 0x0B: // Check stdin status → AL=0xFF if char available, 0x00 if not
      cpu.setReg8(EAX, emu.dosKeyBuffer.length > 0 ? 0xFF : 0x00);
      break;

    case 0x0E: { // Select default drive (DL=drive number 0=A,1=B,2=C...)
      const dl = cpu.reg[EDX] & 0xFF;
      const driveLetter = String.fromCharCode(0x41 + Math.min(dl, 25));
      emu.currentDrive = driveLetter;
      cpu.setReg8(EAX, 26); // AL = number of logical drives
      break;
    }

    case 0x19: { // Get current drive → AL=drive number
      const driveCode = emu.currentDrive.charCodeAt(0) - 0x41;
      cpu.setReg8(EAX, driveCode);
      break;
    }

    case 0x1A: // Set DTA address (DS:DX)
      dosSetDTA(cpu, emu);
      break;

    case 0x1C: { // Get drive info (DL=drive, 0=default)
      // Return: AL=sectors/cluster, CX=bytes/sector, DX=total clusters, DS:BX→media ID byte
      cpu.setReg8(EAX, 8);       // 8 sectors per cluster
      cpu.setReg16(ECX, 512);    // 512 bytes per sector
      cpu.setReg16(EDX, 65535);  // total clusters
      break;
    }

    case 0x25: { // Set interrupt vector (AL=int, DS:DX=handler)
      const intNo = al;
      const handler = (cpu.getReg16(EDX)) | (cpu.ds << 16);
      emu._dosIntVectors.set(intNo, handler);
      // Also update the real IVT in memory so programs that read it directly
      // (e.g. CALL FAR through IVT) get the correct vector
      emu.memory.writeU16(intNo * 4, cpu.getReg16(EDX));     // offset
      emu.memory.writeU16(intNo * 4 + 2, cpu.ds);            // segment
      break;
    }

    case 0x2A: { // Get date → CX=year, DH=month, DL=day, AL=day of week
      const now = new Date();
      cpu.setReg16(ECX, now.getFullYear());
      cpu.setReg16(EDX, ((now.getMonth() + 1) << 8) | now.getDate());
      cpu.setReg8(EAX, now.getDay());
      break;
    }

    case 0x2C: { // Get time → CH=hour, CL=min, DH=sec, DL=1/100sec
      const now = new Date();
      cpu.setReg16(ECX, (now.getHours() << 8) | now.getMinutes());
      cpu.setReg16(EDX, (now.getSeconds() << 8) | Math.floor(now.getMilliseconds() / 10));
      break;
    }

    case 0x2F: // Get DTA → ES:BX
      dosGetDTA(cpu, emu);
      break;

    case 0x30: { // Get DOS version → AL=major, AH=minor
      // AL on entry: 0=standard, 1=get true version
      const DOS_MAJOR = 5;
      const DOS_MINOR = 0;
      cpu.setReg16(EAX, (DOS_MINOR << 8) | DOS_MAJOR); // AL=major, AH=minor
      cpu.setReg16(EBX, 0x0000); // BH=version flag, BL=OEM serial
      cpu.setReg16(ECX, 0x0000);
      break;
    }

    case 0x33: // Get/set Ctrl-C check state
      if (al === 0x00) cpu.setReg8(2 /* DL */, 0); // DL=0 OFF
      break;

    case 0x35: { // Get interrupt vector (AL=int) → ES:BX
      let vec = emu._dosIntVectors.get(al) || 0;
      // Fall back to IVT memory — programs may write vectors directly
      // to the IVT without using INT 21h AH=25h
      const biosDefault = emu._dosBiosDefaultVectors.get(al) ?? 0;
      if (!vec || vec === biosDefault) {
        const ivtOff = cpu.mem.readU16(al * 4);
        const ivtSeg = cpu.mem.readU16(al * 4 + 2);
        const ivtVec = (ivtSeg << 16) | ivtOff;
        if (ivtVec !== biosDefault && ivtSeg !== 0xF000) vec = ivtVec;
      }
      cpu.setReg16(EBX, vec & 0xFFFF);
      cpu.es = (vec >>> 16) & 0xFFFF;
      break;
    }

    case 0x36: { // Get free disk space (DL=drive, 0=default)
      // AX=sectors/cluster, BX=available clusters, CX=bytes/sector, DX=total clusters
      cpu.setReg16(EAX, 8);       // 8 sectors per cluster
      cpu.setReg16(EBX, 32768);   // ~128MB free
      cpu.setReg16(ECX, 512);     // 512 bytes per sector
      cpu.setReg16(EDX, 65535);   // total clusters
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3B: { // Change current directory (DS:DX=path)
      const dsBase = cpu.segBase(cpu.ds);
      const dx = cpu.getReg16(EDX);
      let path = '';
      for (let i = 0; i < 128; i++) {
        const ch = cpu.mem.readU8(dsBase + dx + i);
        if (ch === 0) break;
        path += String.fromCharCode(ch);
      }
      const resolved = dosResolvePath(emu, path);
      const drive = resolved[0];
      console.log(`[DOS] CHDIR "${path}" -> "${resolved}"`);
      emu.currentDirs.set(drive, resolved);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x3C: // Create file (CX=attributes, DS:DX=filename)
      dosCreateFile(cpu, emu);
      break;

    case 0x3D: // Open file (AL=mode, DS:DX=filename)
      dosOpenFile(cpu, emu);
      break;

    case 0x3E: // Close file
      dosCloseFile(cpu, emu);
      break;

    case 0x3F: // Read file (BX=handle, CX=count, DS:DX=buffer)
      dosReadFile(cpu, emu);
      break;

    case 0x42: // Seek file (BX=handle, AL=origin, CX:DX=offset)
      dosSeekFile(cpu, emu);
      break;

    case 0x43: // Get/Set file attributes
      dosFileAttributes(cpu, emu);
      break;

    case 0x47: { // Get current directory (DL=drive, DS:SI → 64-byte buffer)
      const dsBase = cpu.segBase(cpu.ds);
      const si = cpu.getReg16(ESI);
      const dl = cpu.reg[EDX] & 0xFF;
      const driveLetter = dl === 0 ? emu.currentDrive : String.fromCharCode(0x40 + dl);
      const curDir = emu.currentDirs.get(driveLetter) || (driveLetter + ':\\');
      // DOS convention: return path without drive letter and without leading backslash
      // e.g. "C:\WINDOWS\SYSTEM32" → "WINDOWS\SYSTEM32", "C:\" → ""
      let dirStr = curDir.length > 3 ? curDir.substring(3) : '';
      for (let i = 0; i < dirStr.length && i < 63; i++) {
        cpu.mem.writeU8(dsBase + si + i, dirStr.charCodeAt(i));
      }
      cpu.mem.writeU8(dsBase + si + Math.min(dirStr.length, 63), 0);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x52: { // Get List of Lists → ES:BX
      // Build LoL structure if not already done
      if (!emu._dosLoLAddr) {
        buildDosLoL(cpu, emu);
      }
      const lolAddr = emu._dosLoLAddr!;
      cpu.es = (lolAddr >>> 4) & 0xFFFF;
      cpu.setReg16(EBX, lolAddr & 0x0F);
      break;
    }

    case 0x4E: // FindFirst (CX=attributes, DS:DX=filespec)
      dosFindFirst(cpu, emu);
      break;

    case 0x4F: // FindNext
      dosFindNext(cpu, emu);
      break;

    case 0x40: // Write to file handle (BX=handle, CX=count, DS:DX=buffer)
      dosWriteFile(cpu, emu);
      break;

    case 0x44: // IOCTL
      dosIoctl(cpu, emu);
      break;

    case 0x48: { // Allocate memory (BX=paragraphs)
      const paras = cpu.getReg16(EBX);
      // Walk MCB chain to find a free block large enough
      const firstMcb = emu._dosMcbFirstSeg || 0x0060;
      let mcbSeg = firstMcb;
      let allocated = false;
      let largestFree = 0;
      for (let iter = 0; iter < 1000; iter++) {
        const mcbLin = mcbSeg * 16;
        const type = cpu.mem.readU8(mcbLin);
        const owner = cpu.mem.readU16(mcbLin + 1);
        const size = cpu.mem.readU16(mcbLin + 3);
        if (owner === 0 && size >= paras) {
          // Found a free block — split it
          const blockSeg = mcbSeg + 1;
          const pspSeg = emu._dosPSP || emu._dosLoadSegment || 0x100;
          cpu.mem.writeU16(mcbLin + 1, pspSeg); // owner = current PSP
          if (size > paras + 1) {
            // Split: shrink this MCB and create a new free MCB after
            cpu.mem.writeU16(mcbLin + 3, paras);
            cpu.mem.writeU8(mcbLin, 0x4D); // 'M'
            const newMcbSeg = blockSeg + paras;
            const newMcbLin = newMcbSeg * 16;
            cpu.mem.writeU8(newMcbLin, type); // inherit 'M' or 'Z'
            cpu.mem.writeU16(newMcbLin + 1, 0x0000); // free
            cpu.mem.writeU16(newMcbLin + 3, size - paras - 1);
          }
          cpu.setReg16(EAX, blockSeg);
          cpu.setFlag(CF, false);
          allocated = true;
          break;
        }
        if (owner === 0 && size > largestFree) largestFree = size;
        if (type === 0x5A) break; // last block
        mcbSeg += size + 1;
      }
      if (!allocated) {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 8); // insufficient memory
        cpu.setReg16(EBX, largestFree);
      }
      break;
    }

    case 0x49: { // Free memory (ES=segment of block)
      const blockSeg = cpu.es;
      const mcbLin = (blockSeg - 1) * 16;
      const type = cpu.mem.readU8(mcbLin);
      if (type === 0x4D || type === 0x5A) {
        cpu.mem.writeU16(mcbLin + 1, 0x0000); // mark as free
      }
      cpu.setFlag(CF, false);
      break;
    }

    case 0x4A: { // Resize memory block (ES=segment, BX=new size in paragraphs)
      const blockSeg = cpu.es;
      const newParas = cpu.getReg16(EBX);
      const topOfMem = 0xA000;

      // Update MCB at blockSeg - 1
      const mcbLinear = (blockSeg - 1) * 16;
      const mcbType = cpu.mem.readU8(mcbLinear);
      if (mcbType === 0x4D || mcbType === 0x5A) {
        const oldParas = cpu.mem.readU16(mcbLinear + 3);
        if (blockSeg + newParas > topOfMem) {
          // Not enough memory
          cpu.setFlag(CF, true);
          cpu.setReg16(EAX, 8); // insufficient memory
          cpu.setReg16(EBX, topOfMem - blockSeg); // max available
          break;
        }
        // Update this MCB's size
        cpu.mem.writeU16(mcbLinear + 3, newParas);

        // Update or create the free MCB after the resized block
        const freeSeg = blockSeg + newParas;
        const freeLinear = freeSeg * 16;
        const freeParas = topOfMem - freeSeg - 1;
        if (freeParas > 0) {
          cpu.mem.writeU8(mcbLinear, 0x4D); // more blocks follow
          cpu.mem.writeU8(freeLinear, 0x5A); // last block
          cpu.mem.writeU16(freeLinear + 1, 0x0000); // free
          cpu.mem.writeU16(freeLinear + 3, freeParas);
        } else {
          cpu.mem.writeU8(mcbLinear, 0x5A); // this is now last block
        }
      }

      // Update heap pointers
      const blockEnd = (blockSeg + newParas) * 16;
      if (blockEnd > emu.heapBase) {
        emu.heapBase = ((blockEnd + 0xF) & ~0xF);
        emu.heapPtr = emu.heapBase;
      }
      cpu.setFlag(CF, false);
      break;
    }

    case 0x4C: { // Terminate with return code
      const retCode = al;
      if (dosExecReturn(cpu, emu, retCode)) break;
      // Check PSP terminate address (offset 0x0A) — used by custom loaders
      // that set up a child PSP with a return address (like Second Reality's runexe)
      {
        const pspLin = (emu._dosPSP || 0x100) * 16;
        const termIP = cpu.mem.readU16(pspLin + 0x0A);
        const termCS = cpu.mem.readU16(pspLin + 0x0C);
        const parentPSP = cpu.mem.readU16(pspLin + 0x16);
        // If terminate address points to real code (not BIOS stub) and parent PSP differs
        if (termCS !== 0xF000 && termCS !== 0 && parentPSP !== (emu._dosPSP || 0x100)) {
          console.log(`[INT 21h] AH=4C: child PSP=${(emu._dosPSP||0x100).toString(16)} returning to ${termCS.toString(16)}:${termIP.toString(16)} parent=${parentPSP.toString(16)}`);
          emu._dosExitCode = retCode;
          // Restore parent PSP
          emu._dosPSP = parentPSP;
          // Jump to terminate address
          cpu.cs = termCS;
          cpu.eip = cpu.segBase(termCS) + termIP;
          break;
        }
      }
      emu.exitedNormally = true;
      emu.halted = true;
      cpu.halted = true;
      cpu.haltReason = `terminated with code ${retCode}`;
      break;
    }

    case 0x50: { // Set PSP segment
      emu._dosPSP = cpu.getReg16(EBX);
      break;
    }

    case 0x51: case 0x62: { // Get PSP segment → BX
      cpu.setReg16(EBX, emu._dosPSP || emu._dosLoadSegment || 0);
      break;
    }

    case 0x66: { // Get/Set global code page
      if (al === 0x01) {
        // Get: BX = active code page, DX = system code page
        cpu.setReg16(EBX, 437); // US English
        cpu.setReg16(EDX, 437);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, false); // Set — just succeed
      }
      break;
    }

    case 0x65: { // Get Extended Country Information
      if (al === 0x02 || al === 0x06) {
        // AL=02: Get uppercase table, AL=06: Get collating table
        // Write a minimal info block at ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(EDI);
        const addr = esBase + di;
        cpu.mem.writeU8(addr, al); // info ID
        // Write a pointer to a 256-byte identity map
        // Allocate a small area for the table
        const tblAddr = emu.heapPtr;
        emu.heapPtr += 258;
        cpu.mem.writeU16(tblAddr, 256); // table size
        for (let j = 0; j < 256; j++) cpu.mem.writeU8(tblAddr + 2 + j, j);
        // Write far pointer to table (offset:segment)
        const tblSeg = (tblAddr >>> 4) & 0xFFFF;
        const tblOff = tblAddr & 0xF;
        cpu.mem.writeU16(addr + 1, tblOff);
        cpu.mem.writeU16(addr + 3, tblSeg);
        cpu.setReg16(ECX, 5);
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 1);
      }
      break;
    }

    case 0x71:
      // Windows 95 Long Filename (LFN) API — not supported
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 0x7100); // function not supported
      break;

    case 0x63: { // Get Lead Byte Table (DBCS)
      // DS:SI → empty DBCS lead byte table (just a terminating 0x0000)
      // Use a fixed address in low memory (0x600 — free DOS area)
      const tblLinear = 0x600;
      cpu.mem.writeU16(tblLinear, 0); // empty table = 0x0000 terminator
      cpu.ds = (tblLinear >> 4) & 0xFFFF;
      cpu.setReg16(ESI, tblLinear & 0xF);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x29: { // Parse Filename into FCB
      const flags = cpu.getReg8(EAX); // AL = parsing flags
      let si = (cpu.ds << 4) + cpu.getReg16(ESI);
      const di = (cpu.es << 4) + cpu.getReg16(EDI);
      const mem = cpu.mem;

      // Skip leading separators if bit 0 set
      if (flags & 1) {
        while (si < mem.length) {
          const ch = mem.readU8(si);
          if (ch === 0x20 || ch === 0x09) { si++; } // space/tab
          else break;
        }
      }

      // Initialize FCB: drive=0, filename=spaces, extension=spaces
      mem.writeU8(di, 0); // drive
      for (let i = 1; i <= 8; i++) mem.writeU8(di + i, 0x20); // filename
      for (let i = 9; i <= 11; i++) mem.writeU8(di + i, 0x20); // extension

      let hasWild = false;
      let pos = si;

      // Check for drive letter
      if (pos + 1 < mem.length && mem.readU8(pos + 1) === 0x3A) { // ':'
        const drv = mem.readU8(pos);
        const drvNum = (drv >= 0x61 ? drv - 0x60 : drv >= 0x41 ? drv - 0x40 : 0);
        mem.writeU8(di, drvNum);
        pos += 2;
      }

      // Parse filename (up to 8 chars)
      let fnIdx = 0;
      while (pos < mem.length && fnIdx < 8) {
        const ch = mem.readU8(pos);
        if (ch === 0 || ch === 0x0D || ch === 0x20 || ch === 0x09 || ch === 0x2E || ch === 0x2F || ch === 0x5C) break;
        if (ch === 0x2A) { // '*' — fill rest with '?'
          hasWild = true;
          for (; fnIdx < 8; fnIdx++) mem.writeU8(di + 1 + fnIdx, 0x3F);
          pos++;
          break;
        }
        if (ch === 0x3F) hasWild = true;
        mem.writeU8(di + 1 + fnIdx, ch >= 0x61 && ch <= 0x7A ? ch - 0x20 : ch);
        fnIdx++;
        pos++;
      }

      // Parse extension if '.' present
      if (pos < mem.length && mem.readU8(pos) === 0x2E) {
        pos++; // skip '.'
        let extIdx = 0;
        while (pos < mem.length && extIdx < 3) {
          const ch = mem.readU8(pos);
          if (ch === 0 || ch === 0x0D || ch === 0x20 || ch === 0x09 || ch === 0x2F || ch === 0x5C) break;
          if (ch === 0x2A) {
            hasWild = true;
            for (; extIdx < 3; extIdx++) mem.writeU8(di + 9 + extIdx, 0x3F);
            pos++;
            break;
          }
          if (ch === 0x3F) hasWild = true;
          mem.writeU8(di + 9 + extIdx, ch >= 0x61 && ch <= 0x7A ? ch - 0x20 : ch);
          extIdx++;
          pos++;
        }
      }

      // Update DS:SI to point past parsed name
      cpu.setReg16(ESI, pos & 0xFFFF);
      // AL = 0 (no wildcards), 1 (wildcards found)
      cpu.setReg8(EAX, hasWild ? 1 : 0);
      break;
    }

    case 0x03: // Auxiliary input (AUX/COM1) — return null
      cpu.setReg8(EAX, 0);
      break;

    case 0x04: // Auxiliary output (AUX/COM1) — ignore
    case 0x05: // Printer output (PRN/LPT1) — ignore
      break;

    case 0x0C: { // Clear keyboard buffer, invoke keyboard function
      emu.dosKeyBuffer.length = 0;
      const subFunc = al;
      if (subFunc === 0x01 || subFunc === 0x06 || subFunc === 0x07 || subFunc === 0x08 || subFunc === 0x0A) {
        // Re-dispatch with AH=subfunc
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | (subFunc << 8);
        return handleInt21(cpu, emu);
      }
      break;
    }

    case 0x0D: // Disk reset — flush all buffers, succeed silently
      break;

    case 0x0F: // Open file using FCB — return AL=FF (fail)
    case 0x10: // Close file using FCB — return AL=FF
    case 0x11: // Search first using FCB — return AL=FF (not found)
    case 0x12: // Search next using FCB — return AL=FF (not found)
    case 0x14: // Sequential read using FCB — return AL=01 (EOF)
    case 0x15: // Sequential write using FCB — return AL=01
    case 0x16: // Create file using FCB — return AL=FF (fail)
    case 0x21: // Random read using FCB — return AL=01
    case 0x22: // Random write using FCB — return AL=01
    case 0x27: // Random block read using FCB — CX=0, AL=01
    case 0x28: // Random block write using FCB — CX=0, AL=01
      // FCB functions: stub as failure — FCBs are legacy DOS 1.x API
      cpu.setReg8(EAX, ah === 0x14 || ah === 0x15 || ah === 0x21 || ah === 0x22 || ah === 0x27 || ah === 0x28 ? 0x01 : 0xFF);
      if (ah === 0x27 || ah === 0x28) cpu.setReg16(ECX, 0);
      break;

    case 0x13: { // Delete file using FCB — return AL=FF (fail)
      cpu.setReg8(EAX, 0xFF);
      break;
    }

    case 0x17: { // Rename file using FCB — return AL=FF (fail)
      cpu.setReg8(EAX, 0xFF);
      break;
    }

    case 0x1B: { // Get allocation table info for default drive
      // AL=sectors/cluster, CX=bytes/sector, DX=total clusters, DS:BX→media ID
      cpu.setReg8(EAX, 8);       // 8 sectors per cluster
      cpu.setReg16(ECX, 512);    // 512 bytes per sector
      cpu.setReg16(EDX, 65535);  // total clusters
      break;
    }

    case 0x23: { // Get file size using FCB — return AL=FF (fail)
      cpu.setReg8(EAX, 0xFF);
      break;
    }

    case 0x24: // Set relative record field for FCB — no-op
      break;

    case 0x26: // Create new PSP at segment in DX — minimal stub
      break;

    case 0x2B: // Set date (CX=year, DH=month, DL=day) — accept silently
      cpu.setReg8(EAX, 0); // AL=0 = success
      break;

    case 0x2D: // Set time (CH=hour, CL=min, DH=sec, DL=1/100) — accept silently
      cpu.setReg8(EAX, 0); // AL=0 = success
      break;

    case 0x2E: // Set/reset verify switch (AL=0 off, AL=1 on)
      emu._dosVerifyFlag = !!(al & 1);
      break;

    case 0x31: { // Terminate and stay resident (AL=return code, DX=paragraphs to keep)
      emu.exitedNormally = true;
      emu.halted = true;
      cpu.halted = true;
      break;
    }

    case 0x34: { // Get address of InDOS flag → ES:BX
      // Allocate a single byte for the InDOS flag if not done
      if (!emu._dosInDOSAddr) {
        emu._dosInDOSAddr = emu.heapPtr;
        emu.heapPtr += 2;
        emu.memory.writeU8(emu._dosInDOSAddr, 0);
      }
      cpu.es = (emu._dosInDOSAddr >>> 4) & 0xFFFF;
      cpu.setReg16(EBX, emu._dosInDOSAddr & 0x0F);
      break;
    }

    case 0x37: // Get/set switch character (undocumented)
      if (al === 0x00) {
        cpu.setReg8(2 /* DL */, 0x2F); // '/' is the switch char
        cpu.setReg8(EAX, 0); // AL=0 success
      } else {
        cpu.setReg8(EAX, 0);
      }
      break;

    case 0x38: { // Get/set country-dependent information
      if (al === 0x00 || (al !== 0xFF && (cpu.reg[EDX] & 0xFFFF) !== 0xFFFF)) {
        // Get country info → DS:DX buffer (34 bytes)
        const dsBase = cpu.segBase(cpu.ds);
        const bufAddr = dsBase + cpu.getReg16(EDX);
        // Zero 34 bytes
        for (let i = 0; i < 34; i++) cpu.mem.writeU8(bufAddr + i, 0);
        const DATE_FORMAT_USA = 0;
        cpu.mem.writeU16(bufAddr + 0, DATE_FORMAT_USA);
        // Currency symbol at offset 2 (5 bytes ASCIIZ)
        cpu.mem.writeU8(bufAddr + 2, 0x24); // '$'
        cpu.mem.writeU8(bufAddr + 3, 0);
        // Thousands separator at offset 7 (2 bytes ASCIIZ)
        cpu.mem.writeU8(bufAddr + 7, 0x2C); // ','
        cpu.mem.writeU8(bufAddr + 8, 0);
        // Decimal separator at offset 9 (2 bytes ASCIIZ)
        cpu.mem.writeU8(bufAddr + 9, 0x2E); // '.'
        cpu.mem.writeU8(bufAddr + 10, 0);
        // Date separator at offset 11
        cpu.mem.writeU8(bufAddr + 11, 0x2D); // '-'
        cpu.mem.writeU8(bufAddr + 12, 0);
        // Time separator at offset 13
        cpu.mem.writeU8(bufAddr + 13, 0x3A); // ':'
        cpu.mem.writeU8(bufAddr + 14, 0);
        // Currency format at offset 15
        cpu.mem.writeU8(bufAddr + 15, 0); // currency symbol precedes, no space
        // Digits after decimal in currency at offset 16
        cpu.mem.writeU8(bufAddr + 16, 2);
        // Time format at offset 17 (0=12h, 1=24h)
        cpu.mem.writeU8(bufAddr + 17, 0);
        cpu.setReg16(EBX, 1); // BX = country code (1 = USA)
        cpu.setFlag(CF, false);
      } else {
        // Set country — just succeed
        cpu.setFlag(CF, false);
      }
      break;
    }

    case 0x39: // Create subdirectory (mkdir) DS:DX=path
      dosMkdir(cpu, emu);
      break;

    case 0x3A: // Remove subdirectory (rmdir) DS:DX=path
      dosRmdir(cpu, emu);
      break;

    case 0x41: // Delete file (DS:DX=filename)
      dosDeleteFile(cpu, emu);
      break;

    case 0x45: // Duplicate file handle (BX=handle) → AX=new handle
      dosDupHandle(cpu, emu);
      break;

    case 0x46: // Force duplicate handle (BX=src, CX=dst)
      dosForceDupHandle(cpu, emu);
      break;

    case 0x4B: { // EXEC — Load and Execute Program
      // AL=00 Load+Execute, AL=01 Load overlay, AL=03 Load only
      // DS:DX → ASCIZ program name, ES:BX → parameter block
      const dsBase = cpu.segBase(cpu.ds);
      const dxVal = cpu.getReg16(EDX);
      const pathAddr = dsBase + dxVal;
      // Log raw bytes at path address for debugging
      const rawBytes: string[] = [];
      for (let i = 0; i < 30; i++) {
        const b = cpu.mem.readU8(pathAddr + i);
        if (b === 0) break;
        rawBytes.push(b.toString(16).padStart(2, '0'));
      }
      console.log(`[INT 21h] EXEC path at DS:DX=${cpu.ds.toString(16)}:${dxVal.toString(16)} raw=[${rawBytes.join(' ')}]`);
      const progName = cpu.mem.readCString(pathAddr);
      // Parameter block at ES:BX: word envSeg, dword cmdTail, ...
      const esBase = cpu.segBase(cpu.es);
      const paramBlock = esBase + cpu.getReg16(EBX);
      const envSeg = cpu.mem.readU16(paramBlock);
      const cmdTailOfs = cpu.mem.readU16(paramBlock + 2);
      const cmdTailSeg = cpu.mem.readU16(paramBlock + 4);
      const cmdTailAddr = (cmdTailSeg << 4) + cmdTailOfs;
      // Command tail: first byte = length, then the string, terminated by CR
      const cmdLen = cpu.mem.readU8(cmdTailAddr);
      let cmdTail = '';
      for (let i = 0; i < cmdLen; i++) {
        const ch = cpu.mem.readU8(cmdTailAddr + 1 + i);
        if (ch === 0x0D || ch === 0) break;
        cmdTail += String.fromCharCode(ch);
      }

      if (al !== 0) {
        console.warn(`[INT 21h] EXEC AL=${al} not supported: "${progName}" params="${cmdTail}"`);
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 1); // ERROR_INVALID_FUNCTION
        break;
      }

      // Resolve path and find file data
      const execResolved = dosResolvePath(emu, progName);
      const fileInfo = emu.fs.findFile(execResolved, emu.additionalFiles);
      let execData: Uint8Array | null = null;
      if (fileInfo) {
        if (fileInfo.source === 'additional') {
          const ab = emu.additionalFiles.get(fileInfo.name);
          if (ab) execData = new Uint8Array(ab);
        } else if (fileInfo.source === 'external') {
          const ext = emu.fs.externalFiles.get(execResolved.toUpperCase());
          if (ext) execData = ext.data;
        }
      }
      if (!execData) {
        console.warn(`[INT 21h] EXEC file not found: "${progName}" resolved="${execResolved}"`);
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 2); // ERROR_FILE_NOT_FOUND
        break;
      }

      // Determine if COM or MZ
      const isCom = execResolved.endsWith('.COM') ||
        (execData.length < 0x10000 && !(execData[0] === 0x4D && execData[1] === 0x5A));
      const isMz = !isCom && execData[0] === 0x4D && execData[1] === 0x5A;

      if (!isCom && !isMz) {
        console.warn(`[INT 21h] EXEC unknown format: "${progName}"`);
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 11); // ERROR_BAD_FORMAT
        break;
      }

      // Find free memory block from MCB chain
      const firstMcb = emu._dosMcbFirstSeg || 0x0060;
      let childSeg = 0;
      let availParas = 0;
      {
        let mcbSeg = firstMcb;
        for (let iter = 0; iter < 1000; iter++) {
          const mcbLin = mcbSeg * 16;
          const type = cpu.mem.readU8(mcbLin);
          const owner = cpu.mem.readU16(mcbLin + 1);
          const size = cpu.mem.readU16(mcbLin + 3);
          if (owner === 0 && size > availParas) {
            childSeg = mcbSeg + 1;
            availParas = size;
          }
          if (type === 0x5A) break;
          mcbSeg += size + 1;
        }
      }

      // Calculate required paragraphs
      let neededParas: number;
      if (isCom) {
        // PSP (0x10 paras) + max(image, 64KB segment)
        neededParas = 0x10 + Math.ceil(execData.length / 16);
      } else {
        // MZ: parse header to get image size + minalloc
        const mzDv = new DataView(execData.buffer, execData.byteOffset, execData.byteLength);
        const e_cparhdr = mzDv.getUint16(0x08, true);
        const e_minalloc = mzDv.getUint16(0x0A, true);
        const e_cp = mzDv.getUint16(0x04, true);
        const e_cblp = mzDv.getUint16(0x02, true);
        const headerSize = e_cparhdr * 16;
        let imgSize: number;
        if (e_cp === 0) {
          imgSize = execData.length - headerSize;
        } else {
          imgSize = (e_cp - 1) * 512 + (e_cblp || 512) - headerSize;
        }
        imgSize = Math.min(imgSize, execData.length - headerSize);
        neededParas = 0x10 + Math.ceil(imgSize / 16) + e_minalloc;
      }

      if (availParas < neededParas || childSeg === 0) {
        console.warn(`[INT 21h] EXEC insufficient memory: need ${neededParas} paras, have ${availParas}`);
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 8); // ERROR_NOT_ENOUGH_MEMORY
        break;
      }

      // Save parent state
      emu._dosExecStack.push({
        regs: new Int32Array(cpu.reg),
        cs: cpu.cs, ds: cpu.ds, es: cpu.es, ss: cpu.ss,
        eip: cpu.eip, flags: cpu.getFlags(),
        psp: emu._dosPSP, dta: emu._dosDTA,
      });

      // Allocate MCB for child
      const childMcbLin = (childSeg - 1) * 16;
      cpu.mem.writeU16(childMcbLin + 1, childSeg); // owner = child PSP
      if (availParas > neededParas + 1) {
        // Split MCB
        cpu.mem.writeU16(childMcbLin + 3, neededParas);
        const oldType = cpu.mem.readU8(childMcbLin);
        cpu.mem.writeU8(childMcbLin, 0x4D);
        const freeSeg = childSeg + neededParas;
        const freeLin = freeSeg * 16;
        cpu.mem.writeU8(freeLin, oldType);
        cpu.mem.writeU16(freeLin + 1, 0x0000);
        cpu.mem.writeU16(freeLin + 3, availParas - neededParas - 1);
      }

      // Set up child PSP at childSeg
      const childPspLin = childSeg * 16;
      cpu.mem.writeU8(childPspLin + 0x00, 0xCD); // INT 20h
      cpu.mem.writeU8(childPspLin + 0x01, 0x20);
      cpu.mem.writeU16(childPspLin + 0x02, childSeg + neededParas); // top of memory
      // Environment segment: use parent's if envSeg=0
      const childEnvSeg = envSeg || cpu.mem.readU16((emu._dosPSP << 4) + 0x2C);
      cpu.mem.writeU16(childPspLin + 0x2C, childEnvSeg);
      // Copy command tail to PSP:80h
      cpu.mem.writeU8(childPspLin + 0x80, cmdLen);
      for (let i = 0; i < 127; i++) {
        cpu.mem.writeU8(childPspLin + 0x81 + i, cpu.mem.readU8(cmdTailAddr + 1 + i));
      }
      cpu.mem.writeU8(childPspLin + 0x81 + cmdLen, 0x0D);
      // Parent PSP
      cpu.mem.writeU16(childPspLin + 0x16, emu._dosPSP);

      // Load child program
      const childProgSeg = childSeg + 0x10; // after PSP
      const childProgLin = childProgSeg * 16;
      let childCS: number, childIP: number, childSS: number, childSP: number;

      if (isCom) {
        // COM: load at PSP:0100h
        for (let i = 0; i < execData.length; i++) {
          cpu.mem.writeU8(childPspLin + 0x100 + i, execData[i]);
        }
        childCS = childSeg;
        childIP = 0x0100;
        childSS = childSeg;
        childSP = 0xFFFE;
      } else {
        // MZ: parse and load
        const mzDv = new DataView(execData.buffer, execData.byteOffset, execData.byteLength);
        const e_cparhdr = mzDv.getUint16(0x08, true);
        const e_cp = mzDv.getUint16(0x04, true);
        const e_cblp = mzDv.getUint16(0x02, true);
        const e_crlc = mzDv.getUint16(0x06, true);
        const e_lfarlc = mzDv.getUint16(0x18, true);
        const headerSize = e_cparhdr * 16;
        let imgSize: number;
        if (e_cp === 0) {
          imgSize = execData.length - headerSize;
        } else {
          imgSize = (e_cp - 1) * 512 + (e_cblp || 512) - headerSize;
        }
        imgSize = Math.min(imgSize, execData.length - headerSize);

        // Copy image
        for (let i = 0; i < imgSize; i++) {
          cpu.mem.writeU8(childProgLin + i, execData[headerSize + i]);
        }

        // Apply relocations
        for (let i = 0; i < e_crlc; i++) {
          const rOff = e_lfarlc + i * 4;
          if (rOff + 4 > execData.length) break;
          const off = mzDv.getUint16(rOff, true);
          const seg = mzDv.getUint16(rOff + 2, true);
          const linearAddr = childProgLin + seg * 16 + off;
          const oldVal = cpu.mem.readU16(linearAddr);
          cpu.mem.writeU16(linearAddr, (oldVal + childProgSeg) & 0xFFFF);
        }

        childCS = (mzDv.getUint16(0x16, true) + childProgSeg) & 0xFFFF;
        childIP = mzDv.getUint16(0x14, true);
        childSS = (mzDv.getUint16(0x0E, true) + childProgSeg) & 0xFFFF;
        childSP = mzDv.getUint16(0x10, true);
      }

      // Switch to child
      emu._dosPSP = childSeg;
      emu._dosDTA = childPspLin + 0x80; // default DTA at PSP:80h
      cpu.cs = childCS;
      cpu.ds = childSeg;
      cpu.es = childSeg;
      cpu.ss = childSS;
      cpu.eip = cpu.segBase(childCS) + childIP;
      cpu.reg[4] = childSP; // SP
      cpu.setFlags(cpu.getFlags() | 0x0200); // IF=1

      console.log(`[INT 21h] EXEC "${progName}" -> CS:IP=${childCS.toString(16)}:${childIP.toString(16)} SS:SP=${childSS.toString(16)}:${childSP.toString(16)} PSP=${childSeg.toString(16)} ${isCom ? 'COM' : 'MZ'} progSeg=${childProgSeg.toString(16)}`);
      // Log INT 16h vector at EXEC time
      const int16off = cpu.mem.readU16(0x16 * 4);
      const int16seg = cpu.mem.readU16(0x16 * 4 + 2);
      console.log(`[INT 21h] INT 16h vector at EXEC: ${int16seg.toString(16)}:${int16off.toString(16)}`);
      cpu.setFlag(CF, false);
      break;
    }

    case 0x4D: // Get return code of sub-process → AX=return code
      cpu.setReg16(EAX, emu._dosExitCode);
      break;

    case 0x54: // Get verify setting → AL
      cpu.setReg8(EAX, emu._dosVerifyFlag ? 1 : 0);
      break;

    case 0x55: { // Create child PSP (DX=segment for new PSP)
      const newPspSeg = cpu.getReg16(EDX);
      const newPspLin = newPspSeg * 16;
      const srcPspLin = (emu._dosPSP || 0x100) * 16;
      // Copy 256 bytes from current PSP to new PSP
      for (let i = 0; i < 256; i++) {
        cpu.mem.writeU8(newPspLin + i, cpu.mem.readU8(srcPspLin + i));
      }
      // Update parent PSP pointer (offset 0x16) to point to current PSP
      cpu.mem.writeU16(newPspLin + 0x16, emu._dosPSP || 0x100);
      break;
    }

    case 0x56: // Rename file (DS:DX=old, ES:DI=new)
      dosRenameFile(cpu, emu);
      break;

    case 0x57: // Get/set file date and time (BX=handle)
      dosFileDateTime(cpu, emu);
      break;

    case 0x58: { // Get/set memory allocation strategy
      if (al === 0x00) {
        // Get: return first fit (0)
        cpu.setReg16(EAX, 0);
        cpu.setFlag(CF, false);
      } else if (al === 0x01) {
        // Set — accept silently
        cpu.setFlag(CF, false);
      } else if (al === 0x02) {
        // Get UMB link state — UMBs not linked (0)
        cpu.setReg16(EAX, 0);
        cpu.setFlag(CF, false);
      } else if (al === 0x03) {
        // Set UMB link state — accept silently
        cpu.setFlag(CF, false);
      } else {
        cpu.setFlag(CF, true);
        cpu.setReg16(EAX, 1);
      }
      break;
    }

    case 0x59: { // Get extended error information
      // AX=extended error code, BH=error class, BL=suggested action, CH=locus
      cpu.setReg16(EAX, 0); // no error
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0000; // class=0, action=0
      cpu.setReg16(ECX, 0); // locus=0
      break;
    }

    case 0x5A: // Create temporary file (CX=attr, DS:DX=path prefix)
      dosCreateTempFile(cpu, emu);
      break;

    case 0x5B: // Create new file (fail if exists) CX=attr, DS:DX=filename
      dosCreateNewFile(cpu, emu);
      break;

    case 0x5C: // Lock/unlock file region
      dosLockFile(cpu, emu);
      break;

    case 0x67: // Set handle count
      dosSetHandleCount(cpu, emu);
      break;

    case 0x68: // Flush buffer (BX=handle)
      dosFlushBuffer(cpu, emu);
      break;

    case 0x6C: // Extended open/create (DOS 4.0+)
      dosExtendedOpen(cpu, emu);
      break;

    default:
      console.warn(`[INT 21h] Unhandled AH=0x${ah.toString(16)} at EIP=0x${(cpu.eip >>> 0).toString(16)}`);
      cpu.setFlag(CF, true);
      cpu.setReg16(EAX, 1); // invalid function
      break;
  }
  return true;
}

/**
 * Build DOS List of Lists (LoL) and MCB chain for INT 21h AH=52h.
 * MEM.EXE walks the MCB chain starting from LoL offset -2.
 */
function buildDosLoL(cpu: CPU, emu: Emulator): void {
  const mem = cpu.mem;

  // MCB chain was already set up by mz-loader.ts
  const MCB_FIRST_SEG = emu._dosMcbFirstSeg || 0x0060;

  // List of Lists structure
  // Allocate at a paragraph-aligned address above MCB chain
  // LoL has first MCB segment at offset -2 from the returned ES:BX
  // So we need: [word firstMCBseg] [LoL data...]
  const lolBase = ((emu.heapPtr + 0xF) & ~0xF);
  emu.heapPtr = lolBase + 128;
  // Zero it
  for (let i = 0; i < 128; i++) mem.writeU8(lolBase + i, 0);

  // Write first MCB segment at lolBase (this becomes offset -2 of LoL)
  mem.writeU16(lolBase, MCB_FIRST_SEG);

  // The returned pointer (ES:BX) points to lolBase+2
  // Key fields in LoL (offsets from ES:BX):
  // -2: first MCB segment (already written)
  // +0: pointer to first DPB (0 = none)
  // +4: pointer to first SFT (0 = none)
  // +22h: number of block devices
  // +24h: NUL device header
  const lolPtr = lolBase + 2;

  // DPB pointer = 0 (no drives)
  mem.writeU32(lolPtr + 0x00, 0xFFFFFFFF); // no DPB chain

  // SFT pointer
  mem.writeU32(lolPtr + 0x04, 0xFFFFFFFF);

  // Number of block devices at +0x20
  mem.writeU8(lolPtr + 0x20, 3); // C: D: E:

  // NUL device header at +0x22 (18 bytes)
  // Next pointer = FFFF:FFFF
  mem.writeU32(lolPtr + 0x22, 0xFFFFFFFF);
  // Attribute = 0x8004 (character device, NUL)
  mem.writeU16(lolPtr + 0x26, 0x8004);

  emu._dosLoLAddr = lolPtr;
}
