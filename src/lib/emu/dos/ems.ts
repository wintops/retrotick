// EMS (Expanded Memory Specification) — INT 67h handler
// Provides LIM EMS 4.0 compatible expanded memory using linear memory above 1MB

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, EBX = 3, ECX = 1, EDX = 2;

// EMS page frame at segment D000 (linear D0000-DFFFF = 64KB = 4 pages)
const EMS_PAGE_FRAME_SEG = 0xD000;
const EMS_PAGE_SIZE = 16384; // 16KB per page
const EMS_TOTAL_PAGES = 256; // 4MB of EMS
const EMS_MAX_HANDLES = 128;

interface EmsHandle {
  pages: number;        // number of 16KB pages allocated
  baseAddr: number;     // linear address in our memory where pages are stored
}

export function handleInt67(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;

  // Initialize EMS state on first call
  if (!emu._emsHandles) {
    emu._emsHandles = new Map<number, EmsHandle>();
    emu._emsNextHandle = 1;
    emu._emsNextAddr = 0x200000; // Start EMS storage at 2MB linear
    emu._emsMapping = [-1, -1, -1, -1]; // 4 physical pages, each maps to a logical page addr
  }

  switch (ah) {
    case 0x40: // Get status
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0 (success)
      break;

    case 0x41: // Get page frame segment
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | EMS_PAGE_FRAME_SEG;
      break;

    case 0x42: { // Get page count
      // Count used pages
      let usedPages = 0;
      if (emu._emsHandles) {
        for (const h of emu._emsHandles.values()) usedPages += h.pages;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (EMS_TOTAL_PAGES - usedPages); // unallocated pages
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | EMS_TOTAL_PAGES; // total pages
      break;
    }

    case 0x43: { // Allocate pages (BX=count) → DX=handle
      const count = cpu.reg[EBX] & 0xFFFF;
      const handle = emu._emsNextHandle++;
      const baseAddr = emu._emsNextAddr;
      emu._emsNextAddr += count * EMS_PAGE_SIZE;
      emu._emsHandles.set(handle, { pages: count, baseAddr });
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EDX] = (cpu.reg[EDX] & 0xFFFF0000) | handle;
      break;
    }

    case 0x44: { // Map/unmap page (AL=physical page 0-3, BX=logical page, DX=handle)
      const physPage = cpu.reg[EAX] & 0xFF;
      const logPage = cpu.reg[EBX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (physPage > 3) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8A00; // AH=8A invalid physical page
        break;
      }

      if (logPage === 0xFFFF) {
        // Unmap
        emu._emsMapping[physPage] = -1;
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
        break;
      }

      const emb = emu._emsHandles.get(handle);
      if (!emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // AH=83 invalid handle
        break;
      }

      // Map: copy logical page data to page frame
      const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
      const dstAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;

      // If there was a previously mapped page, save it back first
      const prevAddr = emu._emsMapping[physPage];
      if (prevAddr >= 0) {
        cpu.mem.copyBlock(prevAddr, dstAddr, EMS_PAGE_SIZE);
      }

      // Load new page into frame
      cpu.mem.copyBlock(dstAddr, srcAddr, EMS_PAGE_SIZE);
      emu._emsMapping[physPage] = srcAddr;

      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      break;
    }

    case 0x45: { // Deallocate pages (DX=handle)
      const handle = cpu.reg[EDX] & 0xFFFF;
      emu._emsHandles.delete(handle);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      break;
    }

    case 0x47: { // Save Page Map (DX=handle) — saves current mapping state
      const handle = cpu.reg[EDX] & 0xFFFF;
      if (!emu._emsSavedMaps) emu._emsSavedMaps = new Map<number, number[]>();
      // Save both the mapping array AND the page frame contents for each mapped page
      const saved = [...emu._emsMapping];
      emu._emsSavedMaps.set(handle, saved);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x48: { // Restore Page Map (DX=handle) — restores saved mapping state
      const handle = cpu.reg[EDX] & 0xFFFF;
      const saved = emu._emsSavedMaps?.get(handle);
      if (!saved) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300; // invalid handle
        break;
      }
      // Save back currently mapped pages, then restore saved mapping
      for (let p = 0; p < 4; p++) {
        const dstAddr = EMS_PAGE_FRAME_SEG * 16 + p * EMS_PAGE_SIZE;
        const curAddr = emu._emsMapping[p];
        if (curAddr >= 0) {
          cpu.mem.copyBlock(curAddr, dstAddr, EMS_PAGE_SIZE);
        }
        const savedAddr = saved[p];
        if (savedAddr >= 0) {
          cpu.mem.copyBlock(dstAddr, savedAddr, EMS_PAGE_SIZE);
        }
        emu._emsMapping[p] = savedAddr;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x46: // Get version
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000; // AH=0
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFFFF00) | 0x40; // AL=4.0
      break;

    case 0x4B: // Get handle count → BX
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (emu._emsHandles?.size ?? 0);
      break;

    case 0x4C: { // Get handle pages (DX=handle) → BX=pages
      const handle = cpu.reg[EDX] & 0xFFFF;
      const emb = emu._emsHandles?.get(handle);
      if (emb) {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | emb.pages;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      break;
    }

    case 0x4D: { // Get all handle pages → ES:DI filled, BX=count
      const esBase = cpu.segBase(cpu.es);
      const di = cpu.getReg16(7); // EDI
      let addr = esBase + di;
      let count = 0;
      if (emu._emsHandles) {
        for (const [h, info] of emu._emsHandles) {
          cpu.mem.writeU16(addr, h);
          cpu.mem.writeU16(addr + 2, info.pages);
          addr += 4;
          count++;
        }
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | count;
      break;
    }

    case 0x50: { // Map/unmap multiple pages
      const al = cpu.reg[EAX] & 0xFF;
      // AL=0: physical page + logical page pairs, AL=1: segment + logical page pairs
      // For simplicity, handle like AH=44 but multiple pages
      const count = cpu.reg[ECX] & 0xFFFF;
      const handle = cpu.reg[EDX] & 0xFFFF;
      const dsBase = cpu.segBase(cpu.ds);
      const si = cpu.getReg16(6); // ESI
      const emb = emu._emsHandles?.get(handle);

      for (let i = 0; i < count; i++) {
        const logPage = cpu.mem.readU16(dsBase + si + i * 4);
        let physPage: number;
        if (al === 0) {
          physPage = cpu.mem.readU16(dsBase + si + i * 4 + 2);
        } else {
          const seg = cpu.mem.readU16(dsBase + si + i * 4 + 2);
          physPage = Math.floor((seg - EMS_PAGE_FRAME_SEG) * 16 / EMS_PAGE_SIZE);
        }

        if (physPage >= 0 && physPage < 4 && emb) {
          const srcAddr = emb.baseAddr + logPage * EMS_PAGE_SIZE;
          const dstAddr = EMS_PAGE_FRAME_SEG * 16 + physPage * EMS_PAGE_SIZE;
          const prevAddr = emu._emsMapping[physPage];
          if (prevAddr >= 0) {
            cpu.mem.copyBlock(prevAddr, dstAddr, EMS_PAGE_SIZE);
          }
          cpu.mem.copyBlock(dstAddr, srcAddr, EMS_PAGE_SIZE);
          emu._emsMapping[physPage] = srcAddr;
        }
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    case 0x51: { // Reallocate pages (DX=handle, BX=new count)
      const handle = cpu.reg[EDX] & 0xFFFF;
      const newCount = cpu.reg[EBX] & 0xFFFF;
      const emb = emu._emsHandles?.get(handle);
      if (emb) {
        emb.pages = newCount;
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      } else {
        cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8300;
      }
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | newCount;
      break;
    }

    case 0x58: { // Get mappable physical address array
      const al = cpu.reg[EAX] & 0xFF;
      if (al === 0) {
        // Return array at ES:DI
        const esBase = cpu.segBase(cpu.es);
        const di = cpu.getReg16(7);
        for (let i = 0; i < 4; i++) {
          cpu.mem.writeU16(esBase + di + i * 4, EMS_PAGE_FRAME_SEG + i * (EMS_PAGE_SIZE / 16));
          cpu.mem.writeU16(esBase + di + i * 4 + 2, i);
        }
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      } else {
        // Return count only
        cpu.reg[ECX] = (cpu.reg[ECX] & 0xFFFF0000) | 4;
      }
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x0000;
      break;
    }

    default:
      console.warn(`[EMS] Unhandled INT 67h AH=0x${ah.toString(16).padStart(2, '0')}`);
      cpu.reg[EAX] = (cpu.reg[EAX] & 0xFFFF00FF) | 0x8400; // AH=84 function not supported
      break;
  }

  return true;
}
