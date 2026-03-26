/**
 * WASM codegen for x86 group opcodes — Group 80/81/FE/FF/F6/F7.
 */

import type { WasmBuilder } from './wasm-builder';
import type { Memory } from '../memory';
import type { CodegenCtx } from './wasm-codegen';
import { emitReg8Get, emitReg8Set, emitRegGet16, emitRegSet16 } from './wasm-codegen';
import { REG_ESP } from './wasm-codegen';
import { OFF_FLAGS, OFF_SEGBASES } from './flat-memory';
import { emitModRM32Addr, emitAddrMask } from './wasm-codegen-mem';
import { emitAddSegBase, emitStoreI32Direct } from './wasm-codegen-mem';
import {
  LOP_ADD8, LOP_ADD16, LOP_ADD32, LOP_SUB8, LOP_SUB16, LOP_SUB32,
  LOP_AND8, LOP_AND16, LOP_AND32, LOP_OR8, LOP_OR16, LOP_OR32,
  LOP_XOR8, LOP_XOR16, LOP_XOR32,
  LOP_INC8, LOP_INC16, LOP_INC32, LOP_DEC8, LOP_DEC16, LOP_DEC32,
  LOP_NEG8, LOP_NEG16, LOP_NEG32,
  emitSetLazyFlags, emitSetLazyFlagsImm, emitOpMask,
} from './wasm-codegen-flags';

const SS_BASE = OFF_SEGBASES + 12;

/** Emit ALU op + return LazyOp (same logic as emitAluOp in modrm.ts) */
function emitAluOp81(b: WasmBuilder, aluType: number, is16: boolean): number {
  switch (aluType) {
    case 0: b.addI32(); return is16 ? LOP_ADD16 : LOP_ADD32;
    case 1: b.orI32(); return is16 ? LOP_OR16 : LOP_OR32;
    case 4: b.andI32(); return is16 ? LOP_AND16 : LOP_AND32;
    case 5: b.subI32(); return is16 ? LOP_SUB16 : LOP_SUB32;
    case 6: b.xorI32(); return is16 ? LOP_XOR16 : LOP_XOR32;
    case 7: b.subI32(); return is16 ? LOP_SUB16 : LOP_SUB32;
    default: return 0;
  }
}

/** Emit the ALU WASM instruction for aluOp */
function emitAluInstr(b: WasmBuilder, aluOp: number): void {
  switch (aluOp) {
    case 0: b.addI32(); break;
    case 1: b.orI32(); break;
    case 4: b.andI32(); break;
    case 5: b.subI32(); break;
    case 6: b.xorI32(); break;
    case 7: b.subI32(); break;
  }
}

/** ALU op to 8-bit LazyOp */
function aluLop8(op: number): number {
  switch (op) {
    case 0: return LOP_ADD8;
    case 1: return LOP_OR8;
    case 4: return LOP_AND8;
    case 5: return LOP_SUB8;
    case 6: return LOP_XOR8;
    case 7: return LOP_SUB8;
    default: return 0;
  }
}

// --- Group 80: ALU r/m8, imm8 ---

export function emitGroup80(
  b: WasmBuilder, mem: Memory, pos: number,
  tmp1: number, tmp2: number, _writeVGAIdx: number,
): number {
  const modrm = mem.readU8(pos);
  const aluOp = (modrm >> 3) & 7;
  if (aluOp === 2 || aluOp === 3) return -1;
  // Bail on memory for write-back ops (CMP=7 is read-only, OK with memory)
  if (aluOp !== 7 && ((modrm >> 6) & 3) !== 3) return -1;
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const imm = mem.readU8(pos + mr.extraBytes);

  if (mr.isReg) {
    const rm8 = mr.rm;
    emitReg8Get(b, rm8); b.setLocal(tmp1);
    b.getLocal(tmp1); b.constI32(imm);
    emitAluInstr(b, aluOp);
    const lop = aluLop8(aluOp);
    if (aluOp === 7) {
      b.constI32(0xFF); b.andI32(); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
    } else {
      b.constI32(0xFF); b.andI32();
      emitReg8Set(b, rm8);
      emitReg8Get(b, rm8); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
    }
    b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
    b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
  } else {
    // Memory CMP r/m8, imm8 (aluOp=7 only reaches here)
    emitAddrMask(b);
    emitLoadU8(b); b.setLocal(tmp1); // tmp1 = [mem]
    b.getLocal(tmp1); b.constI32(imm);
    b.subI32(); b.constI32(0xFF); b.andI32(); b.setLocal(tmp2);
    emitSetLazyFlagsImm(b, LOP_SUB8, tmp2, 0, 0);
    b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
    b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
  }
  return mr.extraBytes + 1;
}

// --- Group 81: ALU r/m16/32, imm16/32 ---
// Modeled exactly on emitGroup83 (which works), only imm size differs.

export function emitGroup81(
  b: WasmBuilder, mem: Memory, pos: number, is16: boolean,
  tmp1: number, tmp2: number,
): number {
  const modrm = mem.readU8(pos);
  const aluOp = (modrm >> 3) & 7;
  if (aluOp === 2 || aluOp === 3) return -1; // ADC/SBB
  if (aluOp !== 7 && ((modrm >> 6) & 3) !== 3) return -1; // CMP=7 is read-only, OK with memory
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const immSize = is16 ? 2 : 4;
  const imm = is16 ? mem.readU16(pos + mr.extraBytes) : mem.readU32(pos + mr.extraBytes) | 0;

  if (mr.isReg) {
    const rm = mr.rm;
    b.getLocal(rm); b.setLocal(tmp1);
    if (is16) { emitRegGet16(b, rm); } else { b.getLocal(rm); }
    b.constI32(imm);
    const lop = emitAluOp81(b, aluOp, is16);
    if (aluOp === 7) {
      b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); emitOpMask(b, lop); b.storeI32(OFF_FLAGS + 8);
      b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
    } else {
      if (is16) { emitRegSet16(b, rm); } else { b.setLocal(rm); }
      emitSetLazyFlagsImm(b, lop, rm, 0, 0);
      b.constI32(0); b.getLocal(tmp1); emitOpMask(b, lop); b.storeI32(OFF_FLAGS + 8);
      b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
    }
  } else {
    // Memory CMP r/m, imm (aluOp=7 only reaches here)
    emitAddrMask(b);
    if (is16) { b.loadU16(0); } else { b.loadI32Unaligned(0); }
    b.setLocal(tmp1);
    b.getLocal(tmp1); b.constI32(imm); b.subI32(); b.setLocal(tmp2);
    const lop = is16 ? LOP_SUB16 : LOP_SUB32;
    emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
    b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
    b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
  }
  return mr.extraBytes + immSize;
}

// --- Group FE: INC/DEC r/m8 ---

export function emitGroupFE(ctx: CodegenCtx, pos: number): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const modrm = mem.readU8(pos);
  if (((modrm >> 3) & 7) > 1) return -1;
  if (((modrm >> 6) & 3) !== 3) return -1; // bail before emitting bytecode for memory operands
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const op = mr.reg;

  const rm8 = mr.rm;
  emitReg8Get(b, rm8); b.setLocal(tmp1);
  b.getLocal(tmp1);
  if (op === 0) { b.constI32(1); b.addI32(); }
  else { b.constI32(1); b.subI32(); }
  b.constI32(0xFF); b.andI32();
  emitReg8Set(b, rm8);
  emitReg8Get(b, rm8); b.setLocal(tmp2);
  emitSetLazyFlags(b, op === 0 ? LOP_INC8 : LOP_DEC8, tmp2, tmp1, tmp1);
  return mr.extraBytes;
}

// --- Group FF: INC/DEC/PUSH r/m16/32 ---

export function emitGroupFF(ctx: CodegenCtx, pos: number, is16: boolean): number {
  const { b, mem, tmp1 } = ctx;
  const modrm = mem.readU8(pos);
  const op = (modrm >> 3) & 7;
  if (op === 2 || op === 3 || op === 4 || op === 5) return -1; // bail before emitting bytecode
  // For INC/DEC (op 0/1), bail on memory operands before emitModRM32Addr
  if ((op === 0 || op === 1) && ((modrm >> 6) & 3) !== 3) return -1;
  const mr = emitModRM32Addr(b, modrm, mem, pos);

  if (op === 0 || op === 1) {
    const rm = mr.rm;
    b.getLocal(rm); b.setLocal(tmp1);
    if (is16) {
      emitRegGet16(b, rm); b.constI32(1);
      if (op === 0) b.addI32(); else b.subI32();
      emitRegSet16(b, rm);
    } else {
      b.getLocal(rm); b.constI32(1);
      if (op === 0) b.addI32(); else b.subI32();
      b.setLocal(rm);
    }
    emitSetLazyFlags(b, op === 0
      ? (is16 ? LOP_INC16 : LOP_INC32)
      : (is16 ? LOP_DEC16 : LOP_DEC32), rm, tmp1, tmp1);
    return mr.extraBytes;
  }

  if (op === 6) {
    if (mr.isReg) {
      if (is16) {
        emitRegGet16(b, REG_ESP); b.constI32(2); b.subI32();
        b.constI32(0xFFFF); b.andI32();
        const tmpSP = b.allocLocal();
        b.teeLocal(tmpSP);
        emitAddSegBase(b, SS_BASE);
        emitRegGet16(b, mr.rm); b.storeU16(0);
        b.getLocal(tmpSP); emitRegSet16(b, REG_ESP);
        b.freeLocal(tmpSP);
      } else {
        b.getLocal(REG_ESP); b.constI32(4); b.subI32(); b.teeLocal(REG_ESP);
        b.getLocal(mr.rm);
        emitStoreI32Direct(b);
      }
    } else {
      emitAddrMask(b);
      if (is16) { b.loadU16(0); } else { b.loadI32Unaligned(0); }
      b.setLocal(tmp1);
      if (is16) {
        emitRegGet16(b, REG_ESP); b.constI32(2); b.subI32();
        b.constI32(0xFFFF); b.andI32();
        const tmpSP = b.allocLocal();
        b.teeLocal(tmpSP);
        emitAddSegBase(b, SS_BASE);
        b.getLocal(tmp1); b.storeU16(0);
        b.getLocal(tmpSP); emitRegSet16(b, REG_ESP);
        b.freeLocal(tmpSP);
      } else {
        b.getLocal(REG_ESP); b.constI32(4); b.subI32(); b.teeLocal(REG_ESP);
        b.getLocal(tmp1);
        emitStoreI32Direct(b);
      }
    }
    return mr.extraBytes;
  }

  return -1;
}

// --- Group F6: TEST/NOT/NEG r/m8 ---

export function emitGroupF6(ctx: CodegenCtx, pos: number): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const modrm = mem.readU8(pos);
  if (((modrm >> 6) & 3) !== 3) return -1; // bail before emitting bytecode for memory operands
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const op = mr.reg;

  const rm8 = mr.rm;
  switch (op) {
    case 0: case 1: {
      const imm = mem.readU8(pos + mr.extraBytes);
      emitReg8Get(b, rm8); b.constI32(imm); b.andI32(); b.setLocal(tmp1);
      emitSetLazyFlagsImm(b, LOP_AND8, tmp1, 0, 0);
      return mr.extraBytes + 1;
    }
    case 2: {
      emitReg8Get(b, rm8);
      b.constI32(0xFF); b.xorI32();
      emitReg8Set(b, rm8);
      return mr.extraBytes;
    }
    case 3: {
      emitReg8Get(b, rm8); b.setLocal(tmp1);
      b.constI32(0); b.getLocal(tmp1); b.subI32();
      b.constI32(0xFF); b.andI32();
      emitReg8Set(b, rm8);
      emitReg8Get(b, rm8); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, LOP_NEG8, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      return mr.extraBytes;
    }
    default: return -1;
  }
}

// --- Group F7: TEST/NOT/NEG r/m16/32 ---

export function emitGroupF7(ctx: CodegenCtx, pos: number, is16: boolean): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const modrm = mem.readU8(pos);
  if (((modrm >> 6) & 3) !== 3) return -1; // bail before emitting bytecode for memory operands
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const op = mr.reg;

  const rm = mr.rm;
  const immSize = is16 ? 2 : 4;
  switch (op) {
    case 0: case 1: {
      const imm = is16 ? mem.readU16(pos + mr.extraBytes)
        : mem.readU32(pos + mr.extraBytes) | 0;
      if (is16) { emitRegGet16(b, rm); } else { b.getLocal(rm); }
      b.constI32(imm); b.andI32(); b.setLocal(tmp1);
      emitSetLazyFlagsImm(b, is16 ? LOP_AND16 : LOP_AND32, tmp1, 0, 0);
      return mr.extraBytes + immSize;
    }
    case 2: {
      if (is16) {
        emitRegGet16(b, rm); b.constI32(0xFFFF); b.xorI32();
        emitRegSet16(b, rm);
      } else {
        b.getLocal(rm); b.constI32(-1); b.xorI32(); b.setLocal(rm);
      }
      return mr.extraBytes;
    }
    case 3: {
      if (is16) { emitRegGet16(b, rm); } else { b.getLocal(rm); }
      b.setLocal(tmp1);
      b.constI32(0); b.getLocal(tmp1); b.subI32();
      if (is16) { emitRegSet16(b, rm); emitRegGet16(b, rm); b.setLocal(tmp2); }
      else { b.setLocal(rm); b.getLocal(rm); b.setLocal(tmp2); }
      emitSetLazyFlagsImm(b, is16 ? LOP_NEG16 : LOP_NEG32, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      return mr.extraBytes;
    }
    default: return -1;
  }
}
