/**
 * JIT basic block compiler — translates x86 instructions into JavaScript functions.
 *
 * Scans forward from a given address, decoding x86 instructions and emitting
 * JavaScript source code. Stops at block boundaries (jumps, calls, interrupts,
 * port I/O). The generated source is compiled via Function constructor.
 *
 * Security note: The generated code is deterministic — derived entirely from
 * the emulated program's machine code bytes, not from user input. This is the
 * standard approach for browser-based emulator JIT compilation.
 */

import type { Memory } from '../memory';
import type { CompiledBlock } from './jit-cache';

// Register indices (must match cpu.reg layout)
const REG_NAMES = ['r[0]', 'r[1]', 'r[2]', 'r[3]', 'r[4]', 'r[5]', 'r[6]', 'r[7]'];

/** Result of compile-time ModRM decode */
interface ModRMResult {
  isReg: boolean;     // true if mod=3 (register operand)
  reg: number;        // register field (bits 5-3)
  rm: number;         // rm field (bits 2-0) — only valid if isReg
  addrExpr: string;   // JS expression for effective address (only if !isReg)
  bytesConsumed: number; // total bytes consumed (modrm + SIB + displacement)
}

/** Decode ModRM at compile time, producing a JS address expression string.
 *  rb(a) reads a byte at compile-time address a. */
function decodeModRM16(modrm: number, rb: (a: number) => number, rw: (a: number) => number, offset: number): ModRMResult {
  const mod = modrm >> 6;
  const reg = (modrm >> 3) & 7;
  const rm = modrm & 7;
  let consumed = 1; // modrm byte

  if (mod === 3) return { isReg: true, reg, rm, addrExpr: '', bytesConsumed: 1 };

  // 16-bit addressing modes (no SIB)
  let base = '';
  const segs: Record<number, string> = {
    0: '(r[3]&0xFFFF)+(r[6]&0xFFFF)', // BX+SI
    1: '(r[3]&0xFFFF)+(r[7]&0xFFFF)', // BX+DI
    2: '(r[5]&0xFFFF)+(r[6]&0xFFFF)', // BP+SI
    3: '(r[5]&0xFFFF)+(r[7]&0xFFFF)', // BP+DI
    4: '(r[6]&0xFFFF)',               // SI
    5: '(r[7]&0xFFFF)',               // DI
    6: mod === 0 ? '' : '(r[5]&0xFFFF)', // BP (or disp16 if mod=0)
    7: '(r[3]&0xFFFF)',               // BX
  };

  if (mod === 0 && rm === 6) {
    // [disp16]
    const disp = rw(offset + 1);
    consumed += 2;
    return { isReg: false, reg, rm, addrExpr: `(c.segBase(c.ds)+${disp})>>>0`, bytesConsumed: consumed };
  }

  base = segs[rm];
  let disp = 0;
  if (mod === 1) { disp = rb(offset + 1); if (disp > 127) disp -= 256; consumed += 1; }
  else if (mod === 2) { disp = rw(offset + 1); if (disp > 32767) disp -= 65536; consumed += 2; }

  // Use SS segment for BP-based addressing, DS for others
  const segReg = (rm === 2 || rm === 3 || rm === 6) ? 'c.ss' : 'c.ds';
  const dispStr = disp !== 0 ? `+${disp}` : '';
  return { isReg: false, reg, rm, addrExpr: `(c.segBase(${segReg})+${base}${dispStr})>>>0`, bytesConsumed: consumed };
}

function decodeModRM32(modrm: number, rb: (a: number) => number, rd: (a: number) => number, offset: number): ModRMResult {
  const mod = modrm >> 6;
  const reg = (modrm >> 3) & 7;
  const rm = modrm & 7;
  let consumed = 1;

  if (mod === 3) return { isReg: true, reg, rm, addrExpr: '', bytesConsumed: 1 };

  // SIB byte handling
  if (rm === 4) {
    // SIB — bail for now (Phase 2b)
    return { isReg: false, reg, rm, addrExpr: '', bytesConsumed: -1 }; // -1 = unsupported
  }

  if (mod === 0 && rm === 5) {
    // [disp32]
    const disp = rd(offset + 1);
    consumed += 4;
    return { isReg: false, reg, rm, addrExpr: `${disp >>> 0}`, bytesConsumed: consumed };
  }

  let base = REG_NAMES[rm];
  let disp = 0;
  if (mod === 1) { disp = rb(offset + 1); if (disp > 127) disp -= 256; consumed += 1; }
  else if (mod === 2) { disp = rd(offset + 1) | 0; consumed += 4; }

  const dispStr = disp !== 0 ? (disp > 0 ? `+${disp}` : `${disp}`) : '';
  return { isReg: false, reg, rm, addrExpr: `(${base}${dispStr})>>>0`, bytesConsumed: consumed };
}

// LazyOp constants (must match lazy-op.ts enum values)
// 16-bit variants are value - 1 (e.g. ADD16 = ADD32 - 1 = 2)
const LOP_ADD16 = 2, LOP_ADD32 = 3;
const LOP_SUB16 = 5, LOP_SUB32 = 6;
const LOP_XOR16 = 14, LOP_XOR32 = 15;
const LOP_INC16 = 17, LOP_INC32 = 18;
const LOP_DEC16 = 20, LOP_DEC32 = 21;

/** Try to compile a basic block starting at the given linear address.
 *  Returns a CompiledBlock if successful, or null if the block can't be compiled. */
export function compileBlock(mem: Memory, startAddr: number, use32: boolean): CompiledBlock | null {
  // Support both 16-bit (DOS real mode) and 32-bit modes

  const lines: string[] = [];
  let addr = startAddr;
  let instrCount = 0;
  const MAX_BLOCK_INSNS = 64;
  const segKeys = new Set<number>();
  const is16 = !use32; // 16-bit operand size by default

  segKeys.add(addr >>> 16);

  // Read bytes from memory at compile time
  const rb = (a: number): number => mem.readU8(a >>> 0);
  const rw = (a: number): number => mem.readU16(a >>> 0);
  const rd = (a: number): number => mem.readU32(a >>> 0);

  // Helpers for 16/32 bit mode
  const pushSize = is16 ? 2 : 4;
  const writeOp = is16 ? 'writeU16' : 'writeU32';
  const readOp = is16 ? 'readU16' : 'readU32';
  const readImm = is16 ? rw : rd;
  const immSize = is16 ? 2 : 4;
  // For 16-bit: mask registers to 16-bit in r/m operations
  const regGet = (r: number) => is16 ? `(${REG_NAMES[r]}&0xFFFF)` : REG_NAMES[r];
  const regSet = (r: number, expr: string) => is16
    ? `${REG_NAMES[r]}=(${REG_NAMES[r]}&~0xFFFF)|(${expr})&0xFFFF;`
    : `${REG_NAMES[r]}=${expr};`;
  const spDec = `r[4]=(r[4]${is16 ? '&~0xFFFF|((r[4]&0xFFFF)-' + pushSize + ')&0xFFFF' : '-' + pushSize})|0;`;
  const spInc = `r[4]=(r[4]${is16 ? '&~0xFFFF|((r[4]&0xFFFF)+' + pushSize + ')&0xFFFF' : '+' + pushSize})|0;`;
  const spAddr = is16 ? '((c.segBase(c.ss)+(r[4]&0xFFFF))>>>0)' : '(r[4]>>>0)';

  // Helper: decode ModRM for current mode
  const decodeModRM = (modrm: number, modrm_addr: number): ModRMResult =>
    is16 ? decodeModRM16(modrm, rb, rw, modrm_addr) : decodeModRM32(modrm, rb, rd, modrm_addr);

  let blockComplete = false;

  while (instrCount < MAX_BLOCK_INSNS && !blockComplete) {
    const instrStart = addr;
    const op = rb(addr); addr++;

    switch (op) {
      // NOP
      case 0x90:
        break;

      // PUSH reg (50-57)
      case 0x50: case 0x51: case 0x52: case 0x53:
      case 0x54: case 0x55: case 0x56: case 0x57: {
        const reg = op - 0x50;
        lines.push(`${spDec}m.${writeOp}(${spAddr},${regGet(reg)});`);
        break;
      }

      // POP reg (58-5F)
      case 0x58: case 0x59: case 0x5A: case 0x5B:
      case 0x5C: case 0x5D: case 0x5E: case 0x5F: {
        const reg = op - 0x58;
        lines.push(regSet(reg, `m.${readOp}(${spAddr})`));
        lines.push(spInc);
        break;
      }

      // PUSH imm16/32 (68)
      case 0x68: {
        const imm = readImm(addr); addr += immSize;
        lines.push(`${spDec}m.${writeOp}(${spAddr},${is16 ? imm & 0xFFFF : imm >>> 0});`);
        break;
      }

      // PUSH imm8 sign-extended (6A)
      case 0x6A: {
        let imm = rb(addr); addr++;
        if (imm > 127) imm -= 256;
        lines.push(`${spDec}m.${writeOp}(${spAddr},${imm & (is16 ? 0xFFFF : 0xFFFFFFFF)});`);
        break;
      }

      // MOV reg, imm16/32 (B8-BF)
      case 0xB8: case 0xB9: case 0xBA: case 0xBB:
      case 0xBC: case 0xBD: case 0xBE: case 0xBF: {
        const reg = op - 0xB8;
        const imm = readImm(addr); addr += immSize;
        lines.push(regSet(reg, `${imm | 0}`));
        break;
      }

      // MOV r/m, reg (89)
      case 0x89: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        if (mr.isReg) {
          lines.push(regSet(mr.rm, regGet(mr.reg)));
        } else {
          lines.push(`m.${writeOp}(${mr.addrExpr},${regGet(mr.reg)});`);
        }
        break;
      }

      // MOV reg, r/m (8B)
      case 0x8B: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        if (mr.isReg) {
          lines.push(regSet(mr.reg, regGet(mr.rm)));
        } else {
          lines.push(regSet(mr.reg, `m.${readOp}(${mr.addrExpr})`));
        }
        break;
      }

      // XOR r/m, reg (31)
      case 0x31: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        if (mr.isReg) {
          if (mr.reg === mr.rm) {
            lines.push(regSet(mr.rm, '0'));
            lines.push(`c.lazyOp=${lop};c.lazyResult=0;c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
          } else {
            lines.push(regSet(mr.rm, `${regGet(mr.rm)}^${regGet(mr.reg)}`));
            lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.rm)};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
          }
        } else {
          lines.push(`var _v=m.${readOp}(${mr.addrExpr})^${regGet(mr.reg)};m.${writeOp}(${mr.addrExpr},_v);`);
          lines.push(`c.lazyOp=${lop};c.lazyResult=_v;c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        }
        break;
      }

      // SUB r/m, reg (29)
      case 0x29: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_SUB16 : LOP_SUB32;
        if (mr.isReg) {
          lines.push(`var _a=${regGet(mr.rm)},_b=${regGet(mr.reg)};`);
          lines.push(regSet(mr.rm, '(_a-_b)'));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.rm)};c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        } else {
          lines.push(`var _a=m.${readOp}(${mr.addrExpr}),_b=${regGet(mr.reg)},_r=(_a-_b)|0;m.${writeOp}(${mr.addrExpr},_r);`);
          lines.push(`c.lazyOp=${lop};c.lazyResult=_r;c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        }
        break;
      }

      // ADD r/m, reg (01)
      case 0x01: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_ADD16 : LOP_ADD32;
        if (mr.isReg) {
          lines.push(`var _a=${regGet(mr.rm)},_b=${regGet(mr.reg)};`);
          lines.push(regSet(mr.rm, '(_a+_b)'));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.rm)};c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        } else {
          lines.push(`var _a=m.${readOp}(${mr.addrExpr}),_b=${regGet(mr.reg)},_r=(_a+_b)|0;m.${writeOp}(${mr.addrExpr},_r);`);
          lines.push(`c.lazyOp=${lop};c.lazyResult=_r;c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        }
        break;
      }

      // ADD reg, r/m (03)
      case 0x03: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_ADD16 : LOP_ADD32;
        const srcExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(`var _a=${regGet(mr.reg)},_b=${srcExpr};`);
        lines.push(regSet(mr.reg, '(_a+_b)'));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.reg)};c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        break;
      }

      // SUB reg, r/m (2B)
      case 0x2B: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_SUB16 : LOP_SUB32;
        const srcExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(`var _a=${regGet(mr.reg)},_b=${srcExpr};`);
        lines.push(regSet(mr.reg, '(_a-_b)'));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.reg)};c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        break;
      }

      // XOR reg, r/m (33)
      case 0x33: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        const srcExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(regSet(mr.reg, `${regGet(mr.reg)}^${srcExpr}`));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.reg)};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // CMP r/m, reg (39)
      case 0x39: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_SUB16 : LOP_SUB32;
        const aExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(`var _a=${aExpr},_b=${regGet(mr.reg)};`);
        lines.push(`c.lazyOp=${lop};c.lazyResult=(_a-_b)|0;c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        break;
      }

      // CMP reg, r/m (3B)
      case 0x3B: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_SUB16 : LOP_SUB32;
        const srcExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(`var _a=${regGet(mr.reg)},_b=${srcExpr};`);
        lines.push(`c.lazyOp=${lop};c.lazyResult=(_a-_b)|0;c.lazyA=_a;c.lazyB=_b;c.flagsValid=false;`);
        break;
      }

      // TEST r/m, reg (85)
      case 0x85: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32; // TEST sets flags like AND
        const aExpr = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(`var _r=${aExpr}&${regGet(mr.reg)};`);
        lines.push(`c.lazyOp=${lop};c.lazyResult=_r;c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // INC reg (40-47)
      case 0x40: case 0x41: case 0x42: case 0x43:
      case 0x44: case 0x45: case 0x46: case 0x47: {
        const reg = op - 0x40;
        const lop = is16 ? LOP_INC16 : LOP_INC32;
        lines.push(regSet(reg, `(${regGet(reg)}+1)`));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(reg)};c.flagsCache=c.flagsCache&1;c.flagsValid=false;`);
        break;
      }

      // DEC reg (48-4F)
      case 0x48: case 0x49: case 0x4A: case 0x4B:
      case 0x4C: case 0x4D: case 0x4E: case 0x4F: {
        const reg = op - 0x48;
        const lop = is16 ? LOP_DEC16 : LOP_DEC32;
        lines.push(regSet(reg, `(${regGet(reg)}-1)`));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(reg)};c.flagsCache=c.flagsCache&1;c.flagsValid=false;`);
        break;
      }

      // RET (C3) — block boundary
      case 0xC3: {
        if (is16) {
          lines.push(`var _ip=m.readU16(${spAddr});${spInc}return (c.segBase(c.cs)+_ip)>>>0;`);
        } else {
          lines.push(`var _ip=m.readU32(r[4]>>>0);r[4]=(r[4]+4)|0;return _ip;`);
        }
        blockComplete = true;
        break;
      }

      // JMP rel8 (EB) — block boundary
      case 0xEB: {
        let rel = rb(addr); addr++;
        if (rel > 127) rel -= 256;
        // Linear target = addr + rel (works for both 16-bit and 32-bit)
        const target = (addr + rel) | 0;
        lines.push(`return ${target};`);
        blockComplete = true;
        break;
      }

      // JMP rel16/32 (E9) — block boundary
      case 0xE9: {
        const rel = is16 ? rw(addr) : rd(addr);
        addr += immSize;
        const relSigned = is16 ? (rel > 32767 ? rel - 65536 : rel) : (rel | 0);
        const target = (addr + relSigned) | 0;
        lines.push(`return ${target};`);
        blockComplete = true;
        break;
      }

      // CALL rel16/32 (E8) — block boundary
      case 0xE8: {
        const rel = is16 ? rw(addr) : rd(addr);
        addr += immSize;
        const relSigned = is16 ? (rel > 32767 ? rel - 65536 : rel) : (rel | 0);
        const target = (addr + relSigned) | 0;
        if (is16) {
          // Push 16-bit return IP (offset from CS base, computed at runtime)
          lines.push(`${spDec}m.writeU16(${spAddr},(${addr}-c.segBase(c.cs))&0xFFFF);return ${target};`);
        } else {
          lines.push(`r[4]=(r[4]-4)|0;m.writeU32(r[4]>>>0,${addr});return ${target};`);
        }
        blockComplete = true;
        break;
      }

      // Jcc rel8 (70-7F) — conditional jump, block boundary
      case 0x70: case 0x71: case 0x72: case 0x73:
      case 0x74: case 0x75: case 0x76: case 0x77:
      case 0x78: case 0x79: case 0x7A: case 0x7B:
      case 0x7C: case 0x7D: case 0x7E: case 0x7F: {
        let rel = rb(addr); addr++;
        if (rel > 127) rel -= 256;
        const cc = op - 0x70;
        const target = (addr + rel) | 0;
        const fallthrough = addr;
        // Materialize flags and test condition
        lines.push(`c.materializeFlags();`);
        lines.push(`if(c.testCC(${cc}))return ${target};`);
        lines.push(`return ${fallthrough};`);
        blockComplete = true;
        break;
      }

      // LEA reg, [mem] (8D) — load effective address
      case 0x8D: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0 || mr.isReg) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        // LEA loads the ADDRESS, not the value — and no segment base for 32-bit
        // For 16-bit, strip the segment base (LEA doesn't add segment)
        lines.push(regSet(mr.reg, mr.addrExpr));
        break;
      }

      // Group 83: ALU r/m, imm8 (sign-extended) — extremely common
      case 0x83: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        let imm = rb(addr); addr++;
        if (imm > 127) imm -= 256; // sign-extend
        const aluOp = mr.reg; // 0=ADD,1=OR,2=ADC,3=SBB,4=AND,5=SUB,6=XOR,7=CMP
        if (aluOp === 2 || aluOp === 3) { addr = instrStart; blockComplete = true; continue; } // ADC/SBB need CF
        const dst = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        const setDst = (expr: string) => mr.isReg ? regSet(mr.rm, expr) : `m.${writeOp}(${mr.addrExpr},${expr});`;
        if (aluOp === 7) { // CMP — no write
          const lop = is16 ? LOP_SUB16 : LOP_SUB32;
          lines.push(`var _a=${dst};c.lazyOp=${lop};c.lazyResult=(_a-${imm})|0;c.lazyA=_a;c.lazyB=${imm};c.flagsValid=false;`);
        } else if (aluOp === 0) { // ADD
          const lop = is16 ? LOP_ADD16 : LOP_ADD32;
          lines.push(`var _a=${dst};`);
          lines.push(setDst(`(_a+${imm})`));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`};c.lazyA=_a;c.lazyB=${imm};c.flagsValid=false;`);
        } else if (aluOp === 5) { // SUB
          const lop = is16 ? LOP_SUB16 : LOP_SUB32;
          lines.push(`var _a=${dst};`);
          lines.push(setDst(`(_a-${imm})`));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`};c.lazyA=_a;c.lazyB=${imm};c.flagsValid=false;`);
        } else if (aluOp === 4) { // AND
          const lop = is16 ? LOP_XOR16 : LOP_XOR32; // AND flags like XOR (CF=OF=0)
          lines.push(setDst(`${dst}&${imm}`));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        } else if (aluOp === 1) { // OR
          const lop = is16 ? LOP_XOR16 : LOP_XOR32;
          lines.push(setDst(`${dst}|${imm}`));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        } else if (aluOp === 6) { // XOR
          const lop = is16 ? LOP_XOR16 : LOP_XOR32;
          lines.push(setDst(`${dst}^${imm}`));
          lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        }
        break;
      }

      // AND r/m, reg (21)
      case 0x21: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        if (mr.isReg) {
          lines.push(regSet(mr.rm, `${regGet(mr.rm)}&${regGet(mr.reg)}`));
        } else {
          lines.push(`var _v=m.${readOp}(${mr.addrExpr})&${regGet(mr.reg)};m.${writeOp}(${mr.addrExpr},_v);`);
        }
        lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : '_v'};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // AND reg, r/m (23)
      case 0x23: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        const src = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(regSet(mr.reg, `${regGet(mr.reg)}&${src}`));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.reg)};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // OR r/m, reg (09)
      case 0x09: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        if (mr.isReg) {
          lines.push(regSet(mr.rm, `${regGet(mr.rm)}|${regGet(mr.reg)}`));
        } else {
          lines.push(`var _v=m.${readOp}(${mr.addrExpr})|${regGet(mr.reg)};m.${writeOp}(${mr.addrExpr},_v);`);
        }
        lines.push(`c.lazyOp=${lop};c.lazyResult=${mr.isReg ? regGet(mr.rm) : '_v'};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // OR reg, r/m (0B)
      case 0x0B: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const lop = is16 ? LOP_XOR16 : LOP_XOR32;
        const src = mr.isReg ? regGet(mr.rm) : `m.${readOp}(${mr.addrExpr})`;
        lines.push(regSet(mr.reg, `${regGet(mr.reg)}|${src}`));
        lines.push(`c.lazyOp=${lop};c.lazyResult=${regGet(mr.reg)};c.lazyA=0;c.lazyB=0;c.flagsValid=false;`);
        break;
      }

      // MOV r/m, imm (C7 for 16/32, C6 for 8)
      case 0xC7: {
        const mr = decodeModRM(rb(addr), addr);
        if (mr.bytesConsumed < 0) { addr = instrStart; blockComplete = true; continue; }
        addr += mr.bytesConsumed;
        const imm = readImm(addr); addr += immSize;
        if (mr.isReg) {
          lines.push(regSet(mr.rm, `${imm | 0}`));
        } else {
          lines.push(`m.${writeOp}(${mr.addrExpr},${is16 ? imm & 0xFFFF : imm | 0});`);
        }
        break;
      }

      // LOOP rel8 (E2) — block boundary
      case 0xE2: {
        let rel = rb(addr); addr++;
        if (rel > 127) rel -= 256;
        const target = (addr + rel) | 0;
        if (is16) {
          lines.push(`var _cx=((r[1]&0xFFFF)-1)&0xFFFF;r[1]=(r[1]&~0xFFFF)|_cx;`);
          lines.push(`if(_cx!==0)return ${target};`);
        } else {
          lines.push(`r[1]=(r[1]-1)|0;`);
          lines.push(`if(r[1]!==0)return ${target};`);
        }
        lines.push(`return ${addr};`);
        blockComplete = true;
        break;
      }

      // Anything else: can't compile, end block before this instruction
      default:
        addr = instrStart;
        blockComplete = true;
        continue;
    }

    instrCount++;
    segKeys.add(addr >>> 16);
  }

  if (instrCount === 0) return null;

  // Always add fallthrough return if the last line isn't already a return
  const lastLine = lines[lines.length - 1] || '';
  if (!lastLine.includes('return ')) {
    lines.push(`return ${addr};`);
  }

  const src = lines.join('\n');
  try {
    // r = cpu.reg (Int32Array), m = cpu.mem (Memory), c = cpu (CPU)
    // Using Function constructor for JIT compilation of x86 machine code
    const fn = new Function('r', 'm', 'c', src) as CompiledBlock['fn'];
    return { fn, startAddr, endAddr: addr, instrCount, segKeys: [...segKeys] };
  } catch {
    return null;
  }
}
