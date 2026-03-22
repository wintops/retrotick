import { Memory } from '../memory';
import { materializeFlags } from './flags';
import { decodeModRM as _decodeModRM, decodeSIB as _decodeSIB, getSegOverrideSel as _getSegOverrideSel, decodeModRM16 as _decodeModRM16, writeModRM as _writeModRM, decodeFPUModRM as _decodeFPUModRM } from './decode';
import { cpuStep } from './dispatch';
import { LazyOp } from './lazy-op';
import type { Emulator } from '../emulator';

// Register indices
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// Flag bits
const CF = 0x001;
const PF = 0x004;
const ZF = 0x040;
const SF = 0x080;
const TF = 0x100;
const DF = 0x400;
const OF = 0x800;

export class CPU {
  mem: Memory;
  reg = new Int32Array(8);
  eip = 0;

  // Lazy flag evaluation state
  lazyOp = LazyOp.NONE;
  lazyResult = 0;
  lazyA = 0;
  lazyB = 0;
  flagsCache = 0x0202; // bit 1 always set, IF=1 (interrupts enabled)
  flagsValid = true;

  // SSE/SSE2 XMM registers (8 x 128-bit, stored as pairs of Float64)
  xmmF64 = new Float64Array(16);  // xmm0..xmm7 as 2 doubles each
  xmmI32 = new Int32Array(this.xmmF64.buffer); // alias as 32 int32s (4 per xmm)

  // x87 FPU state (public for cpu-fpu.ts extraction)
  fpuStack = new Float64Array(8);
  fpuTop = 0;     // stack top pointer (0-7)
  fpuCW = 0x037F; // control word: all exceptions masked, double precision, round to nearest
  fpuSW = 0;      // status word
  fpuTW = 0xFFFF; // tag word: all empty
  // Raw 64-bit integer storage for FILD/FISTP QWORD precision preservation.
  // JS doubles only have 53-bit mantissa; 64-bit integers >2^53 lose precision.
  // When FILD QWORD loads a value, the exact BigInt is stored here.
  // FISTP QWORD uses this if available, bypassing double conversion.
  // Cleared by any arithmetic FPU operation that modifies the slot.
  fpuI64: (bigint | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  // Raw 64-bit double storage for FLD/FSTP QWORD NaN bit pattern preservation.
  // JS Float64Array canonicalizes NaN payloads (all NaN → 0x7FF8000000000000).
  // For memory copy via FPU (FLD m64/FSTP m64), store raw lo/hi U32 pair.
  fpuRaw64: ([number, number] | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];
  // Raw 80-bit (10-byte) storage for FLD/FSTP TBYTE (m80real) precision preservation.
  // 80-bit extended has 64-bit mantissa; JS double has only 53. Round-trip loses 11 bits.
  fpuRaw80: ([number, number, number] | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];

  // Halt / thunk state
  halted = false;
  haltReason = '';
  thunkHit = false; // set when EIP is in thunk range

  // Segment base for FS register (points to TEB)
  fsBase = 0;
  // Per-instruction segment override flag (set during prefix parsing, cleared after instruction)
  _segOverride = 0; // 0 = none, 0x64 = FS, 0x26=ES, 0x2E=CS, 0x36=SS, 0x3E=DS

  // Back-reference to emulator (set during load, used for DOS INT handling)
  emu: Emulator | null = null;

  // Real mode: segment * 16 = linear (no lookup table needed)
  realMode = false;

  // 16-bit (NE) mode support
  use32 = true; // false for NE executables
  cs = 0; // code segment selector
  ds = 0; // data segment selector
  es = 0; // extra segment selector
  ss = 0; // stack segment selector
  segBases: Map<number, number> = new Map<number, number>(); // selector → linear base address
  _addrSize16 = false; // true when current instruction uses 16-bit addressing
  _inhibitTF = false;  // true after INT/IRET/MOV SS/POP SS (suppresses TF trap)

  constructor(mem: Memory) {
    this.mem = mem;
  }

  fs = 0; // FS segment selector
  gs = 0; // GS segment selector

  /** Load CS and update use32/_addrSize16 from GDT descriptor in protected mode */
  loadCS(selector: number): void {
    this.cs = selector;
    if (!this.realMode) {
      const is32 = this.loadGdtDescriptorIs32(selector);
      this.use32 = is32;
      this._addrSize16 = !is32;
    }
  }

  /** Get linear base address for a segment selector */
  segBase(sel: number): number {
    if (this.realMode) return (sel * 16) >>> 0;
    const cached = this.segBases.get(sel);
    if (cached !== undefined) return cached;
    // LDT-style selector: strip RPL/TI bits (low 3 bits = __AHSHIFT)
    // to find the canonical selector assigned by the NE loader
    const canonical = sel >>> 3;
    if (canonical > 0) {
      const cbase = this.segBases.get(canonical);
      if (cbase !== undefined) return cbase;
    }
    // Look up in GDT if available
    const base = this.loadGdtDescriptorBase(sel);
    if (base !== undefined) {
      this.segBases.set(sel, base);
      return base;
    }
    return 0;
  }

  /** Read a GDT descriptor and return the base address */
  loadGdtDescriptorBase(sel: number): number | undefined {
    if (!this.emu || !this.emu._gdtBase) return undefined;
    const index = (sel & 0xFFF8) >>> 3; // selector index (ignore RPL and TI)
    if (index === 0) return 0; // null selector
    const descAddr = this.emu._gdtBase + index * 8;
    if (index * 8 + 7 > this.emu._gdtLimit) return undefined;
    const lo = this.mem.readU32(descAddr);
    const hi = this.mem.readU32(descAddr + 4);
    // Base: bits 31:24 of hi, bits 7:0 of hi, bits 31:16 of lo
    const baseLo = (lo >>> 16) & 0xFFFF;
    const baseMid = hi & 0xFF;
    const baseHi = (hi >>> 24) & 0xFF;
    return (baseHi << 24) | (baseMid << 16) | baseLo;
  }

  /** Read a GDT descriptor and return whether it's a 32-bit segment */
  loadGdtDescriptorIs32(sel: number): boolean {
    if (!this.emu || !this.emu._gdtBase) return false;
    const index = (sel & 0xFFF8) >>> 3;
    if (index === 0) return false;
    const descAddr = this.emu._gdtBase + index * 8;
    if (index * 8 + 7 > this.emu._gdtLimit) return false;
    const hi = this.mem.readU32(descAddr + 4);
    // D/B bit is bit 22 of hi dword
    return (hi & (1 << 22)) !== 0;
  }

  // Register accessors for 8/16 bit subregisters
  getReg8(idx: number): number {
    // idx 0-3: AL,CL,DL,BL; 4-7: AH,CH,DH,BH
    if (idx < 4) return this.reg[idx] & 0xFF;
    return (this.reg[idx - 4] >> 8) & 0xFF;
  }

  setReg8(idx: number, val: number): void {
    val &= 0xFF;
    if (idx < 4) {
      this.reg[idx] = (this.reg[idx] & ~0xFF) | val;
    } else {
      const r = idx - 4;
      this.reg[r] = (this.reg[r] & ~0xFF00) | (val << 8);
    }
  }

  getReg16(idx: number): number {
    return this.reg[idx] & 0xFFFF;
  }

  setReg16(idx: number, val: number): void {
    this.reg[idx] = (this.reg[idx] & ~0xFFFF) | (val & 0xFFFF);
  }

  // EFLAGS
  materializeFlags(): void {
    materializeFlags(this);
  }

  getFlags(): number {
    if (!this.flagsValid) materializeFlags(this);
    return this.flagsCache;
  }

  setFlags(f: number): void {
    this.flagsCache = f | 0x0002;
    this.flagsValid = true;
    this.lazyOp = LazyOp.NONE;
  }

  getFlag(bit: number): boolean {
    if (bit === DF) return !!(this.flagsCache & DF);
    if (!this.flagsValid) materializeFlags(this);
    return !!(this.flagsCache & bit);
  }

  setFlag(bit: number, val: boolean): void {
    if (!this.flagsValid) materializeFlags(this);
    if (val) this.flagsCache |= bit;
    else this.flagsCache &= ~bit;
  }

  setLazy(op: number, result: number, a: number, b: number): void {
    this.lazyOp = op;
    this.lazyResult = result;
    this.lazyA = a;
    this.lazyB = b;
    this.flagsValid = false;
  }

  // Push / Pop — in 16-bit mode, use SS:SP with 16-bit wrap
  push32(val: number): void {
    if (!this.use32) {
      const base = this.segBase(this.ss);
      let sp = (this.reg[ESP] - 4) & 0xFFFF;
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | sp;
      this.mem.writeU32((base + sp) >>> 0, val >>> 0);
    } else {
      this.reg[ESP] = (this.reg[ESP] - 4) | 0;
      this.mem.writeU32(this.reg[ESP] >>> 0, val >>> 0);
    }
  }

  pop32(): number {
    if (!this.use32) {
      const base = this.segBase(this.ss);
      const sp = this.reg[ESP] & 0xFFFF;
      const val = this.mem.readU32((base + sp) >>> 0);
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | ((sp + 4) & 0xFFFF);
      return val;
    } else {
      const val = this.mem.readU32(this.reg[ESP] >>> 0);
      this.reg[ESP] = (this.reg[ESP] + 4) | 0;
      return val;
    }
  }

  push16(val: number): void {
    if (!this.use32) {
      const base = this.segBase(this.ss);
      let sp = (this.reg[ESP] - 2) & 0xFFFF;
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | sp;
      this.mem.writeU16((base + sp) >>> 0, val & 0xFFFF);
    } else {
      this.reg[ESP] = (this.reg[ESP] - 2) | 0;
      this.mem.writeU16(this.reg[ESP] >>> 0, val & 0xFFFF);
    }
  }

  pop16(): number {
    if (!this.use32) {
      const base = this.segBase(this.ss);
      const sp = this.reg[ESP] & 0xFFFF;
      const val = this.mem.readU16((base + sp) >>> 0);
      this.reg[ESP] = (this.reg[ESP] & ~0xFFFF) | ((sp + 2) & 0xFFFF);
      return val;
    } else {
      const val = this.mem.readU16(this.reg[ESP] >>> 0);
      this.reg[ESP] = (this.reg[ESP] + 2) | 0;
      return val;
    }
  }

  // Fetch instruction byte
  fetch8(): number {
    const v = this.mem.readU8(this.eip >>> 0);
    this.eip = (this.eip + 1) | 0;
    return v;
  }

  fetch16(): number {
    const v = this.mem.readU16(this.eip >>> 0);
    this.eip = (this.eip + 2) | 0;
    return v;
  }

  fetch32(): number {
    const v = this.mem.readU32(this.eip >>> 0);
    this.eip = (this.eip + 4) | 0;
    return v;
  }

  fetchI8(): number {
    const v = this.mem.readI8(this.eip >>> 0);
    this.eip = (this.eip + 1) | 0;
    return v;
  }

  fetchI32(): number {
    const v = this.mem.readI32(this.eip >>> 0);
    this.eip = (this.eip + 4) | 0;
    return v;
  }

  // ModRM/SIB decoding — delegated to cpu-decode.ts
  decodeModRM(sizeBits: number): { isReg: boolean; regField: number; val: number; addr: number } {
    return _decodeModRM(this, sizeBits);
  }

  decodeSIB(mod: number): { addr: number; bpBase: boolean } {
    return _decodeSIB(this, mod);
  }

  getSegOverrideSel(): number {
    return _getSegOverrideSel(this);
  }

  decodeModRM16(sizeBits: number): { isReg: boolean; regField: number; val: number; addr: number } {
    return _decodeModRM16(this, sizeBits);
  }

  writeModRM(decoded: { isReg: boolean; addr: number }, val: number, sizeBits: number): void {
    _writeModRM(this, decoded, val, sizeBits);
  }

  decodeFPUModRM(): { mod: number; regField: number; rm: number; addr: number } {
    return _decodeFPUModRM(this);
  }

  // ALU helpers
  alu(op: number, a: number, b: number, size: 8 | 16 | 32): number {
    let result: number;
    const addOp = size === 8 ? LazyOp.ADD8 : size === 16 ? LazyOp.ADD16 : LazyOp.ADD32;
    const subOp = size === 8 ? LazyOp.SUB8 : size === 16 ? LazyOp.SUB16 : LazyOp.SUB32;

    switch (op) {
      case 0: // ADD
        result = (a + b) | 0;
        this.setLazy(addOp, result, a, b);
        return result;
      case 1: // OR
        result = a | b;
        this.setLazy(size === 8 ? LazyOp.OR8 : size === 16 ? LazyOp.OR16 : LazyOp.OR32, result, a, b);
        return result;
      case 2: { // ADC
        const cf = this.getFlag(CF) ? 1 : 0;
        result = (a + b + cf) | 0;
        // Store unsigned b + cf to avoid signed overflow losing carry info
        this.setLazy(addOp, result, a, (b >>> 0) + cf);
        return result;
      }
      case 3: { // SBB
        const cf = this.getFlag(CF) ? 1 : 0;
        result = (a - b - cf) | 0;
        // Store unsigned b + cf to avoid signed overflow losing borrow info
        this.setLazy(subOp, result, a, (b >>> 0) + cf);
        return result;
      }
      case 4: // AND
        result = a & b;
        this.setLazy(size === 8 ? LazyOp.AND8 : size === 16 ? LazyOp.AND16 : LazyOp.AND32, result, a, b);
        return result;
      case 5: // SUB
        result = (a - b) | 0;
        this.setLazy(subOp, result, a, b);
        return result;
      case 6: // XOR
        result = a ^ b;
        this.setLazy(size === 8 ? LazyOp.XOR8 : size === 16 ? LazyOp.XOR16 : LazyOp.XOR32, result, a, b);
        return result;
      case 7: // CMP
        result = (a - b) | 0;
        this.setLazy(subOp, result, a, b);
        return a; // CMP doesn't store result
      default:
        return a;
    }
  }

  // Condition code evaluation
  testCC(cc: number): boolean {
    switch (cc) {
      case 0x0: return this.getFlag(OF);
      case 0x1: return !this.getFlag(OF);
      case 0x2: return this.getFlag(CF);
      case 0x3: return !this.getFlag(CF);
      case 0x4: return this.getFlag(ZF);
      case 0x5: return !this.getFlag(ZF);
      case 0x6: return this.getFlag(CF) || this.getFlag(ZF);
      case 0x7: return !this.getFlag(CF) && !this.getFlag(ZF);
      case 0x8: return this.getFlag(SF);
      case 0x9: return !this.getFlag(SF);
      case 0xA: return this.getFlag(PF);
      case 0xB: return !this.getFlag(PF);
      case 0xC: return this.getFlag(SF) !== this.getFlag(OF);
      case 0xD: return this.getFlag(SF) === this.getFlag(OF);
      case 0xE: return this.getFlag(ZF) || (this.getFlag(SF) !== this.getFlag(OF));
      case 0xF: return !this.getFlag(ZF) && (this.getFlag(SF) === this.getFlag(OF));
      default: return false;
    }
  }

  // Execute one instruction — delegated to cpu-step.ts
  step(): void {
    // Check if TF was set BEFORE this instruction (single-step trap fires after)
    const tfBefore = this.getFlags() & TF;
    this._inhibitTF = false;
    cpuStep(this);
    // If TF was set before the instruction, fire INT 1 (single-step exception)
    // Intel: no trap after INT/IRET/MOV SS/POP SS instructions
    if (tfBefore && !this._inhibitTF && !this.halted && this.emu) {
      // Clear TF before firing INT 1 (processor clears it on interrupt entry)
      const flags = this.getFlags();
      this.setFlags(flags & ~TF);
      // Push flags (with TF still set, as saved), CS, IP — then jump to INT 1 handler
      if (!this.use32) {
        this.push16(flags);
        this.push16(this.cs);
        this.push16((this.eip - this.segBase(this.cs)) & 0xFFFF);
        // Look up INT 1 vector from IVT
        const vec = this.mem.readU32(1 * 4);
        const newIP = vec & 0xFFFF;
        const newCS = (vec >>> 16) & 0xFFFF;
        this.cs = newCS;
        this.eip = this.segBase(newCS) + newIP;
      }
    }
  }
}
