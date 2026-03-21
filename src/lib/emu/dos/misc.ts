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
      // Programs probe this to detect enhanced keyboard support.
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
  if (emu._dosExecStack.length > 0) {
    dosExecReturnFromInt20(cpu, emu);
    return true;
  }
  // Check PSP terminate address (used by custom loaders like Second Reality's runexe)
  const pspLin = (emu._dosPSP || 0x100) * 16;
  const termIP = cpu.mem.readU16(pspLin + 0x0A);
  const termCS = cpu.mem.readU16(pspLin + 0x0C);
  const parentPSP = cpu.mem.readU16(pspLin + 0x16);
  console.warn(`[INT 20h] PSP=0x${(emu._dosPSP||0x100).toString(16)} termAddr=${termCS.toString(16)}:${termIP.toString(16)} parent=0x${parentPSP.toString(16)} ESP=0x${(cpu.reg[4]>>>0).toString(16)}`);
  if (termCS !== 0xF000 && termCS !== 0 && parentPSP !== (emu._dosPSP || 0x100)) {
    console.log(`[INT 20h] child PSP=${(emu._dosPSP||0x100).toString(16)} returning to ${termCS.toString(16)}:${termIP.toString(16)} parent=${parentPSP.toString(16)}`);
    emu._dosPSP = parentPSP;
    cpu.cs = termCS;
    cpu.eip = cpu.segBase(termCS) + termIP;
    return true;
  }
  emu.exitedNormally = true;
  emu.halted = true;
  cpu.halted = true;
  return true;
}

/** Restore parent state after child INT 20h terminate. */
function dosExecReturnFromInt20(cpu: CPU, emu: Emulator): void {
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
  emu._dosExitCode = 0; // INT 20h has no return code
  cpu.reg.set(parent.regs);
  cpu.cs = parent.cs;
  cpu.ds = parent.ds;
  cpu.es = parent.es;
  cpu.ss = parent.ss;
  cpu.eip = parent.eip;
  cpu.setFlags(parent.flags);
  // EXEC returns with CF=0 on success
  cpu.setFlag(0x001, false); // CF
  console.log(`[INT 20h] Child terminated, returning to parent PSP=${parent.psp.toString(16)}`);
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

  if (ah === 0xDB) {
    // UCDOS multiplex — check if UCDOS stub is set up
    if (al === 0x00 && emu._dosUcdosStubSeg) {
      cpu.setReg8(EAX, 0xFF);        // AL=FF: installed
      cpu.setReg16(EBX, 0x5450);     // BX="TP" signature
      cpu.setReg8(EDX, 0x06);        // DL=06: version 6+
      return true;
    }
  }

  console.warn(`[INT 2Fh] Unhandled AX=0x${ax.toString(16)} at EIP=0x${(cpu.eip >>> 0).toString(16)}`);
  return true;
}

// --- INT 3: UCDOS Runtime API ---
// UCDOS hooks INT 3 as its main runtime API for Chinese display/input.
// Overlay code uses INT 3 extensively with AH subfunctions.
export function handleUcdosInt3(cpu: CPU, emu: Emulator): boolean {
  const ax = cpu.getReg16(EAX);
  const ah = (ax >> 8) & 0xFF;
  const al = ax & 0xFF;
  const bx = cpu.getReg16(EBX);
  const cx = cpu.getReg16(ECX);
  const dx = cpu.getReg16(EDX);
  const callerIP = ((cpu.eip - 1) - cpu.segBase(cpu.cs)) & 0xFFFF;

  void callerIP; // used for debugging

  switch (ah) {
    case 0x00: {
      // Initialize UCDOS display buffer / set display segment
      // AX = segment for display buffer
      // Returns: DX = display buffer size (rows * bytes_per_row)
      // UCDOS uses 25 rows * 160 bytes/row (80 cols * 2 bytes each) for text
      // But [DS:323E] = 0x220 = 544. That's 17 * 32 = 544 (Chinese cell grid?)
      // Read expected value from data segment if available
      const dsBase = cpu.segBase(cpu.ds);
      const expected = cpu.mem.readU16(dsBase + 0x323E);
      if (expected > 0) {
        cpu.setReg16(EDX, expected);
      } else {
        cpu.setReg16(EDX, 0x220); // 544 = default display size
      }
      break;
    }
    case 0x01: {
      // Set display mode / parameters
      // AL has sub-mode, BX/CX/DX have coordinates or dimensions
      break;
    }
    case 0x02: {
      // Set cursor position or display parameters
      break;
    }
    case 0x09: {
      // Display Chinese string / draw text
      break;
    }
    case 0x12: {
      // Get display info — returns screen parameters
      // CX = screen width in chars, DX = screen height in chars
      cpu.setReg16(ECX, 80);  // 80 columns
      cpu.setReg16(EDX, 25);  // 25 rows
      break;
    }
    case 0x25: {
      // Input method / keyboard control
      break;
    }
    case 0x26: {
      // Allocate/init display buffer — same as AH=00, returns DX = buffer size
      // Caller checks: CMP DX, [DS:323E]; JE continue
      const dsBase = cpu.segBase(cpu.ds);
      const expected = cpu.mem.readU16(dsBase + 0x323E);
      cpu.setReg16(EDX, expected > 0 ? expected : 0x220);
      break;
    }
    default:
      break;
  }
  return true;
}

// --- INT 79h: UCDOS API ---
// UCDOS INT 79h uses AL (not AH) as the function selector.
export function handleInt79(cpu: CPU, emu: Emulator): boolean {
  const al = cpu.reg[EAX] & 0xFF;

  switch (al) {
    case 0x00: // Installation check
      // AL=FF means installed, BX="TP" signature
      cpu.setReg8(EAX, 0xFF);
      cpu.setReg16(EBX, 0x5450); // "TP"
      break;

    case 0x01: // Get version
      cpu.setReg16(EAX, 0x0600); // Version 6.0
      break;

    case 0x02: // Get display mode
      cpu.setReg8(EAX, 0x00); // text mode
      break;

    case 0x0D: // Get UCDOS data segment → ES
      cpu.es = emu._dosUcdosStubSeg;
      break;

    case 0x10: { // Input method control
      const ah = (cpu.reg[EAX] >> 8) & 0xFF;
      if (ah === 0x02) {
        cpu.setReg8(EAX, 0x00); // input method not active
      }
      break;
    }

    case 0x30: { // Get UCDOS installation drive
      // Return the current drive letter in AL.
      const driveCode = emu.currentDrive.charCodeAt(0) - 0x41;
      cpu.setReg8(EAX, driveCode); // 0=A, 1=B, 2=C, 3=D, ...
      break;
    }

    default:
      break;
  }
  return true;
}

// --- INT 7Fh: UCDOS Drive Query ---
// UCDOS programs call INT 7Fh with DX=0xFFFF to get the installation drive letter in DL.
export function handleInt7F(cpu: CPU, emu: Emulator): boolean {
  const dx = cpu.getReg16(EDX);
  if (dx === 0xFFFF) {
    // Return drive letter in DL
    cpu.setReg8(EDX, emu.currentDrive.charCodeAt(0));
  }
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
