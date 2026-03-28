import type { CPU } from './cpu';
import type { Memory } from '../memory';
import { fpuPush, fpuPop, fpuST, fpuSetST } from './fpu';

// Flag bits needed for fpuCompareToCPUFlags
const CF = 0x001;
const ZF = 0x040;
const PF = 0x004;

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

function readF32(mem: Memory, addr: number): number {
  const bits = mem.readU32(addr);
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setUint32(0, bits, true);
  return dv.getFloat32(0, true);
}

function writeF32(mem: Memory, addr: number, val: number): void {
  const buf = new ArrayBuffer(4);
  const dv = new DataView(buf);
  dv.setFloat32(0, val, true);
  mem.writeU32(addr, dv.getUint32(0, true));
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

function roundToNearestEven(val: number): number {
  // Round-half-to-even (banker's rounding) — x86 FPU default rounding mode
  if (Math.abs(val - Math.trunc(val)) === 0.5) {
    // Exactly halfway — pick the even candidate
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

export function execFPU_D8(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    const val = readF32(mem, addr);
    fpuArith(cpu, regField, fpuST(cpu, 0), val);
  } else {
    fpuArith(cpu, regField, fpuST(cpu, 0), fpuST(cpu, rm));
  }
}

export function execFPU_D9(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    switch (regField) {
      case 0: fpuPush(cpu, readF32(mem, addr)); break;
      case 2: writeF32(mem, addr, fpuST(cpu, 0)); break;
      case 3: writeF32(mem, addr, fpuPop(cpu)); break;
      case 4: { // FLDENV — Load FPU Environment (14 bytes in 16-bit mode)
        cpu.fpuCW = mem.readU16(addr);
        cpu.fpuSW = mem.readU16(addr + 2);
        cpu.fpuTW = mem.readU16(addr + 4);
        // IP/opcode/operand fields (offsets 6-13) not critical — skip
        cpu.fpuTop = (cpu.fpuSW >> 11) & 7;
        break;
      }
      case 5: cpu.fpuCW = mem.readU16(addr); break; // FLDCW
      case 6: { // FNSTENV — Store FPU Environment (14 bytes in 16-bit mode)
        mem.writeU16(addr, cpu.fpuCW);
        mem.writeU16(addr + 2, cpu.fpuSW | (cpu.fpuTop << 11));
        mem.writeU16(addr + 4, cpu.fpuTW);
        mem.writeU16(addr + 6, 0);  // FPU IP offset
        mem.writeU16(addr + 8, 0);  // FPU IP selector
        mem.writeU16(addr + 10, 0); // FPU operand offset
        mem.writeU16(addr + 12, 0); // FPU operand selector
        // FNSTENV masks all exceptions after storing
        cpu.fpuCW |= 0x003F;
        break;
      }
      case 7: mem.writeU16(addr, cpu.fpuCW); break; // FNSTCW
      default:
        console.warn(`FPU D9 /${regField} mem unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  } else {
    const subop = (regField << 3) | rm;
    switch (subop) {
      case 0x00: case 0x01: case 0x02: case 0x03:
      case 0x04: case 0x05: case 0x06: case 0x07: {
        const val = fpuST(cpu, rm);
        fpuPush(cpu, val);
        break;
      }
      case 0x08: case 0x09: case 0x0A: case 0x0B:
      case 0x0C: case 0x0D: case 0x0E: case 0x0F: {
        const tmp = fpuST(cpu, 0);
        fpuSetST(cpu, 0, fpuST(cpu, rm));
        fpuSetST(cpu, rm, tmp);
        break;
      }
      case 0x10: break;
      case 0x20: fpuSetST(cpu, 0, -fpuST(cpu, 0)); break;
      case 0x21: fpuSetST(cpu, 0, Math.abs(fpuST(cpu, 0))); break;
      case 0x24: fpuCompare(cpu, fpuST(cpu, 0), 0); break;
      case 0x25: {
        const v = fpuST(cpu, 0);
        if (isNaN(v)) fpuSetCC(cpu, false, false, false, true);
        else if (!isFinite(v)) fpuSetCC(cpu, false, true, false, true);
        else if (v === 0) fpuSetCC(cpu, true, false, false, false);
        else fpuSetCC(cpu, false, true, false, false);
        break;
      }
      case 0x28: fpuPush(cpu, 1); break;
      case 0x29: fpuPush(cpu, Math.log2(10)); break;
      case 0x2A: fpuPush(cpu, Math.LOG2E); break;
      case 0x2B: fpuPush(cpu, Math.PI); break;
      case 0x2C: fpuPush(cpu, Math.log10(2)); break;
      case 0x2D: fpuPush(cpu, Math.LN2); break;
      case 0x2E: fpuPush(cpu, 0); break;
      case 0x30: fpuSetST(cpu, 0, Math.pow(2, fpuST(cpu, 0)) - 1); break;
      case 0x31: {
        const x = fpuPop(cpu);
        fpuSetST(cpu, 0, fpuST(cpu, 0) * Math.log2(x));
        break;
      }
      case 0x32: {
        // FPTAN: ST(0) = tan(ST(0)), then push 1.0
        fpuSetST(cpu, 0, Math.tan(fpuST(cpu, 0)));
        fpuPush(cpu, 1.0);
        cpu.fpuSW &= ~0x0400; // clear C2 (reduction complete)
        break;
      }
      case 0x33: {
        const x = fpuPop(cpu);
        fpuSetST(cpu, 0, Math.atan2(fpuST(cpu, 0), x));
        break;
      }
      case 0x34: { // FXTRACT — ST(0) → exponent in ST(1), significand in ST(0)
        const v = fpuST(cpu, 0);
        if (v === 0) {
          fpuSetST(cpu, 0, -Infinity); // exponent of 0 is -inf
          fpuPush(cpu, 0);
        } else {
          const exp = Math.floor(Math.log2(Math.abs(v)));
          fpuSetST(cpu, 0, exp);
          fpuPush(cpu, v / Math.pow(2, exp));
        }
        break;
      }
      case 0x35: { // FPREM1 — IEEE partial remainder
        const st0 = fpuST(cpu, 0);
        const st1 = fpuST(cpu, 1);
        const q = Math.round(st0 / st1);
        fpuSetST(cpu, 0, st0 - q * st1);
        cpu.fpuSW &= ~0x0400; // clear C2
        break;
      }
      case 0x36: cpu.fpuTop = (cpu.fpuTop - 1) & 7; break;
      case 0x37: cpu.fpuTop = (cpu.fpuTop + 1) & 7; break;
      case 0x38: { // FPREM — truncated partial remainder
        fpuSetST(cpu, 0, fpuST(cpu, 0) % fpuST(cpu, 1));
        cpu.fpuSW &= ~0x0400;
        break;
      }
      case 0x39: {
        const x = fpuPop(cpu);
        fpuSetST(cpu, 0, fpuST(cpu, 0) * Math.log2(x + 1));
        break;
      }
      case 0x3A: fpuSetST(cpu, 0, Math.sqrt(fpuST(cpu, 0))); break;
      case 0x3B: {
        const v = fpuST(cpu, 0);
        fpuSetST(cpu, 0, Math.sin(v));
        fpuPush(cpu, Math.cos(v));
        break;
      }
      case 0x3C: { // FRNDINT — round to integer as float (no 32-bit truncation)
        const v = fpuST(cpu, 0);
        const rc = (cpu.fpuCW >> 10) & 3;
        fpuSetST(cpu, 0, rc === 0 ? roundToNearestEven(v) : rc === 1 ? Math.floor(v) : rc === 2 ? Math.ceil(v) : Math.trunc(v));
        break;
      }
      case 0x3D: fpuSetST(cpu, 0, fpuST(cpu, 0) * Math.pow(2, Math.trunc(fpuST(cpu, 1)))); break;
      case 0x3E: fpuSetST(cpu, 0, Math.sin(fpuST(cpu, 0))); break;
      case 0x3F: fpuSetST(cpu, 0, Math.cos(fpuST(cpu, 0))); break;
      default:
        console.warn(`FPU D9 reg subop 0x${subop.toString(16)} unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  }
}

export function execFPU_DA(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    const val = mem.readI32(addr);
    fpuArith(cpu, regField, fpuST(cpu, 0), val);
  } else {
    if (regField === 0 && cpu.getFlag(CF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    else if (regField === 1 && cpu.getFlag(ZF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    else if (regField === 2 && (cpu.getFlag(CF) || cpu.getFlag(ZF))) fpuSetST(cpu, 0, fpuST(cpu, rm));
    else if (regField === 3 && cpu.getFlag(PF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    else if (regField === 5 && rm === 1) {
      fpuCompare(cpu, fpuST(cpu, 0), fpuST(cpu, 1));
      fpuPop(cpu);
      fpuPop(cpu);
    }
  }
}

export function execFPU_DB(cpu: CPU, mod: number, regField: number, rm: number, addr: number): void {
  const mem = cpu.mem;
  const isMem = mod !== 3;
  if (isMem) {
    switch (regField) {
      case 0: fpuPush(cpu, mem.readI32(addr)); break;
      case 1: mem.writeU32(addr, (Math.trunc(fpuPop(cpu))) | 0); break;
      case 2: mem.writeU32(addr, fpuRound(cpu, fpuST(cpu, 0))); break;
      case 3: mem.writeU32(addr, fpuRound(cpu, fpuPop(cpu))); break;
      case 5: {
        // FLD m80real: preserve raw 10 bytes for FSTP round-trip
        const lo = mem.readU32(addr);
        const hi = mem.readU32(addr + 4);
        const exp_sign = mem.readU16(addr + 8);
        const sign = (exp_sign & 0x8000) ? -1 : 1;
        const exp = (exp_sign & 0x7FFF);
        if (exp === 0 && lo === 0 && hi === 0) {
          fpuPush(cpu, 0);
        } else if (exp === 0x7FFF) {
          fpuPush(cpu, sign * Infinity);
        } else {
          const mantissa = hi * 0x100000000 + lo;
          fpuPush(cpu, sign * mantissa * Math.pow(2, exp - 16383 - 63));
        }
        cpu.fpuRaw80[cpu.fpuTop] = [lo, hi, exp_sign];
        break;
      }
      case 7: {
        // FSTP m80 — use raw bytes if available for exact preservation
        const raw80 = cpu.fpuRaw80[cpu.fpuTop];
        if (raw80) {
          mem.writeU32(addr, raw80[0]);
          mem.writeU32(addr + 4, raw80[1]);
          mem.writeU16(addr + 8, raw80[2]);
          cpu.fpuRaw80[cpu.fpuTop] = undefined;
          cpu.fpuI64[cpu.fpuTop] = undefined;
          cpu.fpuRaw64[cpu.fpuTop] = undefined;
          cpu.fpuTW |= (3 << (cpu.fpuTop * 2));
          cpu.fpuTop = (cpu.fpuTop + 1) & 7;
          break;
        }
        const val = fpuPop(cpu);
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
          // Decompose double to 80-bit extended
          // Double: 1 sign, 11-bit exp (bias 1023), 52-bit mantissa (implicit 1)
          // Extended: 1 sign, 15-bit exp (bias 16383), 64-bit mantissa (explicit 1)
          const buf = new ArrayBuffer(8);
          const dv = new DataView(buf);
          dv.setFloat64(0, abs, false); // big-endian for easy bit extraction
          const hi32 = dv.getUint32(0);
          const lo32 = dv.getUint32(4);
          const dblExp = (hi32 >>> 20) & 0x7FF;
          const dblMantHi = hi32 & 0xFFFFF; // top 20 bits of 52-bit mantissa
          const dblMantLo = lo32;            // bottom 32 bits of 52-bit mantissa
          if (dblExp === 0) {
            // Denormal double → denormal or small normal extended
            // For simplicity, store as extended denormal
            const mantHi = (dblMantHi << 11) | (dblMantLo >>> 21);
            const mantLo = (dblMantLo << 11) >>> 0;
            mem.writeU32(addr, mantLo);
            mem.writeU32(addr + 4, mantHi);
            mem.writeU16(addr + 8, sign << 15);
          } else {
            const extExp = dblExp - 1023 + 16383;
            // 64-bit mantissa: bit 63 = explicit 1, bits 62..11 = 52-bit mantissa, bits 10..0 = 0
            const mantHi = (0x80000000 | (dblMantHi << 11) | (dblMantLo >>> 21)) >>> 0;
            const mantLo = (dblMantLo << 11) >>> 0;
            mem.writeU32(addr, mantLo);
            mem.writeU32(addr + 4, mantHi);
            mem.writeU16(addr + 8, (sign << 15) | extExp);
          }
        }
        break;
      }
      default:
        console.warn(`FPU DB /${regField} mem unimplemented at EIP=0x${((cpu.eip) >>> 0).toString(16)}`);
        break;
    }
  } else {
    if (regField === 4) {
      if (rm === 2) {
        cpu.fpuSW &= 0x7F00;
      } else if (rm === 3) {
        cpu.fpuCW = 0x037F;
        cpu.fpuSW = 0;
        cpu.fpuTW = 0xFFFF;
        cpu.fpuTop = 0;
      }
    } else if (regField === 5) {
      fpuCompareToCPUFlags(cpu, fpuST(cpu, 0), fpuST(cpu, rm));
    } else if (regField === 6) {
      fpuCompareToCPUFlags(cpu, fpuST(cpu, 0), fpuST(cpu, rm));
    } else if (regField === 0) {
      if (!cpu.getFlag(CF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    } else if (regField === 1) {
      if (!cpu.getFlag(ZF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    } else if (regField === 2) {
      if (!cpu.getFlag(CF) && !cpu.getFlag(ZF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    } else if (regField === 3) {
      if (!cpu.getFlag(PF)) fpuSetST(cpu, 0, fpuST(cpu, rm));
    }
  }
}
