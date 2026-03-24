/**
 * WASM codegen for additional x86 opcodes — 8-bit ALU, MOV variants, shifts,
 * PUSH/POP imm, and port I/O.
 */

import type { WasmBuilder } from './wasm-builder';
import type { CodegenCtx } from './wasm-codegen';
import { emitReg8Get, emitReg8Set, emitRegGet16, emitRegSet16 } from './wasm-codegen';
import { REG_EAX, REG_ESP } from './wasm-codegen';
import { OFF_FLAGS, OFF_SEGBASES } from './flat-memory';
import { emitModRM32Addr } from './wasm-codegen-mem';
import {
  emitLoadU8, emitLoadU16, emitLoadI32,
  emitStoreU8WithVGA, emitStoreI32Direct,
  emitAddSegBase,
} from './wasm-codegen-mem';
import {
  LOP_ADD8, LOP_ADD16, LOP_ADD32, LOP_SUB8, LOP_SUB16, LOP_SUB32,
  LOP_AND8, LOP_AND16, LOP_AND32, LOP_OR8, LOP_XOR8,
  LOP_SHL8, LOP_SHL16, LOP_SHL32, LOP_SHR8, LOP_SHR16, LOP_SHR32,
  LOP_SAR8, LOP_SAR16, LOP_SAR32,
  emitSetLazyFlags, emitSetLazyFlagsImm,
} from './wasm-codegen-flags';

const DS_BASE = OFF_SEGBASES + 4;
const SS_BASE = OFF_SEGBASES + 12;

/** ALU op to 8-bit LazyOp */
function aluLop8(aluOp: number): number {
  switch (aluOp) {
    case 0: return LOP_ADD8;
    case 1: return LOP_OR8;
    case 4: return LOP_AND8;
    case 5: return LOP_SUB8;
    case 6: return LOP_XOR8;
    case 7: return LOP_SUB8;
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

// --- 8-bit ALU with ModRM ---

/**
 * Emit 8-bit ALU: r/m8 OP reg8 or reg8 OP r/m8.
 * Returns bytes consumed, or -1 if unsupported.
 */
export function emit8bitALU(
  ctx: CodegenCtx, pos: number, aluOp: number, toReg: boolean,
): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const modrm = mem.readU8(pos);
  if (aluOp === 2 || aluOp === 3) return -1;
  // Bail on [mem] OP reg8 write-back before emitting bytecode
  if (!toReg && ((modrm >> 6) & 3) !== 3) return -1;
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const regF = mr.reg;

  if (mr.isReg) {
    const dst8 = toReg ? regF : mr.rm;
    const src8 = toReg ? mr.rm : regF;
    emitReg8Get(b, dst8); b.setLocal(tmp1);
    b.getLocal(tmp1);
    emitReg8Get(b, src8);
    emitAluInstr(b, aluOp);
    const lop = aluLop8(aluOp);
    if (aluOp === 7) {
      b.constI32(0xFF); b.andI32(); b.setLocal(tmp2);
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      emitReg8Get(b, src8); b.setLocal(tmp2);
      b.constI32(0); b.getLocal(tmp2); b.storeI32(OFF_FLAGS + 12);
    } else {
      b.constI32(0xFF); b.andI32(); b.teeLocal(tmp2);
      emitReg8Set(b, dst8);
      emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      emitReg8Get(b, src8); b.setLocal(tmp1);
      b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 12);
    }
  } else {
    if (toReg) {
      b.teeLocal(tmp1);
      emitLoadU8(b);
      b.setLocal(tmp2);
      emitReg8Get(b, regF); b.setLocal(tmp1);
      b.getLocal(tmp1); b.getLocal(tmp2);
      emitAluInstr(b, aluOp);
      const lop = aluLop8(aluOp);
      if (aluOp === 7) {
        b.constI32(0xFF); b.andI32(); b.setLocal(tmp2);
        emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
        b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      } else {
        emitReg8Set(b, regF);
        emitReg8Get(b, regF); b.setLocal(tmp2);
        emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
        b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
      }
    } else {
      return -1; // [mem] OP reg8 write-back — bail
    }
  }
  return mr.extraBytes;
}

// --- Immediate ALU (05/25/A9) ---

/** Emit ADD/AND/TEST EAX, imm16/32 */
export function emitALU_eax_imm(
  ctx: CodegenCtx, pos: number, aluOp: number, is16: boolean,
): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const immSize = is16 ? 2 : 4;
  const imm = is16 ? mem.readU16(pos) : mem.readU32(pos) | 0;

  if (is16) { emitRegGet16(b, REG_EAX); } else { b.getLocal(REG_EAX); }
  b.setLocal(tmp1);

  if (aluOp === 0xFF) {
    // TEST: AND without storing
    b.getLocal(tmp1); b.constI32(imm); b.andI32(); b.setLocal(tmp2);
    emitSetLazyFlagsImm(b, is16 ? LOP_AND16 : LOP_AND32, tmp2, 0, 0);
    return immSize;
  }

  b.getLocal(tmp1); b.constI32(imm);
  if (aluOp === 0) { b.addI32(); }
  else if (aluOp === 4) { b.andI32(); }

  if (is16) { emitRegSet16(b, REG_EAX); } else { b.setLocal(REG_EAX); }

  const lop = aluOp === 0
    ? (is16 ? LOP_ADD16 : LOP_ADD32)
    : (is16 ? LOP_AND16 : LOP_AND32);
  if (is16) { emitRegGet16(b, REG_EAX); b.setLocal(tmp2); }
  else { b.getLocal(REG_EAX); b.setLocal(tmp2); }
  emitSetLazyFlagsImm(b, lop, tmp2, 0, 0);
  b.constI32(0); b.getLocal(tmp1); b.storeI32(OFF_FLAGS + 8);
  b.constI32(0); b.constI32(imm); b.storeI32(OFF_FLAGS + 12);
  return immSize;
}

// --- MOV 8-bit variants ---

/** Emit MOV r/m8, reg8 (0x88) or MOV reg8, r/m8 (0x8A) */
export function emitMOV8_rm(
  ctx: CodegenCtx, pos: number, toReg: boolean,
): number {
  const { b, mem, tmp1 } = ctx;
  const modrm = mem.readU8(pos);
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const regF = mr.reg;

  if (mr.isReg) {
    if (toReg) { emitReg8Get(b, mr.rm); emitReg8Set(b, regF); }
    else { emitReg8Get(b, regF); emitReg8Set(b, mr.rm); }
  } else {
    if (toReg) {
      emitLoadU8(b);
      emitReg8Set(b, regF);
    } else {
      emitReg8Get(b, regF);
      emitStoreU8WithVGA(b, ctx.writeVGAIdx, tmp1, ctx.tmp2);
    }
  }
  return mr.extraBytes;
}

/** Emit MOV AX/EAX, [moffs] (0xA1) */
export function emitMOV_moffs_AL(
  ctx: CodegenCtx, pos: number, toAL: boolean, is16: boolean,
): number {
  const { b, mem } = ctx;
  const addrLen = ctx.addrSize16 ? 2 : 4;
  const addr = ctx.addrSize16 ? mem.readU16(pos) : mem.readU32(pos) | 0;

  b.constI32(addr);
  emitAddSegBase(b, DS_BASE);

  if (toAL) {
    if (is16) { emitLoadU16(b); emitRegSet16(b, REG_EAX); }
    else { emitLoadI32(b); b.setLocal(REG_EAX); }
  } else {
    return -1;
  }
  return addrLen;
}

/** Emit MOV r/m8, imm8 (0xC6) */
export function emitMOV_rm8_imm8(ctx: CodegenCtx, pos: number): number {
  const { b, mem, tmp1 } = ctx;
  const modrm = mem.readU8(pos);
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  if (mr.reg !== 0) return -1;
  const imm = mem.readU8(pos + mr.extraBytes);

  if (mr.isReg) {
    b.constI32(imm); emitReg8Set(b, mr.rm);
  } else {
    b.constI32(imm);
    emitStoreU8WithVGA(b, ctx.writeVGAIdx, tmp1, ctx.tmp2);
  }
  return mr.extraBytes + 1;
}

/** Emit MOV r/m16/32, imm16/32 (0xC7) */
export function emitMOV_rm_imm(
  ctx: CodegenCtx, pos: number, is16: boolean,
): number {
  const { b, mem } = ctx;
  const modrm = mem.readU8(pos);
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  if (mr.reg !== 0) return -1;
  const immSize = is16 ? 2 : 4;
  const imm = is16 ? mem.readU16(pos + mr.extraBytes)
    : mem.readU32(pos + mr.extraBytes) | 0;

  if (mr.isReg) {
    if (is16) { b.constI32(imm); emitRegSet16(b, mr.rm); }
    else { b.constI32(imm); b.setLocal(mr.rm); }
  } else {
    b.constI32(imm);
    if (is16) { b.storeU16(0); }
    else { b.storeI32Unaligned(0); }
  }
  return mr.extraBytes + immSize;
}

// --- Shifts ---

/** Emit shift r/m16/32 by imm8 (0xC1) */
export function emitShift_imm8(
  ctx: CodegenCtx, pos: number, is16: boolean,
): number {
  const { b, mem, tmp1 } = ctx;
  const modrm = mem.readU8(pos);
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const shiftOp = mr.reg;
  const count = mem.readU8(pos + mr.extraBytes) & 0x1F;

  if (count === 0) return mr.extraBytes + 1;
  if (!mr.isReg) return -1;
  if (shiftOp === 2 || shiftOp === 3) return -1;

  const rm = mr.rm;
  b.getLocal(rm); b.setLocal(tmp1);
  if (is16) { emitRegGet16(b, rm); } else { b.getLocal(rm); }
  b.constI32(count);
  let lop: number;
  switch (shiftOp) {
    case 0: b.rotlI32();
      if (is16) { emitRegSet16(b, rm); } else { b.setLocal(rm); }
      return mr.extraBytes + 1;
    case 1: b.rotrI32();
      if (is16) { emitRegSet16(b, rm); } else { b.setLocal(rm); }
      return mr.extraBytes + 1;
    case 4: case 6: b.shlI32(); lop = is16 ? LOP_SHL16 : LOP_SHL32; break;
    case 5: b.shrUI32(); lop = is16 ? LOP_SHR16 : LOP_SHR32; break;
    case 7: b.shrSI32(); lop = is16 ? LOP_SAR16 : LOP_SAR32; break;
    default: return -1;
  }

  if (is16) { emitRegSet16(b, rm); } else { b.setLocal(rm); }
  emitSetLazyFlags(b, lop, rm, tmp1, tmp1);
  return mr.extraBytes + 1;
}

/** Emit shift r/m8 by 1 (0xD0) or r/m16/32 by 1 (0xD1) */
export function emitShift_by1(
  ctx: CodegenCtx, pos: number, is8bit: boolean, is16: boolean,
): number {
  const { b, mem, tmp1, tmp2 } = ctx;
  const modrm = mem.readU8(pos);
  const mr = emitModRM32Addr(b, modrm, mem, pos);
  const shiftOp = mr.reg;

  if (!mr.isReg) return -1;
  if (shiftOp === 2 || shiftOp === 3) return -1;

  const rm = mr.rm;
  if (is8bit) {
    emitReg8Get(b, rm); b.setLocal(tmp1);
    b.getLocal(tmp1); b.constI32(1);
  } else {
    b.getLocal(rm); b.setLocal(tmp1);
    if (is16) { emitRegGet16(b, rm); } else { b.getLocal(rm); }
    b.constI32(1);
  }

  let lop: number;
  switch (shiftOp) {
    case 0: b.rotlI32();
      if (is8bit) { emitReg8Set(b, rm); }
      else if (is16) { emitRegSet16(b, rm); }
      else { b.setLocal(rm); }
      return mr.extraBytes;
    case 1: b.rotrI32();
      if (is8bit) { emitReg8Set(b, rm); }
      else if (is16) { emitRegSet16(b, rm); }
      else { b.setLocal(rm); }
      return mr.extraBytes;
    case 4: case 6:
      b.shlI32();
      lop = is8bit ? LOP_SHL8 : is16 ? LOP_SHL16 : LOP_SHL32;
      break;
    case 5:
      b.shrUI32();
      lop = is8bit ? LOP_SHR8 : is16 ? LOP_SHR16 : LOP_SHR32;
      break;
    case 7:
      b.shrSI32();
      lop = is8bit ? LOP_SAR8 : is16 ? LOP_SAR16 : LOP_SAR32;
      break;
    default: return -1;
  }

  if (is8bit) { emitReg8Set(b, rm); }
  else if (is16) { emitRegSet16(b, rm); }
  else { b.setLocal(rm); }

  if (is8bit) {
    emitReg8Get(b, rm); b.setLocal(tmp2);
    emitSetLazyFlags(b, lop, tmp2, tmp1, tmp1);
  } else {
    emitSetLazyFlags(b, lop, rm, tmp1, tmp1);
  }
  return mr.extraBytes;
}

// --- PUSH imm ---

/** Emit PUSH imm8 sign-extended (0x6A) */
export function emitPUSH_imm8(
  ctx: CodegenCtx, pos: number, is16: boolean,
): number {
  const { b, mem } = ctx;
  let imm = mem.readU8(pos);
  if (imm > 127) imm -= 256;

  if (is16) {
    emitRegGet16(b, REG_ESP); b.constI32(2); b.subI32();
    b.constI32(0xFFFF); b.andI32();
    const tmpSP = b.allocLocal();
    b.teeLocal(tmpSP);
    emitAddSegBase(b, SS_BASE);
    b.constI32(imm & 0xFFFF); b.storeU16(0);
    b.getLocal(tmpSP); emitRegSet16(b, REG_ESP);
    b.freeLocal(tmpSP);
  } else {
    b.getLocal(REG_ESP); b.constI32(4); b.subI32();
    b.teeLocal(REG_ESP);
    b.constI32(imm);
    emitStoreI32Direct(b);
  }
  return 1;
}

/** Emit PUSH imm16/32 (0x68) */
export function emitPUSH_imm(
  ctx: CodegenCtx, pos: number, is16: boolean,
): number {
  const { b, mem } = ctx;
  const immSize = is16 ? 2 : 4;
  const imm = is16 ? mem.readU16(pos) : mem.readU32(pos) | 0;

  if (is16) {
    emitRegGet16(b, REG_ESP); b.constI32(2); b.subI32();
    b.constI32(0xFFFF); b.andI32();
    const tmpSP = b.allocLocal();
    b.teeLocal(tmpSP);
    emitAddSegBase(b, SS_BASE);
    b.constI32(imm); b.storeU16(0);
    b.getLocal(tmpSP); emitRegSet16(b, REG_ESP);
    b.freeLocal(tmpSP);
  } else {
    b.getLocal(REG_ESP); b.constI32(4); b.subI32();
    b.teeLocal(REG_ESP);
    b.constI32(imm);
    emitStoreI32Direct(b);
  }
  return immSize;
}

// --- Port I/O ---

/** Emit IN AL, imm8 (0xE4) */
export function emitIN_AL_imm8(ctx: CodegenCtx, pos: number): number {
  const { b, mem } = ctx;
  const port = mem.readU8(pos);
  b.constI32(port);
  b.call(ctx.portInIdx);
  emitReg8Set(b, 0);
  return 1;
}

/** Emit IN AL, DX (0xEC) */
export function emitIN_AL_DX(ctx: CodegenCtx): number {
  const { b } = ctx;
  emitRegGet16(b, 2);
  b.call(ctx.portInIdx);
  emitReg8Set(b, 0);
  return 0;
}

/** Emit OUT imm8, AL (0xE6) */
export function emitOUT_imm8_AL(ctx: CodegenCtx, pos: number): number {
  const { b, mem } = ctx;
  const port = mem.readU8(pos);
  b.constI32(port);
  emitReg8Get(b, 0);
  b.call(ctx.portOutIdx);
  return 1;
}

/** Emit OUT DX, AL (0xEE) */
export function emitOUT_DX_AL(ctx: CodegenCtx): number {
  const { b } = ctx;
  emitRegGet16(b, 2);
  emitReg8Get(b, 0);
  b.call(ctx.portOutIdx);
  return 0;
}
