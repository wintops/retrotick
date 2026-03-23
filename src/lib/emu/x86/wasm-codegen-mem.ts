/**
 * WASM codegen for memory access — handles direct loads/stores to flat memory
 * with VGA range interception via imported functions.
 */

import type { WasmBuilder } from './wasm-builder';
import { OFF_SEGBASES } from './flat-memory';

/**
 * Emit code to compute a linear address from segment base + offset.
 * The offset should already be on the WASM stack.
 * For PMODE/W flat model (base=0), this is a no-op.
 *
 * @param segBaseOffset - offset within the CPU state for the segment base
 *   DS=OFF_SEGBASES+4, ES=OFF_SEGBASES+8, SS=OFF_SEGBASES+12, CS=OFF_SEGBASES+0
 */
export function emitAddSegBase(b: WasmBuilder, segBaseOffset: number): void {
  // Load segment base from CPU state area and add to offset on stack
  b.constI32(0);
  b.loadI32(segBaseOffset);
  b.addI32();
}

/** Emit: load i32 from flat memory at address on stack */
export function emitLoadI32(b: WasmBuilder): void {
  b.loadI32Unaligned(0);
}

/** Emit: load u16 from flat memory at address on stack */
export function emitLoadU16(b: WasmBuilder): void {
  b.loadU16(0);
}

/** Emit: load u8 from flat memory at address on stack */
export function emitLoadU8(b: WasmBuilder): void {
  b.loadU8(0);
}

/** Emit: load s8 from flat memory at address on stack */
export function emitLoadS8(b: WasmBuilder): void {
  b.loadS8(0);
}

/** Emit: load s16 from flat memory at address on stack */
export function emitLoadS16(b: WasmBuilder): void {
  b.loadS16(0);
}

/**
 * Emit: store u8 to flat memory with VGA check.
 * Stack: [addr, value]
 * If addr is in VGA range (0xA0000-0xAFFFF), calls imported writeVGA.
 * Otherwise, direct i32.store8.
 *
 * @param writeVGAIdx - import index for writeVGA(addr, val) function
 * @param addrLocal - temp local to hold address
 * @param valLocal - temp local to hold value
 */
export function emitStoreU8WithVGA(
  b: WasmBuilder, writeVGAIdx: number, addrLocal: number, valLocal: number
): void {
  // Save addr and val from stack
  b.setLocal(valLocal);
  b.teeLocal(addrLocal);
  // Check if in VGA range: (addr >>> 16) === 0xA
  b.constI32(16); b.shrUI32();
  b.constI32(0xA); b.eqI32();
  b.ifVoid();
    // VGA path: call imported function
    b.getLocal(addrLocal);
    b.getLocal(valLocal);
    b.call(writeVGAIdx);
  b.elseBlock();
    // Direct write
    b.getLocal(addrLocal);
    b.getLocal(valLocal);
    b.storeU8(0);
  b.end();
}

/** Emit: store u8 directly (known non-VGA address) */
export function emitStoreU8Direct(b: WasmBuilder): void {
  // Stack: [addr, value]
  b.storeU8(0);
}

/**
 * Emit: store u16 with VGA check.
 * Stack: [addr, value]
 */
export function emitStoreU16WithVGA(
  b: WasmBuilder, writeVGAIdx: number, addrLocal: number, valLocal: number
): void {
  b.setLocal(valLocal);
  b.teeLocal(addrLocal);
  b.constI32(16); b.shrUI32();
  b.constI32(0xA); b.eqI32();
  b.ifVoid();
    // VGA: write two bytes via imported function
    b.getLocal(addrLocal);
    b.getLocal(valLocal);
    b.constI32(0xFF); b.andI32();
    b.call(writeVGAIdx);
    b.getLocal(addrLocal); b.constI32(1); b.addI32();
    b.getLocal(valLocal);
    b.constI32(8); b.shrUI32();
    b.constI32(0xFF); b.andI32();
    b.call(writeVGAIdx);
  b.elseBlock();
    b.getLocal(addrLocal);
    b.getLocal(valLocal);
    b.storeU16(0);
  b.end();
}

/**
 * Emit: store i32 with VGA check.
 * Stack: [addr, value]
 */
export function emitStoreI32WithVGA(
  b: WasmBuilder, writeVGAIdx: number, addrLocal: number, valLocal: number
): void {
  b.setLocal(valLocal);
  b.teeLocal(addrLocal);
  b.constI32(16); b.shrUI32();
  b.constI32(0xA); b.eqI32();
  b.ifVoid();
    // VGA: write four bytes via imported function
    for (let i = 0; i < 4; i++) {
      b.getLocal(addrLocal);
      if (i > 0) { b.constI32(i); b.addI32(); }
      b.getLocal(valLocal);
      if (i > 0) { b.constI32(i * 8); b.shrUI32(); }
      b.constI32(0xFF); b.andI32();
      b.call(writeVGAIdx);
    }
  b.elseBlock();
    b.getLocal(addrLocal);
    b.getLocal(valLocal);
    b.storeI32Unaligned(0);
  b.end();
}

/** Result of ModRM decode at compile time */
export interface ModRMDecoded {
  isReg: boolean;   // mod=3 (register operand)
  reg: number;      // register field (bits 5-3)
  rm: number;       // rm field (bits 2-0)
  extraBytes: number; // bytes consumed (ModRM + SIB + displacement)
}

/**
 * Decode ModRM at compile time and emit WASM address computation.
 * For register operands (mod=3), no WASM is emitted.
 * For memory operands, pushes the linear address onto the WASM stack.
 */
export function emitModRM32Addr(
  b: WasmBuilder, modrm: number, mem: any, pos: number
): ModRMDecoded {
  const mod = (modrm >> 6) & 3;
  const reg = (modrm >> 3) & 7;
  const rm = modrm & 7;

  if (mod === 3) return { isReg: true, reg, rm, extraBytes: 1 };

  let extra = 1; // ModRM byte itself

  if (rm === 4) {
    // SIB byte
    const sib = mem.readU8(pos + extra);
    extra++;
    const scale = (sib >> 6) & 3;
    const index = (sib >> 3) & 7;
    const base = sib & 7;

    // Base
    if (base === 5 && mod === 0) {
      // [disp32 + scaled index]
      const disp = mem.readU32(pos + extra) | 0; extra += 4;
      b.constI32(disp);
    } else {
      b.getLocal(base);
    }

    // Index (ESP=4 means no index)
    if (index !== 4) {
      b.getLocal(index);
      if (scale > 0) { b.constI32(scale); b.shlI32(); }
      b.addI32();
    }

    // Displacement
    if (mod === 1) { let d = mem.readU8(pos + extra); if (d > 127) d -= 256; extra++; if (d) { b.constI32(d); b.addI32(); } }
    else if (mod === 2) { const d = mem.readU32(pos + extra) | 0; extra += 4; if (d) { b.constI32(d); b.addI32(); } }
  } else if (rm === 5 && mod === 0) {
    // [disp32]
    const disp = mem.readU32(pos + extra) | 0; extra += 4;
    b.constI32(disp);
  } else {
    // [reg + disp]
    b.getLocal(rm);
    if (mod === 1) { let d = mem.readU8(pos + extra); if (d > 127) d -= 256; extra++; if (d) { b.constI32(d); b.addI32(); } }
    else if (mod === 2) { const d = mem.readU32(pos + extra) | 0; extra += 4; if (d) { b.constI32(d); b.addI32(); } }
  }

  return { isReg: false, reg, rm, extraBytes: extra };
}

/** Emit: store u16 directly (known non-VGA) */
export function emitStoreU16Direct(b: WasmBuilder): void { b.storeU16(0); }

/** Emit: store i32 directly (known non-VGA) */
export function emitStoreI32Direct(b: WasmBuilder): void { b.storeI32Unaligned(0); }

/**
 * Emit code to compute a 16-bit ModRM effective address in WASM.
 * Pushes the linear address (segment_base + effective_addr) onto the WASM stack.
 *
 * @param regLocals - array of 8 register locals [EAX..EDI]
 * @param modrm - ModRM byte
 * @param mem - Memory for reading displacement bytes
 * @param pos - position after ModRM byte in instruction stream
 * @param dsBase - offset for DS segment base in CPU state
 * @param ssBase - offset for SS segment base in CPU state
 * @returns number of extra bytes consumed (displacement)
 */
export function emitModRM16Addr(
  b: WasmBuilder, regLocals: number[], modrm: number, mem: any,
  pos: number, dsBase: number, ssBase: number
): number {
  const mod = (modrm >> 6) & 3;
  const rm = modrm & 7;
  let extraBytes = 0;

  // Use SS for BP-based, DS for others
  const useSS = rm === 2 || rm === 3 || (rm === 6 && mod !== 0);
  const segOff = useSS ? ssBase : dsBase;

  if (mod === 0 && rm === 6) {
    // [disp16]
    const disp = mem.readU16(pos);
    extraBytes = 2;
    b.constI32(disp);
  } else {
    // Base register(s)
    const addrParts: [number, number][] = [ // [regIdx, mask(always 0xFFFF)]
      [3, 6], [3, 7], [5, 6], [5, 7], // BX+SI, BX+DI, BP+SI, BP+DI
      [6, -1], [7, -1], [5, -1], [3, -1], // SI, DI, BP, BX
    ][rm] as any;

    // Emit base components
    if (rm <= 3) {
      // Two-register modes
      const [r1, r2] = [[3,6],[3,7],[5,6],[5,7]][rm];
      b.getLocal(regLocals[r1]); b.constI32(0xFFFF); b.andI32();
      b.getLocal(regLocals[r2]); b.constI32(0xFFFF); b.andI32();
      b.addI32();
    } else {
      const regIdx = [6, 7, 5, 3][rm - 4];
      b.getLocal(regLocals[regIdx]); b.constI32(0xFFFF); b.andI32();
    }

    // Add displacement
    if (mod === 1) {
      let disp = mem.readU8(pos); if (disp > 127) disp -= 256;
      extraBytes = 1;
      if (disp !== 0) { b.constI32(disp); b.addI32(); }
    } else if (mod === 2) {
      let disp = mem.readU16(pos); if (disp > 32767) disp -= 65536;
      extraBytes = 2;
      if (disp !== 0) { b.constI32(disp); b.addI32(); }
    }

    // Mask to 16-bit
    b.constI32(0xFFFF); b.andI32();
  }

  // Add segment base
  emitAddSegBase(b, segOff);

  return extraBytes;
}
