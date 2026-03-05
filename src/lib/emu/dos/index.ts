import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { handleInt09, handleInt16 } from './keyboard';
import { handleInt10 } from './video';
import { handleInt21 } from './int21';
import { handleInt15, handleInt1A, handleInt20, handleInt2F, handleInt33 } from './misc';

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
  if (cpu.realMode) {
    const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
    const fromSyntheticStub = isFromSyntheticBiosStub(cpu, biosDefault);
    const vec = emu._dosIntVectors.get(intNum) ?? biosDefault;
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
    case 0x08: { // Timer tick (IRQ0) — update BIOS tick counter at 0x46C
      emu.memory.writeU32(0x46C, (emu.memory.readU32(0x46C) + 1) >>> 0);
      // Chain to INT 1Ch (user timer tick hook) like real BIOS.
      // Programs like QBasic install INT 1Ch handlers for time-based processing.
      const vec1C = emu._dosIntVectors.get(0x1C);
      const bios1C = emu._dosBiosDefaultVectors.get(0x1C) ?? ((0xF000 << 16) | (0x1C * 5));
      if (vec1C && vec1C !== bios1C) {
        const seg = (vec1C >>> 16) & 0xFFFF;
        const off = vec1C & 0xFFFF;
        const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
        cpu.push16(cpu.getFlags() & 0xFFFF);
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
    default:
      if (cpu.realMode) {
        // No custom handler — just IRET
        return true;
      }
      return false;
  }
}
