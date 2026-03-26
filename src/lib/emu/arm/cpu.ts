import { Memory } from '../memory';
import { armStep } from './dispatch';
import type { Emulator } from '../emulator';

// Register indices
export const R0 = 0, R1 = 1, R2 = 2, R3 = 3;
export const R4 = 4, R5 = 5, R6 = 6, R7 = 7;
export const R8 = 8, R9 = 9, R10 = 10, R11 = 11;
export const R12 = 12, SP = 13, LR = 14, PC = 15;

// CPSR flag bits
export const N_FLAG = 0x80000000;
export const Z_FLAG = 0x40000000;
export const C_FLAG = 0x20000000;
export const V_FLAG = 0x10000000;

export class ArmCPU {
  mem: Memory;
  reg = new Int32Array(16); // R0-R15 (R13=SP, R14=LR, R15=PC)
  cpsr = 0x10; // User mode, ARM state

  // Halt / thunk state
  halted = false;
  haltReason = '';
  thunkHit = false;

  // Back-reference to emulator
  emu: Emulator | null = null;

  // Alias for x86 compat in emulator (eip-like access)
  get eip(): number { return this.reg[PC] >>> 0; }
  set eip(v: number) { this.reg[PC] = v; }

  constructor(mem: Memory) {
    this.mem = mem;
  }

  // CPSR flag accessors
  getN(): boolean { return (this.cpsr & N_FLAG) !== 0; }
  getZ(): boolean { return (this.cpsr & Z_FLAG) !== 0; }
  getC(): boolean { return (this.cpsr & C_FLAG) !== 0; }
  getV(): boolean { return (this.cpsr & V_FLAG) !== 0; }

  setNZ(result: number): void {
    this.cpsr = (this.cpsr & ~(N_FLAG | Z_FLAG))
      | ((result & 0x80000000) ? N_FLAG : 0)
      | ((result === 0) ? Z_FLAG : 0);
  }

  setNZCV(result: number, carry: boolean, overflow: boolean): void {
    this.cpsr = (this.cpsr & ~(N_FLAG | Z_FLAG | C_FLAG | V_FLAG))
      | ((result & 0x80000000) ? N_FLAG : 0)
      | (((result & 0xFFFFFFFF) === 0) ? Z_FLAG : 0)
      | (carry ? C_FLAG : 0)
      | (overflow ? V_FLAG : 0);
  }

  /** Test ARM condition code (top 4 bits of instruction) */
  testCC(cond: number): boolean {
    switch (cond) {
      case 0x0: return this.getZ();                            // EQ
      case 0x1: return !this.getZ();                           // NE
      case 0x2: return this.getC();                            // CS/HS
      case 0x3: return !this.getC();                           // CC/LO
      case 0x4: return this.getN();                            // MI
      case 0x5: return !this.getN();                           // PL
      case 0x6: return this.getV();                            // VS
      case 0x7: return !this.getV();                           // VC
      case 0x8: return this.getC() && !this.getZ();            // HI
      case 0x9: return !this.getC() || this.getZ();            // LS
      case 0xA: return this.getN() === this.getV();            // GE
      case 0xB: return this.getN() !== this.getV();            // LT
      case 0xC: return !this.getZ() && (this.getN() === this.getV()); // GT
      case 0xD: return this.getZ() || (this.getN() !== this.getV()); // LE
      case 0xE: return true;                                   // AL (always)
      case 0xF: return true;                                   // unconditional (NV in ARMv4 = never, but used as always in ARMv5+)
      default: return false;
    }
  }

  /** Barrel shifter: compute shifted operand and carry out */
  barrelShift(rm: number, shiftType: number, shiftAmt: number, oldCarry: boolean): { val: number; carry: boolean } {
    const val = rm >>> 0;
    if (shiftAmt === 0) {
      // Special cases for shift amount 0
      switch (shiftType) {
        case 0: return { val: rm, carry: oldCarry }; // LSL #0 = no shift
        case 1: return { val: 0, carry: !!(val & 0x80000000) }; // LSR #32
        case 2: { // ASR #32
          const sign = (rm >> 31) | 0;
          return { val: sign, carry: !!(val & 0x80000000) };
        }
        case 3: { // RRX (rotate right extended by 1)
          const c = oldCarry ? 0x80000000 : 0;
          return { val: ((val >>> 1) | c) >>> 0, carry: !!(val & 1) };
        }
      }
    }
    switch (shiftType) {
      case 0: { // LSL
        if (shiftAmt >= 32) return { val: 0, carry: shiftAmt === 32 ? !!(val & 1) : false };
        return { val: (val << shiftAmt) >>> 0, carry: !!((val >>> (32 - shiftAmt)) & 1) };
      }
      case 1: { // LSR
        if (shiftAmt >= 32) return { val: 0, carry: shiftAmt === 32 ? !!(val & 0x80000000) : false };
        return { val: (val >>> shiftAmt) >>> 0, carry: !!((val >>> (shiftAmt - 1)) & 1) };
      }
      case 2: { // ASR
        if (shiftAmt >= 32) {
          const sign = (rm >> 31) | 0;
          return { val: sign >>> 0, carry: !!(val & 0x80000000) };
        }
        return { val: (rm >> shiftAmt) >>> 0, carry: !!((val >>> (shiftAmt - 1)) & 1) };
      }
      case 3: { // ROR
        const amt = shiftAmt & 31;
        if (amt === 0) return { val: val, carry: !!(val & 0x80000000) };
        const result = ((val >>> amt) | (val << (32 - amt))) >>> 0;
        return { val: result, carry: !!(result & 0x80000000) };
      }
    }
    return { val: rm, carry: oldCarry };
  }

  /** Decode operand2 for data processing instructions (immediate form) */
  decodeImm(instr: number): { val: number; carry: boolean } {
    const imm8 = instr & 0xFF;
    const rotate = ((instr >>> 8) & 0xF) * 2;
    if (rotate === 0) return { val: imm8, carry: this.getC() };
    const val = ((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0;
    return { val, carry: !!(val & 0x80000000) };
  }

  // Fetch a 32-bit ARM instruction
  fetch32(): number {
    const addr = this.reg[PC] >>> 0;
    const v = this.mem.readU32(addr);
    this.reg[PC] = (this.reg[PC] + 4) | 0;
    return v;
  }

  step(): void {
    armStep(this);
  }
}
