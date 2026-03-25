/**
 * WASM codegen — translates x86 instructions within a basic block to WASM bytecode.
 *
 * Registers are WASM locals 0-7 (EAX=0, ECX=1, EDX=2, EBX=3, ESP=4, EBP=5, ESI=6, EDI=7).
 * Additional locals (8+) are allocated via builder.allocLocal().
 */

import type { WasmBuilder } from './wasm-builder';
import type { Memory } from '../memory';
import { OFF_FLAGS, OFF_SEGBASES } from './flat-memory';
import { emitLoadU8, emitLoadU16, emitLoadI32, emitStoreU8WithVGA, emitStoreU16Direct, emitStoreI32Direct, emitAddSegBase, setAddrSize16 } from './wasm-codegen-mem';
import { emitMOV_rm, emitALU_rm, emitLEA, emitGroup83, emitTEST_rm } from './wasm-codegen-modrm';
import { LOP_ADD8, LOP_SUB8, LOP_SUB16, LOP_SUB32, LOP_AND8, LOP_OR8, LOP_XOR8, LOP_INC16, LOP_INC32, LOP_DEC16, LOP_DEC32, emitSetLazyFlags, emitSetLazyFlagsImm } from './wasm-codegen-flags';
import { emit8bitALU, emitALU_eax_imm, emitMOV8_rm, emitMOV_moffs_AL, emitMOV_rm8_imm8, emitMOV_rm_imm, emitShift_imm8, emitShift_by1, emitPUSH_imm8, emitPUSH_imm, emitIN_AL_imm8, emitIN_AL_DX, emitOUT_imm8_AL, emitOUT_DX_AL } from './wasm-codegen-ops';
import { emitGroup80, emitGroup81, emitGroupFE, emitGroupFF, emitGroupF6, emitGroupF7 } from './wasm-codegen-grp';

// Register local indices (must match the local allocation in wasm-module.ts)
export const REG_EAX = 0, REG_ECX = 1, REG_EDX = 2, REG_EBX = 3;
export const REG_ESP = 4, REG_EBP = 5, REG_ESI = 6, REG_EDI = 7;

// Extra locals allocated by the codegen (indices 8+, set during init)
let TMP1 = 8, TMP2 = 9, TMP3 = 10;
let STATE_LOCAL = 11, COUNTER_LOCAL = 12;

const DS_BASE = OFF_SEGBASES + 4;
const SS_BASE = OFF_SEGBASES + 12;

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
export function emitRegGet16(b: WasmBuilder, reg: number): void {
  b.getLocal(reg); b.constI32(0xFFFF); b.andI32();
}

/** Emit 16-bit register set: reg = (reg & ~0xFFFF) | (val & 0xFFFF) */
export function emitRegSet16(b: WasmBuilder, reg: number): void {
  // Stack has: value (16-bit)
  b.constI32(0xFFFF); b.andI32(); // mask to 16
  b.getLocal(reg); b.constI32(~0xFFFF); b.andI32(); // high bits of reg
  b.orI32();
  b.setLocal(reg);
}

/** Emit 8-bit register get: AL=r[0]&0xFF, AH=(r[0]>>8)&0xFF, etc */
export function emitReg8Get(b: WasmBuilder, r8: number): void {
  if (r8 < 4) {
    b.getLocal(r8); b.constI32(0xFF); b.andI32();
  } else {
    b.getLocal(r8 - 4); b.constI32(8); b.shrUI32(); b.constI32(0xFF); b.andI32();
  }
}

/** Emit 8-bit register set. Stack has: new 8-bit value */
export function emitReg8Set(b: WasmBuilder, r8: number): void {
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
  let hasSegOverride = false;
  const PREFIX_SET = new Set([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3]);
  while (PREFIX_SET.has(mem.readU8(pos))) {
    const pfx = mem.readU8(pos);
    if (pfx === 0x66) opSize32 = !opSize32;
    else if (pfx === 0x67) addrSize16 = !addrSize16;
    else if (pfx === 0x26 || pfx === 0x2E || pfx === 0x36 || pfx === 0x3E || pfx === 0x64 || pfx === 0x65) hasSegOverride = true;
    else if (pfx === 0xF2 || pfx === 0xF3 || pfx === 0xF0) hasSegOverride = true; // REP/LOCK also bail
    pos++;
  }
  // Bail on segment overrides — codegen always uses default DS/SS
  if (hasSegOverride) return -1;

  const is16 = !opSize32;
  const immSize = is16 ? 2 : 4;
  // Update module-level address size so emitModRM32Addr bails on 16-bit memory operands
  setAddrSize16(addrSize16);
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

    // ALU AL, imm8 (04=ADD, 0C=OR, 24=AND, 2C=SUB, 34=XOR)
    case 0x04: case 0x0C: case 0x24: case 0x2C: case 0x34: {
      const imm = mem.readU8(pos); pos++;
      const aluMap: Record<number, [() => void, number]> = {
        0x04: [() => b.addI32(), LOP_ADD8],
        0x0C: [() => b.orI32(), LOP_OR8],
        0x24: [() => b.andI32(), LOP_AND8],
        0x2C: [() => b.subI32(), LOP_SUB8],
        0x34: [() => b.xorI32(), LOP_XOR8],
      };
      const [aluFn, lop] = aluMap[op];
      emitReg8Get(b, 0); b.setLocal(tmp1); // save old AL
      b.getLocal(tmp1); b.constI32(imm);
      aluFn();
      b.constI32(0xFF); b.andI32(); b.teeLocal(tmp2);
      emitReg8Set(b, 0); // write result to AL
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8); // lazyA = old AL
      b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12); // lazyB = imm
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

    // MOV r/m8, reg8 (0x88) and MOV reg8, r/m8 (0x8A)
    case 0x88: { const n = emitMOV8_rm(ctx, pos, false); if (n < 0) return -1; pos += n; break; }
    case 0x8A: { const n = emitMOV8_rm(ctx, pos, true); if (n < 0) return -1; pos += n; break; }

    // MOV AL, [moffs] (A0)
    case 0xA0: {
      if (addrSize16) {
        const moffs = mem.readU16(pos);
        b.constI32(moffs); emitAddSegBase(b, DS_BASE); emitLoadU8(b); emitReg8Set(b, 0);
        pos += 2;
      } else {
        const moffs = mem.readU32(pos) | 0;
        b.constI32(moffs); emitAddSegBase(b, DS_BASE); emitLoadU8(b); emitReg8Set(b, 0);
        pos += 4;
      }
      break;
    }

    case 0xA1: { const n = emitMOV_moffs_AL(ctx, pos, true, is16); if (n < 0) return -1; pos += n; break; }

    // MOV [moffs], AL (A2) / MOV [moffs], AX/EAX (A3)
    case 0xA2: {
      const addrLen = addrSize16 ? 2 : 4;
      const moffs = addrSize16 ? mem.readU16(pos) : mem.readU32(pos) | 0;
      b.constI32(moffs); emitAddSegBase(b, DS_BASE);
      emitReg8Get(b, 0); // AL
      emitStoreU8WithVGA(b, ctx.writeVGAIdx, tmp1, tmp2);
      pos += addrLen; break;
    }
    case 0xA3: {
      const addrLen = addrSize16 ? 2 : 4;
      const moffs = addrSize16 ? mem.readU16(pos) : mem.readU32(pos) | 0;
      b.constI32(moffs); emitAddSegBase(b, DS_BASE);
      if (is16) { emitRegGet16(b, 0); emitStoreU16Direct(b); }
      else { b.getLocal(0); emitStoreI32Direct(b); }
      pos += addrLen; break;
    }

    case 0xC6: { const n = emitMOV_rm8_imm8(ctx, pos); if (n < 0) return -1; pos += n; break; }
    case 0xC7: { const n = emitMOV_rm_imm(ctx, pos, is16); if (n < 0) return -1; pos += n; break; }

    // PUSH imm
    case 0x6A: { pos += emitPUSH_imm8(ctx, pos, is16); break; }
    case 0x68: { pos += emitPUSH_imm(ctx, pos, is16); break; }

    // Port I/O
    case 0xE4: { pos += emitIN_AL_imm8(ctx, pos); break; }
    case 0xEC: { emitIN_AL_DX(ctx); break; }
    case 0xE6: { pos += emitOUT_imm8_AL(ctx, pos); break; }
    case 0xEE: { emitOUT_DX_AL(ctx); break; }

    // ALU EAX, imm
    case 0x05: { const n = emitALU_eax_imm(ctx, pos, 0, is16); if (n < 0) return -1; pos += n; break; }
    case 0x25: { const n = emitALU_eax_imm(ctx, pos, 4, is16); if (n < 0) return -1; pos += n; break; }
    case 0xA9: { const n = emitALU_eax_imm(ctx, pos, 0xFF, is16); if (n < 0) return -1; pos += n; break; }

    // Shifts
    case 0xC1: { const n = emitShift_imm8(ctx, pos, is16); if (n < 0) return -1; pos += n; break; }
    case 0xD0: { const n = emitShift_by1(ctx, pos, true, false); if (n < 0) return -1; pos += n; break; }
    case 0xD1: { const n = emitShift_by1(ctx, pos, false, is16); if (n < 0) return -1; pos += n; break; }

    // Group opcodes
    // 8-bit ALU r/m8, reg8 and reg8, r/m8
    case 0x00: case 0x08: case 0x28: case 0x30: case 0x38:
    case 0x02: case 0x0A: case 0x2A: case 0x32: case 0x3A:
    {
      const aluType = (op >> 3) & 7;
      const toReg = !!(op & 2);
      const n = emit8bitALU(ctx, pos, aluType, toReg);
      if (n < 0) return -1;
      pos += n;
      break;
    }
    case 0x80: { const n = emitGroup80(b, mem, pos, tmp1, tmp2, ctx.writeVGAIdx); if (n < 0) return -1; pos += n; break; }
    case 0x81: { const n = emitGroup81(b, mem, pos, is16, tmp1, tmp2); if (n < 0) return -1; pos += n; break; }
    case 0xFE: { const n = emitGroupFE(ctx, pos); if (n < 0) return -1; pos += n; break; }
    case 0xFF: { const n = emitGroupFF(ctx, pos, is16); if (n < 0) return -1; pos += n; break; }
    case 0xF6: { const n = emitGroupF6(ctx, pos); if (n < 0) return -1; pos += n; break; }
    case 0xF7: { const n = emitGroupF7(ctx, pos, is16); if (n < 0) return -1; pos += n; break; }

    // Anything else: unsupported
    default:
      return -1;
  }

  // Increment instruction counter
  b.getLocal(COUNTER_LOCAL); b.constI32(1); b.addI32(); b.setLocal(COUNTER_LOCAL);

  return pos - addr;
}
