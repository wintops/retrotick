import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { XMS_STUB_SEG, XMS_STUB_OFF } from './xms';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, EDI = 7;
const CF = 0x001;

// --- INT 15h: System Services ---
export function handleInt15(cpu: CPU, _emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  switch (ah) {
    case 0xC0: { // Get system configuration table
      // Return ES:BX to an AT-compatible BIOS configuration table.
      // QBasic probes this to detect enhanced keyboard support.
      cpu.es = 0xF000;
      cpu.setReg16(EBX, 0x0600);
      cpu.setFlag(CF, false);
      cpu.setReg8(EAX + 4, 0x00);
      break;
    }
    case 0x4F: { // Keyboard intercept (called by BIOS INT 09h on AT-class machines)
      // Default BIOS behavior with no installed filter: continue (CF=0).
      // Custom INT 15h handlers are dispatched by vector chaining in handleDosInt.
      cpu.setFlag(CF, false);
      break;
    }
    case 0xC2: { // PS/2 Pointing device
      // Not installed
      cpu.setFlag(CF, true);
      cpu.setReg8(EAX + 4, 0x04); // AH = error: interface error
      break;
    }
    default:
      cpu.setFlag(CF, true);
      break;
  }
  return true;
}

/** INT 1Ah — BIOS time services */
export function handleInt1A(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >>> 8) & 0xFF;
  switch (ah) {
    case 0x00: {
      // Get system timer tick count (18.2 ticks/sec since midnight)
      const ticks = emu.memory.readU32(0x46C);
      cpu.setReg16(ECX, (ticks >>> 16) & 0xFFFF); // CX = high word
      cpu.setReg16(EDX, ticks & 0xFFFF);           // DX = low word
      cpu.setReg8(EAX, 0); // AL = midnight flag (0 = no midnight rollover)
      return true;
    }
    case 0x02: {
      // Get real-time clock time → CH=hours(BCD), CL=minutes(BCD), DH=seconds(BCD)
      const now = new Date();
      const toBCD = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
      cpu.setReg8(5, toBCD(now.getHours()));   // CH (idx 5)
      cpu.setReg8(1, toBCD(now.getMinutes())); // CL (idx 1)
      cpu.setReg8(6, toBCD(now.getSeconds())); // DH (idx 6)
      cpu.reg[0] = cpu.reg[0] & ~CF;
      return true;
    }
    case 0x04: {
      // Get real-time clock date → CH=century(BCD), CL=year(BCD), DH=month(BCD), DL=day(BCD)
      const now = new Date();
      const toBCD = (n: number) => ((Math.floor(n / 10) << 4) | (n % 10)) & 0xFF;
      const year = now.getFullYear();
      cpu.setReg8(5, toBCD(Math.floor(year / 100))); // CH
      cpu.setReg8(1, toBCD(year % 100));               // CL
      cpu.setReg8(6, toBCD(now.getMonth() + 1));       // DH
      cpu.setReg8(2, toBCD(now.getDate()));             // DL
      cpu.reg[0] = cpu.reg[0] & ~CF;
      return true;
    }
    default:
      return true; // ignore unknown subfunctions
  }
}

// --- INT 20h: Terminate ---
export function handleInt20(cpu: CPU, emu: Emulator): boolean {
  emu.exitedNormally = true;
  emu.halted = true;
  cpu.halted = true;
  return true;
}

// --- INT 2Fh: Multiplex ---
export function handleInt2F(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  const ah = (ax >> 8) & 0xFF;
  const al = ax & 0xFF;

  if (ah === 0x12 && al === 0x2E) {
    // SYSMSG interface — DL selects subfunction
    const dl = cpu.reg[EDX] & 0xFF;
    if (!emu._sysmsgTablesAddr) {
      const base = ((emu.heapPtr + 0xF) & ~0xF);
      emu.heapPtr = base + 256;
      emu._sysmsgTablesAddr = base;
      for (let i = 0; i < 256; i++) cpu.mem.writeU8(base + i, 0);
    }
    if (dl === 0x08) {
      return true;
    }
    const idx = (dl >>> 1) & 0x03;
    const tableAddr = emu._sysmsgTablesAddr + idx * 32;
    cpu.es = (tableAddr >>> 4) & 0xFFFF;
    cpu.setReg16(EDI, tableAddr & 0x0F);
    return true;
  }

  if (ax === 0x4300) {
    cpu.setReg8(EAX, 0x80); // XMS driver installed
    return true;
  }

  if (ax === 0x4310) {
    // Get XMS driver entry point → ES:BX
    cpu.es = XMS_STUB_SEG;
    cpu.setReg16(EBX, XMS_STUB_OFF);
    return true;
  }

  if (ah === 0x15) {
    // MSCDEX — CD-ROM not installed
    cpu.setReg16(EBX, 0); // 0 CD-ROM drive letters
    return true;
  }

  if (ax === 0x0500) {
    cpu.setReg8(EAX, 0xFF); // DPMI not present
    return true;
  }

  if (ah === 0x15) {
    // MSCDEX (CD-ROM) — not installed; BX=0 means 0 CD drives
    cpu.setReg16(EBX, 0);
    return true;
  }

  console.warn(`[INT 2Fh] Unhandled AX=0x${ax.toString(16)} at EIP=0x${(cpu.eip >>> 0).toString(16)}`);
  return true;
}

// --- INT 33h: Mouse ---
export function handleInt33(cpu: CPU, _emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  if (ax === 0x0000) {
    cpu.setReg16(EAX, 0);
    cpu.setReg16(EBX, 0);
  }
  return true;
}
