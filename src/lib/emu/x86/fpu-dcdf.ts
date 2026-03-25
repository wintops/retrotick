import type { CPU } from './cpu';
import type { Memory } from '../memory';
import { fpuPush, fpuPop, fpuST, fpuSetST } from './fpu';

// Flag bits
const CF = 0x001;
const ZF = 0x040;
const PF = 0x004;

const EAX = 0;

function fpuSetCC(cpu: CPU, c3: boolean, c2: boolean, c1: boolean, c0: boolean): void {
  cpu.fpuSW &= ~(0x4700);
  if (c0) cpu.fpuSW |= 0x0100;
  if (c1) cpu.fpuSW |= 0x0200;
  if (c2) cpu.fpuSW |= 0x0400;
  if (c3) cpu.fpuSW |= 0x4000;
}

function fpuCompare(cpu: CPU, a: number, b: number): void {
  if (isNaN(a) || isNaN(b)) {
    fpuSetCC(cpu, true, true, false, true);
  } else if (a > b) {
    fpuSetCC(cpu, false, false, false, false);
  } else if (a < b) {
    fpuSetCC(cpu, false, false, false, true);
  } else {
    fpuSetCC(cpu, true, false, false, false);
  }
}

function fpuCompareToCPUFlags(cpu: CPU, a: number, b: number): void {
  const flags = cpu.getFlags();
  let f = flags & ~(CF | ZF | PF);
  if (isNaN(a) || isNaN(b)) {
    f |= CF | ZF | PF;
  } else if (a < b) {
    f |= CF;
  } else if (a === b) {
    f |= ZF;
  }
  cpu.setFlags(f);
}

function roundToNearestEven(val: number): number {
  if (Math.abs(val - Math.trunc(val)) === 0.5) {
    const lo = Math.floor(val);
    const hi = Math.ceil(val);
    return (lo % 2 === 0) ? lo : hi;
  }
  return Math.round(val);
}

function fpuRound(cpu: CPU, val: number): number {
  const rc = (cpu.fpuCW >> 10) & 3;
  switch (rc) {
    case 0: return roundToNearestEven(val) | 0;
    case 1: return Math.floor(val) | 0;
    case 2: return Math.ceil(val) | 0;
    case 3: return Math.trunc(val) | 0;
    default: return roundToNearestEven(val) | 0;
  }
}

function readF64(mem: Memory, addr: number): number {
  const lo = mem.readU32(addr);
  const hi = mem.readU32(addr + 4);
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
  return dv.getFloat64(0, true);
}

function writeF64(mem: Memory, addr: number, val: number): void {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setFloat64(0, val, true);
  mem.writeU32(addr, dv.getUint32(0, true));
  mem.writeU32(addr + 4, dv.getUint32(4, true));
}

function readI64AsFloat(mem: Memory, addr: number): number {
  const lo = mem.readU32(addr);
  const hi = mem.readI32(addr + 4); // signed — FILD loads signed int64
  return hi * 0x100000000 + lo;
}

function readI64AsBigInt(mem: Memory, addr: number): bigint {
  const lo = BigInt(mem.readU32(addr)) & 0xFFFFFFFFn;
  const hi = BigInt(mem.readU32(addr + 4)) & 0xFFFFFFFFn;
  return (hi << 32n) | lo;
}

function writeFloatAsI64(mem: Memory, addr: number, val: number): void {
  const bi = BigInt(Math.trunc(val));
  const u64 = bi & 0xFFFFFFFFFFFFFFFFn;
  mem.writeU32(addr, Number(u64 & 0xFFFFFFFFn));
  mem.writeU32(addr + 4, Number((u64 >> 32n) & 0xFFFFFFFFn));
}

function writeBigIntAsI64(mem: Memory, addr: number, val: bigint): void {
  const u64 = val & 0xFFFFFFFFFFFFFFFFn;
  mem.writeU32(addr, Number(u64 & 0xFFFFFFFFn));
  mem.writeU32(addr + 4, Number((u64 >> 32n) & 0xFFFFFFFFn));
}

function fpuArith(cpu: CPU, op: number, a: number, b: number): void {
  switch (op) {
    case 0: fpuSetST(cpu, 0, a + b); break;
    case 1: fpuSetST(cpu, 0, a * b); break;
    case 2: fpuCompare(cpu, a, b); break;
    case 3: fpuCompare(cpu, a, b); fpuPop(cpu); break;
    case 4: fpuSetST(cpu, 0, a - b); break;
    case 5: fpuSetST(cpu, 0, b - a); break;
    case 6: fpuSetST(cpu, 0, a / b); break;
    case 7: fpuSetST(cpu, 0, b / a); break;
  }
}

export function execFPU_DC(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    const val = readF64(mem, addr);
    fpuArith(cpu, regField, fpuST(cpu, 0), val);
  } else {
    switch (regField) {
      case 0: fpuSetST(cpu, rm, fpuST(cpu, rm) + fpuST(cpu, 0)); break;
      case 1: fpuSetST(cpu, rm, fpuST(cpu, rm) * fpuST(cpu, 0)); break;
      case 2: fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, rm)); break;
      case 3: fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, rm)); fpuPop(cpu); break;
      case 4: fpuSetST(cpu, rm, fpuST(cpu, rm) - fpuST(cpu, 0)); break;
      case 5: fpuSetST(cpu, rm, fpuST(cpu, 0) - fpuST(cpu, rm)); break;
      case 6: fpuSetST(cpu, rm, fpuST(cpu, rm) / fpuST(cpu, 0)); break;
      case 7: fpuSetST(cpu, rm, fpuST(cpu, 0) / fpuST(cpu, rm)); break;
    }
  }
}

export function execFPU_DD(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    switch (regField) {
      case 0: {
        // FLD m64real: store raw U32 pair for NaN bit pattern preservation
        const lo = mem.readU32(addr);
        const hi = mem.readU32(addr + 4);
        fpuPush(cpu, readF64(mem, addr));
        cpu.fpuRaw64[cpu.fpuTop] = [lo, hi];
        break;
      }
      case 1: writeFloatAsI64(mem, addr, Math.trunc(fpuPop(cpu))); break;
      case 2: {
        // FST m64real: use raw bits if available
        const raw = cpu.fpuRaw64[cpu.fpuTop];
        if (raw) { mem.writeU32(addr, raw[0]); mem.writeU32(addr + 4, raw[1]); }
        else writeF64(mem, addr, fpuST(cpu, 0));
        break;
      }
      case 3: {
        // FSTP m64real: use raw bits if available
        const raw = cpu.fpuRaw64[cpu.fpuTop];
        if (raw) {
          mem.writeU32(addr, raw[0]); mem.writeU32(addr + 4, raw[1]);
          cpu.fpuRaw64[cpu.fpuTop] = undefined;
          cpu.fpuI64[cpu.fpuTop] = undefined;
          cpu.fpuTW |= (3 << (cpu.fpuTop * 2));
          cpu.fpuTop = (cpu.fpuTop + 1) & 7;
        } else {
          writeF64(mem, addr, fpuPop(cpu));
        }
        break;
      }
      case 4: break;
      case 6: break;
      case 7: mem.writeU16(addr, cpu.fpuSW | (cpu.fpuTop << 11)); break;
      default:
        console.warn(`FPU DD /${regField} mem unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  } else {
    switch (regField) {
      case 0:
        cpu.fpuTW |= (3 << (((cpu.fpuTop + rm) & 7) * 2));
        break;
      case 2: fpuSetST(cpu, rm, fpuST(cpu, 0)); break;
      case 3: fpuSetST(cpu, rm, fpuST(cpu, 0)); fpuPop(cpu); break;
      case 4: fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, rm)); break;
      case 5: fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, rm)); fpuPop(cpu); break;
      default:
        console.warn(`FPU DD reg /${regField} unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  }
}

export function execFPU_DE(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    const raw = mem.readU16(addr);
    const val = (raw << 16) >> 16;
    fpuArith(cpu, regField, fpuST(cpu, 0), val);
  } else {
    switch (regField) {
      case 0: fpuSetST(cpu, rm, fpuST(cpu, rm) + fpuST(cpu, 0)); fpuPop(cpu); break;
      case 1: fpuSetST(cpu, rm, fpuST(cpu, rm) * fpuST(cpu, 0)); fpuPop(cpu); break;
      case 2:
        fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, rm));
        fpuPop(cpu);
        break;
      case 3:
        if (rm === 1) {
          fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, 1));
          fpuPop(cpu);
          fpuPop(cpu);
        }
        break;
      case 4: fpuSetST(cpu, rm, fpuST(cpu, rm) - fpuST(cpu, 0)); fpuPop(cpu); break;
      case 5: fpuSetST(cpu, rm, fpuST(cpu, 0) - fpuST(cpu, rm)); fpuPop(cpu); break;
      case 6: fpuSetST(cpu, rm, fpuST(cpu, rm) / fpuST(cpu, 0)); fpuPop(cpu); break;
      case 7: fpuSetST(cpu, rm, fpuST(cpu, 0) / fpuST(cpu, rm)); fpuPop(cpu); break;
    }
  }
}

export function execFPU_DF(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    switch (regField) {
      case 0: {
        const raw = mem.readU16(addr);
        fpuPush(cpu, (raw << 16) >> 16);
        break;
      }
      case 1: {
        const v = Math.trunc(fpuPop(cpu));
        mem.writeU16(addr, v & 0xFFFF);
        break;
      }
      case 2: mem.writeU16(addr, fpuRound(cpu, fpuST(cpu, 0)) & 0xFFFF); break;
      case 3: mem.writeU16(addr, fpuRound(cpu, fpuPop(cpu)) & 0xFFFF); break;
      case 5: {
        // FILD m64int: load 64-bit integer, preserve exact BigInt for FISTP round-trip
        const rawI64 = readI64AsBigInt(mem, addr);
        fpuPush(cpu, readI64AsFloat(mem, addr));
        cpu.fpuI64[cpu.fpuTop] = rawI64;
        break;
      }
      case 7: {
        // FISTP m64int: if raw BigInt available (no arithmetic since FILD), use it
        const rawI64 = cpu.fpuI64[cpu.fpuTop];
        if (rawI64 !== undefined) {
          writeBigIntAsI64(mem, addr, rawI64);
          cpu.fpuI64[cpu.fpuTop] = undefined;
          cpu.fpuTW |= (3 << (cpu.fpuTop * 2));
          cpu.fpuTop = (cpu.fpuTop + 1) & 7;
        } else {
          writeFloatAsI64(mem, addr, fpuPop(cpu));
        }
        break;
      }
      default:
        console.warn(`FPU DF /${regField} mem unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  } else {
    if (regField === 4 && rm === 0) {
      cpu.setReg16(EAX, cpu.fpuSW | (cpu.fpuTop << 11));
    } else if (regField === 5) {
      fpuCompareToCPUFlags(cpu, fpuST(cpu, 0), fpuST(cpu, rm));
      fpuPop(cpu);
    } else if (regField === 6) {
      fpuCompareToCPUFlags(cpu, fpuST(cpu, 0), fpuST(cpu, rm));
      fpuPop(cpu);
    }
  }
}
