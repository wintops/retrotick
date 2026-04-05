import type { CPU } from './cpu';
import { LazyOp } from './lazy-op';

// Flag bits
const CF = 0x001;
const PF = 0x004;
const AF = 0x010;
const ZF = 0x040;
const SF = 0x080;
const DF = 0x400;
const OF = 0x800;

// Parity lookup for low 8 bits
const PARITY_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let bits = 0;
  for (let j = 0; j < 8; j++) if (i & (1 << j)) bits++;
  PARITY_TABLE[i] = (bits & 1) === 0 ? 1 : 0;
}

export function materializeFlags(cpu: CPU): void {
  if (cpu.flagsValid) return;
  cpu.flagsValid = true;
  const res = cpu.lazyResult;
  const a = cpu.lazyA;
  const b = cpu.lazyB;
  let f = cpu.flagsCache & (DF | 0x7300); // preserve DF, TF, IF, IOPL, NT
  f |= 0x0002; // bit 1 always set

  switch (cpu.lazyOp) {
    case LazyOp.ADD8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      // CF: detect unsigned overflow including carry-in (lazyCF=0 for ADD, 1 for ADC)
      f |= ((a & 0xFF) + (b & 0xFF) + cpu.lazyCF > 0xFF) ? CF : 0;
      f |= ((~(a ^ b) & (a ^ res)) & 0x80) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.ADD16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= ((a & 0xFFFF) + (b & 0xFFFF) + cpu.lazyCF > 0xFFFF) ? CF : 0;
      f |= ((~(a ^ b) & (a ^ res)) & 0x8000) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.ADD32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      // CF: unsigned overflow. lazyCF carries the ADC carry-in (0 for plain ADD).
      f |= ((a >>> 0) + (b >>> 0) + cpu.lazyCF) > 0xFFFFFFFF ? CF : 0;
      f |= ((~(a ^ b) & (a ^ res)) & 0x80000000) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.SUB8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      // CF: unsigned borrow. lazyCF carries the SBB borrow-in (0 for plain SUB).
      f |= ((a & 0xFF) < (b & 0xFF) + cpu.lazyCF) ? CF : 0;
      f |= (((a ^ b) & (a ^ res)) & 0x80) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.SUB16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= ((a & 0xFFFF) < (b & 0xFFFF) + cpu.lazyCF) ? CF : 0;
      f |= (((a ^ b) & (a ^ res)) & 0x8000) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.SUB32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      // CF: unsigned borrow. lazyCF carries the SBB borrow-in (0 for plain SUB).
      f |= ((a >>> 0) < (b >>> 0) + cpu.lazyCF) ? CF : 0;
      f |= (((a ^ b) & (a ^ res)) & 0x80000000) ? OF : 0;
      f |= ((a ^ b ^ res) & 0x10) ? AF : 0;
      break;
    }
    case LazyOp.AND8: case LazyOp.OR8: case LazyOp.XOR8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      // CF=0, OF=0
      break;
    }
    case LazyOp.AND16: case LazyOp.OR16: case LazyOp.XOR16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      break;
    }
    case LazyOp.AND32: case LazyOp.OR32: case LazyOp.XOR32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      break;
    }
    case LazyOp.INC8: {
      const r8 = res & 0xFF;
      f |= cpu.flagsCache & CF; // INC preserves CF
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      f |= r8 === 0x80 ? OF : 0;
      f |= (r8 & 0x0F) === 0 ? AF : 0;
      break;
    }
    case LazyOp.INC16: {
      const r16 = res & 0xFFFF;
      f |= cpu.flagsCache & CF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= r16 === 0x8000 ? OF : 0;
      f |= (r16 & 0x0F) === 0 ? AF : 0;
      break;
    }
    case LazyOp.INC32: {
      const r32 = res >>> 0;
      f |= cpu.flagsCache & CF;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      f |= r32 === 0x80000000 ? OF : 0;
      f |= (r32 & 0x0F) === 0 ? AF : 0;
      break;
    }
    case LazyOp.DEC8: {
      const r8 = res & 0xFF;
      f |= cpu.flagsCache & CF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      f |= r8 === 0x7F ? OF : 0;
      f |= (r8 & 0x0F) === 0x0F ? AF : 0;
      break;
    }
    case LazyOp.DEC16: {
      const r16 = res & 0xFFFF;
      f |= cpu.flagsCache & CF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= r16 === 0x7FFF ? OF : 0;
      f |= (r16 & 0x0F) === 0x0F ? AF : 0;
      break;
    }
    case LazyOp.DEC32: {
      const r32 = res >>> 0;
      f |= cpu.flagsCache & CF;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      f |= r32 === 0x7FFFFFFF ? OF : 0;
      f |= (r32 & 0x0F) === 0x0F ? AF : 0;
      break;
    }
    case LazyOp.SHL8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      f |= b ? CF : 0; // b = last shifted-out bit
      break;
    }
    case LazyOp.SHL16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= b ? CF : 0;
      break;
    }
    case LazyOp.SHL32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      f |= b ? CF : 0;
      break;
    }
    case LazyOp.SHR8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      f |= b ? CF : 0;
      break;
    }
    case LazyOp.SHR16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= b ? CF : 0;
      break;
    }
    case LazyOp.SHR32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      f |= b ? CF : 0;
      break;
    }
    case LazyOp.SAR8: case LazyOp.SAR16: case LazyOp.SAR32: {
      const op = cpu.lazyOp;
      const mask = op === LazyOp.SAR8 ? 0xFF : op === LazyOp.SAR16 ? 0xFFFF : 0xFFFFFFFF;
      const signBit = op === LazyOp.SAR8 ? 0x80 : op === LazyOp.SAR16 ? 0x8000 : 0x80000000;
      const rv = (op === LazyOp.SAR32 ? res >>> 0 : res) & mask;
      f |= rv === 0 ? ZF : 0;
      f |= rv & signBit ? SF : 0;
      f |= PARITY_TABLE[rv & 0xFF] ? PF : 0;
      f |= b ? CF : 0;
      // OF=0 for SAR with count=1 (sign bit unchanged)
      break;
    }
    case LazyOp.NEG8: {
      const r8 = res & 0xFF;
      f |= r8 === 0 ? ZF : 0;
      f |= r8 & 0x80 ? SF : 0;
      f |= PARITY_TABLE[r8] ? PF : 0;
      f |= a !== 0 ? CF : 0; // CF = (original != 0)
      f |= r8 === 0x80 ? OF : 0;
      f |= (a & 0x0F) !== 0 ? AF : 0;
      break;
    }
    case LazyOp.NEG16: {
      const r16 = res & 0xFFFF;
      f |= r16 === 0 ? ZF : 0;
      f |= r16 & 0x8000 ? SF : 0;
      f |= PARITY_TABLE[r16 & 0xFF] ? PF : 0;
      f |= (a & 0xFFFF) !== 0 ? CF : 0;
      f |= r16 === 0x8000 ? OF : 0;
      f |= (a & 0x0F) !== 0 ? AF : 0;
      break;
    }
    case LazyOp.NEG32: {
      const r32 = res >>> 0;
      f |= r32 === 0 ? ZF : 0;
      f |= r32 & 0x80000000 ? SF : 0;
      f |= PARITY_TABLE[r32 & 0xFF] ? PF : 0;
      f |= (a >>> 0) !== 0 ? CF : 0;
      f |= r32 === 0x80000000 ? OF : 0;
      f |= (a & 0x0F) !== 0 ? AF : 0;
      break;
    }
    default:
      break;
  }
  cpu.flagsCache = f;
}
