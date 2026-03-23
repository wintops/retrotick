/**
 * WASM codegen — translates x86 instructions within a basic block to WASM bytecode.
 *
 * Registers are WASM locals 0-7 (EAX=0, ECX=1, EDX=2, EBX=3, ESP=4, EBP=5, ESI=6, EDI=7).
 * Additional locals (8+) are allocated via builder.allocLocal().
 */

import type { WasmBuilder } from './wasm-builder';
import type { Memory } from '../memory';
import { OFF_REGS, OFF_FLAGS, OFF_SEGBASES, OFF_EIP, OFF_EXIT } from './flat-memory';
import {
  emitLoadU8, emitLoadU16, emitLoadI32, emitLoadS8, emitLoadS16,
  emitStoreU8WithVGA, emitStoreU16WithVGA, emitStoreI32WithVGA,
  emitStoreU8Direct, emitStoreU16Direct, emitStoreI32Direct,
  emitAddSegBase, emitModRM16Addr,
} from './wasm-codegen-mem';
import { emitMOV_rm, emitALU_rm, emitLEA, emitGroup83, emitTEST_rm } from './wasm-codegen-modrm';
import {
  LOP_ADD8, LOP_ADD16, LOP_ADD32, LOP_SUB8, LOP_SUB16, LOP_SUB32,
  LOP_AND8, LOP_AND16, LOP_AND32, LOP_XOR8, LOP_XOR16, LOP_XOR32,
  LOP_INC16, LOP_INC32, LOP_DEC16, LOP_DEC32,
  LOP_SHL8, LOP_SHL16, LOP_SHL32, LOP_SHR8, LOP_SHR16, LOP_SHR32,
  emitSetLazyFlags, emitSetLazyFlagsImm,
} from './wasm-codegen-flags';

// Register local indices (must match the local allocation in wasm-module.ts)
export const REG_EAX = 0, REG_ECX = 1, REG_EDX = 2, REG_EBX = 3;
export const REG_ESP = 4, REG_EBP = 5, REG_ESI = 6, REG_EDI = 7;

// Extra locals allocated by the codegen (indices 8+, set during init)
let TMP1 = 8, TMP2 = 9, TMP3 = 10;
let STATE_LOCAL = 11, COUNTER_LOCAL = 12;

const DS_BASE = OFF_SEGBASES + 4;
const SS_BASE = OFF_SEGBASES + 12;
const ES_BASE = OFF_SEGBASES + 8;

/** Codegen context — tracks state during block compilation */
export interface CodegenCtx {
  b: WasmBuilder;
  mem: Memory;
  use32: boolean;
  is16: boolean;      // operand size 16-bit
  addrSize16: boolean;
  writeVGAIdx: number; // import index for writeVGA
  testCCIdx: number;   // import index for testCC
  portInIdx: number;   // import index for portIn
  portOutIdx: number;  // import index for portOut
  tmp1: number;        // temp local
  tmp2: number;        // temp local
  tmp3: number;        // temp local
}

/** Initialize codegen locals — called once per module */
export function initCodegenLocals(
  tmp1: number, tmp2: number, tmp3: number,
  stateLocal: number, counterLocal: number
): void {
  TMP1 = tmp1; TMP2 = tmp2; TMP3 = tmp3;
  STATE_LOCAL = stateLocal; COUNTER_LOCAL = counterLocal;
}

/** Emit 16-bit register get: (reg & 0xFFFF) */
function emitRegGet16(b: WasmBuilder, reg: number): void {
  b.getLocal(reg); b.constI32(0xFFFF); b.andI32();
}

/** Emit 16-bit register set: reg = (reg & ~0xFFFF) | (val & 0xFFFF) */
function emitRegSet16(b: WasmBuilder, reg: number): void {
  // Stack has: value (16-bit)
  b.constI32(0xFFFF); b.andI32(); // mask to 16
  b.getLocal(reg); b.constI32(~0xFFFF); b.andI32(); // high bits of reg
  b.orI32();
  b.setLocal(reg);
}

/** Emit 8-bit register get: AL=r[0]&0xFF, AH=(r[0]>>8)&0xFF, etc */
function emitReg8Get(b: WasmBuilder, r8: number): void {
  if (r8 < 4) {
    b.getLocal(r8); b.constI32(0xFF); b.andI32();
  } else {
    b.getLocal(r8 - 4); b.constI32(8); b.shrUI32(); b.constI32(0xFF); b.andI32();
  }
}

/** Emit 8-bit register set. Stack has: new 8-bit value */
function emitReg8Set(b: WasmBuilder, r8: number): void {
  if (r8 < 4) {
    b.constI32(0xFF); b.andI32();
    b.getLocal(r8); b.constI32(~0xFF); b.andI32();
    b.orI32(); b.setLocal(r8);
  } else {
    b.constI32(0xFF); b.andI32();
    b.constI32(8); b.shlI32();
    b.getLocal(r8 - 4); b.constI32(~0xFF00); b.andI32();
    b.orI32(); b.setLocal(r8 - 4);
  }
}

/**
 * Emit one x86 instruction as WASM bytecode.
 * Returns the number of bytes consumed, or -1 if the opcode is unsupported.
 */
export function emitInstruction(ctx: CodegenCtx, addr: number): number {
  const { b, mem, tmp1, tmp2, tmp3 } = ctx;
  let pos = addr;
  let opSize32 = ctx.use32;
  let addrSize16 = !ctx.use32;

  // Handle prefixes
  const PREFIX_SET = new Set([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3]);
  while (PREFIX_SET.has(mem.readU8(pos))) {
    const pfx = mem.readU8(pos);
    if (pfx === 0x66) opSize32 = !opSize32;
    if (pfx === 0x67) addrSize16 = !addrSize16;
    // Segment overrides, LOCK, REP: noted but not yet fully handled
    pos++;
  }

  const is16 = !opSize32;
  const immSize = is16 ? 2 : 4;
  const op = mem.readU8(pos); pos++;

  switch (op) {
    case 0x90: // NOP
      break;

    // INC reg (40-47)
    case 0x40: case 0x41: case 0x42: case 0x43:
    case 0x44: case 0x45: case 0x46: case 0x47: {
      const reg = op - 0x40;
      b.getLocal(reg); b.setLocal(tmp1); // save old value
      if (is16) {
        emitRegGet16(b, reg);
        b.constI32(1); b.addI32();
        emitRegSet16(b, reg);
      } else {
        b.getLocal(reg); b.constI32(1); b.addI32(); b.setLocal(reg);
      }
      emitSetLazyFlags(b, is16 ? LOP_INC16 : LOP_INC32, reg, tmp1, tmp1);
      break;
    }

    // DEC reg (48-4F)
    case 0x48: case 0x49: case 0x4A: case 0x4B:
    case 0x4C: case 0x4D: case 0x4E: case 0x4F: {
      const reg = op - 0x48;
      b.getLocal(reg); b.setLocal(tmp1);
      if (is16) {
        emitRegGet16(b, reg);
        b.constI32(1); b.subI32();
        emitRegSet16(b, reg);
      } else {
        b.getLocal(reg); b.constI32(1); b.subI32(); b.setLocal(reg);
      }
      emitSetLazyFlags(b, is16 ? LOP_DEC16 : LOP_DEC32, reg, tmp1, tmp1);
      break;
    }

    // PUSH reg (50-57)
    case 0x50: case 0x51: case 0x52: case 0x53:
    case 0x54: case 0x55: case 0x56: case 0x57: {
      const reg = op - 0x50;
      if (is16) {
        // SP -= 2
        emitRegGet16(b, REG_ESP); b.constI32(2); b.subI32();
        b.constI32(0xFFFF); b.andI32(); b.teeLocal(tmp1);
        // addr = SS_base + SP
        emitAddSegBase(b, SS_BASE);
        // store reg16
        if (reg === REG_ESP) { b.getLocal(tmp1); } else { emitRegGet16(b, reg); }
        emitStoreU16Direct(b);
        // write back SP
        b.getLocal(tmp1); emitRegSet16(b, REG_ESP);
      } else {
        // ESP -= 4
        b.getLocal(REG_ESP); b.constI32(4); b.subI32(); b.teeLocal(REG_ESP);
        b.getLocal(reg);
        emitStoreI32Direct(b);
      }
      break;
    }

    // POP reg (58-5F)
    case 0x58: case 0x59: case 0x5A: case 0x5B:
    case 0x5C: case 0x5D: case 0x5E: case 0x5F: {
      const reg = op - 0x58;
      if (is16) {
        emitRegGet16(b, REG_ESP);
        b.teeLocal(tmp1);
        emitAddSegBase(b, SS_BASE);
        emitLoadU16(b);
        emitRegSet16(b, reg);
        b.getLocal(tmp1); b.constI32(2); b.addI32(); b.constI32(0xFFFF); b.andI32();
        emitRegSet16(b, REG_ESP);
      } else {
        b.getLocal(REG_ESP);
        emitLoadI32(b);
        b.setLocal(reg);
        b.getLocal(REG_ESP); b.constI32(4); b.addI32(); b.setLocal(REG_ESP);
      }
      break;
    }

    // MOV reg, imm (B8-BF)
    case 0xB8: case 0xB9: case 0xBA: case 0xBB:
    case 0xBC: case 0xBD: case 0xBE: case 0xBF: {
      const reg = op - 0xB8;
      if (is16) {
        const imm = mem.readU16(pos); pos += 2;
        b.constI32(imm); emitRegSet16(b, reg);
      } else {
        const imm = mem.readU32(pos) | 0; pos += 4;
        b.constI32(imm); b.setLocal(reg);
      }
      break;
    }

    // MOV r8, imm8 (B0-B7)
    case 0xB0: case 0xB1: case 0xB2: case 0xB3:
    case 0xB4: case 0xB5: case 0xB6: case 0xB7: {
      const r8 = op - 0xB0;
      const imm = mem.readU8(pos); pos++;
      b.constI32(imm); emitReg8Set(b, r8);
      break;
    }

    // MOV r/m, reg (89) — full ModRM support
    case 0x89: {
      const n = emitMOV_rm(b, mem, pos, is16, 'rm_reg', tmp1);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // MOV reg, r/m (8B) — full ModRM support
    case 0x8B: {
      const n = emitMOV_rm(b, mem, pos, is16, 'reg_rm', tmp1);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // LEA reg, [mem] (8D)
    case 0x8D: {
      const n = emitLEA(b, mem, pos, is16);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // ALU r/m, reg and reg, r/m — full ModRM support
    case 0x01: case 0x03: // ADD
    case 0x09: case 0x0B: // OR
    case 0x21: case 0x23: // AND
    case 0x29: case 0x2B: // SUB
    case 0x31: case 0x33: // XOR
    case 0x39: case 0x3B: // CMP
    {
      const aluType = (op >> 3) & 7;
      const direction = (op & 2) ? 'reg_rm' as const : 'rm_reg' as const;
      const n = emitALU_rm(b, mem, pos, is16, aluType, direction, tmp1, tmp2);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // TEST r/m, reg (85 = 16/32bit, 84 = 8bit)
    case 0x84: case 0x85: {
      const n = emitTEST_rm(b, mem, pos, op === 0x84, is16, tmp1);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // CMP AL, imm8 (3C)
    case 0x3C: {
      const imm = mem.readU8(pos); pos++;
      emitReg8Get(b, 0); b.setLocal(tmp1);
      b.getLocal(tmp1); b.constI32(imm); b.subI32(); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, LOP_SUB8, tmp2, 0, 0);
      // store A=tmp1 manually
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
      break;
    }

    // TEST AL, imm8 (A8)
    case 0xA8: {
      const imm = mem.readU8(pos); pos++;
      emitReg8Get(b, 0); b.constI32(imm); b.andI32(); b.setLocal(tmp1);
      emitSetLazyFlagsImm(b, LOP_AND8, tmp1, 0, 0);
      break;
    }

    // Group 83: ALU r/m, imm8 — full ModRM support
    case 0x83: {
      const n = emitGroup83(b, mem, pos, is16, tmp1, tmp2);
      if (n < 0) return -1;
      pos += n;
      break;
    }

    // CMP AX/EAX, imm (3D)
    case 0x3D: {
      const imm = is16 ? mem.readU16(pos) : mem.readU32(pos) | 0;
      pos += immSize;
      if (is16) { emitRegGet16(b, 0); } else { b.getLocal(0); }
      b.setLocal(tmp1);
      b.getLocal(tmp1); b.constI32(imm); b.subI32(); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, is16 ? LOP_SUB16 : LOP_SUB32, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
      break;
    }

    // Anything else: unsupported
    default:
      return -1;
  }

  // Increment instruction counter
  b.getLocal(COUNTER_LOCAL); b.constI32(1); b.addI32(); b.setLocal(COUNTER_LOCAL);

  return pos - addr;
}
