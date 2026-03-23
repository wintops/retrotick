/**
 * WASM codegen for x86 lazy flag operations.
 *
 * Stores lazyOp/lazyResult/lazyA/lazyB to the shared memory CPU state area.
 * Also implements CMP+Jcc fusion for zero-overhead conditional branches.
 */

import type { WasmBuilder, Label } from './wasm-builder';
import { OFF_FLAGS } from './flat-memory';

// LazyOp values (must match lazy-op.ts enum)
export const LOP_NONE = 0;
export const LOP_ADD8 = 1, LOP_ADD16 = 2, LOP_ADD32 = 3;
export const LOP_SUB8 = 4, LOP_SUB16 = 5, LOP_SUB32 = 6;
export const LOP_AND8 = 7, LOP_AND16 = 8, LOP_AND32 = 9;
export const LOP_XOR8 = 13, LOP_XOR16 = 14, LOP_XOR32 = 15;
export const LOP_INC8 = 16, LOP_INC16 = 17, LOP_INC32 = 18;
export const LOP_DEC8 = 19, LOP_DEC16 = 20, LOP_DEC32 = 21;
export const LOP_SHL8 = 22, LOP_SHL16 = 23, LOP_SHL32 = 24;
export const LOP_SHR8 = 25, LOP_SHR16 = 26, LOP_SHR32 = 27;
export const LOP_SAR8 = 28, LOP_SAR16 = 29, LOP_SAR32 = 30;

/** Emit code to store lazy flag state to shared memory */
export function emitSetLazyFlags(
  b: WasmBuilder, lazyOp: number, resultLocal: number, aLocal: number, bLocal: number
): void {
  // lazyOp
  b.constI32(0); b.constI32(lazyOp); b.storeI32(OFF_FLAGS);
  // lazyResult
  b.constI32(0); b.getLocal(resultLocal); b.storeI32(OFF_FLAGS + 4);
  // lazyA
  b.constI32(0); b.getLocal(aLocal); b.storeI32(OFF_FLAGS + 8);
  // lazyB
  b.constI32(0); b.getLocal(bLocal); b.storeI32(OFF_FLAGS + 12);
  // flagsValid = false
  b.constI32(0); b.constI32(0); b.storeI32(OFF_FLAGS + 20);
}

/** Emit: store immediate values for lazy flags (no locals needed for A/B) */
export function emitSetLazyFlagsImm(
  b: WasmBuilder, lazyOp: number, resultLocal: number, aImm: number, bImm: number
): void {
  b.constI32(0); b.constI32(lazyOp); b.storeI32(OFF_FLAGS);
  b.constI32(0); b.getLocal(resultLocal); b.storeI32(OFF_FLAGS + 4);
  b.constI32(0); b.constI32(aImm); b.storeI32(OFF_FLAGS + 8);
  b.constI32(0); b.constI32(bImm); b.storeI32(OFF_FLAGS + 12);
  b.constI32(0); b.constI32(0); b.storeI32(OFF_FLAGS + 20);
}

/** Emit: store lazyResult from stack top + lazyA from local, lazyB immediate */
export function emitSetLazyFlagsResultOnStack(
  b: WasmBuilder, lazyOp: number, resultTmp: number, aLocal: number, bImm: number
): void {
  // result is on WASM stack — tee into temp, then store all fields
  b.teeLocal(resultTmp);
  b.drop(); // clear stack (we saved it in resultTmp)
  b.constI32(0); b.constI32(lazyOp); b.storeI32(OFF_FLAGS);
  b.constI32(0); b.getLocal(resultTmp); b.storeI32(OFF_FLAGS + 4);
  b.constI32(0); b.getLocal(aLocal); b.storeI32(OFF_FLAGS + 8);
  b.constI32(0); b.constI32(bImm); b.storeI32(OFF_FLAGS + 12);
  b.constI32(0); b.constI32(0); b.storeI32(OFF_FLAGS + 20);
}

/**
 * Emit a fused CMP+Jcc or TEST+Jcc pattern.
 * Instead of storing flags and calling testCC, directly inline the comparison.
 *
 * @param cc - x86 condition code (0-F)
 * @param lastOp - the ALU operation that set flags ('sub8'|'sub16'|'sub32'|'and8'|'and16'|'and32')
 * @param resultLocal - local holding the result of the ALU op
 * @param aLocal - local holding operand A
 * @param bLocal - local holding operand B (or -1 if B is immediate)
 * @param bImm - immediate B value (used if bLocal === -1)
 * @param dispatchLabel - label for br to loop dispatch
 * @param stateLocal - local holding the br_table state
 * @param targetState - state index for the taken branch
 */
export function emitFusedJcc(
  b: WasmBuilder, cc: number, lastOp: string,
  resultLocal: number, aLocal: number, bLocal: number, bImm: number,
  dispatchLabel: Label, stateLocal: number, targetState: number
): void {
  // For SUB-based ops (CMP), we can fuse common conditions
  // For AND-based ops (TEST), result is already the AND value
  const isSub = lastOp.startsWith('sub');
  const mask = lastOp.endsWith('8') ? 0xFF : lastOp.endsWith('16') ? 0xFFFF : 0xFFFFFFFF;

  switch (cc) {
    case 0x04: // JE/JZ: ZF=1 -> result == 0
      b.getLocal(resultLocal);
      if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
      b.eqzI32();
      break;
    case 0x05: // JNE/JNZ: ZF=0 -> result != 0
      b.getLocal(resultLocal);
      if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
      b.constI32(0); b.neI32();
      break;
    case 0x0C: // JL/JNGE: SF!=OF
      if (isSub) {
        b.getLocal(aLocal);
        if (bLocal >= 0) b.getLocal(bLocal); else b.constI32(bImm);
        b.ltSI32();
      } else {
        // Fallback: call testCC
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x0D: // JGE/JNL: SF==OF
      if (isSub) {
        b.getLocal(aLocal);
        if (bLocal >= 0) b.getLocal(bLocal); else b.constI32(bImm);
        b.geSI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x0E: // JLE/JNG: ZF=1 or SF!=OF
      if (isSub) {
        b.getLocal(aLocal);
        if (bLocal >= 0) b.getLocal(bLocal); else b.constI32(bImm);
        b.leSI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x0F: // JG/JNLE: ZF=0 and SF==OF
      if (isSub) {
        b.getLocal(aLocal);
        if (bLocal >= 0) b.getLocal(bLocal); else b.constI32(bImm);
        b.gtSI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x02: // JB/JNAE/JC: CF=1
      if (isSub) {
        b.getLocal(aLocal);
        if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
        if (bLocal >= 0) { b.getLocal(bLocal); if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); } }
        else b.constI32(bImm & mask);
        b.ltUI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x03: // JAE/JNB/JNC: CF=0
      if (isSub) {
        b.getLocal(aLocal);
        if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
        if (bLocal >= 0) { b.getLocal(bLocal); if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); } }
        else b.constI32(bImm & mask);
        b.geUI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x06: // JBE/JNA: CF=1 or ZF=1
      if (isSub) {
        b.getLocal(aLocal);
        if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
        if (bLocal >= 0) { b.getLocal(bLocal); if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); } }
        else b.constI32(bImm & mask);
        b.leUI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x07: // JA/JNBE: CF=0 and ZF=0
      if (isSub) {
        b.getLocal(aLocal);
        if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); }
        if (bLocal >= 0) { b.getLocal(bLocal); if (mask !== 0xFFFFFFFF) { b.constI32(mask); b.andI32(); } }
        else b.constI32(bImm & mask);
        b.gtUI32();
      } else {
        emitTestCCFallback(b, cc);
      }
      break;
    case 0x08: // JS: SF=1 -> result has sign bit set
      b.getLocal(resultLocal);
      if (mask === 0xFF) { b.constI32(0x80); b.andI32(); }
      else if (mask === 0xFFFF) { b.constI32(0x8000); b.andI32(); }
      else { b.constI32(0); b.ltSI32(); break; }
      b.constI32(0); b.neI32();
      break;
    case 0x09: // JNS: SF=0
      b.getLocal(resultLocal);
      if (mask === 0xFF) { b.constI32(0x80); b.andI32(); b.eqzI32(); }
      else if (mask === 0xFFFF) { b.constI32(0x8000); b.andI32(); b.eqzI32(); }
      else { b.constI32(0); b.geSI32(); }
      break;
    default:
      // Unsupported CC — fallback to imported testCC
      emitTestCCFallback(b, cc);
      break;
  }

  // Now stack has i32 condition. Branch if true.
  b.ifVoid();
    b.constI32(targetState); b.setLocal(stateLocal);
    b.br(dispatchLabel);
  b.end();
}

/** Fallback: call imported testCC(cc) function */
function emitTestCCFallback(b: WasmBuilder, cc: number): void {
  b.constI32(cc);
  b.call(0); // assume testCC is import index 0 — will be set during module assembly
}
