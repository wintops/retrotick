import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleInt09, handleInt16 } from './keyboard';
import { handleInt10 } from './video';
import { handleInt21 } from './int21';
import { handleInt15, handleInt1A, handleInt20, handleInt2F, handleInt33, handleInt79, handleInt7F, handleUcdosInt3 } from './misc';
import { handleXms, XMS_INT } from './xms';
import { handleInt67 } from './ems';

export { handleInt21 } from './int21';
export { syncVideoMemory } from './video';

const EAX = 0;

function isFromSyntheticBiosStub(cpu: CPU, biosDefault: number): boolean {
  const seg = (biosDefault >>> 16) & 0xFFFF;
  const off = biosDefault & 0xFFFF;
  if (cpu.cs !== seg) return false;
  const ip16 = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
  // INT imm8 handler runs with IP already advanced past opcode+imm (2 bytes).
  return ip16 === ((off + 2) & 0xFFFF) || ip16 === ((off + 3) & 0xFFFF);
}

/** Handle DOS/BIOS interrupts. Returns true if handled, false if not. */
export function handleDosInt(cpu: CPU, intNum: number, emu: Emulator): boolean {
  // When UCDOS is active and no custom INT 3 handler installed,
  // handle INT 3 in JS as UCDOS runtime API.
  if (intNum === 3 && emu._dosUcdosStubSeg) {
    const ivtSeg3 = cpu.mem.readU16(3 * 4 + 2);
    const ivtOff3 = cpu.mem.readU16(3 * 4);
    const bd3 = emu._dosBiosDefaultVectors.get(3) ?? ((0xF000 << 16) | (3 * 5));
    const ivt3 = (ivtSeg3 << 16) | ivtOff3;
    // If IVT still points to BIOS default, handle in JS
    if (ivt3 === bd3 || ivtSeg3 === 0xF000) {
      return handleUcdosInt3(cpu, emu);
    }
    // Otherwise let IVT dispatch run the program's own handler
  }
  if (cpu.realMode) {
    const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
    const fromSyntheticStub = isFromSyntheticBiosStub(cpu, biosDefault);
    // Check both _dosIntVectors (set via INT 21h/AH=25h) and IVT memory
    // (written directly by programs like PoP's sound driver).
    const ivtOff = cpu.mem.readU16(intNum * 4);
    const ivtSeg = cpu.mem.readU16(intNum * 4 + 2);
    const ivtVec = (ivtSeg << 16) | ivtOff;
    let vec: number;
    if (ivtVec !== biosDefault && ivtSeg !== 0xF000) {
      vec = ivtVec;
    } else {
      vec = emu._dosIntVectors.get(intNum) ?? biosDefault;
    }
    if (vec !== biosDefault && !fromSyntheticStub) {
      const seg = (vec >>> 16) & 0xFFFF;
      const off = vec & 0xFFFF;
      const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
      cpu.push16(cpu.getFlags() & 0xFFFF);
      cpu.push16(cpu.cs);
      cpu.push16(returnIP);
      cpu.setFlags(cpu.getFlags() & ~0x0300); // clear IF+TF on interrupt entry
      cpu.cs = seg;
      cpu.eip = cpu.segBase(seg) + off;
      return true;
    }
  }

  switch (intNum) {
    case 0x03: // INT 3 — NOP if no UCDOS (UCDOS case handled above)
      return true;
    case 0x08: { // Timer tick (IRQ0) — update BIOS tick counter at 0x46C
      emu.memory.writeU32(0x46C, (emu.memory.readU32(0x46C) + 1) >>> 0);
      // Chain to INT 1Ch (user timer tick hook) like real BIOS.
      // Programs like QBasic install INT 1Ch handlers for time-based processing.
      const bios1C = emu._dosBiosDefaultVectors.get(0x1C) ?? ((0xF000 << 16) | (0x1C * 5));
      // Check IVT memory first — programs may write INT 1Ch directly
      const ivt1COff = cpu.mem.readU16(0x1C * 4);
      const ivt1CSeg = cpu.mem.readU16(0x1C * 4 + 2);
      const ivt1CVec = (ivt1CSeg << 16) | ivt1COff;
      const vec1C = (ivt1CVec !== bios1C && ivt1CSeg !== 0xF000)
        ? ivt1CVec
        : (emu._dosIntVectors.get(0x1C) ?? bios1C);
      if (vec1C && vec1C !== bios1C) {
        const seg = (vec1C >>> 16) & 0xFFFF;
        const off = vec1C & 0xFFFF;
        const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
        // Real BIOS INT 08h handler does STI before chaining to INT 1Ch,
        // so FLAGS pushed for INT 1Ch have IF=1. This allows INT 1Ch handlers
        // to IRET back to an IF=1 context, enabling nested interrupts.
        cpu.push16((cpu.getFlags() | 0x0200) & 0xFFFF);
        cpu.push16(cpu.cs);
        cpu.push16(returnIP);
        cpu.setFlags(cpu.getFlags() & ~0x0300);
        cpu.cs = seg;
        cpu.eip = cpu.segBase(seg) + off;
      }
      return true;
    }
    case 0x09: return handleInt09(cpu, emu);
    case 0x12: // Get conventional memory size → AX = KB (640)
      cpu.setReg16(EAX, 640);
      return true;
    case 0x18: // ROM BASIC — used by 256-byte intros as a cheap exit
    case 0x19: // Bootstrap loader (reboot) — also used by intros as a 2-byte exit
      emu.halted = true;
      cpu.halted = true;
      if (emu.onReboot) {
        emu.onReboot();
      }
      return true;
    case 0x10: return handleInt10(cpu, emu);
    case 0x16: return handleInt16(cpu, emu, cpu.cs === 0xF000);
    case 0x20: return handleInt20(cpu, emu);
    case 0x21: return handleInt21(cpu, emu);
    case 0x15: return handleInt15(cpu, emu);
    case 0x33: return handleInt33(cpu, emu);
    case 0x2A: // Network — not installed
      cpu.setReg8(EAX, 0); // AL=0 means not installed
      return true;
    case 0x1A: return handleInt1A(cpu, emu);
    case 0x2F: return handleInt2F(cpu, emu);
    case 0x25: // Absolute Disk Read — return error (drive not ready)
    case 0x26: { // Absolute Disk Write — return error
      // INT 25h/26h leave the original flags on the stack.
      // The CPU already pushed flags+CS+IP for the INT instruction.
      // These interrupts push an extra copy of flags that the caller must POPF.
      cpu.push16(cpu.getFlags() & 0xFFFF);
      // Return CF=1 with error code 0x02 (drive not ready) in AX
      cpu.setFlag(0x001, true); // CF
      cpu.setReg16(EAX, 0x0002);
      return true;
    }
    case 0x67: return handleInt67(cpu, emu); // EMS (Expanded Memory)
    case 0x79: return handleInt79(cpu, emu);
    case 0x7F: return handleInt7F(cpu, emu);
    case XMS_INT: return handleXms(cpu, emu);
    default:
      if (cpu.realMode) {
        // No custom handler — just IRET
        return true;
      }
      return false;
  }
}
