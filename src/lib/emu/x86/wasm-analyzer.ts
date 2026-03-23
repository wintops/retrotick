/**
 * Basic block analyzer for WASM JIT — discovers all basic blocks reachable
 * from a hot address via BFS, builds a control flow graph.
 */

import type { Memory } from '../memory';

/** A basic block in the control flow graph */
export interface WasmBasicBlock {
  addr: number;           // start linear address
  endAddr: number;        // address after last instruction byte
  instrCount: number;     // number of x86 instructions
  successors: number[];   // addresses of successor blocks (0, 1, or 2)
  isConditional: boolean; // ends with Jcc?
  branchTarget: number;   // taken-branch target (for Jcc/JMP)
  fallthrough: number;    // fall-through address (for Jcc, or next for linear)
  exitType: 'jcc' | 'jmp' | 'call' | 'ret' | 'fallthrough' | 'bail';
  conditionCode: number; // x86 CC (0-F) for Jcc, -1 otherwise
}

const MAX_BLOCKS = 256;
const MAX_REGION_SIZE = 65536; // 64KB

// Prefixes
const PREFIX_SET = new Set([0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3]);

/** Compute ModRM + SIB + displacement length (starting at the ModRM byte) */
function modrmLen(mem: Memory, addr: number, addrSize16: boolean): number {
  const modrm = mem.readU8(addr);
  const mod = (modrm >> 6) & 3;
  const rm = modrm & 7;
  let len = 1; // ModRM byte
  if (mod === 3) return len;
  if (addrSize16) {
    // 16-bit addressing
    if (mod === 0 && rm === 6) return len + 2; // disp16
    if (mod === 1) return len + 1;
    if (mod === 2) return len + 2;
    return len;
  }
  // 32-bit addressing
  if (rm === 4) { // SIB present
    const sib = mem.readU8(addr + 1);
    len++;
    if ((sib & 7) === 5 && mod === 0) return len + 4;
    if (mod === 1) return len + 1;
    if (mod === 2) return len + 4;
    return len;
  }
  if (rm === 5 && mod === 0) return len + 4;
  if (mod === 1) return len + 1;
  if (mod === 2) return len + 4;
  return len;
}

/** Result of decoding one instruction */
interface DecodedInsn {
  length: number;
  blockEnd: boolean;       // this instruction ends the block
  isConditional: boolean;  // Jcc (two successors)
  isUnconditional: boolean; // JMP/RET (no fallthrough)
  branchTarget: number;    // absolute target (-1 if unknown/indirect)
  conditionCode: number;   // x86 CC (0-F) for Jcc, -1 otherwise
}

/** Decode one x86 instruction at addr, return length + control flow info */
function decodeInsn(mem: Memory, addr: number, use32: boolean): DecodedInsn {
  let pos = addr;
  let opSize32 = use32;
  let addrSize16 = !use32;

  // Consume prefixes
  while (PREFIX_SET.has(mem.readU8(pos))) {
    const pfx = mem.readU8(pos);
    if (pfx === 0x66) opSize32 = !opSize32;
    if (pfx === 0x67) addrSize16 = !addrSize16;
    pos++;
  }

  const op = mem.readU8(pos); pos++;
  const immSize = opSize32 ? 4 : 2;

  const result: DecodedInsn = { length: 0, blockEnd: false, isConditional: false, isUnconditional: false, branchTarget: -1, conditionCode: -1 };

  switch (op) {
    // 1-byte no-operand
    case 0x90: case 0x98: case 0x99: // NOP, CBW/CWDE, CWD/CDQ
    case 0xA4: case 0xA5: case 0xA6: case 0xA7: // string ops
    case 0xAA: case 0xAB: case 0xAC: case 0xAD: case 0xAE: case 0xAF:
    case 0xF5: case 0xF8: case 0xF9: case 0xFA: case 0xFB: case 0xFC: case 0xFD: // flag ops
    case 0xC9: // LEAVE
      break;

    // INC/DEC/PUSH/POP reg (40-5F), XCHG reg,AX (91-97)
    case 0x40: case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
    case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F:
    case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57:
    case 0x58: case 0x59: case 0x5A: case 0x5B: case 0x5C: case 0x5D: case 0x5E: case 0x5F:
    case 0x91: case 0x92: case 0x93: case 0x94: case 0x95: case 0x96: case 0x97:
      break;

    // MOV reg8, imm8 (B0-B7)
    case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6: case 0xB7:
      pos += 1;
      break;

    // MOV reg, imm16/32 (B8-BF)
    case 0xB8: case 0xB9: case 0xBA: case 0xBB: case 0xBC: case 0xBD: case 0xBE: case 0xBF:
      pos += immSize;
      break;

    // ALU r/m, r and r, r/m (00-3F pattern)
    case 0x00: case 0x01: case 0x02: case 0x03: case 0x08: case 0x09: case 0x0A: case 0x0B:
    case 0x10: case 0x11: case 0x12: case 0x13: case 0x18: case 0x19: case 0x1A: case 0x1B:
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x28: case 0x29: case 0x2A: case 0x2B:
    case 0x30: case 0x31: case 0x32: case 0x33: case 0x38: case 0x39: case 0x3A: case 0x3B:
    // MOV r/m, r and r, r/m, LEA, TEST, XCHG, MOV sreg
    case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89: case 0x8A: case 0x8B:
    case 0x8C: case 0x8D: case 0x8E: case 0x8F:
    // SHIFT by 1 and CL
    case 0xD0: case 0xD1: case 0xD2: case 0xD3:
    // FPU
    case 0xD8: case 0xD9: case 0xDA: case 0xDB: case 0xDC: case 0xDD: case 0xDE: case 0xDF:
    // BOUND, LES, LDS, ARPL
    case 0x62: case 0x63: case 0xC4: case 0xC5:
      pos += modrmLen(mem, pos, addrSize16);
      break;

    // ALU AL, imm8
    case 0x04: case 0x0C: case 0x14: case 0x1C: case 0x24: case 0x2C: case 0x34: case 0x3C:
    case 0xA8: // TEST AL, imm8
    case 0x6A: // PUSH imm8
      pos += 1;
      break;

    // ALU AX, imm16/32
    case 0x05: case 0x0D: case 0x15: case 0x1D: case 0x25: case 0x2D: case 0x35: case 0x3D:
    case 0xA9: // TEST AX, imm
    case 0x68: // PUSH imm16/32
      pos += immSize;
      break;

    // Group 80/82: ALU r/m8, imm8
    case 0x80: case 0x82: case 0xC6: // also MOV r/m8, imm8
      pos += modrmLen(mem, pos, addrSize16) + 1;
      break;

    // Group 81: ALU r/m, imm16/32
    case 0x81: case 0xC7: // also MOV r/m, imm16/32
      pos += modrmLen(mem, pos, addrSize16) + immSize;
      break;

    // Group 83: ALU r/m, imm8 sign-extended
    case 0x83:
      pos += modrmLen(mem, pos, addrSize16) + 1;
      break;

    // SHIFT r/m, imm8
    case 0xC0: case 0xC1:
      pos += modrmLen(mem, pos, addrSize16) + 1;
      break;

    // IMUL r, r/m, imm8
    case 0x6B:
      pos += modrmLen(mem, pos, addrSize16) + 1;
      break;

    // IMUL r, r/m, imm16/32
    case 0x69:
      pos += modrmLen(mem, pos, addrSize16) + immSize;
      break;

    // MOV moffs (A0-A3)
    case 0xA0: case 0xA2: // 8-bit
      pos += addrSize16 ? 2 : 4;
      break;
    case 0xA1: case 0xA3: // 16/32-bit
      pos += addrSize16 ? 2 : 4;
      break;

    // Group F6: TEST/NOT/NEG/MUL/DIV r/m8
    case 0xF6: {
      const mrm = mem.readU8(pos);
      const reg = (mrm >> 3) & 7;
      pos += modrmLen(mem, pos, addrSize16);
      if (reg === 0 || reg === 1) pos += 1; // TEST has imm8
      break;
    }

    // Group F7: TEST/NOT/NEG/MUL/DIV r/m16/32
    case 0xF7: {
      const mrm = mem.readU8(pos);
      const reg = (mrm >> 3) & 7;
      pos += modrmLen(mem, pos, addrSize16);
      if (reg === 0 || reg === 1) pos += immSize; // TEST has imm
      break;
    }

    // Group FE: INC/DEC r/m8
    case 0xFE:
      pos += modrmLen(mem, pos, addrSize16);
      break;

    // Group FF: INC/DEC/CALL/JMP/PUSH r/m
    case 0xFF: {
      const mrm = mem.readU8(pos);
      const reg = (mrm >> 3) & 7;
      pos += modrmLen(mem, pos, addrSize16);
      if (reg === 2 || reg === 3) { result.blockEnd = true; result.isUnconditional = true; } // CALL
      if (reg === 4 || reg === 5) { result.blockEnd = true; result.isUnconditional = true; } // JMP indirect
      break;
    }

    // Jcc short (70-7F)
    case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7A: case 0x7B: case 0x7C: case 0x7D: case 0x7E: case 0x7F: {
      let rel = mem.readU8(pos); pos++;
      if (rel > 127) rel -= 256;
      result.blockEnd = true;
      result.isConditional = true;
      result.branchTarget = pos + rel;
      result.conditionCode = op & 0x0F;
      break;
    }

    // JMP short
    case 0xEB: {
      let rel = mem.readU8(pos); pos++;
      if (rel > 127) rel -= 256;
      result.blockEnd = true;
      result.isUnconditional = true;
      result.branchTarget = pos + rel;
      break;
    }

    // JMP near
    case 0xE9: {
      let rel: number;
      if (opSize32) { rel = mem.readU32(pos) | 0; pos += 4; }
      else { rel = mem.readU16(pos); if (rel > 32767) rel -= 65536; pos += 2; }
      result.blockEnd = true;
      result.isUnconditional = true;
      result.branchTarget = pos + rel;
      break;
    }

    // CALL near
    case 0xE8: {
      let rel: number;
      if (opSize32) { rel = mem.readU32(pos) | 0; pos += 4; }
      else { rel = mem.readU16(pos); if (rel > 32767) rel -= 65536; pos += 2; }
      result.blockEnd = true;
      result.branchTarget = pos + rel;
      // CALL falls through (return address is next insn)
      break;
    }

    // LOOP/LOOPcc
    case 0xE0: case 0xE1: case 0xE2: case 0xE3: {
      let rel = mem.readU8(pos); pos++;
      if (rel > 127) rel -= 256;
      result.blockEnd = true;
      result.isConditional = true;
      result.branchTarget = pos + rel;
      break;
    }

    // RET / RETF
    case 0xC3: case 0xCB:
      result.blockEnd = true; result.isUnconditional = true;
      break;
    case 0xC2: case 0xCA: // RET imm16
      pos += 2;
      result.blockEnd = true; result.isUnconditional = true;
      break;

    // INT / INTO / IRET
    case 0xCC: result.blockEnd = true; result.isUnconditional = true; break;
    case 0xCD: pos += 1; result.blockEnd = true; result.isUnconditional = true; break;
    case 0xCE: case 0xCF: result.blockEnd = true; result.isUnconditional = true; break;

    // ENTER
    case 0xC8: pos += 3; break;

    // Port I/O — block boundary
    case 0xE4: case 0xE5: case 0xE6: case 0xE7: pos += 1; result.blockEnd = true; break;
    case 0xEC: case 0xED: case 0xEE: case 0xEF: result.blockEnd = true; break;

    // HLT
    case 0xF4: result.blockEnd = true; result.isUnconditional = true; break;

    // CALL far
    case 0x9A: pos += immSize + 2; result.blockEnd = true; break;
    // JMP far
    case 0xEA: pos += immSize + 2; result.blockEnd = true; result.isUnconditional = true; break;

    // 2-byte opcodes (0F xx)
    case 0x0F: {
      const op2 = mem.readU8(pos); pos++;
      if (op2 >= 0x80 && op2 <= 0x8F) {
        // Jcc near
        let rel: number;
        if (opSize32) { rel = mem.readU32(pos) | 0; pos += 4; }
        else { rel = mem.readU16(pos); if (rel > 32767) rel -= 65536; pos += 2; }
        result.blockEnd = true;
        result.isConditional = true;
        result.branchTarget = pos + rel;
        result.conditionCode = op2 & 0x0F;
      } else if ((op2 >= 0x90 && op2 <= 0x9F) || (op2 >= 0x40 && op2 <= 0x4F) ||
                 op2 === 0xAF || op2 === 0xB6 || op2 === 0xB7 || op2 === 0xBE || op2 === 0xBF ||
                 op2 === 0xA3 || op2 === 0xA4 || op2 === 0xA5 || op2 === 0xAB || op2 === 0xAC || op2 === 0xAD ||
                 op2 === 0xB0 || op2 === 0xB1 || op2 === 0xB3 || op2 === 0xBA || op2 === 0xBB || op2 === 0xBC || op2 === 0xBD ||
                 op2 === 0xC0 || op2 === 0xC1 || op2 === 0x00 || op2 === 0x01) {
        // ModRM-based 0F opcodes
        pos += modrmLen(mem, pos, addrSize16);
        if (op2 === 0xBA) pos += 1; // BT/BTS/BTR/BTC imm8
        if (op2 === 0xA4 || op2 === 0xAC) pos += 1; // SHLD/SHRD imm8
      } else if (op2 === 0x31) {
        // RDTSC — no extra bytes
      } else {
        // Unknown 0F opcode — bail
        result.blockEnd = true; result.isUnconditional = true;
      }
      break;
    }

    // Unknown opcode — bail
    default:
      result.blockEnd = true;
      result.isUnconditional = true;
      break;
  }

  result.length = pos - addr;
  return result;
}

/** Analyze a code region starting from startAddr, return basic blocks */
export function analyzeRegion(
  mem: Memory, startAddr: number, use32: boolean
): Map<number, WasmBasicBlock> {
  const blocks = new Map<number, WasmBasicBlock>();
  const queue: number[] = [startAddr];
  const visited = new Set<number>();
  const regionBase = startAddr & ~(MAX_REGION_SIZE - 1);
  const regionEnd = regionBase + MAX_REGION_SIZE;

  while (queue.length > 0 && blocks.size < MAX_BLOCKS) {
    const blockAddr = queue.shift()!;
    if (visited.has(blockAddr)) continue;
    if (blockAddr < regionBase || blockAddr >= regionEnd) continue;
    visited.add(blockAddr);

    // Decode instructions until block boundary
    let addr = blockAddr;
    let instrCount = 0;

    while (addr < regionEnd) {
      const insn = decodeInsn(mem, addr, use32);
      instrCount++;
      addr += insn.length;

      if (insn.blockEnd) {
        const successors: number[] = [];
        let branchTarget = insn.branchTarget;
        let fallthrough = addr;
        let exitType: WasmBasicBlock['exitType'] = 'bail';

        if (insn.isConditional) {
          exitType = 'jcc';
          if (branchTarget >= regionBase && branchTarget < regionEnd) {
            successors.push(branchTarget);
            queue.push(branchTarget);
          }
          successors.push(fallthrough);
          queue.push(fallthrough);
        } else if (insn.isUnconditional) {
          if (branchTarget >= 0 && branchTarget >= regionBase && branchTarget < regionEnd) {
            exitType = 'jmp';
            successors.push(branchTarget);
            queue.push(branchTarget);
          } else if (branchTarget < 0) {
            exitType = 'ret';
          } else {
            exitType = 'jmp';
          }
        } else {
          // Port I/O or CALL — falls through
          exitType = 'call';
          successors.push(fallthrough);
          queue.push(fallthrough);
          if (branchTarget >= regionBase && branchTarget < regionEnd) {
            successors.push(branchTarget);
            queue.push(branchTarget);
          }
        }

        blocks.set(blockAddr, {
          addr: blockAddr, endAddr: addr, instrCount, successors,
          isConditional: insn.isConditional, branchTarget, fallthrough,
          exitType, conditionCode: insn.conditionCode,
        });
        break;
      }

      // Check if we're running into an already-known block start
      if (blocks.has(addr) || visited.has(addr)) {
        blocks.set(blockAddr, {
          addr: blockAddr, endAddr: addr, instrCount,
          successors: [addr], isConditional: false,
          branchTarget: addr, fallthrough: addr, exitType: 'fallthrough',
          conditionCode: -1,
        });
        break;
      }
    }
  }

  // Split blocks at addresses that are branch targets of other blocks
  splitAtBranchTargets(blocks);

  return blocks;
}

/** Split blocks that have a branch target in their middle */
function splitAtBranchTargets(blocks: Map<number, WasmBasicBlock>): void {
  // Collect all branch targets
  const targets = new Set<number>();
  for (const b of blocks.values()) {
    for (const s of b.successors) targets.add(s);
  }

  // Find blocks that contain a target in their interior
  for (const target of targets) {
    if (blocks.has(target)) continue; // already a block start
    for (const [addr, b] of blocks) {
      if (target > b.addr && target < b.endAddr) {
        // Split: b becomes [addr, target), new block is [target, endAddr)
        const newBlock: WasmBasicBlock = {
          addr: target, endAddr: b.endAddr, instrCount: 0,
          successors: b.successors, isConditional: b.isConditional,
          branchTarget: b.branchTarget, fallthrough: b.fallthrough, exitType: b.exitType,
          conditionCode: b.conditionCode,
        };
        // Recount instructions (approximate — set to 1 for now, will be refined during codegen)
        newBlock.instrCount = Math.max(1, b.instrCount - 1);
        b.endAddr = target;
        b.instrCount = Math.max(1, b.instrCount - newBlock.instrCount);
        b.successors = [target];
        b.isConditional = false;
        b.branchTarget = target;
        b.fallthrough = target;
        b.exitType = 'fallthrough';
        b.conditionCode = -1;
        blocks.set(target, newBlock);
        break; // restart scan (map modified)
      }
    }
  }
}
