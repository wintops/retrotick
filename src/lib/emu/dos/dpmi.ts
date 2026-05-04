// DPMI 0.9 host — provides protected mode entry and INT 31h services
// for DOS/4GW and other DPMI-based DOS extenders.

import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleDosInt } from './index';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// DPMI entry point stub location: F000:0A00 (after XMS at 0800 and UCDOS at 0900)
export const DPMI_ENTRY_SEG = 0xF000;
export const DPMI_ENTRY_OFF = 0x0A00;
// INT number used by the DPMI entry stub to trap into our handler
export const DPMI_INT = 0xFD;
// Raw mode switch stubs
const DPMI_RM2PM_OFF = 0x0A10; // RM → PM switch stub (at F000:0A10)
// PM→RM stub must be in the first 64KB (linear < 0x10000) so 16-bit PM code
// can reach it via CALL FAR with a 16-bit offset.
// Must NOT conflict with MCB chain (env MCB at 0x600) or DOS kernel stubs (0x500).
const DPMI_PM2RM_LINEAR = 0x05F0; // after DOS kernel stubs, before env MCB
export const DPMI_SWITCH_INT = 0xFC; // trap INT for mode switch stubs

// GDT placed at ~4MB, above EMS at 0x200000
const DPMI_GDT_LINEAR = 0x3F0000;
const DPMI_GDT_ENTRIES = 8192;
const DPMI_GDT_LIMIT = DPMI_GDT_ENTRIES * 8 - 1;

// PM default interrupt reflector stubs — 256 stubs × 5 bytes each = 1280 bytes
// Placed right after the GDT (0x3F0000 + 0x10000 = 0x400000)
const DPMI_REFLECTOR_BASE = 0x400000;
export const DPMI_REFLECTOR_INT = 0xFE; // trap INT for PM reflector stubs
export const DPMI_REFLECTOR_SEL = 0x38; // GDT index 7 — PM reflector code segment selector

// Memory blocks start after reflector area
const DPMI_MEM_START = 0x400600;

// First allocatable selector (index 16 → selector 0x80)
const DPMI_FIRST_SEL = 0x80;

export interface DpmiState {
  is32bit: boolean; // true if client entered as 32-bit (AX bit 0 = 1)
  nextSelector: number;
  freeSelectors: number[];
  nextMemHandle: number;
  memBlocks: Map<number, { base: number; size: number }>;
  nextMemAddr: number;
  dosMemBlocks: Map<number, { rmSeg: number; sel: number; paras: number }>;
  pmExcHandlers: Map<number, { sel: number; off: number }>;
  // Real mode callbacks (AX=0303/0304)
  rmCallbacks?: { pmSel: number; pmOff: number; rmStructAddr: number; rmSeg: number; rmOff: number }[];
  rmCallbackNextAddr?: number; // next linear address for RM callback stubs
  // Saved client state for DPMI interrupt returns. Real DPMI hosts restore
  // the full client state (SS:ESP, CS:EIP, EFLAGS) when the ISR does IRETD
  // (via ring-transition traps). We emulate this by saving at dispatch time
  // and restoring on IRETD.
  irqReturnStack: { ss: number; esp: number; cs: number; eip: number; eflags: number }[];
}

/** Write DPMI stubs at F000:0A00 (entry), F000:0A10 (RM→PM), F000:0A20 (PM→RM) */
export function setupDpmiStub(mem: { writeU8(addr: number, val: number): void }): void {
  const romBase = DPMI_ENTRY_SEG * 16;
  // Entry point: INT FD; RETF
  mem.writeU8(romBase + DPMI_ENTRY_OFF + 0, 0xCD);
  mem.writeU8(romBase + DPMI_ENTRY_OFF + 1, DPMI_INT);
  mem.writeU8(romBase + DPMI_ENTRY_OFF + 2, 0xCB); // RETF

  // RM→PM switch stub at F000:0A10: INT FC; RETF
  mem.writeU8(romBase + DPMI_RM2PM_OFF + 0, 0xCD);
  mem.writeU8(romBase + DPMI_RM2PM_OFF + 1, DPMI_SWITCH_INT);
  mem.writeU8(romBase + DPMI_RM2PM_OFF + 2, 0xCB);

  // PM→RM switch stub at low linear address (must be < 0x10000 for 16-bit PM CALL FAR)
  mem.writeU8(DPMI_PM2RM_LINEAR + 0, 0xCD);
  mem.writeU8(DPMI_PM2RM_LINEAR + 1, DPMI_SWITCH_INT);
  mem.writeU8(DPMI_PM2RM_LINEAR + 2, 0xCB);
}

// ── GDT helpers ──────────────────────────────────────────────────────

function writeGdtEntry(
  mem: Emulator['memory'], gdtBase: number, index: number,
  base: number, limit: number, access: number, flags: number
): void {
  const addr = gdtBase + index * 8;
  // Bytes 0-1: limit bits 15:0
  mem.writeU16(addr, limit & 0xFFFF);
  // Bytes 2-3: base bits 15:0
  mem.writeU16(addr + 2, base & 0xFFFF);
  // Byte 4: base bits 23:16
  mem.writeU8(addr + 4, (base >>> 16) & 0xFF);
  // Byte 5: access byte
  mem.writeU8(addr + 5, access);
  // Byte 6: flags (upper nibble) | limit bits 19:16 (lower nibble)
  mem.writeU8(addr + 6, ((flags & 0x0F) << 4) | ((limit >>> 16) & 0x0F));
  // Byte 7: base bits 31:24
  mem.writeU8(addr + 7, (base >>> 24) & 0xFF);
}

function readGdtEntryBase(mem: Emulator['memory'], gdtBase: number, index: number): number {
  const addr = gdtBase + index * 8;
  const lo = mem.readU32(addr);
  const hi = mem.readU32(addr + 4);
  const baseLo = (lo >>> 16) & 0xFFFF;
  const baseMid = hi & 0xFF;
  const baseHi = (hi >>> 24) & 0xFF;
  return (baseHi << 24) | (baseMid << 16) | baseLo;
}

function readGdtEntryLimit(mem: Emulator['memory'], gdtBase: number, index: number): number {
  const addr = gdtBase + index * 8;
  const lo = mem.readU32(addr);
  const hi = mem.readU32(addr + 4);
  const limitLo = lo & 0xFFFF;
  const limitHi = (hi >>> 16) & 0x0F; // bits 19:16 from byte 6 lower nibble
  return (limitHi << 16) | limitLo;
}

// ── DPMI entry point (INT 0xFD) ─────────────────────────────────────

/** Called on INT 0xFD — switch from real mode to protected mode */
export function handleDpmiEntry(cpu: CPU, emu: Emulator): boolean {
  const is32bit = (cpu.reg[EAX] & 1) !== 0;
  {
    const sb = (cpu.ss * 16) >>> 0;
    const sp = cpu.reg[ESP] & 0xFFFF;
    const peekIP = cpu.mem.readU16((sb + sp) >>> 0);
    const peekCS = cpu.mem.readU16((sb + sp + 2) >>> 0);
    console.log(`[DPMI] Entering PM (${is32bit ? '32' : '16'}-bit) — retCS:IP=${peekCS.toString(16)}:${peekIP.toString(16)} rmDS=${cpu.ds.toString(16)} rmES=${cpu.es.toString(16)} rmSS=${cpu.ss.toString(16)} rmSP=${sp.toString(16)} PSP=${(emu._dosPSP ?? 0).toString(16)}`);
    (emu as any)._dbgSawDpmiEntry = true;
  }

  // Enable A20 gate — required for PM to access memory above 1MB.
  // The GDT is at 0x3F0000; with A20 off, writes would go to 0xF0000.
  emu.memory.a20Mask = 0xFFFFFFFF;

  // Enable IVT protection: silently drop PM writes to the real-mode IVT
  // (linear 0-0x3FF). On a real DPMI host with paging, PM linear 0 maps to a
  // different physical page than the RM IVT, so DOS/4GW's PM-side writes
  // (e.g. REP MOVSW at cs=0x98 to clear "PM IVT entries" 0x20-0x27) never
  // clobber the actual RM IVT. Without paging, those writes would overwrite
  // IVT[0x20..0x27] with zeros, and DOS/4GW's subsequent IVT reads (used to
  // populate DPMI AX=0x0302 call structs) would return 0:0, breaking all
  // file I/O reflected to RM. IVT protection preserves the original IVT.
  emu.memory._ivtProtect = true;

  // Build GDT
  const gdtBase = DPMI_GDT_LINEAR;
  // Zero-fill GDT area
  for (let i = 0; i < DPMI_GDT_ENTRIES * 8; i++) {
    emu.memory.writeU8(gdtBase + i, 0);
  }

  // Initial selectors map the caller's real-mode segments (DPMI spec: the host
  // creates descriptors whose bases equal the RM segment * 16).
  // For 32-bit clients (AX bit 0 = 1): D=1, for 16-bit: D=0.
  const rmDS = cpu.ds;
  const rmSS = cpu.ss;
  const rmES = cpu.es;
  const dsBase = (rmDS * 16) >>> 0;
  const ssBase = (rmSS * 16) >>> 0;
  const esBase = (rmES * 16) >>> 0;
  // Initial descriptors are always 16-bit (D=0). The bootstrap code at the
  // return address is 16-bit MZ code. The 32-bit flag (AX bit 0) only affects
  // how DPMI services handle register parameters (32-bit offsets vs 16-bit).
  // idx 1 (0x08): code — placeholder, updated after popping retCS below
  writeGdtEntry(emu.memory, gdtBase, 1, 0, 0xFFFF, 0x9A, 0x00);
  // idx 2 (0x10): data — base=RM DS*16, limit=64KB, read/write
  writeGdtEntry(emu.memory, gdtBase, 2, dsBase, 0xFFFF, 0x92, 0x00);
  // idx 3 (0x18): stack — base=RM SS*16, limit=64KB, read/write
  writeGdtEntry(emu.memory, gdtBase, 3, ssBase, 0xFFFF, 0x92, 0x00);
  // idx 4 (0x20): PSP selector — base=PSP*16, limit=0xFF
  const pspBase = (emu._dosPSP || 0) * 16;
  writeGdtEntry(emu.memory, gdtBase, 4, pspBase, 0xFF, 0x92, 0x00);
  // idx 5 (0x28): ES shadow — base=RM ES*16, limit=64KB, read/write.
  // Note: DPMI 0.9 spec says the initial ES should be a PSP selector, but in
  // practice DOS4GW reads ES right after entry expecting to find the same
  // data its real-mode ES was pointing at (typically its own data segment).
  // Mirroring rmES into a dedicated selector lets both conformant and
  // DOS4GW-style clients work.
  writeGdtEntry(emu.memory, gdtBase, 5, esBase, 0xFFFF, 0x92, 0x00);
  // idx 6 (0x30): flat code — base=0, limit=4GB, for raw mode switch stubs
  writeGdtEntry(emu.memory, gdtBase, 6, 0, 0xFFFFF, 0x9A, 0x08); // G=1

  // idx 7 (0x38): PM reflector code — base=DPMI_REFLECTOR_BASE, limit=0x800, code, DPL=3.
  // Limit 0x800 covers 256×6 INT-reflector stubs (ending near 0x600) plus the
  // "default terminator" stub at offset 0x700 used by the DOS/4GW handler-table
  // populator in memory.ts. For 32-bit clients we use D=1 so cpu.use32 is set
  // while stubs run (matches the 32-bit RETF in the caller-side dispatch).
  writeGdtEntry(emu.memory, gdtBase, 7, DPMI_REFLECTOR_BASE, 0x800, 0xFA, is32bit ? 0x04 : 0x00);

  // Write 256 reflector stubs: MOV AL, intNum; INT FEh; RETF.
  // The DPMI default reflector address (returned by AX=0204 GetPmIntVector) is
  // a callable far procedure — clients reach it with CALL FAR, which pushes
  // CS:IP (or CS:EIP for 32-bit clients). The stub must terminate with RETF
  // and the RETF's operand size must match the caller's CALL FAR push.
  //
  // Although DOS/4GW 1.95 declares itself a 32-bit client, its LE code is
  // loaded into 16-bit real-mode-shadow segments (base = sel*16, D=0), so its
  // CALL FAR instructions execute in 16-bit mode and push only 2+2 bytes.
  // We therefore force the RETF to pop 2 bytes + 2 bytes regardless of the
  // reflector segment's D bit by using a 0x66 operand-size prefix in 32-bit
  // segments. In 16-bit segments, a plain CB is already a 16-bit RETF.
  const stubStride = is32bit ? 6 : 5;
  for (let i = 0; i < 256; i++) {
    const addr = DPMI_REFLECTOR_BASE + i * stubStride;
    emu.memory.writeU8(addr + 0, 0xB0);              // MOV AL, imm8
    emu.memory.writeU8(addr + 1, i);
    emu.memory.writeU8(addr + 2, 0xCD);              // INT FEh
    emu.memory.writeU8(addr + 3, DPMI_REFLECTOR_INT);
    if (is32bit) {
      emu.memory.writeU8(addr + 4, 0x66);            // operand-size override
      emu.memory.writeU8(addr + 5, 0xCB);            // RETF (16-bit in a 32-bit seg)
    } else {
      emu.memory.writeU8(addr + 4, 0xCB);            // RETF (16-bit in a 16-bit seg)
    }
  }
  (emu as any)._dpmiReflectorStride = stubStride;

  // Default terminator stub at offset 0x700. DOS/4GW's chain-walk path at
  // cs=1569:0xbf4 routes type=1 entries to the handler via JMP FAR (RETFD with
  // EAX=offset, EDX=selector). When the handler returns, the dispatcher at
  // cs=1569:0xc3a inspects the returned EAX: if non-zero it falls into the
  // error-1001 path. So our terminator must clear EAX before RETF, otherwise
  // EAX is whatever junk happened to be in the register at call time.
  // Encoding `31 c0 cb` works in both 16-bit (XOR AX,AX) and 32-bit
  // (XOR EAX,EAX) operand-size modes, then RETF that auto-sizes to the
  // selector's D bit.
  emu.memory.writeU8(DPMI_REFLECTOR_BASE + 0x700, 0x31); // XOR
  emu.memory.writeU8(DPMI_REFLECTOR_BASE + 0x701, 0xC0); // EAX, EAX
  emu.memory.writeU8(DPMI_REFLECTOR_BASE + 0x702, 0xCB); // RETF
  emu.memory._dpmiTerminatorSel = 0x38;
  emu.memory._dpmiTerminatorOff = 0x700;

  // Set GDT in emulator
  emu._gdtBase = gdtBase;
  emu._gdtLimit = DPMI_GDT_LIMIT;
  emu._cr0 |= 1; // PE bit

  // The caller did FAR CALL to F000:0A00 in real mode, pushing RM CS:IP.
  // Pop the return address while still in real mode (so pop16 uses SS:SP).
  const retIP = cpu.pop16();
  const retCS = cpu.pop16();
  const retLinear = (retCS * 16 + retIP) >>> 0;

  // NOW update the CS GDT entry with the caller's actual CS (retCS, not the stub's F000)
  const csBase = (retCS * 16) >>> 0;
  writeGdtEntry(emu.memory, gdtBase, 1, csBase, 0xFFFF, 0x9A, 0x00);

  // Convert real-mode stack pointer to flat linear address before switching
  const flatSP = (cpu.ss * 16 + (cpu.reg[ESP] & 0xFFFF)) >>> 0;

  // Switch to protected mode
  cpu.realMode = false;

  // Load segment registers.
  // DPMI 0.9 spec: initial ES is the PSP selector. DOS/4GW 1.95 saves ES into
  // its internal "psp_sel" global right after entry and later uses DS=psp_sel
  // to read the command tail at DS:0x81. If ES isn't the PSP selector, the
  // command-tail parser reads garbage and argv[0] synthesis fails.
  // GDT[5] (sel 0x28) still holds the rmES shadow for clients that want it.
  cpu.loadCS(0x08);
  cpu.ds = 0x10;
  cpu.es = 0x20;      // PSP selector (base = PSP * 16)
  cpu.ss = 0x18;
  cpu.loadFS(0);
  cpu.gs = 0;

  // ESP stays as the 16-bit SP (initial code is always 16-bit)
  cpu.reg[ESP] = (cpu.reg[ESP] & ~0xFFFF) | ((flatSP - ssBase) & 0xFFFF);

  // EIP = segBase + offset. retLinear = retCS*16 + retIP = csBase + retIP.
  cpu.eip = retLinear;

  // Populate segBases for fast lookup
  cpu.segBases.set(0x08, csBase);
  cpu.segBases.set(0x10, dsBase);
  cpu.segBases.set(0x18, ssBase);
  cpu.segBases.set(0x20, pspBase);
  cpu.segBases.set(0x28, esBase);
  cpu.segBases.set(0x30, 0); // flat code for stubs
  cpu.segBases.set(0x38, DPMI_REFLECTOR_BASE); // PM reflector stubs
  // Mirror limits into segLimits so LSL can resolve them via the fast Map path
  // (otherwise every LSL in hot loops — DOS/4GW's selector scans — would have
  // to read 8 bytes of GDT memory).
  cpu.segLimits.set(0x08, 0xFFFF);
  cpu.segLimits.set(0x10, 0xFFFF);
  cpu.segLimits.set(0x18, 0xFFFF);
  cpu.segLimits.set(0x20, 0xFF);
  cpu.segLimits.set(0x28, 0xFFFF);
  cpu.segLimits.set(0x30, 0xFFFFFFFF); // 4GB flat (G=1, limit=0xFFFFF pages)
  cpu.segLimits.set(0x38, 0x500);

  // Initialize DPMI state
  emu._dpmiState = {
    is32bit,
    nextSelector: DPMI_FIRST_SEL,
    freeSelectors: [],
    nextMemHandle: 1,
    memBlocks: new Map(),
    nextMemAddr: DPMI_MEM_START,
    dosMemBlocks: new Map(),
    pmExcHandlers: new Map(),
    irqReturnStack: [],
  };

  // Clear carry flag = success
  cpu.setFlag(0x001, false);
  return true;
}

// ── INT 31h — DPMI services ─────────────────────────────────────────

export function handleInt31(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);

  if (!emu._dpmiState) {
    // VCPI mode (DOS4GW is itself the DPMI host) — don't claim INT 31h.
    // Returning false lets dispatchException fall through to the PM IDT,
    // so DOS4GW's own INT 31h handler runs.
    return false;
  }

  const st = emu._dpmiState;


  switch (ax) {
    // ── Descriptor management ──────────────────────────────────────
    case 0x0000: return dpmiAllocDescriptors(cpu, emu, st);
    case 0x0001: return dpmiFreeDescriptor(cpu, st);
    case 0x0003: return dpmiGetSelectorIncrement(cpu);
    case 0x0006: return dpmiGetSegmentBase(cpu, emu, st);
    case 0x0007: return dpmiSetSegmentBase(cpu, emu, st);
    case 0x0008: return dpmiSetSegmentLimit(cpu, emu, st);
    case 0x0009: return dpmiSetAccessRights(cpu, emu);
    case 0x000A: return dpmiCreateAlias(cpu, emu, st);
    case 0x000B: return dpmiGetDescriptor(cpu, emu);
    case 0x000C: return dpmiSetDescriptor(cpu, emu);

    // ── DOS memory ─────────────────────────────────────────────────
    case 0x0100: return dpmiAllocDosMem(cpu, emu, st);
    case 0x0101: return dpmiFreeDosMem(cpu, st);

    // ── Interrupt vectors ──────────────────────────────────────────
    case 0x0200: return dpmiGetRmIntVector(cpu, emu);
    case 0x0201: return dpmiSetRmIntVector(cpu, emu);
    case 0x0202: return dpmiGetPmExcHandler(cpu, st, true);  // exception handler (exc 0-31)
    case 0x0203: return dpmiSetPmExcHandler(cpu, st, true);  // exception handler (exc 0-31)
    case 0x0204: return dpmiGetPmExcHandler(cpu, st, false); // interrupt vector (int 0-255)
    case 0x0205: return dpmiSetPmExcHandler(cpu, st, false); // interrupt vector (int 0-255)

    // ── Real mode translation ──────────────────────────────────────
    case 0x0300: return dpmiSimulateRmInt(cpu, emu, 'int');
    case 0x0301: return dpmiSimulateRmInt(cpu, emu, 'farcall');
    case 0x0302: return dpmiSimulateRmInt(cpu, emu, 'iret');
    case 0x0303: { // Allocate Real Mode Callback
      // DS:(E)SI = PM callback procedure address
      // ES:(E)DI = RM call structure (50-byte buffer) used by the callback
      const pmSel = cpu.ds;
      const pmOff = cpu.use32 ? (cpu.reg[ESI] >>> 0) : cpu.getReg16(ESI);
      const rmStructSel = cpu.es;
      const rmStructOff = cpu.use32 ? (cpu.reg[EDI] >>> 0) : cpu.getReg16(EDI);
      const rmStructAddr = (cpu.segBase(rmStructSel) + rmStructOff) >>> 0;

      // Create a stub in low memory (< 0x100000) that does INT FBh; RETF
      // INT FBh is our trap for RM callbacks
      if (!st.rmCallbacks) st.rmCallbacks = [];
      if (!st.rmCallbackNextAddr) st.rmCallbackNextAddr = 0x5E0; // just before PM→RM stub at 0x5F0

      const stubLinear = st.rmCallbackNextAddr;
      st.rmCallbackNextAddr -= 5; // each stub is 3 bytes but leave room
      const callbackIndex = st.rmCallbacks.length;

      // Write stub: MOV AL, index; INT FBh; RETF
      emu.memory.writeU8(stubLinear, 0xB0);           // MOV AL, imm8
      emu.memory.writeU8(stubLinear + 1, callbackIndex);
      emu.memory.writeU8(stubLinear + 2, 0xCD);       // INT 0xFB
      emu.memory.writeU8(stubLinear + 3, 0xFB);
      emu.memory.writeU8(stubLinear + 4, 0xCB);       // RETF

      st.rmCallbacks.push({ pmSel, pmOff, rmStructAddr, rmSeg: (stubLinear >>> 4) & 0xFFFF, rmOff: stubLinear & 0x0F });

      // Return CX:DX = RM callback address (seg:off)
      const rmSeg = (stubLinear >>> 4) & 0xFFFF;
      const rmOff = stubLinear & 0x000F;
      cpu.setReg16(ECX, rmSeg);
      cpu.setReg16(EDX, rmOff);
      cpu.setFlag(0x001, false);
      return true;
    }
    case 0x0304: // Free RM callback — NOP
      cpu.setFlag(0x001, false);
      return true;
    case 0x0305: { // Get State Save/Restore Addresses
      // AX = size of buffer needed (0 = no state to save)
      cpu.setReg16(EAX, 0);
      // BX:CX = real mode save/restore address (0:0 = not applicable)
      cpu.setReg16(EBX, 0);
      cpu.setReg16(ECX, 0);
      // SI:(E)DI = protected mode save/restore address (0:0 = not applicable)
      cpu.setReg16(ESI, 0);
      cpu.reg[EDI] = 0;
      cpu.setFlag(0x001, false);
      return true;
    }
    case 0x0306: return dpmiGetRawModeSwitch(cpu);

    // ── Vendor API ─────────────────────────────────────────────────
    case 0x0A00: // Get Vendor-Specific API Entry Point — not supported
      cpu.setFlag(0x001, true);
      return true;

    // ── Version info ───────────────────────────────────────────────
    case 0x0400: return dpmiGetVersion(cpu);

    // ── Memory management ──────────────────────────────────────────
    case 0x0500: return dpmiGetFreeMemInfo(cpu, emu);
    case 0x0501: return dpmiAllocMemBlock(cpu, st);
    case 0x0502: return dpmiFreeMemBlock(cpu, st);
    case 0x0503: return dpmiResizeMemBlock(cpu, st);
    case 0x0600: // Lock linear region — NOP success
    case 0x0601: // Unlock linear region — NOP success
      cpu.setFlag(0x001, false);
      return true;
    case 0x0702: // Mark page as demand paging candidate — NOP success
    case 0x0703: // Discard page contents — NOP success
      cpu.setFlag(0x001, false);
      return true;
    case 0x0800: return dpmiPhysicalAddrMapping(cpu);
    case 0x0900: { // Get and Disable Virtual Interrupt State — return prev IF, then CLI
      const prevIF = (cpu.getFlags() & 0x0200) ? 1 : 0;
      cpu.setReg8(EAX, prevIF);
      cpu.setFlags(cpu.getFlags() & ~0x0200);
      cpu.setFlag(0x001, false);
      return true;
    }
    case 0x0901: { // Get and Enable Virtual Interrupt State — return prev IF, then STI
      const prevIF = (cpu.getFlags() & 0x0200) ? 1 : 0;
      cpu.setReg8(EAX, prevIF);
      cpu.setFlags(cpu.getFlags() | 0x0200);
      cpu.setFlag(0x001, false);
      return true;
    }
    case 0x0902: { // Get Virtual Interrupt State — return current IF
      const curIF = (cpu.getFlags() & 0x0200) ? 1 : 0;
      cpu.setReg8(EAX, curIF);
      cpu.setFlag(0x001, false);
      return true;
    }

    default:
      console.warn(`[DPMI] Unimplemented INT 31h AX=0x${ax.toString(16).padStart(4, '0')} → CF=1`);
      cpu.setFlag(0x001, true);
      break;
  }
  return true;
}

// ── Descriptor functions ─────────────────────────────────────────────

/** AX=0000: Allocate LDT descriptors. CX=count → AX=base selector */
function dpmiAllocDescriptors(cpu: CPU, emu: Emulator, st: DpmiState): boolean {
  const count = cpu.getReg16(ECX) || 1;
  // DPMI requires the returned selectors to be contiguous with an increment of
  // 8. Try to satisfy the request from freeSelectors first: scan for any run of
  // `count` consecutive free entries, remove them from the pool, and reuse that
  // base. Otherwise fall through to bumping nextSelector.
  let base = -1;
  if (count === 1 && st.freeSelectors.length > 0) {
    base = st.freeSelectors.pop()!;
  } else if (count > 1 && st.freeSelectors.length >= count) {
    const sorted = [...st.freeSelectors].sort((a, b) => a - b);
    for (let i = 0; i <= sorted.length - count; i++) {
      let ok = true;
      for (let j = 1; j < count; j++) {
        if (sorted[i + j] !== sorted[i] + j * 8) { ok = false; break; }
      }
      if (ok) {
        base = sorted[i];
        const run = new Set<number>();
        for (let j = 0; j < count; j++) run.add(sorted[i + j]);
        st.freeSelectors = st.freeSelectors.filter(s => !run.has(s));
        break;
      }
    }
  }
  if (base < 0) {
    base = st.nextSelector;
    st.nextSelector = base + count * 8;
  }
  for (let i = 0; i < count; i++) {
    const sel = base + i * 8;
    const idx = (sel & 0xFFF8) >>> 3;
    writeGdtEntry(emu.memory, emu._gdtBase, idx, 0, 0, 0xF2, 0x00);
    // Seed segLimits with the initial 0 limit so LSL's Map path resolves it
    // without falling back to a GDT memory read on every call.
    cpu.segLimits.set(sel, 0);
  }
  cpu.setReg16(EAX, base);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0001: Free LDT descriptor. BX=selector */
function dpmiFreeDescriptor(cpu: CPU, st: DpmiState): boolean {
  const sel = cpu.getReg16(EBX);
  st.freeSelectors.push(sel);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0003: Get selector increment → AX=8 */
function dpmiGetSelectorIncrement(cpu: CPU): boolean {
  cpu.setReg16(EAX, 8);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0006: Get segment base address. BX=selector → CX:DX=base */
function dpmiGetSegmentBase(cpu: CPU, emu: Emulator, _st: DpmiState): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  let base = readGdtEntryBase(emu.memory, emu._gdtBase, idx);
  // Same uninitialized-descriptor fallback as cpu.segBase: if the GDT slot
  // has base=0 AND limit=0, synthesize base = sel * 16 (treat the selector
  // value as a real-mode segment shadow — what DOS/4GW assumes).
  if (base === 0 && sel >= 8) {
    const limit = readGdtEntryLimit(emu.memory, emu._gdtBase, idx);
    if (limit === 0) base = (sel * 16) >>> 0;
  }
  cpu.setReg16(ECX, (base >>> 16) & 0xFFFF);
  cpu.setReg16(EDX, base & 0xFFFF);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0007: Set segment base address. BX=selector, CX:DX=base */
function dpmiSetSegmentBase(cpu: CPU, emu: Emulator, _st: DpmiState): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  const newBase = ((cpu.getReg16(ECX) << 16) | cpu.getReg16(EDX)) >>> 0;

  // Read existing descriptor, update base
  const addr = emu._gdtBase + idx * 8;
  const oldLo = emu.memory.readU32(addr);
  const oldHi = emu.memory.readU32(addr + 4);
  const limit = (oldLo & 0xFFFF) | ((oldHi & 0x000F0000));
  const access = (oldHi >>> 8) & 0xFF;
  const flags = (oldHi >>> 20) & 0x0F;
  writeGdtEntry(emu.memory, emu._gdtBase, idx, newBase, limit, access, flags);

  // Update segBases cache (write-through: descriptor is already updated)
  cpu.segBases.set(sel, newBase);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0008: Set segment limit. BX=selector, CX:DX=limit */
function dpmiSetSegmentLimit(cpu: CPU, emu: Emulator, _st: DpmiState): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  const requestedLimit = ((cpu.getReg16(ECX) << 16) | cpu.getReg16(EDX)) >>> 0;
  let newLimit = requestedLimit;

  const addr = emu._gdtBase + idx * 8;
  const oldHi = emu.memory.readU32(addr + 4);
  const base = readGdtEntryBase(emu.memory, emu._gdtBase, idx);
  const access = (oldHi >>> 8) & 0xFF;
  let flags = (oldHi >>> 20) & 0x0F;

  // If limit > 1MB, must use granularity bit (page granularity)
  if (newLimit > 0xFFFFF) {
    flags |= 0x08; // G=1
    newLimit = newLimit >>> 12;
  } else {
    flags &= ~0x08; // G=0
  }

  writeGdtEntry(emu.memory, emu._gdtBase, idx, base, newLimit, access, flags);
  // Mirror the effective byte limit into segLimits so LSL hits the fast Map path.
  cpu.segLimits.set(sel, requestedLimit);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0009: Set descriptor access rights. BX=selector, CX=access rights */
function dpmiSetAccessRights(cpu: CPU, emu: Emulator): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  const rights = cpu.getReg16(ECX);

  const addr = emu._gdtBase + idx * 8;
  const base = readGdtEntryBase(emu.memory, emu._gdtBase, idx);
  const limit = readGdtEntryLimit(emu.memory, emu._gdtBase, idx);
  // CL = access byte, CH upper nibble (bits 12-15 of CX) = G, D/B, L, AVL
  const access = rights & 0xFF;
  const flags = (rights >>> 12) & 0x0F;

  writeGdtEntry(emu.memory, emu._gdtBase, idx, base, limit, access, flags);
  // Base is unchanged but the D/B bit (in flags) may flip — refresh _ssB32 if
  // this is the live SS selector so future push/pop pick up the new size.
  if (cpu.ss === sel) cpu.refreshSsB32();
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=000A: Create code segment alias (data). BX=selector → AX=new data sel */
function dpmiCreateAlias(cpu: CPU, emu: Emulator, st: DpmiState): boolean {
  const srcSel = cpu.getReg16(EBX);
  const srcIdx = (srcSel & 0xFFF8) >>> 3;
  const base = readGdtEntryBase(emu.memory, emu._gdtBase, srcIdx);
  const limit = readGdtEntryLimit(emu.memory, emu._gdtBase, srcIdx);

  // Allocate a new selector with data access rights (read/write, DPL=3)
  const newSel = st.nextSelector;
  st.nextSelector += 8;
  const newIdx = (newSel & 0xFFF8) >>> 3;

  // Copy flags from source but change access to data R/W
  const srcAddr = emu._gdtBase + srcIdx * 8;
  const srcHi = emu.memory.readU32(srcAddr + 4);
  const flags = (srcHi >>> 20) & 0x0F;
  writeGdtEntry(emu.memory, emu._gdtBase, newIdx, base, limit, 0xF2, flags);

  cpu.segBases.set(newSel, base);
  // Mirror the byte limit (accounting for G bit) into segLimits for fast LSL.
  const byteLimit = ((flags & 0x08) !== 0) ? ((((limit + 1) << 12) - 1) >>> 0) : limit;
  cpu.segLimits.set(newSel, byteLimit);
  cpu.setReg16(EAX, newSel);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=000B: Get descriptor. BX=selector, ES:EDI → 8-byte buffer */
function dpmiGetDescriptor(cpu: CPU, emu: Emulator): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  const descAddr = emu._gdtBase + idx * 8;
  const edi = cpu.use32 ? (cpu.reg[EDI] >>> 0) : (cpu.reg[EDI] & 0xFFFF);
  const bufAddr = (cpu.segBase(cpu.es) + edi) >>> 0;

  for (let i = 0; i < 8; i++) {
    emu.memory.writeU8(bufAddr + i, emu.memory.readU8(descAddr + i));
  }
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=000C: Set descriptor. BX=selector, ES:EDI → 8-byte descriptor */
function dpmiSetDescriptor(cpu: CPU, emu: Emulator): boolean {
  const sel = cpu.getReg16(EBX);
  const idx = (sel & 0xFFF8) >>> 3;
  const descAddr = emu._gdtBase + idx * 8;
  const bufAddr = (cpu.segBase(cpu.es) + (cpu.use32 ? cpu.reg[EDI] : (cpu.reg[EDI] & 0xFFFF))) >>> 0;

  for (let i = 0; i < 8; i++) {
    emu.memory.writeU8(descAddr + i, emu.memory.readU8(bufAddr + i));
  }
  // Update segBases and segLimits caches from the freshly written descriptor.
  const base = readGdtEntryBase(emu.memory, emu._gdtBase, idx);
  const rawLimit = readGdtEntryLimit(emu.memory, emu._gdtBase, idx);
  const hi = emu.memory.readU32(descAddr + 4);
  const byteLimit = ((hi & (1 << 23)) !== 0) ? ((((rawLimit + 1) << 12) - 1) >>> 0) : rawLimit;
  cpu.segBases.set(sel, base);
  cpu.segLimits.set(sel, byteLimit);
  cpu.setFlag(0x001, false);
  return true;
}

// ── DOS memory ───────────────────────────────────────────────────────

/** AX=0100: Allocate DOS memory block. BX=paragraphs → AX=RM seg, DX=selector */
function dpmiAllocDosMem(cpu: CPU, emu: Emulator, st: DpmiState): boolean {
  const paras = cpu.getReg16(EBX);
  // Allocate from conventional memory (below 640K)
  // Use a simple bump allocator starting at 0x5000 segment
  const rmSeg = 0x5000 + st.dosMemBlocks.size * ((paras + 0xFF) & ~0xFF);
  const base = rmSeg * 16;
  const size = paras * 16;

  // Create a selector for it
  const sel = st.nextSelector;
  st.nextSelector += 8;
  const idx = (sel & 0xFFF8) >>> 3;
  writeGdtEntry(emu.memory, emu._gdtBase, idx, base, size - 1, 0xF2, 0x00);
  cpu.segBases.set(sel, base);
  cpu.segLimits.set(sel, size - 1);

  st.dosMemBlocks.set(sel, { rmSeg, sel, paras });

  cpu.setReg16(EAX, rmSeg);
  cpu.setReg16(EDX, sel);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0101: Free DOS memory block. DX=selector */
function dpmiFreeDosMem(cpu: CPU, st: DpmiState): boolean {
  const sel = cpu.getReg16(EDX);
  st.dosMemBlocks.delete(sel);
  cpu.setFlag(0x001, false);
  return true;
}

// ── Interrupt vectors ────────────────────────────────────────────────

/** AX=0200: Get real mode interrupt vector. BL=int → CX:DX=seg:off */
function dpmiGetRmIntVector(cpu: CPU, emu: Emulator): boolean {
  const intNum = cpu.getReg8(EBX); // BL
  const seg = emu.memory.readU16(intNum * 4 + 2);
  const off = emu.memory.readU16(intNum * 4);
  cpu.setReg16(ECX, seg);
  cpu.setReg16(EDX, off);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0201: Set real mode interrupt vector. BL=int, CX:DX=seg:off */
function dpmiSetRmIntVector(cpu: CPU, emu: Emulator): boolean {
  const intNum = cpu.getReg8(EBX); // BL
  const seg = cpu.getReg16(ECX);
  const off = cpu.getReg16(EDX);
  emu.memory.writeU16(intNum * 4, off);
  emu.memory.writeU16(intNum * 4 + 2, seg);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0204: Get protected mode exception handler. BL=exc → CX:EDX=sel:off */
function dpmiGetPmExcHandler(cpu: CPU, st: DpmiState, isException: boolean): boolean {
  const vec = cpu.getReg8(EBX);
  const key = isException ? vec : vec + 256; // separate namespace
  const handler = st.pmExcHandlers.get(key);
  if (handler) {
    cpu.setReg16(ECX, handler.sel);
    cpu.reg[EDX] = handler.off;
  } else {
    // Default PM reflector stub for this interrupt. Per-stub stride is 5 bytes
    // for 16-bit clients and 6 bytes for 32-bit clients (extra 0x66 operand-
    // size override on the terminating RETF).
    const stride = (cpu.emu as any)?._dpmiReflectorStride || 5;
    cpu.setReg16(ECX, 0x38);
    cpu.reg[EDX] = vec * stride;
  }
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0203/0205: Set PM exception/interrupt handler. BL=vec, CX:EDX=sel:off */
function dpmiSetPmExcHandler(cpu: CPU, st: DpmiState, isException: boolean): boolean {
  const vec = cpu.getReg8(EBX);
  const key = isException ? vec : vec + 256; // separate namespace
  const sel = cpu.getReg16(ECX);
  const off = cpu.use32 ? (cpu.reg[EDX] >>> 0) : cpu.getReg16(EDX);
  st.pmExcHandlers.set(key, { sel, off });
  cpu.setFlag(0x001, false);
  return true;
}

// ── Real mode simulation ─────────────────────────────────────────────

/** AX=0300 (int), AX=0301 (farcall), AX=0302 (iret) — invoke a real-mode
 *  procedure (either via INT, a far CALL, or a pushed IRET frame) described
 *  by a 50-byte RM call structure at ES:EDI. For 'int', BL provides the INT
 *  number (the struct's CS:IP is ignored and the IVT is used). For 'farcall'
 *  and 'iret', the struct's CS:IP specifies the target, and BL is ignored. */
function dpmiSimulateRmInt(cpu: CPU, emu: Emulator, mode: 'int' | 'farcall' | 'iret'): boolean {
  const intNum = cpu.getReg8(EBX); // BL
  const structAddr = (cpu.segBase(cpu.es) + (cpu.use32 ? cpu.reg[EDI] : (cpu.reg[EDI] & 0xFFFF))) >>> 0;
  const sriCS = emu.memory.readU16(structAddr + 0x2C);
  const sriIP = emu.memory.readU16(structAddr + 0x2A);
  const sriSS = emu.memory.readU16(structAddr + 0x30);
  const sriSP = emu.memory.readU16(structAddr + 0x2E);
  const targetLinear = (sriCS * 16 + sriIP) >>> 0;
  let targetBytes = '';
  for (let k = 0; k < 16; k++) targetBytes += emu.memory.readU8((targetLinear + k) >>> 0).toString(16).padStart(2, '0') + ' ';
  const inEax = emu.memory.readU32(structAddr + 0x1C);
  const inEbx = emu.memory.readU32(structAddr + 0x10);
  const inEcx = emu.memory.readU32(structAddr + 0x18);
  const inEdx = emu.memory.readU32(structAddr + 0x14);
  const inES = emu.memory.readU16(structAddr + 0x22);
  const inDS = emu.memory.readU16(structAddr + 0x24);
  if (emu.traceDosInt) {
    console.log(`[DPMI-SRI] mode=${mode} intNum=${intNum.toString(16)} struct@0x${structAddr.toString(16)} rmCS:IP=${sriCS.toString(16)}:${sriIP.toString(16)} (lin 0x${targetLinear.toString(16)}) rmSS:SP=${sriSS.toString(16)}:${sriSP.toString(16)} bytes=[${targetBytes.trim()}]`);
    console.log(`  in: eax=${inEax.toString(16)} ebx=${inEbx.toString(16)} ecx=${inEcx.toString(16)} edx=${inEdx.toString(16)} es=${inES.toString(16)} ds=${inDS.toString(16)}`);
    // Dump current caller EIP bytes to see where INT 31h fired from
    const callerCS = cpu.cs;
    const callerCsBase = cpu.realMode ? (callerCS * 16) >>> 0 : cpu.segBase(callerCS);
    const callerIp = (cpu.eip - callerCsBase) >>> 0;
    let callerBytes = '';
    for (let k = -6; k < 4; k++) callerBytes += emu.memory.readU8((cpu.eip + k) >>> 0).toString(16).padStart(2, '0') + ' ';
    console.log(`  caller @${callerCS.toString(16)}:${callerIp.toString(16)} bytes=[${callerBytes.trim()}]`);
  }
  // Read the 50-byte real mode call structure
  const rmEDI = emu.memory.readU32(structAddr + 0x00);
  const rmESI = emu.memory.readU32(structAddr + 0x04);
  const rmEBP = emu.memory.readU32(structAddr + 0x08);
  // +0x0C reserved
  const rmEBX = emu.memory.readU32(structAddr + 0x10);
  const rmEDX = emu.memory.readU32(structAddr + 0x14);
  const rmECX = emu.memory.readU32(structAddr + 0x18);
  const rmEAX = emu.memory.readU32(structAddr + 0x1C);
  const rmFlags = emu.memory.readU16(structAddr + 0x20);
  const rmES = emu.memory.readU16(structAddr + 0x22);
  const rmDS = emu.memory.readU16(structAddr + 0x24);
  // +0x26 FS, +0x28 GS, +0x2A IP, +0x2C CS, +0x2E SP, +0x30 SS

  // Save PM state
  const savedRegs = new Int32Array(8);
  savedRegs.set(cpu.reg);
  const savedFlags = cpu.getFlags();
  const savedCS = cpu.cs;
  const savedDS = cpu.ds;
  const savedES = cpu.es;
  const savedSS = cpu.ss;
  const savedFS = cpu.fs;
  const savedGS = cpu.gs;
  const savedEIP = cpu.eip;
  const savedRealMode = cpu.realMode;

  // Load RM registers from struct
  cpu.reg[EDI] = rmEDI;
  cpu.reg[ESI] = rmESI;
  cpu.reg[EBP] = rmEBP;
  cpu.reg[EBX] = rmEBX;
  cpu.reg[EDX] = rmEDX;
  cpu.reg[ECX] = rmECX;
  cpu.reg[EAX] = rmEAX;
  cpu.setFlags(rmFlags);
  cpu.es = rmES;
  cpu.ds = rmDS;

  // Temporarily switch to real mode for the INT handler
  cpu.realMode = true;
  cpu.use32 = false;

  // For AX=0300 we dispatch the IVT entry for BL; for AX=0301/0302 the
  // target is specified in the struct's CS:IP.
  //
  // We can't synchronously execute arbitrary real-mode code from within a
  // JS handler. But DOS/4GW's LE loader uses AX=0302 to invoke a fixed
  // dispatch table in low memory where each entry is `CD XX CA YY YY`
  // (INT imm8; RETF imm16). For those stubs we can just emulate the INT
  // directly. Any other farcall/iret target falls through as a NOP.
  if (mode === 'int') {
    handleDosInt(cpu, intNum, emu);
  } else {
    const targetLin = (sriCS * 16 + sriIP) >>> 0;
    const b0 = emu.memory.readU8(targetLin);
    const b2 = emu.memory.readU8((targetLin + 2) >>> 0);
    if (b0 === 0xCD && (b2 === 0xCA || b2 === 0xCB)) {
      const stubInt = emu.memory.readU8((targetLin + 1) >>> 0);
      if (emu.traceDosInt) {
        console.log(`  → ${mode} stub is 'INT ${stubInt.toString(16)}; RET${b2 === 0xCA ? 'F' : 'F'}' — executing INT ${stubInt.toString(16)}`);
        // For INT 21h AH=40h (write) to stderr/stdout, dump the buffer contents
        // BEFORE the call (handleDosInt actually writes it out) so we can see
        // what the DOS extender is reporting.
        if (stubInt === 0x21) {
          const ah = (cpu.reg[EAX] >>> 8) & 0xFF;
          if (ah === 0x40) {
            const h = cpu.getReg16(EBX);
            const n = cpu.getReg16(ECX);
            const dsB = cpu.segBase(cpu.ds);
            const ptr = (dsB + cpu.getReg16(EDX)) >>> 0;
            let asc = '';
            let hex = '';
            for (let k = 0; k < Math.min(n, 64); k++) {
              const c = emu.memory.readU8((ptr + k) >>> 0);
              hex += c.toString(16).padStart(2, '0') + ' ';
              asc += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
            }
            console.log(`  INT 21h/AH=40 write h=${h} n=${n} ds:dx=${cpu.ds.toString(16)}:${cpu.getReg16(EDX).toString(16)} lin=0x${ptr.toString(16)} hex=[${hex.trim()}] "${asc}"`);
          }
        }
      }
      handleDosInt(cpu, stubInt, emu);
      if (emu.traceDosInt) {
        const outEax = cpu.reg[EAX] >>> 0;
        const outCF = (cpu.getFlags() & 1) ? 1 : 0;
        console.log(`  ← after INT ${stubInt.toString(16)}: eax=${outEax.toString(16)} cf=${outCF}`);
      }
    } else if (emu.traceDosInt) {
      console.warn(`[DPMI-SRI] ${mode} target ${sriCS.toString(16)}:${sriIP.toString(16)} is not a recognized INT-stub — skipped (NOP)`);
    }
  }

  // If the RM handler set _dosFileOpenPending (async file fetch), we must
  // re-issue the whole DPMI AX=0302 call when the data arrives. Restore the
  // caller's state but rewind EIP by 2 so the client re-executes `INT 31h`
  // — that re-triggers dpmiSimulateRmInt with the same struct, which now
  // hits the sync-data path since the fetch populated the cache.
  const asyncPending = !!emu._dosFileOpenPending;
  if (!asyncPending) {
    // Write results back to the struct — the RM handler may have updated any
    // of these, so mirror them all so the DPMI caller sees the same thing a
    // native RM INT would have left in registers and segment regs (e.g. INT 21h
    // AH=2F returns DTA in ES:BX, AH=48 returns AX, etc.).
    emu.memory.writeU32(structAddr + 0x00, cpu.reg[EDI]);
    emu.memory.writeU32(structAddr + 0x04, cpu.reg[ESI]);
    emu.memory.writeU32(structAddr + 0x08, cpu.reg[EBP]);
    emu.memory.writeU32(structAddr + 0x10, cpu.reg[EBX]);
    emu.memory.writeU32(structAddr + 0x14, cpu.reg[EDX]);
    emu.memory.writeU32(structAddr + 0x18, cpu.reg[ECX]);
    emu.memory.writeU32(structAddr + 0x1C, cpu.reg[EAX]);
    emu.memory.writeU16(structAddr + 0x20, cpu.getFlags() & 0xFFFF);
    emu.memory.writeU16(structAddr + 0x22, cpu.es);
    emu.memory.writeU16(structAddr + 0x24, cpu.ds);
    emu.memory.writeU16(structAddr + 0x26, cpu.fs);
    emu.memory.writeU16(structAddr + 0x28, cpu.gs);
  }

  // Restore PM state
  cpu.reg.set(savedRegs);
  cpu.setFlags(savedFlags);
  cpu.cs = savedCS;
  cpu.ds = savedDS;
  cpu.es = savedES;
  cpu.ss = savedSS;
  cpu.loadFS(savedFS);
  cpu.gs = savedGS;
  cpu.eip = asyncPending ? (savedEIP - 2) >>> 0 : savedEIP;
  cpu.realMode = savedRealMode;
  if (!savedRealMode) {
    const is32 = cpu.loadGdtDescriptorIs32(savedCS);
    cpu.use32 = is32;
    cpu._addrSize16 = !is32;
  }

  cpu.setFlag(0x001, false);
  return true;
}

// ── Version info ─────────────────────────────────────────────────────

/** AX=0400: Get DPMI version */
function dpmiGetVersion(cpu: CPU): boolean {
  cpu.setReg8(EAX + 4, 0x00); // AH = major version 0
  cpu.setReg8(EAX, 0x5A);     // AL = minor version 90 (0.9)
  cpu.setReg16(EBX, 0x0005);  // BX = flags: 32-bit supported, virtual memory
  cpu.setReg8(ECX, 0x03);     // CL = processor type (386)
  cpu.setReg8(EDX + 4, 0x08); // DH = master PIC base interrupt (real-mode 08h)
  cpu.setReg8(EDX, 0x70);     // DL = slave PIC base interrupt (real-mode 70h)
  cpu.setFlag(0x001, false);
  return true;
}

// ── Memory management ────────────────────────────────────────────────

/** AX=0500: Get free memory information. ES:EDI → 48-byte info block */
function dpmiGetFreeMemInfo(cpu: CPU, emu: Emulator): boolean {
  const bufAddr = (cpu.segBase(cpu.es) + cpu.reg[EDI]) >>> 0;
  const freeMem = 64 * 1024 * 1024; // Report 64MB free

  // Largest available free block in bytes
  emu.memory.writeU32(bufAddr + 0x00, freeMem);
  // Maximum unlocked page allocation in pages
  emu.memory.writeU32(bufAddr + 0x04, freeMem >>> 12);
  // Maximum locked page allocation in pages
  emu.memory.writeU32(bufAddr + 0x08, freeMem >>> 12);
  // Linear address space size in pages
  emu.memory.writeU32(bufAddr + 0x0C, freeMem >>> 12);
  // Total number of unlocked pages
  emu.memory.writeU32(bufAddr + 0x10, freeMem >>> 12);
  // Total number of free pages
  emu.memory.writeU32(bufAddr + 0x14, freeMem >>> 12);
  // Total number of physical pages
  emu.memory.writeU32(bufAddr + 0x18, freeMem >>> 12);
  // Free linear address space in pages
  emu.memory.writeU32(bufAddr + 0x1C, freeMem >>> 12);
  // Size of paging file/partition in pages
  emu.memory.writeU32(bufAddr + 0x20, 0);
  // Remaining 12 bytes reserved
  emu.memory.writeU32(bufAddr + 0x24, 0);
  emu.memory.writeU32(bufAddr + 0x28, 0);
  emu.memory.writeU32(bufAddr + 0x2C, 0);

  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0501: Allocate memory block. BX:CX=size → BX:CX=linear, SI:DI=handle */
function dpmiAllocMemBlock(cpu: CPU, st: DpmiState): boolean {
  const size = (((cpu.getReg16(EBX) << 16) | cpu.getReg16(ECX)) >>> 0) || 1;
  const base = st.nextMemAddr;
  // Align to 4KB boundary
  st.nextMemAddr = ((base + size + 0xFFF) & ~0xFFF) >>> 0;
  const handle = st.nextMemHandle++;
  st.memBlocks.set(handle, { base, size });

  cpu.setReg16(EBX, (base >>> 16) & 0xFFFF);
  cpu.setReg16(ECX, base & 0xFFFF);
  cpu.setReg16(ESI, (handle >>> 16) & 0xFFFF);
  cpu.setReg16(EDI, handle & 0xFFFF);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0502: Free memory block. SI:DI=handle */
function dpmiFreeMemBlock(cpu: CPU, st: DpmiState): boolean {
  const handle = ((cpu.getReg16(ESI) << 16) | cpu.getReg16(EDI)) >>> 0;
  st.memBlocks.delete(handle);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0503: Resize memory block. BX:CX=new size, SI:DI=handle → BX:CX=new linear, SI:DI=new handle */
function dpmiResizeMemBlock(cpu: CPU, st: DpmiState): boolean {
  const handle = ((cpu.getReg16(ESI) << 16) | cpu.getReg16(EDI)) >>> 0;
  const newSize = (((cpu.getReg16(EBX) << 16) | cpu.getReg16(ECX)) >>> 0) || 1;

  const block = st.memBlocks.get(handle);
  if (!block) {
    cpu.setFlag(0x001, true);
    cpu.setReg16(EAX, 0x8023); // invalid handle
    return true;
  }

  if (newSize <= block.size) {
    // Shrink in place
    block.size = newSize;
  } else {
    // Allocate new block, copy old data
    const newBase = st.nextMemAddr;
    st.nextMemAddr = ((newBase + newSize + 0xFFF) & ~0xFFF) >>> 0;
    block.base = newBase;
    block.size = newSize;
  }

  cpu.setReg16(EBX, (block.base >>> 16) & 0xFFFF);
  cpu.setReg16(ECX, block.base & 0xFFFF);
  cpu.setReg16(ESI, (handle >>> 16) & 0xFFFF);
  cpu.setReg16(EDI, handle & 0xFFFF);
  cpu.setFlag(0x001, false);
  return true;
}

/** AX=0305: Set PM interrupt vector. BL=int, CX:EDX=sel:off */
/** AX=0306: Get raw mode switch addresses.
 *  BX:CX = address to switch from RM to PM (far call in RM)
 *  SI:(E)DI = address to switch from PM to RM (far call in PM) */
function dpmiGetRawModeSwitch(cpu: CPU): boolean {
  // RM→PM: caller does FAR CALL to BX:CX in real mode (seg:off)
  cpu.setReg16(EBX, DPMI_ENTRY_SEG);      // F000
  cpu.setReg16(ECX, DPMI_RM2PM_OFF);      // 0A10
  // PM→RM: caller does FAR CALL to SI:(E)DI in protected mode (sel:off)
  // Selector 0x30 = flat code (base=0, limit=4GB). Offset is the linear address.
  cpu.setReg16(ESI, 0x30);
  cpu.reg[EDI] = DPMI_PM2RM_LINEAR;      // 0x0600 — fits in 16-bit offset
  cpu.setFlag(0x001, false);
  return true;
}

// ── Raw mode switch (INT 0xFC) ───────────────────────────────────────

/** Handle INT 0xFC — raw mode switch between PM and RM.
 *  Register convention (same for both directions):
 *  AX=new DS, CX=new ES, DX=new SS, (E)BX=new (E)SP, SI=new CS, (E)DI=new (E)IP */
/** Handle INT 0xFB — RM callback trap. Called from RM callback stubs. */
export function handleDpmiCallback(cpu: CPU, emu: Emulator): boolean {
  if (!emu._dpmiState?.rmCallbacks) return false;
  const idx = cpu.reg[0] & 0xFF; // AL = callback index (set by MOV AL, imm8 in stub)
  const cb = emu._dpmiState.rmCallbacks[idx];
  if (!cb) return false;

  // Save current RM state into the callback's 50-byte RM call structure
  const s = cb.rmStructAddr;
  emu.memory.writeU32(s + 0x00, cpu.reg[EDI]);
  emu.memory.writeU32(s + 0x04, cpu.reg[ESI]);
  emu.memory.writeU32(s + 0x08, cpu.reg[EBP]);
  emu.memory.writeU32(s + 0x10, cpu.reg[EBX]);
  emu.memory.writeU32(s + 0x14, cpu.reg[EDX]);
  emu.memory.writeU32(s + 0x18, cpu.reg[ECX]);
  emu.memory.writeU32(s + 0x1C, cpu.reg[EAX]);
  emu.memory.writeU16(s + 0x20, cpu.getFlags() & 0xFFFF);
  emu.memory.writeU16(s + 0x22, cpu.es);
  emu.memory.writeU16(s + 0x24, cpu.ds);

  // Switch to PM and call the callback procedure
  // For now, just return success (the callback is rarely actually needed
  // for basic DOS4GW operation — it just needs to be allocatable)
  cpu.setFlag(0x001, false);
  return true;
}

export function handleDpmiSwitch(cpu: CPU, emu: Emulator): boolean {
  if (!emu._dpmiState) return false;

  const newDS = cpu.getReg16(EAX);
  const newES = cpu.getReg16(ECX);
  const newSS = cpu.getReg16(EDX);
  const newCS = cpu.getReg16(ESI);

  if (cpu.realMode) {
    // RM → PM: switch to protected mode
    const newESP = cpu.reg[EBX] >>> 0; // 32-bit ESP for PM
    const newEIP = cpu.reg[EDI] >>> 0; // 32-bit EIP for PM
    if (emu.traceDosInt) console.log(`[DPMI-SW] RM→PM newCS=${newCS.toString(16)} newIP=${newEIP.toString(16)} newDS=${newDS.toString(16)} newES=${newES.toString(16)} newSS=${newSS.toString(16)} newSP=${newESP.toString(16)}`);
    cpu.realMode = false;
    cpu.loadCS(newCS);
    cpu.ds = newDS;
    cpu.es = newES;
    cpu.ss = newSS;
    cpu.reg[ESP] = newESP;
    cpu.eip = (cpu.segBase(newCS) + newEIP) >>> 0;
  } else {
    // PM → RM: switch to real mode
    const newSP = cpu.getReg16(EBX);
    const newIP = cpu.getReg16(EDI);
    if (emu.traceDosInt) console.log(`[DPMI-SW] PM→RM newCS=${newCS.toString(16)} newIP=${newIP.toString(16)} newDS=${newDS.toString(16)} newES=${newES.toString(16)} newSS=${newSS.toString(16)} newSP=${newSP.toString(16)}`);
    cpu.realMode = true;
    cpu.use32 = false;
    cpu._addrSize16 = true;
    cpu.cs = newCS;
    cpu.ds = newDS;
    cpu.es = newES;
    cpu.ss = newSS;
    cpu.reg[ESP] = (cpu.reg[ESP] & ~0xFFFF) | (newSP & 0xFFFF);
    cpu.eip = (newCS * 16 + newIP) >>> 0;
  }
  return true;
}

/** AX=0800: Physical address mapping. BX:CX=phys addr, SI:DI=size → BX:CX=linear */
function dpmiPhysicalAddrMapping(cpu: CPU): boolean {
  // Identity map — linear = physical in our flat model
  // BX:CX already contains the physical address, return it as-is
  cpu.setFlag(0x001, false);
  return true;
}
