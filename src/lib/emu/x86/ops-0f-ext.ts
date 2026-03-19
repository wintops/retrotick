import type { CPU } from './cpu';
import { doShld, doShrd } from './shift';
import { LazyOp } from './lazy-op';

// Flag bits
const CF = 0x001;
const ZF = 0x040;
const OF = 0x800;

// Register indices
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

export function exec0FExt(
  cpu: CPU,
  op2: number,
  opSize: number,
): boolean {
  switch (op2) {
    // BT r/m32, reg32
    case 0xA3: {
      const d = cpu.decodeModRM(opSize);
      const bit = (opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField]) & (opSize - 1);
      const cf = (d.val >> bit) & 1;
      const f = cpu.getFlags() & ~CF;
      cpu.setFlags(f | (cf ? CF : 0));
      return true;
    }

    // BTS r/m32, reg32
    case 0xAB: {
      const d = cpu.decodeModRM(opSize);
      const bit = (opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField]) & (opSize - 1);
      const cf = (d.val >> bit) & 1;
      cpu.writeModRM(d, d.val | (1 << bit), opSize);
      const f = cpu.getFlags() & ~CF;
      cpu.setFlags(f | (cf ? CF : 0));
      return true;
    }

    // BTR r/m32, reg32
    case 0xB3: {
      const d = cpu.decodeModRM(opSize);
      const bit = (opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField]) & (opSize - 1);
      const cf = (d.val >> bit) & 1;
      cpu.writeModRM(d, d.val & ~(1 << bit), opSize);
      const f = cpu.getFlags() & ~CF;
      cpu.setFlags(f | (cf ? CF : 0));
      return true;
    }

    // BT/BTS/BTR/BTC r/m, imm8 (0F BA)
    case 0xBA: {
      const d = cpu.decodeModRM(opSize);
      const bit = cpu.fetch8() & (opSize - 1);
      const cf = (d.val >> bit) & 1;
      const f = cpu.getFlags() & ~CF;
      cpu.setFlags(f | (cf ? CF : 0));
      if (d.regField === 5) cpu.writeModRM(d, d.val | (1 << bit), opSize);
      else if (d.regField === 6) cpu.writeModRM(d, d.val & ~(1 << bit), opSize);
      else if (d.regField === 7) cpu.writeModRM(d, d.val ^ (1 << bit), opSize);
      return true;
    }

    // BSF r32, r/m32
    case 0xBC: {
      const d = cpu.decodeModRM(opSize);
      if (d.val === 0) {
        cpu.setFlags(cpu.getFlags() | ZF);
      } else {
        cpu.setFlags(cpu.getFlags() & ~ZF);
        let bit = 0;
        let v = d.val >>> 0;
        while ((v & 1) === 0) { v >>>= 1; bit++; }
        if (opSize === 16) cpu.setReg16(d.regField, bit);
        else cpu.reg[d.regField] = bit;
      }
      return true;
    }

    // BSR r32, r/m32
    case 0xBD: {
      const d = cpu.decodeModRM(opSize);
      if (d.val === 0) {
        cpu.setFlags(cpu.getFlags() | ZF);
      } else {
        cpu.setFlags(cpu.getFlags() & ~ZF);
        let bit = opSize - 1;
        const v = d.val >>> 0;
        while (bit > 0 && !((v >>> bit) & 1)) bit--;
        if (opSize === 16) cpu.setReg16(d.regField, bit);
        else cpu.reg[d.regField] = bit;
      }
      return true;
    }

    // SHLD r/m32, r32, imm8
    case 0xA4: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.fetch8() & 0x1F;
      if (count) {
        const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField];
        const orig = d.val;
        const { result, carryOut } = doShld(orig, regVal, count, opSize);
        cpu.writeModRM(d, result, opSize);
        // SHL lazy sets ZF, SF, PF, CF correctly (b = carryOut)
        cpu.setLazy(opSize === 16 ? LazyOp.SHL16 : LazyOp.SHL32, result, orig, carryOut);
        if (count === 1) {
          // Materialize flags, then set OF = sign bit changed
          const f = cpu.getFlags();
          const signBit = opSize === 16 ? 0x8000 : 0x80000000;
          const of = ((orig ^ result) & signBit) ? OF : 0;
          cpu.setFlags((f & ~OF) | of);
        }
      }
      return true;
    }

    // SHLD r/m32, r32, CL
    case 0xA5: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.getReg8(ECX) & 0x1F;
      if (count) {
        const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField];
        const orig = d.val;
        const { result, carryOut } = doShld(orig, regVal, count, opSize);
        cpu.writeModRM(d, result, opSize);
        cpu.setLazy(opSize === 16 ? LazyOp.SHL16 : LazyOp.SHL32, result, orig, carryOut);
        if (count === 1) {
          const f = cpu.getFlags();
          const signBit = opSize === 16 ? 0x8000 : 0x80000000;
          const of = ((orig ^ result) & signBit) ? OF : 0;
          cpu.setFlags((f & ~OF) | of);
        }
      }
      return true;
    }

    // SHRD r/m32, r32, imm8
    case 0xAC: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.fetch8() & 0x1F;
      if (count) {
        const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField];
        const orig = d.val;
        const { result, carryOut } = doShrd(orig, regVal, count, opSize);
        cpu.writeModRM(d, result, opSize);
        // SHR lazy sets ZF, SF, PF, CF correctly
        cpu.setLazy(opSize === 16 ? LazyOp.SHR16 : LazyOp.SHR32, result, orig, carryOut);
        if (count === 1) {
          // OF = sign bit changed (orig MSB XOR result MSB)
          const f = cpu.getFlags();
          const signBit = opSize === 16 ? 0x8000 : 0x80000000;
          const of = ((orig ^ result) & signBit) ? OF : 0;
          cpu.setFlags((f & ~OF) | of);
        }
      }
      return true;
    }

    // SHRD r/m32, r32, CL
    case 0xAD: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.getReg8(ECX) & 0x1F;
      if (count) {
        const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField];
        const orig = d.val;
        const { result, carryOut } = doShrd(orig, regVal, count, opSize);
        cpu.writeModRM(d, result, opSize);
        cpu.setLazy(opSize === 16 ? LazyOp.SHR16 : LazyOp.SHR32, result, orig, carryOut);
        if (count === 1) {
          const f = cpu.getFlags();
          const signBit = opSize === 16 ? 0x8000 : 0x80000000;
          const of = ((orig ^ result) & signBit) ? OF : 0;
          cpu.setFlags((f & ~OF) | of);
        }
      }
      return true;
    }

    // CPUID
    case 0xA2: {
      const leaf = cpu.reg[EAX] >>> 0;
      if (leaf === 0) {
        // Max leaf + vendor string "RetroTickYes"
        cpu.reg[EAX] = 1;
        cpu.reg[EBX] = 0x72746552; // "Retr"
        cpu.reg[EDX] = 0x6369546F; // "oTic"
        cpu.reg[ECX] = 0x7365596B; // "kYes"
      } else if (leaf === 1) {
        // Family 5 (Pentium), Model 2, Stepping 0
        cpu.reg[EAX] = 0x0520; // family=5, model=2
        cpu.reg[EBX] = 0;
        cpu.reg[ECX] = 0;
        // EDX feature flags: FPU(0), TSC(4), CX8(8), CMOV(15)
        cpu.reg[EDX] = (1 << 0) | (1 << 4) | (1 << 8) | (1 << 15);
      } else {
        cpu.reg[EAX] = 0;
        cpu.reg[EBX] = 0;
        cpu.reg[ECX] = 0;
        cpu.reg[EDX] = 0;
      }
      return true;
    }

    // XADD r/m32, r32
    case 0xC1: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const origReg = cpu.getReg16(d.regField);
        const sum = d.val + origReg;
        cpu.setReg16(d.regField, d.val);
        cpu.writeModRM(d, sum & 0xFFFF, 16);
        cpu.setLazy(LazyOp.ADD16, sum, d.val, origReg);
      } else {
        const origReg = cpu.reg[d.regField];
        const sum = (d.val + origReg) | 0;
        cpu.reg[d.regField] = d.val | 0;
        cpu.writeModRM(d, sum, 32);
        cpu.setLazy(LazyOp.ADD32, sum, d.val, origReg);
      }
      return true;
    }

    // XADD r/m8, r8
    case 0xC0: {
      const d = cpu.decodeModRM(8);
      const origReg = cpu.getReg8(d.regField);
      const sum = d.val + origReg;
      cpu.setReg8(d.regField, d.val);
      cpu.writeModRM(d, sum & 0xFF, 8);
      cpu.setLazy(LazyOp.ADD8, sum, d.val, origReg);
      return true;
    }

    // CMPXCHG r/m32, r32 (0F B1)
    case 0xB1: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const eaxVal = cpu.getReg16(EAX);
        const cmp = (eaxVal - (d.val & 0xFFFF)) | 0;
        cpu.setLazy(LazyOp.SUB16, cmp, eaxVal, d.val & 0xFFFF);
        if (eaxVal === (d.val & 0xFFFF)) {
          cpu.writeModRM(d, cpu.getReg16(d.regField), 16);
        } else {
          cpu.setReg16(EAX, d.val & 0xFFFF);
        }
      } else {
        const eaxVal = cpu.reg[EAX] | 0;
        const cmp = (eaxVal - (d.val | 0)) | 0;
        cpu.setLazy(LazyOp.SUB32, cmp, eaxVal, d.val | 0);
        if (eaxVal === (d.val | 0)) {
          cpu.writeModRM(d, cpu.reg[d.regField], 32);
        } else {
          cpu.reg[EAX] = d.val | 0;
        }
      }
      return true;
    }

    // CMPXCHG r/m8, r8 (0F B0)
    case 0xB0: {
      const d = cpu.decodeModRM(8);
      const eaxVal = cpu.getReg8(EAX);
      const cmp = (eaxVal - (d.val & 0xFF)) | 0;
      cpu.setLazy(LazyOp.SUB8, cmp, eaxVal, d.val & 0xFF);
      if (eaxVal === (d.val & 0xFF)) {
        cpu.writeModRM(d, cpu.getReg8(d.regField), 8);
      } else {
        cpu.setReg8(EAX, d.val);
      }
      return true;
    }

    // BSWAP r32 (0F C8+rd)
    case 0xC8: case 0xC9: case 0xCA: case 0xCB:
    case 0xCC: case 0xCD: case 0xCE: case 0xCF: {
      const r = op2 - 0xC8;
      const v = cpu.reg[r] >>> 0;
      cpu.reg[r] = (((v & 0xFF) << 24) | ((v & 0xFF00) << 8) |
        ((v >> 8) & 0xFF00) | ((v >> 24) & 0xFF)) | 0;
      return true;
    }

    // BTC r/m32, reg32
    case 0xBB: {
      const d = cpu.decodeModRM(opSize);
      const bit = (opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField]) & (opSize - 1);
      const cf = (d.val >> bit) & 1;
      cpu.writeModRM(d, d.val ^ (1 << bit), opSize);
      const f = cpu.getFlags() & ~CF;
      cpu.setFlags(f | (cf ? CF : 0));
      return true;
    }

    // PUSH FS (0F A0)
    case 0xA0:
      if (opSize === 16) cpu.push16(0);
      else cpu.push32(0);
      return true;

    // POP FS (0F A1)
    case 0xA1:
      if (opSize === 16) cpu.pop16();
      else cpu.pop32();
      return true;

    // PUSH GS (0F A8)
    case 0xA8:
      if (opSize === 16) cpu.push16(0);
      else cpu.push32(0);
      return true;

    // POP GS (0F A9)
    case 0xA9:
      if (opSize === 16) cpu.pop16();
      else cpu.pop32();
      return true;

    // 0F 3F xx xx — undocumented (used by CPU-Z for CPU detection); treat as 4-byte NOP
    case 0x3F: {
      cpu.eip = (cpu.eip + 2) >>> 0; // skip 2 extra bytes
      return true;
    }

    // 0F 31 — RDTSC
    case 0x31: {
      const t = Date.now();
      cpu.reg[EAX] = t & 0xFFFFFFFF;
      cpu.reg[EDX] = 0;
      return true;
    }

    default:
      return false;
  }
}
