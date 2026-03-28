import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, EBX = 3, EDX = 2, ESI = 6;

// XMS entry point stub location: F000:0800
export const XMS_STUB_SEG = 0xF000;
export const XMS_STUB_OFF = 0x0800;
// INT number used by the XMS stub to trap into our handler
export const XMS_INT = 0xFE;

/** Called from emu-load.ts to write the XMS far-call stub into BIOS ROM area. */
export function setupXmsStub(mem: { writeU8(addr: number, val: number): void }): void {
  const base = XMS_STUB_SEG * 16 + XMS_STUB_OFF;
  mem.writeU8(base + 0, 0xCD); // INT 0xFE
  mem.writeU8(base + 1, XMS_INT);
  mem.writeU8(base + 2, 0xCB); // RETF
}

/** Handle INT 0xFE — XMS driver dispatch. Called via far-call to F000:0800. */
export function handleXms(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;

  switch (ah) {
    case 0x00: { // Get XMS version
      cpu.setReg16(EAX, 0x0300); // XMS spec v3.0
      cpu.setReg16(EBX, 0x0001); // driver internal revision
      cpu.setReg16(EDX, 0x0001); // HMA exists
      return true;
    }

    case 0x01: { // Request HMA — DX = bytes needed
      cpu.setReg16(EAX, 1); // success (HMA granted)
      return true;
    }

    case 0x02: { // Release HMA
      cpu.setReg16(EAX, 1);
      return true;
    }

    case 0x03: // Global Enable A20
    case 0x05: // Local Enable A20
      emu.memory.a20Mask = 0xFFFFFFFF;
      cpu.setReg16(EAX, 1);
      cpu.setReg8(EBX, 0x00);
      return true;
    case 0x04: // Global Disable A20
    case 0x06: { // Local Disable A20
      emu.memory.a20Mask = 0xFFFFF;
      cpu.setReg16(EAX, 1);
      cpu.setReg8(EBX, 0x00);
      return true;
    }

    case 0x07: { // Query A20 state
      cpu.setReg16(EAX, emu.memory.a20Mask === 0xFFFFFFFF ? 1 : 0);
      cpu.setReg8(EBX, 0x00);
      return true;
    }

    case 0x08: { // Query free extended memory
      let usedKB = 0;
      for (const h of emu._xmsHandles.values()) usedKB += h.size;
      const freeKB = Math.max(0, emu._xmsTotalKB - usedKB);
      cpu.setReg16(EAX, Math.min(freeKB, 0xFFFF)); // largest free block (KB)
      cpu.setReg16(EDX, Math.min(freeKB, 0xFFFF)); // total free (KB)
      cpu.setReg8(EBX, 0x00); // BL = no error
      return true;
    }

    case 0x09: { // Allocate EMB — DX = size in KB
      const sizeKB = cpu.getReg16(EDX);
      let usedKB = 0;
      for (const h of emu._xmsHandles.values()) usedKB += h.size;
      if (sizeKB > emu._xmsTotalKB - usedKB) {
        cpu.setReg16(EAX, 0); // fail
        cpu.setReg8(EBX, 0xA0); // BL = all XMS allocated
        return true;
      }
      const sizeBytes = sizeKB * 1024;
      const base = xmsAlloc(emu, sizeBytes);
      const handle = emu._xmsNextHandle++;
      emu._xmsHandles.set(handle, { base, size: sizeKB, lockCount: 0 });
      // Track handle by current PSP for auto-free on program exit
      const psp = emu._dosPSP ?? 0;
      if (!emu._xmsPspHandles.has(psp)) emu._xmsPspHandles.set(psp, new Set());
      emu._xmsPspHandles.get(psp)!.add(handle);
      cpu.setReg16(EAX, 1); // success
      cpu.setReg16(EDX, handle);
      return true;
    }

    case 0x0A: { // Free EMB — DX = handle
      const handle = cpu.getReg16(EDX);
      const emb = emu._xmsHandles.get(handle);
      if (!emb) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }
      xmsFree(emu, emb.base, emb.size * 1024);
      emu._xmsHandles.delete(handle);
      // Remove from PSP tracking
      for (const set of emu._xmsPspHandles.values()) set.delete(handle);
      cpu.setReg16(EAX, 1);
      return true;
    }

    case 0x0B: { // Move EMB — DS:SI → XMS move structure
      const structAddr = cpu.segBase(cpu.ds) + (cpu.reg[ESI] & 0xFFFF);
      const length = emu.memory.readU32(structAddr) >>> 0;
      const srcHandle = emu.memory.readU16(structAddr + 4);
      const srcOffset = emu.memory.readU32(structAddr + 6) >>> 0;
      const dstHandle = emu.memory.readU16(structAddr + 10);
      const dstOffset = emu.memory.readU32(structAddr + 12) >>> 0;

      const srcBase = resolveXmsAddr(emu, srcHandle, srcOffset);
      const dstBase = resolveXmsAddr(emu, dstHandle, dstOffset);

      if (srcBase < 0 || dstBase < 0) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }

      // Bounds-check: clamp length to handle size (like DOSBox)
      let copyLen = length;
      if (srcHandle !== 0) {
        const srcEmb = emu._xmsHandles.get(srcHandle);
        if (srcEmb) {
          const maxSrc = srcEmb.size * 1024 - srcOffset;
          if (copyLen > maxSrc) copyLen = Math.max(0, maxSrc);
        }
      }
      if (dstHandle !== 0) {
        const dstEmb = emu._xmsHandles.get(dstHandle);
        if (dstEmb) {
          const maxDst = dstEmb.size * 1024 - dstOffset;
          if (copyLen > maxDst) copyLen = Math.max(0, maxDst);
        }
      }

      emu.memory.copyBlock(dstBase, srcBase, copyLen);
      cpu.setReg16(EAX, 1);
      return true;
    }

    case 0x0C: { // Lock EMB — DX = handle → DX:BX = 32-bit linear address
      const handle = cpu.getReg16(EDX);
      const emb = emu._xmsHandles.get(handle);
      if (!emb) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }
      emb.lockCount++;
      cpu.setReg16(EAX, 1);
      cpu.setReg16(EDX, (emb.base >>> 16) & 0xFFFF); // high word
      cpu.setReg16(EBX, emb.base & 0xFFFF);           // low word
      return true;
    }

    case 0x0D: { // Unlock EMB — DX = handle
      const handle = cpu.getReg16(EDX);
      const emb = emu._xmsHandles.get(handle);
      if (!emb) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }
      if (emb.lockCount > 0) emb.lockCount--;
      cpu.setReg16(EAX, 1);
      return true;
    }

    case 0x0E: { // Get EMB handle info — DX = handle
      const handle = cpu.getReg16(EDX);
      const emb = emu._xmsHandles.get(handle);
      if (!emb) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }
      cpu.setReg16(EAX, 1);
      cpu.setReg8(EBX + 4, emb.lockCount & 0xFF);                        // BH = lock count
      cpu.setReg8(EBX, Math.max(0, 128 - emu._xmsHandles.size) & 0xFF); // BL = free handles
      cpu.setReg16(EDX, emb.size); // DX = size in KB
      return true;
    }

    case 0x0F: { // Reallocate EMB — DX = handle, BX = new size in KB
      const handle = cpu.getReg16(EDX);
      const newSizeKB = cpu.getReg16(EBX);
      const emb = emu._xmsHandles.get(handle);
      if (!emb) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xA2); // BL = invalid handle
        return true;
      }
      if (emb.lockCount > 0) {
        cpu.setReg16(EAX, 0);
        cpu.setReg8(EBX, 0xAB); // BL = EMB locked
        return true;
      }
      if (newSizeKB > emb.size) {
        let usedKB = 0;
        for (const h of emu._xmsHandles.values()) usedKB += h.size;
        if (newSizeKB - emb.size > emu._xmsTotalKB - usedKB) {
          cpu.setReg16(EAX, 0);
          cpu.setReg8(EBX, 0xA0); // BL = all XMS allocated
          return true;
        }
        const newSizeBytes = newSizeKB * 1024;
        const newBase = xmsAlloc(emu, newSizeBytes);
        const copyLen = emb.size * 1024;
        for (let i = 0; i < copyLen; i++) {
          emu.memory.writeU8(newBase + i, emu.memory.readU8(emb.base + i));
        }
        xmsFree(emu, emb.base, emb.size * 1024);
        emb.base = newBase;
      }
      // If shrinking, free the tail portion
      if (newSizeKB < emb.size) {
        const shrinkBytes = (emb.size - newSizeKB) * 1024;
        xmsFree(emu, emb.base + newSizeKB * 1024, shrinkBytes);
      }
      emb.size = newSizeKB;
      cpu.setReg16(EAX, 1);
      return true;
    }

    default:
      console.warn(`[XMS] Unhandled function AH=0x${ah.toString(16).padStart(2, '0')}`);
      cpu.setReg16(EAX, 0);
      cpu.setReg8(EBX, 0x80); // BL = not implemented
      return true;
  }
}

/** Allocate bytes from XMS pool — try free list first, then bump. */
function xmsAlloc(emu: Emulator, sizeBytes: number): number {
  const freeBlocks = emu._xmsFreeBlocks;
  // First-fit from free list
  for (let i = 0; i < freeBlocks.length; i++) {
    const block = freeBlocks[i];
    if (block.size >= sizeBytes) {
      const base = block.base;
      if (block.size === sizeBytes) {
        freeBlocks.splice(i, 1);
      } else {
        block.base += sizeBytes;
        block.size -= sizeBytes;
      }
      return base;
    }
  }
  // Bump allocate
  const base = emu._xmsNextAddr;
  emu._xmsNextAddr += sizeBytes;
  return base;
}

/** Return bytes to the XMS free list, merging adjacent blocks. */
function xmsFree(emu: Emulator, base: number, sizeBytes: number): void {
  if (sizeBytes === 0) return;
  // If this block is at the top of the bump allocator, just shrink it
  if (base + sizeBytes === emu._xmsNextAddr) {
    emu._xmsNextAddr = base;
    // Check if any free blocks now touch the new top
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = emu._xmsFreeBlocks.length - 1; i >= 0; i--) {
        const b = emu._xmsFreeBlocks[i];
        if (b.base + b.size === emu._xmsNextAddr) {
          emu._xmsNextAddr = b.base;
          emu._xmsFreeBlocks.splice(i, 1);
          merged = true;
        }
      }
    }
    return;
  }
  // Insert into free list and merge adjacent
  const freeBlocks = emu._xmsFreeBlocks;
  const end = base + sizeBytes;
  // Find blocks that are adjacent
  let mergedBase = base;
  let mergedEnd = end;
  const remaining: typeof freeBlocks = [];
  for (const b of freeBlocks) {
    const bEnd = b.base + b.size;
    if (bEnd === mergedBase) {
      mergedBase = b.base;
    } else if (b.base === mergedEnd) {
      mergedEnd = bEnd;
    } else {
      remaining.push(b);
    }
  }
  remaining.push({ base: mergedBase, size: mergedEnd - mergedBase });
  emu._xmsFreeBlocks = remaining;
}

/** Free all XMS handles allocated while the given PSP was active (called on program exit). */
export function xmsFreeAllForPsp(emu: Emulator, psp: number): void {
  const handles = emu._xmsPspHandles.get(psp);
  if (!handles || handles.size === 0) return;
  for (const handle of handles) {
    const emb = emu._xmsHandles.get(handle);
    if (emb) {
      xmsFree(emu, emb.base, emb.size * 1024);
      emu._xmsHandles.delete(handle);
    }
  }
  emu._xmsPspHandles.delete(psp);
}

/** Resolve an XMS address. Handle 0 = conventional memory (seg:off in offset). */
function resolveXmsAddr(emu: Emulator, handle: number, offset: number): number {
  if (handle === 0) {
    // Conventional memory: offset is seg:off (high word = segment, low word = offset)
    const seg = (offset >>> 16) & 0xFFFF;
    const off = offset & 0xFFFF;
    return seg * 16 + off;
  }
  const emb = emu._xmsHandles.get(handle);
  if (!emb) return -1;
  return emb.base + offset;
}
