import type { CPU } from './cpu';
import type { Memory } from '../memory';
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

// 80-bit extended real codec shared by FLD/FSTP m80 and FSAVE/FRSTOR.

export function readExtended80(mem: Memory, addr: number): { value: number; raw: [number, number, number] } {
  const lo = mem.readU32(addr);
  const hi = mem.readU32(addr + 4);
  const exp_sign = mem.readU16(addr + 8);
  const sign = (exp_sign & 0x8000) ? -1 : 1;
  const exp = exp_sign & 0x7FFF;
  let value: number;
  if (exp === 0 && lo === 0 && hi === 0) {
    value = 0;
  } else if (exp === 0x7FFF) {
    value = sign * Infinity;
  } else {
    const mantissa = hi * 0x100000000 + lo;
    value = sign * mantissa * Math.pow(2, exp - 16383 - 63);
  }
  return { value, raw: [lo, hi, exp_sign] };
}

export function writeExtended80(mem: Memory, addr: number, val: number, raw80: [number, number, number] | undefined): void {
  if (raw80) {
    mem.writeU32(addr, raw80[0]);
    mem.writeU32(addr + 4, raw80[1]);
    mem.writeU16(addr + 8, raw80[2]);
    return;
  }
  const sign = (val < 0 || Object.is(val, -0)) ? 1 : 0;
  const abs = Math.abs(val);
  if (abs === 0) {
    mem.writeU32(addr, 0);
    mem.writeU32(addr + 4, 0);
    mem.writeU16(addr + 8, sign << 15);
  } else if (isNaN(val)) {
    mem.writeU32(addr, 0);
    mem.writeU32(addr + 4, 0xC0000000);
    mem.writeU16(addr + 8, 0x7FFF);
  } else if (!isFinite(abs)) {
    mem.writeU32(addr, 0);
    mem.writeU32(addr + 4, 0x80000000);
    mem.writeU16(addr + 8, (sign << 15) | 0x7FFF);
  } else {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, abs, false);
    const hi32 = dv.getUint32(0);
    const lo32 = dv.getUint32(4);
    const dblExp = (hi32 >>> 20) & 0x7FF;
    const dblMantHi = hi32 & 0xFFFFF;
    const dblMantLo = lo32;
    if (dblExp === 0) {
      const mantHi = (dblMantHi << 11) | (dblMantLo >>> 21);
      const mantLo = (dblMantLo << 11) >>> 0;
      mem.writeU32(addr, mantLo);
      mem.writeU32(addr + 4, mantHi);
      mem.writeU16(addr + 8, sign << 15);
    } else {
      const extExp = dblExp - 1023 + 16383;
      const mantHi = (0x80000000 | (dblMantHi << 11) | (dblMantLo >>> 21)) >>> 0;
      const mantLo = (dblMantLo << 11) >>> 0;
      mem.writeU32(addr, mantLo);
      mem.writeU32(addr + 4, mantHi);
      mem.writeU16(addr + 8, (sign << 15) | extExp);
    }
  }
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
