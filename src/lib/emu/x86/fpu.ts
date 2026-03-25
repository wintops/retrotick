import type { CPU } from './cpu';
import { execFPU_D8, execFPU_D9, execFPU_DA, execFPU_DB } from './fpu-d8db';
import { execFPU_DC, execFPU_DD, execFPU_DE, execFPU_DF } from './fpu-dcdf';

// FPU helpers — exported for use by d8db/dcdf submodules

export function fpuPush(cpu: CPU, val: number): void {
  cpu.fpuTop = (cpu.fpuTop - 1) & 7;
  cpu.fpuStack[cpu.fpuTop] = val;
  cpu.fpuI64[cpu.fpuTop] = undefined;
  cpu.fpuRaw64[cpu.fpuTop] = undefined;
  cpu.fpuRaw80[cpu.fpuTop] = undefined;
  cpu.fpuTW &= ~(3 << (cpu.fpuTop * 2));
}

export function fpuPop(cpu: CPU): number {
  const val = cpu.fpuStack[cpu.fpuTop];
  cpu.fpuI64[cpu.fpuTop] = undefined;
  cpu.fpuRaw64[cpu.fpuTop] = undefined;
  cpu.fpuRaw80[cpu.fpuTop] = undefined;
  cpu.fpuTW |= (3 << (cpu.fpuTop * 2));
  cpu.fpuTop = (cpu.fpuTop + 1) & 7;
  return val;
}

export function fpuST(cpu: CPU, i: number): number {
  return cpu.fpuStack[(cpu.fpuTop + i) & 7];
}

export function fpuSetST(cpu: CPU, i: number, val: number): void {
  const slot = (cpu.fpuTop + i) & 7;
  cpu.fpuStack[slot] = val;
  cpu.fpuI64[slot] = undefined;
  cpu.fpuRaw64[slot] = undefined;
  cpu.fpuRaw80[slot] = undefined;
  cpu.fpuTW &= ~(3 << (slot * 2));
}

export function execFPU(cpu: CPU, opcode: number): void {
  const d = cpu.decodeFPUModRM();
  const { mod, regField, rm } = d;
  const addr = d.addr;

  switch (opcode) {
    case 0xD8: execFPU_D8(cpu, mod, regField, rm, addr); break;
    case 0xD9: execFPU_D9(cpu, mod, regField, rm, addr); break;
    case 0xDA: execFPU_DA(cpu, mod, regField, rm, addr); break;
    case 0xDB: execFPU_DB(cpu, mod, regField, rm, addr); break;
    case 0xDC: execFPU_DC(cpu, mod, regField, rm, addr); break;
    case 0xDD: execFPU_DD(cpu, mod, regField, rm, addr); break;
    case 0xDE: execFPU_DE(cpu, mod, regField, rm, addr); break;
    case 0xDF: execFPU_DF(cpu, mod, regField, rm, addr); break;
    default:
      console.warn(`FPU opcode 0x${opcode.toString(16)} unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
      cpu.haltReason = 'illegal instruction';
      cpu.halted = true;
      break;
  }
}
