/**
 * Flat memory buffer for WASM JIT — bridges RetroTick's sparse Memory
 * segments with a contiguous WebAssembly.Memory for direct i32.load/store.
 *
 * Layout (128 MB total):
 *   0x00000000 - 0x07FFFFFF:  Emulated address space (128 MB)
 *   0x08000000 - 0x0800001F:  CPU registers (8 x i32)
 *   0x08000020 - 0x08000037:  Lazy flags (6 x i32)
 *   0x08000038 - 0x08000047:  Segment bases (4 x i32)
 *   0x08000048 - 0x08000053:  Control (EIP + exit_reason + entry + counter)
 */

import type { Memory } from '../memory';
import type { CPU } from './cpu';

const FLAT_PAGES = 2049;           // 128 MB + 64KB for CPU state area
const SEG_SIZE = 65536;            // 64KB per segment

// CPU state offsets in flat buffer
export const OFF_REGS     = 0x08000000;  // 8 x i32 (EAX..EDI)
export const OFF_FLAGS    = 0x08000020;  // lazyOp, lazyResult, lazyA, lazyB, flagsCache, flagsValid
export const OFF_SEGBASES = 0x08000038;  // CS_base, DS_base, ES_base, SS_base
export const OFF_EIP      = 0x08000048;
export const OFF_EXIT     = 0x0800004C;
export const OFF_ENTRY    = 0x08000050; // br_table entry state index
export const OFF_COUNTER  = 0x08000054; // instruction counter (written by WASM on exit)

export class FlatMemory {
  readonly wasmMemory: WebAssembly.Memory;
  readonly buffer: ArrayBuffer;
  readonly u8: Uint8Array;
  readonly dv: DataView;

  constructor() {
    this.wasmMemory = new WebAssembly.Memory({ initial: FLAT_PAGES });
    this.buffer = this.wasmMemory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.dv = new DataView(this.buffer);
  }

  /** Copy all allocated sparse segments into the flat buffer */
  syncToFlat(memory: Memory): void {
    for (const key of memory.getSegmentKeys()) {
      const seg = memory.getSegment(key);
      if (!seg) continue;
      const offset = key * SEG_SIZE;
      if (offset + SEG_SIZE > OFF_REGS) continue; // don't overwrite CPU state area
      this.u8.set(seg, offset);
    }
  }

  /** Copy flat buffer back to sparse segments (only segments that exist) */
  syncFromFlat(memory: Memory): void {
    for (const key of memory.getSegmentKeys()) {
      const seg = memory.getSegment(key);
      if (!seg) continue;
      const offset = key * SEG_SIZE;
      if (offset + SEG_SIZE > OFF_REGS) continue;
      seg.set(this.u8.subarray(offset, offset + SEG_SIZE));
    }
  }

  /** Write CPU registers from CPU to flat buffer */
  writeRegs(cpu: CPU): void {
    const dv = this.dv;
    for (let i = 0; i < 8; i++) {
      dv.setInt32(OFF_REGS + i * 4, cpu.reg[i], true);
    }
  }

  /** Read CPU registers from flat buffer back to CPU */
  readRegs(cpu: CPU): void {
    const dv = this.dv;
    for (let i = 0; i < 8; i++) {
      cpu.reg[i] = dv.getInt32(OFF_REGS + i * 4, true);
    }
  }

  /** Write lazy flags from CPU to flat buffer */
  writeFlags(cpu: CPU): void {
    const dv = this.dv;
    dv.setInt32(OFF_FLAGS + 0, cpu.lazyOp, true);
    dv.setInt32(OFF_FLAGS + 4, cpu.lazyResult, true);
    dv.setInt32(OFF_FLAGS + 8, cpu.lazyA, true);
    dv.setInt32(OFF_FLAGS + 12, cpu.lazyB, true);
    dv.setInt32(OFF_FLAGS + 16, cpu.flagsCache, true);
    dv.setInt32(OFF_FLAGS + 20, cpu.flagsValid ? 1 : 0, true);
  }

  /** Read lazy flags from flat buffer back to CPU */
  readFlags(cpu: CPU): void {
    const dv = this.dv;
    cpu.lazyOp = dv.getInt32(OFF_FLAGS + 0, true);
    cpu.lazyResult = dv.getInt32(OFF_FLAGS + 4, true);
    cpu.lazyA = dv.getInt32(OFF_FLAGS + 8, true);
    cpu.lazyB = dv.getInt32(OFF_FLAGS + 12, true);
    cpu.flagsCache = dv.getInt32(OFF_FLAGS + 16, true);
    cpu.flagsValid = dv.getInt32(OFF_FLAGS + 20, true) !== 0;
  }

  /** Write segment bases from CPU to flat buffer */
  writeSegBases(cpu: CPU): void {
    const dv = this.dv;
    dv.setUint32(OFF_SEGBASES + 0, cpu.segBase(cpu.cs) >>> 0, true);
    dv.setUint32(OFF_SEGBASES + 4, cpu.segBase(cpu.ds) >>> 0, true);
    dv.setUint32(OFF_SEGBASES + 8, cpu.segBase(cpu.es) >>> 0, true);
    dv.setUint32(OFF_SEGBASES + 12, cpu.segBase(cpu.ss) >>> 0, true);
  }

  /** Write EIP to flat buffer */
  writeEip(eip: number): void {
    this.dv.setUint32(OFF_EIP, eip >>> 0, true);
  }

  /** Read EIP from flat buffer */
  readEip(): number {
    return this.dv.getUint32(OFF_EIP, true);
  }

  /** Read exit reason from flat buffer */
  readExitReason(): number {
    return this.dv.getInt32(OFF_EXIT, true);
  }

  /** Read instruction counter written by WASM on exit */
  readCounter(): number {
    return this.dv.getInt32(OFF_COUNTER, true);
  }
}
