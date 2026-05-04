// Virtual DMA Services (VDS) — INT 4Bh AX=81xx
//
// VDS lets DOS programs running under a memory manager (EMM386, DPMI host,
// V86 monitor) safely program DMA controllers. Under paging, a program's
// virtual/linear address doesn't match the physical DMA address, so the
// program asks VDS to translate and lock buffer regions.
//
// With paging disabled (real/V86 without CR0.PG), linear == physical and
// every service is a trivial pass-through. With paging enabled (VCPI / DPMI
// clients), we must walk the current page tables to translate the buffer's
// linear address before reporting it as physical — otherwise the DMA
// controller is programmed with a virtual address and reads garbage.
//
// Spec reference: Ralf Brown's Interrupt List, INT 4Bh.
// Presence: BDA byte 40h:7Bh bit 5 set (done in emu-load.ts).

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;
const CF = 0x001;

/** Read a 32-bit linear address from a DDS (DMA Descriptor Structure).
 *  DDS layout:
 *    +0  DWORD region size
 *    +4  DWORD linear offset
 *    +8  WORD  segment/selector
 *    +A  WORD  buffer ID
 *    +C  DWORD physical address (output) */
function ddsLinear(cpu: CPU, ddsAddr: number): number {
  const off = cpu.mem.readU32(ddsAddr + 4) >>> 0;
  const sel = cpu.mem.readU16(ddsAddr + 8);
  // In real/V86 mode the "segment/selector" field is a real-mode segment;
  // linear = seg*16 + offset. In PM this is a selector (base from GDT).
  const base = cpu.realMode ? (sel * 16) : cpu.segBase(sel);
  return (base + off) >>> 0;
}

/** Translate a linear address to its physical mapping when paging is on.
 *  Falls back to the linear address (identity) when paging is off or when
 *  the page walker can't resolve the mapping. */
function toPhysical(cpu: CPU, linear: number): number {
  const mem = cpu.mem as unknown as { _pagingEnabled?: boolean; translate?: (v: number) => number };
  if (!mem._pagingEnabled || !mem.translate) return linear >>> 0;
  const p = mem.translate(linear);
  return p < 0 ? (linear >>> 0) : (p >>> 0);
}

/** Check whether a linear region maps to physically-contiguous pages.
 *  Under paging a virtually-contiguous buffer can be fragmented across
 *  non-adjacent physical pages, in which case the DMA controller cannot be
 *  programmed with a single base + length. Returns the physical address of
 *  the first page regardless, plus whether the whole region is contiguous. */
function checkContiguous(cpu: CPU, linear: number, size: number): { contiguous: boolean; firstPhys: number } {
  const mem = cpu.mem as unknown as { _pagingEnabled?: boolean; translate?: (v: number) => number };
  if (!mem._pagingEnabled || !mem.translate || size === 0) {
    return { contiguous: true, firstPhys: linear >>> 0 };
  }
  const startPhys = mem.translate(linear);
  if (startPhys < 0) return { contiguous: true, firstPhys: linear >>> 0 };
  // Walk one physical page at a time starting at the first page boundary
  // strictly after `linear`. Any mismatch between expected and actual
  // physical address means the buffer crosses into a non-adjacent frame.
  let nextBoundary = (linear + 0x1000) & ~0xFFF;
  while (nextBoundary < linear + size) {
    const nextPhys = mem.translate(nextBoundary);
    if (nextPhys < 0) return { contiguous: false, firstPhys: startPhys >>> 0 };
    const expectedPhys = (startPhys + (nextBoundary - linear)) >>> 0;
    if ((nextPhys >>> 0) !== expectedPhys) {
      return { contiguous: false, firstPhys: startPhys >>> 0 };
    }
    nextBoundary += 0x1000;
  }
  return { contiguous: true, firstPhys: startPhys >>> 0 };
}

/** Build an inline scatter-gather table in the DDS for a fragmented region.
 *  Writes entries starting at DDS+0x10, each entry 8 bytes: DWORD physical
 *  address then DWORD length. Caps at `maxEntries` which the caller read
 *  from DDS+0x10 before invocation. Returns the number of entries written. */
function fillScatterGatherTable(
  cpu: CPU,
  ddsAddr: number,
  linear: number,
  size: number,
  maxEntries: number,
): number {
  const mem = cpu.mem as unknown as { _pagingEnabled?: boolean; translate?: (v: number) => number };
  let written = 0;
  let remaining = size;
  let cursor = linear;
  while (remaining > 0 && written < maxEntries) {
    const fragPhys = mem._pagingEnabled && mem.translate
      ? mem.translate(cursor)
      : cursor;
    // On unmapped page, stop — signals the caller that it ran out of valid
    // mappings mid-buffer (e.g. client needs to touch those pages first).
    if (fragPhys < 0) break;
    // Extend this fragment while subsequent pages are physically adjacent.
    let fragLen = 0x1000 - (cursor & 0xFFF);
    if (fragLen > remaining) fragLen = remaining;
    while (fragLen < remaining) {
      const probeLinear = cursor + fragLen;
      const probePhys = mem._pagingEnabled && mem.translate
        ? mem.translate(probeLinear)
        : probeLinear;
      if (probePhys < 0) break;
      if ((probePhys >>> 0) !== ((fragPhys + fragLen) >>> 0)) break;
      const step = remaining - fragLen < 0x1000 ? remaining - fragLen : 0x1000;
      fragLen += step;
    }
    const entryAddr = ddsAddr + 0x14 + written * 8;
    cpu.mem.writeU32(entryAddr + 0, fragPhys >>> 0);
    cpu.mem.writeU32(entryAddr + 4, fragLen >>> 0);
    cursor += fragLen;
    remaining -= fragLen;
    written++;
  }
  return written;
}

export function handleInt4B(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.reg[EAX] & 0xFFFF;
  const ah = (ax >>> 8) & 0xFF;
  const al = ax & 0xFF;

  if (ah !== 0x81) return false; // not VDS — let default INT 4Bh dispatch

  // ES:DI points to DDS for most services
  const esBase = cpu.realMode ? (cpu.es * 16) : cpu.segBase(cpu.es);
  const di = cpu.reg[EDI] & 0xFFFF;
  const ddsAddr = (esBase + di) >>> 0;

  switch (al) {
    case 0x02: { // Get Version
      // AH=0 success; AL=2; BX=2.0 (BCD major.minor); CX=max_dma_buffer_size;
      // DX=flags (bit 0: PC/XT 0/1; we say AT-class).
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0200;  // AH=02, AL=00 (success)
      cpu.setReg16(EBX, 0x0200);    // v2.0 BCD
      cpu.setReg16(ECX, 0xFFFF);    // max buffer size — we can do any size
      cpu.setReg16(EDX, 0x0000);    // AT-class, no translations needed
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x03: { // Lock DMA Region
      // DMA controllers need a single physically-contiguous base address +
      // length. If the virtually-contiguous region spans non-adjacent
      // physical pages, fail with REGION_NOT_CONTIGUOUS (0x02) so the
      // caller falls back to SG Lock or a bounce buffer.
      const size = cpu.mem.readU32(ddsAddr + 0) >>> 0;
      const linear = ddsLinear(cpu, ddsAddr);
      const { contiguous, firstPhys } = checkContiguous(cpu, linear, size);
      if (!contiguous) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0200; // AL=02 not contiguous
        cpu.setFlag(CF, true);
        return true;
      }
      cpu.mem.writeU32(ddsAddr + 0x0C, firstPhys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;  // AH=0, AL=0 success
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x04: { // Unlock DMA Region
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x05: { // Scatter/Gather Lock Region
      // Extended DDS: +10 WORD available entries, +12 WORD used entries (out),
      // +14 start of inline fragment table (each entry: DWORD physAddr, DWORD len).
      // If the region is physically contiguous we also fill +0C with the base
      // physical address as a convenience (matches how real VDS drivers behave
      // when a single-fragment lock succeeds).
      const size = cpu.mem.readU32(ddsAddr + 0) >>> 0;
      const linear = ddsLinear(cpu, ddsAddr);
      const availEntries = cpu.mem.readU16(ddsAddr + 0x10);
      const { contiguous, firstPhys } = checkContiguous(cpu, linear, size);
      if (contiguous) {
        cpu.mem.writeU32(ddsAddr + 0x0C, firstPhys >>> 0);
        if (availEntries > 0) {
          cpu.mem.writeU32(ddsAddr + 0x14 + 0, firstPhys >>> 0);
          cpu.mem.writeU32(ddsAddr + 0x14 + 4, size >>> 0);
          cpu.mem.writeU16(ddsAddr + 0x12, 1);
        } else {
          cpu.mem.writeU16(ddsAddr + 0x12, 0);
        }
        cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
        cpu.setFlag(CF, false);
        return true;
      }
      const written = fillScatterGatherTable(cpu, ddsAddr, linear, size, availEntries);
      cpu.mem.writeU16(ddsAddr + 0x12, written);
      if (written === 0) {
        // Could not emit even one fragment (probably unmapped page at base)
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0500; // AL=05 buffer not available
        cpu.setFlag(CF, true);
        return true;
      }
      // First fragment's phys also goes to +0C for callers that only look there
      cpu.mem.writeU32(ddsAddr + 0x0C, firstPhys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x06: { // Scatter/Gather Unlock Region
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x07: { // Request DMA Buffer
      // Policy: the DDS already carries a client-provided buffer (region_size,
      // linear_offset, segment/selector). Confirm it by translating to the
      // physical address — under paging that's a page-walk, otherwise it's
      // just the linear address. Real DMA controllers require the buffer in
      // low (<16 MB) memory; our emulator keeps low physical memory flat so
      // this stays valid for typical DOS buffer sizes.
      const phys = toPhysical(cpu, ddsLinear(cpu, ddsAddr));
      cpu.mem.writeU32(ddsAddr + 0x0C, phys >>> 0);
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x08: { // Release DMA Buffer
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x09: { // Copy Into DMA Buffer (no-op: buffer IS client memory)
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x0A: { // Copy Out of DMA Buffer
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    case 0x0B: // Disable DMA Translation
    case 0x0C: { // Enable DMA Translation
      cpu.reg[EAX] = cpu.reg[EAX] & 0xFFFF0000;
      cpu.setFlag(CF, false);
      return true;
    }

    default:
      // Unknown VDS function — return failure with CF=1
      console.warn(`[VDS] Unknown INT 4Bh AX=81${al.toString(16).padStart(2,'0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0F00; // AL=0F (function not supported)
      cpu.setFlag(CF, true);
      return true;
  }
}
