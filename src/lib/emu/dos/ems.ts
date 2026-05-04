// EMS (Expanded Memory Specification) — INT 67h handler
// Provides LIM EMS 4.0 compatible expanded memory using linear memory above XMS

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleGetSetPageMap, handleMapMultiple, handleHandleName, handleMoveExchange } from './ems-ops';

// Register indices — exported for ems-ops.ts
export const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// INT number for VCPI PM service trap (called from PM via stub at VCPI entry point)
export const VCPI_PM_INT = 0xFA;

// VCPI private area — host PM environment loaded during PM→V86 switch.
// Layout matches DOSBox's EMM386 implementation.
export const VCPI_PRIVATE_AREA = 0x3E0000; // 16KB area in extended memory

// VCPI page allocator range — 4KB pages between 1.0625 MB and 16 MB.
// Stays below `_emsNextAddr` (18 MB) so VCPI pages cannot collide with EMS storage.
const VCPI_FIRST_PAGE = 0x110;  // 1.0625 MB
const VCPI_LAST_PAGE = 0xFFF;   // 16 MB - 1 page

/** Set up the VCPI private area (GDT, LDT, IDT, TSS) like DOSBox. */
export function setupVcpiPrivateArea(mem: { writeU8(a: number, v: number): void; writeU16(a: number, v: number): void; writeU32(a: number, v: number): void }): void {
  const P = VCPI_PRIVATE_AREA;

  // === GDT at P+0x0000 (limit=0xFF = 32 entries) ===
  // [0] null
  mem.writeU32(P + 0x0000, 0x00000000);
  mem.writeU32(P + 0x0004, 0x00000000);
  // [1] LDT descriptor: base=P+0x1000, limit=0xFF, type=0x82 (LDT)
  const ldtAddr = P + 0x1000;
  mem.writeU32(P + 0x0008, ((ldtAddr & 0xFFFF) << 16) | 0xFF);
  mem.writeU32(P + 0x000C, ((ldtAddr & 0xFF0000) >> 16) | (ldtAddr & 0xFF000000) | 0x8200);
  // [2] TSS descriptor: base=P+0x3000, limit=0x268, type=0x89 (available 32-bit TSS)
  const tssAddr = P + 0x3000;
  mem.writeU32(P + 0x0010, ((tssAddr & 0xFFFF) << 16) | (0x0068 + 0x200));
  mem.writeU32(P + 0x0014, ((tssAddr & 0xFF0000) >> 16) | (tssAddr & 0xFF000000) | 0x8900);
  // [3..31] zeros (free entries for DOS4GW passup stacks)
  for (let i = 0x18; i < 0x100; i += 4) mem.writeU32(P + i, 0);

  // === LDT at P+0x1000 ===
  mem.writeU32(P + 0x1000, 0x00000000);
  mem.writeU32(P + 0x1004, 0x00000000);
  // [1] sel=0x0C: Code segment (base=P, limit=0xFFFF, 16-bit, execute/read)
  mem.writeU32(P + 0x1008, ((P & 0xFFFF) << 16) | 0xFFFF);
  mem.writeU32(P + 0x100C, ((P & 0xFF0000) >> 16) | (P & 0xFF000000) | 0x9A00);
  // [2] sel=0x14: Data segment (base=P, limit=0xFFFF, 16-bit, read/write)
  mem.writeU32(P + 0x1010, ((P & 0xFFFF) << 16) | 0xFFFF);
  mem.writeU32(P + 0x1014, ((P & 0xFF0000) >> 16) | (P & 0xFF000000) | 0x9200);

  // === IDT at P+0x2000 (256 interrupt gates) ===
  for (let i = 0; i < 256; i++) {
    const stubOff = 0x2800 + i * 4;
    mem.writeU32(P + 0x2000 + i * 8, 0x000C0000 | stubOff);
    mem.writeU32(P + 0x2000 + i * 8 + 4, 0x0000EE00);
  }

  // === INT stubs at P+0x2800 (256 × 4 bytes) ===
  for (let i = 0; i < 256; i++) {
    const stubAddr = P + 0x2800 + i * 4;
    mem.writeU8(stubAddr, 0xCF); // IRET
    mem.writeU8(stubAddr + 1, 0x90);
    mem.writeU8(stubAddr + 2, 0x90);
    mem.writeU8(stubAddr + 3, 0x90);
  }

  // === TSS at P+0x3000 ===
  for (let i = 0; i < 0x68 + 0x200; i++) mem.writeU8(P + 0x3000 + i, 0);
  // Ring 0 stack: SS=0x14 (LDT data seg), ESP=0x2000
  mem.writeU32(P + 0x3004, 0x00002000); // ESP0
  mem.writeU32(P + 0x3008, 0x00000014); // SS0
  mem.writeU32(P + 0x3066, 0x0068);     // IO permission bitmap offset
}

// EMS page frame at segment D000 (linear D0000-DFFFF = 64KB = 4 pages)
export const EMS_PAGE_FRAME_SEG = 0xD000;
export const EMS_PAGE_SIZE = 16384; // 16KB per page
const EMS_TOTAL_PAGES = 256; // 4MB of EMS

// Device driver header segment — programs detect EMS by checking "EMMXXXX0" at seg:000Ah
export const EMS_DEVICE_SEG = 0xE000;

interface EmsHandle {
  pages: number;        // number of 16KB pages allocated
  baseAddr: number;     // linear address in our memory where pages are stored
}

/** Write the EMS device driver header at E000:0000 for detection by programs. */
export function setupEmsDeviceHeader(mem: { writeU8(addr: number, val: number): void }): void {
  const base = EMS_DEVICE_SEG * 16;
  // Device driver header: link (FFFF:FFFF), attributes, strategy/interrupt offsets
  mem.writeU8(base + 0, 0xFF); mem.writeU8(base + 1, 0xFF);
  mem.writeU8(base + 2, 0xFF); mem.writeU8(base + 3, 0xFF); // next device: FFFF:FFFF
  mem.writeU8(base + 4, 0x00); mem.writeU8(base + 5, 0x80); // attributes: 0x8000 (char device)
  mem.writeU8(base + 6, 0x00); mem.writeU8(base + 7, 0x00); // strategy offset
  mem.writeU8(base + 8, 0x00); mem.writeU8(base + 9, 0x00); // interrupt offset
  // Device name at offset 0x0A: "EMMXXXX0"
  const name = 'EMMXXXX0';
  for (let i = 0; i < 8; i++) mem.writeU8(base + 0x0A + i, name.charCodeAt(i));
  // Stub code at E000:0012 (after the 18-byte header): just IRET
  mem.writeU8(base + 0x12, 0xCF); // IRET
}

function initEms(emu: Emulator): void {
  if (!emu._emsHandles) {
    emu._emsHandles = new Map<number, EmsHandle>();
    emu._emsNextHandle = 1;
    emu._emsMapping = [-1, -1, -1, -1]; // 4 physical pages, each maps to a logical page addr
    emu._emsHandleNames = new Map<number, string>();
  }
}

/** Save page frame data back to backing store for a physical page. */
export function saveBack(cpu: CPU, emu: Emulator, physPage: number): void {
  const prevAddr = emu._emsMapping![physPage];
  if (prevAddr >= 0) {
    const frameAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
    cpu.mem.copyBlock(prevAddr, frameAddr, EMS_PAGE_SIZE);
  }
}

/** Map a logical page into a physical page slot. */
export function mapPage(cpu: CPU, emu: Emulator, physPage: number, logPage: number, emb: { baseAddr: number }): void {
  saveBack(cpu, emu, physPage);
  const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
  const frameAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
  cpu.mem.copyBlock(frameAddr, srcAddr, EMS_PAGE_SIZE);
  emu._emsMapping![physPage] = srcAddr;
}

/** Unmap a physical page (save data back, mark unmapped). */
export function unmapPage(cpu: CPU, emu: Emulator, physPage: number): void {
  saveBack(cpu, emu, physPage);
  emu._emsMapping![physPage] = -1;
}

/** Save the current mapping state (both mapping array and page frame contents). */
function savePageMap(cpu: CPU, emu: Emulator): number[] {
  const saved: number[] = [];
  for (let p = 0; p < 4; p++) {
    saved.push(emu._emsMapping![p]);
    saveBack(cpu, emu, p);
  }
  return saved;
}

/** Restore a saved mapping state. */
function restorePageMap(cpu: CPU, emu: Emulator, saved: number[]): void {
  for (let p = 0; p < 4; p++) saveBack(cpu, emu, p);
  for (let p = 0; p < 4; p++) {
    const addr = saved[p];
    if (addr >= 0) {
      const frameAddr = EMS_PAGE_FRAME_SEG * 16 + p * EMS_PAGE_SIZE;
      cpu.mem.copyBlock(frameAddr, addr, EMS_PAGE_SIZE);
    }
    emu._emsMapping![p] = addr;
  }
}

export function handleInt67(cpu: CPU, emu: Emulator): boolean {
  if (!emu.dosEnableEms) {
    cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // AH=84 function not supported
    return true;
  }

  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;
  initEms(emu);

  switch (ah) {
    case 0x40: // Get status
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF); // AH=0 (success)
      break;

    case 0x41: // Get page frame segment
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | EMS_PAGE_FRAME_SEG;
      break;

    case 0x42: { // Get page count
      let usedPages = 0;
      for (const h of emu._emsHandles!.values()) usedPages += h.pages;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES;
      break;
    }

    case 0x43: { // Allocate pages (BX=count) → DX=handle
      const count = cpu.reg[EBX] & 0xFFFF;
      let used43 = 0;
      for (const h of emu._emsHandles!.values()) used43 += h.pages;
      if (count > EMS_TOTAL_PAGES - used43) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700; // not enough pages
        break;
      }
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles!.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x44: { // Map/unmap page (AL=physical page 0-3, BX=logical page, DX=handle)
      const physPage = cpu.reg[EAX] & 0xFF;
      const logPage = cpu.reg[EBX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (physPage > 3) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00;
        break;
      }
      if (logPage === 0xFFFF) {
        unmapPage(cpu, emu, physPage);
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        break;
      }
      const emb = emu._emsHandles!.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (logPage >= emb.pages) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00;
        break;
      }
      mapPage(cpu, emu, physPage, logPage, emb);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x45: { // Deallocate pages (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsHandles!.has(handle)) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      emu._emsHandles!.delete(handle);
      emu._emsHandleNames?.delete(handle);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x46: // Get version
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0040; // AH=0, AL=0x40 (EMS 4.0)
      break;

    case 0x47: { // Save Page Map (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsSavedMaps) emu._emsSavedMaps = new Map<number, number[]>();
      emu._emsSavedMaps.set(handle, savePageMap(cpu, emu));
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x48: { // Restore Page Map (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const saved = emu._emsSavedMaps?.get(handle);
      if (!saved) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      restorePageMap(cpu, emu, saved);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x4B: // Get handle count → BX
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (emu._emsHandles!.size);
      break;

    case 0x4C: { // Get handle pages (DX=handle) → BX=pages
      const handle = cpu.reg[EDX] & 0xFFFF;
      const emb = emu._emsHandles!.get(handle);
      if (emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | emb.pages;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      break;
    }

    case 0x4D: { // Get all handle pages → ES:DI filled, BX=count
      const esBase = cpu.segBase(cpu.es);
      const di = cpu.getReg16(7);
      let addr = esBase + di;
      let count = 0;
      for (const [h, info] of emu._emsHandles!) {
        cpu.mem.writeU16(addr, h);
        cpu.mem.writeU16(addr + 2, info.pages);
        addr += 4;
        count++;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | count;
      break;
    }

    case 0x4E: handleGetSetPageMap(cpu, emu); break;
    case 0x50: handleMapMultiple(cpu, emu); break;

    case 0x51: { // Reallocate pages (DX=handle, BX=new count)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const newCount = cpu.reg[EBX] & 0xFFFF;
      const emb = emu._emsHandles!.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (newCount > emb.pages) {
        let used51 = 0;
        for (const h of emu._emsHandles!.values()) used51 += h.pages;
        if (newCount - emb.pages > EMS_TOTAL_PAGES - used51) {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700;
          break;
        }
        const oldBase = emb.baseAddr;
        const oldEnd = oldBase + emb.pages * EMS_PAGE_SIZE;
        // Flush any mapped pages back to old backing before copying
        for (let p = 0; p < 4; p++) {
          const m = emu._emsMapping![p];
          if (m >= oldBase && m < oldEnd) saveBack(cpu, emu, p);
        }
        const newBase = emu._emsNextAddr;
        emu._emsNextAddr += newCount * EMS_PAGE_SIZE;
        if (emb.pages > 0) cpu.mem.copyBlock(newBase, oldBase, emb.pages * EMS_PAGE_SIZE);
        emb.baseAddr = newBase;
        // Update any active mapping entries that pointed to old backing
        for (let p = 0; p < 4; p++) {
          const m = emu._emsMapping![p];
          if (m >= oldBase && m < oldEnd) {
            emu._emsMapping![p] = m - oldBase + newBase;
          }
        }
      }
      emb.pages = newCount;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | newCount;
      break;
    }

    case 0x52: { // Get/Set Handle Attribute
      const al = cpu.reg[EAX] & 0xFF;
      if (al <= 1 && !emu._emsHandles!.has(cpu.reg[EDX] & 0xFFFF)) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
        break;
      }
      if (al === 0) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0000; // AH=0, AL=0 (volatile)
      } else if (al === 1) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF); // succeed (ignore)
      } else { // al===2: Get capability
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF0000) | 0x0000; // volatile only
      }
      break;
    }

    case 0x53: handleHandleName(cpu, emu); break;

    case 0x54: { // Get Handle Directory
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) { // Get directory → ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        let addr = esBase + di;
        let count = 0;
        for (const [h] of emu._emsHandles!) {
          cpu.mem.writeU16(addr, h);
          const hname = emu._emsHandleNames?.get(h) ?? '';
          for (let i = 0; i < 8; i++) {
            cpu.mem.writeU8(addr + 2 + i, i < hname.length ? hname.charCodeAt(i) : 0);
          }
          addr += 10;
          count++;
        }
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFFFF00) | (count & 0xFF);
      } else { // al===1: Search for named handle
        const dsBase = cpu.segBase(cpu.ds);
        const si = cpu.getReg16(6);
        let searchName = '';
        for (let i = 0; i < 8; i++) {
          const c = cpu.mem.readU8(dsBase + si + i);
          if (c === 0) break;
          searchName += String.fromCharCode(c);
        }
        let found = -1;
        for (const [h, n] of emu._emsHandleNames!) {
          if (n === searchName) { found = h; break; }
        }
        if (found >= 0) {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
          cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | found;
        } else {
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0xA100;
        }
      }
      break;
    }

    case 0x57: handleMoveExchange(cpu, emu); break;

    case 0x58: { // Get mappable physical address array
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        for (let i = 0; i < 4; i++) {
          cpu.mem.writeU16(esBase + di + i * 4, EMS_PAGE_FRAME_SEG + i * (EMS_PAGE_SIZE / 16));
          cpu.mem.writeU16(esBase + di + i * 4 + 2, i);
        }
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      } else {
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x59: { // Get hardware info
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        cpu.mem.writeU16(esBase + di + 0, EMS_PAGE_SIZE / 16);
        cpu.mem.writeU16(esBase + di + 2, 0);
        cpu.mem.writeU16(esBase + di + 4, 16); // page map save area: 4 pages × 4 bytes
        cpu.mem.writeU16(esBase + di + 6, 0);
        cpu.mem.writeU16(esBase + di + 8, 0);
      } else if (al === 1) {
        let usedPages = 0;
        for (const h of emu._emsHandles!.values()) usedPages += h.pages;
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages);
        cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      break;
    }

    case 0x5A: { // Allocate standard/raw pages (same as 0x43 for us)
      const count = cpu.reg[EBX] & 0xFFFF;
      let used5A = 0;
      for (const h of emu._emsHandles!.values()) used5A += h.pages;
      if (count > EMS_TOTAL_PAGES - used5A) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8700;
        break;
      }
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles!.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x5B: { // Alternate Map Register Set — stub
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000);
      break;
    }

    case 0xDE: { // VCPI functions
      const al = cpu.reg[EAX] & 0xFF;
      switch (al) {
        case 0x00: { // VCPI Installation Check
          // Return "VCPI present" unconditionally. In DOSBox, DE00 requires
          // cpu.pmode && FLAG_VM (i.e. V86 mode) — DOSBox always runs RM as V86
          // under an EMM386 monitor. We don't emulate a real V86 monitor, so we
          // present VCPI as available whenever EMS is enabled. DOS extenders
          // (DOS4GW, DPMI hosts) can then use the VCPI services we emulate.
          // Set up private area and save IVT on first successful call so HW
          // interrupts during extender activation see the right vectors.
          if (!emu._vcpiPrivateArea) {
            setupVcpiPrivateArea(cpu.mem);
            emu._vcpiPrivateArea = VCPI_PRIVATE_AREA;
            emu._gdtBase = VCPI_PRIVATE_AREA;
            emu._gdtLimit = 0xFF;
            emu._vcpiSavedIVT = new Uint16Array(256);
            for (let i = 0; i < 256; i++) emu._vcpiSavedIVT[i] = cpu.mem.readU16(i * 4 + 2);
          }
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0 success
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0100; // BX=version 1.0
          break;
        }
        case 0x01: { // VCPI Get Protected Mode Interface
          // ES:DI → page table buffer (256 entries × 4 bytes = 1024 bytes)
          const esBase = cpu.segBase(cpu.es);
          const di = cpu.getReg16(7);
          // Fill page table: identity map first 1MB (256 × 4KB pages)
          // Match DOSBox: pages 0x00-0xFE identity-mapped, page 0xFF → program area
          for (let pg = 0; pg < 0xFF; pg++) {
            cpu.mem.writeU8(esBase + di + pg * 4 + 0, 0x67);
            cpu.mem.writeU16(esBase + di + pg * 4 + 1, pg * 0x10);
            cpu.mem.writeU8(esBase + di + pg * 4 + 3, 0x00);
          }
          // Page 0xFF maps to program area (0x1100) like DOSBox
          cpu.mem.writeU8(esBase + di + 0xFF * 4 + 0, 0x67);
          cpu.mem.writeU16(esBase + di + 0xFF * 4 + 1, 0x1100);
          cpu.mem.writeU8(esBase + di + 0xFF * 4 + 3, 0x00);
          // VCPI spec: advance DI past the page table on return
          cpu.reg[EDI] = (cpu.reg[EDI] & 0xFFFF0000) | ((di + 0x400) & 0xFFFF);
          // DS:SI → 3 GDT descriptors (8 bytes each = 24 bytes)
          // Match DOSBox: 16-bit segments (D=0, G=0, limit=64KB)
          const dsBase = cpu.segBase(cpu.ds);
          const si = cpu.getReg16(6);
          const VCPI_PM_OFF = 0x0B00;
          const vcpiCodeBase = 0xF0000; // ROM area where the PM entry stub lives
          const cbseg_low = (vcpiCodeBase & 0xFFFF) << 16; // base[15:0] in descriptor lo
          const cbseg_high = (vcpiCodeBase >>> 16) & 0xFF;  // base[23:16] in descriptor hi
          // Descriptor 1: code segment (base=vcpiCodeBase, limit=FFFF, 16-bit)
          cpu.mem.writeU32(dsBase + si + 0, 0x0000FFFF | cbseg_low);
          cpu.mem.writeU32(dsBase + si + 4, 0x00009A00 | cbseg_high);
          // Descriptor 2: data segment (base=0, limit=FFFF, 16-bit)
          cpu.mem.writeU32(dsBase + si + 8, 0x0000FFFF);
          cpu.mem.writeU32(dsBase + si + 12, 0x00009200);
          // Descriptor 3: data segment (base=0, limit=FFFF, 16-bit)
          cpu.mem.writeU32(dsBase + si + 16, 0x0000FFFF);
          cpu.mem.writeU32(dsBase + si + 20, 0x00009200);
          // PM entry stub at F000:0B00 — traps into our VCPI PM service handler
          const vcpiPmLinear = vcpiCodeBase + VCPI_PM_OFF;
          cpu.mem.writeU8(vcpiPmLinear, 0xCD);
          cpu.mem.writeU8(vcpiPmLinear + 1, VCPI_PM_INT);
          cpu.mem.writeU8(vcpiPmLinear + 2, 0xCB); // RETF
          // BX = offset within the VCPI code segment (16-bit), preserve upper EBX
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (VCPI_PM_OFF & 0xFFFF);
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x02: // VCPI Maximum Physical Address
          cpu.reg[EDX] = 0x00FFFFFF; // 16MB
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x03: { // VCPI Get Number of Free Pages
          const next = emu._vcpiNextPage ?? VCPI_FIRST_PAGE;
          const free = next > VCPI_LAST_PAGE ? 0 : (VCPI_LAST_PAGE + 1 - next);
          cpu.reg[EDX] = free >>> 0;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x04: { // VCPI Allocate one Page
          if (!emu._vcpiNextPage) emu._vcpiNextPage = VCPI_FIRST_PAGE;
          if (emu._vcpiNextPage > VCPI_LAST_PAGE) {
            cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8800; // no free pages
            break;
          }
          const page = emu._vcpiNextPage++;
          cpu.reg[EDX] = (page << 12) >>> 0; // physical address
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x05: // VCPI Free Page
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x06: { // VCPI Get Physical Address of Page in 1st MB
          // Identity map: physical = linear for first 1MB. The spec restricts
          // CX to page numbers 0x00..0xFF; reject anything outside that range.
          const cxPage = cpu.getReg16(ECX);
          if (cxPage >= 0x100) {
            cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8B00; // invalid page
            break;
          }
          cpu.reg[EDX] = (cxPage << 12) >>> 0;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x07: // VCPI Read CR0 → EBX = current CR0
          cpu.reg[EBX] = (emu._cr0 ?? 0) >>> 0;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x08: { // VCPI Read Debug Registers → ES:DI gets 8 DWORDs (DR0-3, DR6, DR7, 0, 0)
          const esBase = cpu.segBase(cpu.es);
          const di = cpu.getReg16(EDI);
          const drs = emu._vcpiDebugRegs ?? [0, 0, 0, 0, 0, 0, 0, 0];
          for (let i = 0; i < 8; i++) cpu.mem.writeU32(esBase + di + i * 4, drs[i] >>> 0);
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x09: { // VCPI Set Debug Registers → ES:DI provides 8 DWORDs
          const esBase = cpu.segBase(cpu.es);
          const di = cpu.getReg16(EDI);
          if (!emu._vcpiDebugRegs) emu._vcpiDebugRegs = [0, 0, 0, 0, 0, 0, 0, 0];
          for (let i = 0; i < 8; i++) emu._vcpiDebugRegs[i] = cpu.mem.readU32(esBase + di + i * 4) >>> 0;
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        }
        case 0x0A: // VCPI Get PIC Vector Mappings
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x08; // primary PIC base
          cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 0x70; // secondary PIC base
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x0B: // VCPI Set PIC Vector Mappings
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
          break;
        case 0x0C: { // VCPI Switch from V86/RM to Protected Mode
          // Enable A20 first — PM needs full address space for GDT/IDT/LDT
          emu.memory.a20Mask = 0xFFFFFFFF;
          // IVT already saved during DE00 (before DOS4GW modifies it)
          // ESI = linear address of data structure
          const esi = cpu.reg[ESI] >>> 0;
          const newCR3 = cpu.mem.readU32(esi);
          const newLDTR = cpu.mem.readU16(esi + 0x0C);
          const newTR = cpu.mem.readU16(esi + 0x0E);
          const newEIP = cpu.mem.readU32(esi + 0x10);
          const newCS = cpu.mem.readU16(esi + 0x14);
          // Load GDT/IDT: On the first switch, read from the client's GDTR/IDTR.
          // On subsequent switches, reuse the emulator's current GDT/IDT — the PM
          // code may have modified them (via LGDT/LIDT or direct writes), and the
          // client's V86 save code may have overwritten the GDTR pseudo-descriptor
          // in the data structure with unrelated PM state data.
          // Read client's GDTR/IDTR on every switch. DOS4GW modifies its GDT
          // directly via DS:[offset] in V86 mode (treating the GDT as data in
          // its own DS), so we must always use the client's own GDT — never a
          // relocated copy — to see the live entries.
          {
            const gdtrAddr = cpu.mem.readU32(esi + 4);
            const idtrAddr = cpu.mem.readU32(esi + 8);
            const newGdtBase = cpu.mem.readU32(gdtrAddr + 2);
            const newGdtLimit = cpu.mem.readU16(gdtrAddr);
            // Paging is only a partial fix: if the client relocates its GDT
            // into a virtual address whose page is unmapped (PDE/PTE=0), our
            // translate() returns -1 and the descriptor read yields all zeros.
            // On real hardware this would #PF and the client's handler would
            // populate the missing mapping before retrying the access; we
            // don't yet dispatch #PF through the IDT, so detect the all-zero
            // "selector 0x18" case and fall back to the last known good GDT
            // base instead of swallowing the bogus pointer. Only apply when
            // paging is actually active — otherwise the probe spuriously
            // triggers whenever a legitimate small GDT has no descriptor at
            // slot 0x18 (see VCPI test 10).
            const pagingActive = newCR3 !== 0;
            const probeLo = pagingActive ? cpu.mem.readU32(newGdtBase + 0x18) : 1;
            const probeHi = pagingActive ? cpu.mem.readU32(newGdtBase + 0x18 + 4) : 0;
            if (pagingActive && probeLo === 0 && probeHi === 0 && emu._vcpiLastClientGdtBase) {
              emu._gdtBase = emu._vcpiLastClientGdtBase;
              emu._gdtLimit = emu._vcpiLastClientGdtLimit ?? 0xFFFF;
            } else {
              emu._gdtBase = newGdtBase;
              emu._gdtLimit = newGdtLimit;
              emu._vcpiLastClientGdtBase = newGdtBase;
              emu._vcpiLastClientGdtLimit = newGdtLimit;
            }
            emu._idtBase = cpu.mem.readU32(idtrAddr + 2);
            emu._idtLimit = cpu.mem.readU16(idtrAddr);
            emu._vcpiPmGdtBase = emu._gdtBase;
            emu._vcpiPmGdtLimit = emu._gdtLimit;
            emu._vcpiPmIdtBase = emu._idtBase;
            emu._vcpiPmIdtLimit = emu._idtLimit;
          }
          // Store LDTR/TR
          emu._ldtr = newLDTR;
          emu._tr = newTR;
          // Set CR0 PE bit + paging if CR3 is non-zero (matching DOSBox)
          let newCR0 = (emu._cr0 | 1) >>> 0;
          if (newCR3 !== 0) newCR0 = (newCR0 | 0x80000000) >>> 0;
          emu._cr0 = newCR0;
          emu._cr3 = newCR3 >>> 0;
          // Activate paging for the Memory layer: VCPI clients expect
          // virtual↔physical translation via the client-supplied CR3 page
          // directory while in PM.
          cpu.mem.setPaging(newCR3 !== 0, newCR3 & ~0xFFF);
          // Clear TSS busy bit before loading TR (required for LTR)
          if (newTR && emu._gdtBase) {
            const trDescAddr = emu._gdtBase + (newTR & 0xFFF8) + 5;
            const trByte = cpu.mem.readU8(trDescAddr);
            cpu.mem.writeU8(trDescAddr, trByte & 0xFD);
          }
          // Switch to protected mode (matching DOSBox: zero segment regs, set IOPL=3)
          cpu.realMode = false;
          cpu._vm86 = false; // leaving pseudo-V86 for real PM
          cpu.loadCS(newCS);
          cpu.ss = 0;
          cpu.ds = 0;
          cpu.es = 0;
          cpu.loadFS(0);
          cpu.gs = 0;
          cpu.eip = (cpu.segBase(newCS) + newEIP) >>> 0;
          // Clear IF, VM, NT; set IOPL=3
          const flags = cpu.getFlags();
          cpu.setFlags((flags & ~(0x200 | 0x20000 | 0x4000)) | 0x3000);
          break;
        }
        default:
          console.warn(`[EMS] VCPI function 0xDE${al.toString(16).padStart(2, '0')} not supported`);
          cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400;
          break;
      }
      break;
    }

    default:
      console.warn(`[EMS] Unhandled INT 67h AH=0x${ah.toString(16).padStart(2, '0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // function not supported
      break;
  }

  return true;
}

/**
 * Handle VCPI services called from Protected Mode (via INT FAh trap).
 * DOS4GW calls the VCPI PM entry point (CALL FAR vcpiCS:offset) with AX=function.
 * The stub does INT FAh which traps here. After handling, the stub does RETF
 * back to the caller.
 */
export function handleVcpiPM(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  const fn = ax & 0xFF;

  // Control transfer after handling: the INT FAh dispatch leaves EIP pointing at
  // the RETF in the PM entry stub. The stub's segment D bit matches the CS the
  // client installed for the VCPI entry, so its RETF naturally pops the same
  // frame size the caller's CALL FAR pushed (4 bytes for a 16-bit client, 8 for
  // a 32-bit client). Cases 0x04/0x05 therefore just set results and return —
  // no manual stack walk needed.

  switch (fn) {
    case 0x02: // Maximum Physical Address — same as V86 side
      cpu.reg[EDX] = 0x00FFFFFF; // 16 MB
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;

    case 0x03: { // Number of Free Pages
      const next = emu._vcpiNextPage ?? 0x110;
      const free = next > 0xFFF ? 0 : (0xFFF + 1 - next);
      cpu.reg[EDX] = free >>> 0;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;
    }

    case 0x04: { // Allocate 4KB Page
      if (!emu._vcpiNextPage) emu._vcpiNextPage = 0x110;
      const page = emu._vcpiNextPage++;
      cpu.reg[EDX] = page << 12;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;
    }
    case 0x05: // Free 4KB Page
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;

    case 0x06: { // Get Physical Address of Page in 1st MB
      const cxPage = cpu.getReg16(ECX);
      if (cxPage >= 0x100) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8B00;
        return true;
      }
      cpu.reg[EDX] = (cxPage << 12) >>> 0;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;
    }

    case 0x07: // Read CR0
      cpu.reg[EBX] = (emu._cr0 ?? 0) >>> 0;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;

    case 0x0A: // Get PIC Vector Mappings
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x08;
      cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 0x70;
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;

    case 0x0B: // Set PIC Vector Mappings — accept silently
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;

    case 0x0C: { // Switch from PM to V86 mode
      // The client pushes a V86 return frame on the stack before CALL FAR to the
      // entry point:
      //   PUSH GS, PUSH FS, PUSH DS, PUSH ES, PUSH SS
      //   PUSH ESP, PUSH EFLAGS, PUSH CS, PUSH EIP
      // Then CALL FAR pushes its own return CS:EIP (4 bytes for a 16-bit client,
      // 8 bytes for a 32-bit client). dispatchException does not push anything
      // extra for JS-handled traps, so we only need to skip past the CALL FAR
      // frame. The frame size matches the D bit of the stub segment the client
      // installed, which is exactly what cpu.use32 reflects at trap time.
      const ssBase = cpu.segBase(cpu.ss);
      const esp = cpu.reg[ESP] >>> 0;
      const callFarFrameBytes = cpu.use32 ? 8 : 4;
      const frameBase = ssBase + esp + callFarFrameBytes;
      const newEIP = cpu.mem.readU32(frameBase + 0);
      const newCS = cpu.mem.readU32(frameBase + 4) & 0xFFFF;
      const newEFLAGS = cpu.mem.readU32(frameBase + 8);
      const newESP = cpu.mem.readU32(frameBase + 12);
      const newSS = cpu.mem.readU32(frameBase + 16) & 0xFFFF;
      const newES = cpu.mem.readU32(frameBase + 20) & 0xFFFF;
      const newDS = cpu.mem.readU32(frameBase + 24) & 0xFFFF;
      const newFS = cpu.mem.readU32(frameBase + 28) & 0xFFFF;
      const newGS = cpu.mem.readU32(frameBase + 32) & 0xFFFF;

      // Load host private GDT/IDT before switching to V86 (matching DOSBox).
      // This makes SGDT return 32 entries so DOS4GW allocates enough GDT space.
      if (emu._vcpiPrivateArea) {
        const P = emu._vcpiPrivateArea;
        emu._gdtBase = P;
        emu._gdtLimit = 0xFF; // 32 entries
        emu._idtBase = P + 0x2000;
        emu._idtLimit = 0x7FF; // 256 entries
        emu._ldtr = 0x08; // GDT[1] = LDT
        emu._tr = 0x10;   // GDT[2] = TSS
        // Clear TSS busy bit
        const tssDescAddr = P + 0x0010 + 5;
        const tb = cpu.mem.readU8(tssDescAddr);
        cpu.mem.writeU8(tssDescAddr, tb & 0xFD);
      }
      // Switch to V86/real mode. V86 addressing is seg*16 (not flat),
      // so EIP must be stored as linear = segBase + offset.
      console.log(`[VCPI-DE0C] PM→V86 cs=${newCS.toString(16)} eip=${newEIP.toString(16)} ss=${newSS.toString(16)} esp=${newESP.toString(16)} ds=${newDS.toString(16)} es=${newES.toString(16)}`);
      // In V86 mode, linear addresses (seg*16 + offset) STILL go through
      // paging when CR0.PG=1. VCPI clients keep paging on across V86↔PM
      // transitions; only a PM→RM (clear CR0.PE) turns it off. Leave
      // mem.setPaging alone here — if the client hasn't cleared PG, we
      // keep translating.
      cpu.realMode = true;
      cpu._vm86 = true; // back in pseudo-V86
      cpu.use32 = false;
      cpu._addrSize16 = true;
      cpu.cs = newCS;
      cpu.ds = newDS;
      cpu.es = newES;
      cpu.ss = newSS;
      cpu.loadFS(newFS);
      cpu.gs = newGS;
      cpu.reg[ESP] = newESP;
      cpu.eip = ((newCS * 16) + (newEIP & 0xFFFF)) >>> 0;
      cpu.setFlags(newEFLAGS);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      return true;
    }

    default:
      console.warn(`[VCPI-PM] Unhandled function AX=0x${ax.toString(16)}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8F00;
      return true;
  }
}
