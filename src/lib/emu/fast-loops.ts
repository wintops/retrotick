/** Tight loop detector: decodes small backward-jumping loops into mini-IR
 * and executes all iterations in one TypeScript pass. */

const REG_EAX = 0, REG_ECX = 1, REG_EDX = 2, REG_EBX = 3;
const REG_ESP = 4, REG_EBP = 5, REG_ESI = 6, REG_EDI = 7;

const enum Op {
  ADD_RR, ADD_RI, SUB_RR, SUB_RI, ADC_RR, SBB_RR,
  AND_RR, AND_RI, OR_RR, OR_RI, XOR_RR, XOR_RI,
  NOT, NEG, SHL_RI, SHR_RI, SAR_RI, INC, DEC,
  MOV_RR, MOV_RI, CMP_RR, CMP_RI, TEST_RR,
  LEA, MOVZX8,
  LOAD8, LOAD32, LOAD32_SIB, LOAD32_BSIB,
  STORE8, STORE16, STORE32,
}

interface Insn { op: Op; dst: number; src: number; imm: number; base: number; scale: number; disp: number }
interface LoopInfo { startAddr: number; endAddr: number; insns: Insn[]; counterReg: number; cmpReg: number; cmpImm: number; jccType: number }

function ins(op: Op, dst: number, src = 0, imm = 0, base = 0, scale = 0, disp = 0): Insn {
  return { op, dst, src, imm, base, scale, disp };
}

function decodeModRM32(mem: { readU8(a: number): number; readU32(a: number): number },
                       ip: number): { base: number; idx: number; scale: number; disp: number; len: number } | null {
  const modrm = mem.readU8(ip);
  const mod = (modrm >> 6) & 3;
  const rm = modrm & 7;

  if (mod === 3) return null; // register mode, not memory

  let base = rm, idx = -1, scale = 1, disp = 0, len = 1;

  if (rm === 4) { // SIB follows
    const sib = mem.readU8(ip + 1);
    scale = 1 << ((sib >> 6) & 3);
    idx = (sib >> 3) & 7;
    base = sib & 7;
    if (idx === 4) idx = -1; // no index
    len = 2;
    if (mod === 0 && base === 5) { base = -1; disp = mem.readU32(ip + 2) | 0; len = 6; return { base, idx, scale, disp, len }; }
  }

  if (mod === 0) {
    if (rm === 5) { base = -1; disp = mem.readU32(ip + 1) | 0; len = 5; }
  } else if (mod === 1) {
    disp = (mem.readU8(ip + len) << 24) >> 24;
    len += 1;
  } else { // mod === 2
    disp = mem.readU32(ip + len) | 0;
    len += 4;
  }
  return { base, idx, scale, disp, len };
}

// ---- Instruction decoder ----

function decodeLoopBody(mem: { readU8(a: number): number; readU32(a: number): number },
                        start: number, end: number): Insn[] | null {
  const insns: Insn[] = [];
  let ip = start;

  while (ip < end) {
    const b0 = mem.readU8(ip);
    const b1 = mem.readU8(ip + 1);

    // --- ALU reg, r/m32 (mod=11 only) ---
    // 01 /r ADD r/m32,r32 | 03 /r ADD r32,r/m32
    // 09 /r OR  r/m32,r32 | 0B /r OR  r32,r/m32
    // 11 /r ADC r/m32,r32 | 13 /r ADC r32,r/m32
    // 19 /r SBB r/m32,r32 | 1B /r SBB r32,r/m32
    // 21 /r AND r/m32,r32 | 23 /r AND r32,r/m32
    // 29 /r SUB r/m32,r32 | 2B /r SUB r32,r/m32
    // 31 /r XOR r/m32,r32 | 33 /r XOR r32,r/m32
    // 39 /r CMP r/m32,r32 | 3B /r CMP r32,r/m32
    if ((b0 & 0xC4) === 0x00 && (b0 & 1) === 1 && b0 <= 0x3B && b0 !== 0x0F) {
      // 32-bit reg ALU (odd opcodes: 01,03,09,0B,11,13,19,1B,21,23,29,2B,31,33,39,3B)
      const dir = (b0 >> 1) & 1; // 0 = r/m32,r32 dest; 1 = r32,r/m32 dest
      const opType = (b0 >> 3) & 7; // 0=ADD,1=OR,2=ADC,3=SBB,4=AND,5=SUB,6=XOR,7=CMP
      const opMap = [Op.ADD_RR, Op.OR_RR, Op.ADC_RR, Op.SBB_RR, Op.AND_RR, Op.SUB_RR, Op.XOR_RR, Op.CMP_RR];
      if ((b1 & 0xC0) === 0xC0) {
        // reg-reg
        const reg = (b1 >> 3) & 7, rm = b1 & 7;
        const dst = dir ? reg : rm, src = dir ? rm : reg;
        insns.push(ins(opMap[opType], dst, src));
        ip += 2; continue;
      }
      // reg, [mem] — only decode dir=1 (r32, r/m32) for loads
      if (dir === 1) {
        const reg = (b1 >> 3) & 7;
        const m = decodeModRM32(mem, ip + 1);
        if (m && m.idx < 0 && m.base >= 0) {
          // Simple [base+disp] form — emit as LOAD32 + ALU
          const tmp = ins(Op.LOAD32, 8, 0, 0, m.base, 0, m.disp); // pseudo-reg 8
          // We can't use a temp register in our IR easily. Bail for now on memory-source ALU.
        }
      }
      return null;
    }

    // 83 /reg ib — group 1 r/m32, imm8  (ADD/OR/ADC/SBB/AND/SUB/XOR/CMP)
    if (b0 === 0x83 && (b1 & 0xC0) === 0xC0) {
      const op = (b1 >> 3) & 7;
      const rm = b1 & 7;
      const imm = (mem.readU8(ip + 2) << 24) >> 24;
      const opMap: (Op | null)[] = [Op.ADD_RI, Op.OR_RI, null, null, Op.AND_RI, Op.SUB_RI, Op.XOR_RI, Op.CMP_RI];
      const mapped = opMap[op];
      if (mapped !== null) { insns.push(ins(mapped, rm, 0, imm)); ip += 3; continue; }
      return null;
    }

    // 81 /reg id — group 1 r/m32, imm32
    if (b0 === 0x81 && (b1 & 0xC0) === 0xC0) {
      const op = (b1 >> 3) & 7;
      const rm = b1 & 7;
      const imm = mem.readU32(ip + 2) | 0;
      const opMap: (Op | null)[] = [Op.ADD_RI, Op.OR_RI, null, null, Op.AND_RI, Op.SUB_RI, Op.XOR_RI, Op.CMP_RI];
      const mapped = opMap[op];
      if (mapped !== null) { insns.push(ins(mapped, rm, 0, imm)); ip += 6; continue; }
      return null;
    }

    // Short ALU EAX, imm32 (05=ADD, 0D=OR, 25=AND, 2D=SUB, 35=XOR, 3D=CMP)
    if ((b0 & 7) === 5 && b0 <= 0x3D && b0 !== 0x0F) {
      const opType = (b0 >> 3) & 7;
      const opMap: (Op | null)[] = [Op.ADD_RI, Op.OR_RI, null, null, Op.AND_RI, Op.SUB_RI, Op.XOR_RI, Op.CMP_RI];
      const mapped = opMap[opType];
      if (mapped !== null) { insns.push(ins(mapped, REG_EAX, 0, mem.readU32(ip + 1) | 0)); ip += 5; continue; }
      return null;
    }

    // A8 ib — TEST AL, imm8
    if (b0 === 0xA8) { insns.push(ins(Op.TEST_RR, REG_EAX, REG_EAX, mem.readU8(ip + 1))); ip += 2; continue; }
    // A9 id — TEST EAX, imm32
    if (b0 === 0xA9) { insns.push(ins(Op.TEST_RR, REG_EAX, REG_EAX, mem.readU32(ip + 1) | 0)); ip += 5; continue; }
    // F7 /0 id — TEST r/m32, imm32
    if (b0 === 0xF7 && (b1 & 0xC0) === 0xC0 && ((b1 >> 3) & 7) === 0) {
      insns.push(ins(Op.TEST_RR, b1 & 7, b1 & 7, mem.readU32(ip + 2) | 0));
      ip += 6; continue;
    }
    // 85 /r — TEST r/m32, r32  (mod=11 only)
    if (b0 === 0x85 && (b1 & 0xC0) === 0xC0) {
      insns.push(ins(Op.TEST_RR, b1 & 7, (b1 >> 3) & 7));
      ip += 2; continue;
    }

    // F7 /3 — NEG r/m32 (mod=11)
    if (b0 === 0xF7 && (b1 & 0xC0) === 0xC0 && ((b1 >> 3) & 7) === 3) {
      insns.push(ins(Op.NEG, b1 & 7));
      ip += 2; continue;
    }
    // F7 /2 — NOT r/m32 (mod=11)
    if (b0 === 0xF7 && (b1 & 0xC0) === 0xC0 && ((b1 >> 3) & 7) === 2) {
      insns.push(ins(Op.NOT, b1 & 7));
      ip += 2; continue;
    }

    // C1 /reg ib — shift group (SHL=4, SHR=5, SAR=7)
    if (b0 === 0xC1 && (b1 & 0xC0) === 0xC0) {
      const op = (b1 >> 3) & 7;
      const rm = b1 & 7, sh = mem.readU8(ip + 2) & 31;
      if (op === 4) { insns.push(ins(Op.SHL_RI, rm, 0, sh)); ip += 3; continue; }
      if (op === 5) { insns.push(ins(Op.SHR_RI, rm, 0, sh)); ip += 3; continue; }
      if (op === 7) { insns.push(ins(Op.SAR_RI, rm, 0, sh)); ip += 3; continue; }
      return null;
    }
    // D1 /reg — shift by 1
    if (b0 === 0xD1 && (b1 & 0xC0) === 0xC0) {
      const op = (b1 >> 3) & 7, rm = b1 & 7;
      if (op === 4) { insns.push(ins(Op.SHL_RI, rm, 0, 1)); ip += 2; continue; }
      if (op === 5) { insns.push(ins(Op.SHR_RI, rm, 0, 1)); ip += 2; continue; }
      if (op === 7) { insns.push(ins(Op.SAR_RI, rm, 0, 1)); ip += 2; continue; }
      return null;
    }

    // 40-47 INC r32  |  48-4F DEC r32
    if (b0 >= 0x40 && b0 <= 0x47) { insns.push(ins(Op.INC, b0 - 0x40)); ip += 1; continue; }
    if (b0 >= 0x48 && b0 <= 0x4F) { insns.push(ins(Op.DEC, b0 - 0x48)); ip += 1; continue; }

    // 8D /r — LEA r32, [r/m32]
    if (b0 === 0x8D) {
      const reg = (b1 >> 3) & 7;
      const m = decodeModRM32(mem, ip + 1);
      if (m) {
        insns.push(ins(Op.LEA, reg, m.idx >= 0 ? m.idx : 0, 0, m.base, m.idx >= 0 ? m.scale : 0, m.disp));
        ip += 1 + m.len; continue;
      }
      return null;
    }

    // 8B /r — MOV r32, r/m32
    if (b0 === 0x8B) {
      const reg = (b1 >> 3) & 7;
      if ((b1 & 0xC0) === 0xC0) { insns.push(ins(Op.MOV_RR, reg, b1 & 7)); ip += 2; continue; }
      const m = decodeModRM32(mem, ip + 1);
      if (m) {
        if (m.base === -1 && m.idx >= 0) {
          insns.push(ins(Op.LOAD32_SIB, reg, m.idx, 0, -1, m.scale, m.disp));
        } else if (m.idx >= 0 && m.base >= 0) {
          insns.push(ins(Op.LOAD32_BSIB, reg, m.idx, 0, m.base, m.scale, m.disp));
        } else if (m.base >= 0) {
          insns.push(ins(Op.LOAD32, reg, 0, 0, m.base, 0, m.disp));
        } else {
          return null;
        }
        ip += 1 + m.len; continue;
      }
      return null;
    }

    // 89 /r — MOV r/m32, r32
    if (b0 === 0x89) {
      const reg = (b1 >> 3) & 7;
      if ((b1 & 0xC0) === 0xC0) { insns.push(ins(Op.MOV_RR, b1 & 7, reg)); ip += 2; continue; }
      const m = decodeModRM32(mem, ip + 1);
      if (m && m.idx < 0 && m.base >= 0) {
        insns.push(ins(Op.STORE32, 0, reg, 0, m.base, 0, m.disp));
        ip += 1 + m.len; continue;
      }
      return null;
    }

    // 8A /r — MOV r8, r/m8
    if (b0 === 0x8A) {
      const reg = (b1 >> 3) & 7;
      if ((b1 & 0xC0) === 0xC0) return null; // reg-reg byte moves are tricky
      const m = decodeModRM32(mem, ip + 1);
      if (m && m.idx < 0 && m.base >= 0) {
        insns.push(ins(Op.LOAD8, reg, 0, 0, m.base, 0, m.disp));
        ip += 1 + m.len; continue;
      }
      return null;
    }

    // 88 /r — MOV r/m8, r8
    if (b0 === 0x88) {
      const reg = (b1 >> 3) & 7;
      if ((b1 & 0xC0) === 0xC0) return null;
      const m = decodeModRM32(mem, ip + 1);
      if (m && m.idx < 0 && m.base >= 0) {
        insns.push(ins(Op.STORE8, 0, reg, 0, m.base, 0, m.disp));
        ip += 1 + m.len; continue;
      }
      return null;
    }

    // B8-BF — MOV r32, imm32
    if (b0 >= 0xB8 && b0 <= 0xBF) {
      insns.push(ins(Op.MOV_RI, b0 - 0xB8, 0, mem.readU32(ip + 1) | 0));
      ip += 5; continue;
    }
    // C7 /0 — MOV r/m32, imm32 (mod=11)
    if (b0 === 0xC7 && (b1 & 0xC0) === 0xC0 && ((b1 >> 3) & 7) === 0) {
      insns.push(ins(Op.MOV_RI, b1 & 7, 0, mem.readU32(ip + 2) | 0));
      ip += 6; continue;
    }

    // 0F B6 /r — MOVZX r32, r/m8
    if (b0 === 0x0F && b1 === 0xB6) {
      const b2 = mem.readU8(ip + 2);
      const reg = (b2 >> 3) & 7;
      if ((b2 & 0xC0) === 0xC0) {
        insns.push(ins(Op.MOVZX8, reg, b2 & 7));
        ip += 3; continue;
      }
      const m = decodeModRM32(mem, ip + 2);
      if (m && m.idx < 0 && m.base >= 0) {
        insns.push(ins(Op.LOAD8, reg, 0, 1 /* flag: zero-extend whole reg */, m.base, 0, m.disp));
        ip += 2 + m.len; continue;
      }
      return null;
    }

    // 90 — NOP
    if (b0 === 0x90) { ip += 1; continue; }

    // Unrecognised — bail
    return null;
  }
  return insns;
}

// ---- Find backward Jcc ----

function findBackwardJcc(mem: { readU8(a: number): number; readU32(a: number): number }, eip: number):
    { loopStart: number; jccAddr: number; jccLen: number; jccType: number } | null {
  for (let off = 0; off < 48; off++) {
    const b = mem.readU8(eip + off);
    // Short Jcc: 70-7F rel8
    if (b >= 0x70 && b <= 0x7F) {
      const rel = mem.readU8(eip + off + 1);
      if (rel >= 0x80) {
        const target = (eip + off + 2 + ((rel << 24) >> 24)) >>> 0;
        if (target <= eip) return { loopStart: target, jccAddr: eip + off, jccLen: 2, jccType: b };
      }
    }
    // Near Jcc: 0F 80-8F rel32
    if (b === 0x0F) {
      const b2 = mem.readU8(eip + off + 1);
      if (b2 >= 0x80 && b2 <= 0x8F) {
        const rel = mem.readU32(eip + off + 2) | 0;
        if (rel < 0) {
          const target = (eip + off + 6 + rel) >>> 0;
          if (target <= eip) return { loopStart: target, jccAddr: eip + off, jccLen: 6, jccType: b2 - 0x10 };
        }
      }
    }
    // E2 cb — LOOP rel8  (dec ECX, jump if ECX != 0)
    if (b === 0xE2) {
      const rel = mem.readU8(eip + off + 1);
      if (rel >= 0x80) {
        const target = (eip + off + 2 + ((rel << 24) >> 24)) >>> 0;
        if (target <= eip) return { loopStart: target, jccAddr: eip + off, jccLen: 2, jccType: 0xE2 };
      }
    }
  }
  return null;
}

function executeLoop(cpu: { reg: Int32Array; eip: number },
                     mem: { readU8(a: number): number; readU16(a: number): number; readU32(a: number): number;
                            writeU8(a: number, v: number): void; writeU16(a: number, v: number): void; writeU32(a: number, v: number): void },
                     loop: LoopInfo): number {
  const { insns, counterReg, endAddr } = loop;
  if (counterReg < 0) return 0;
  const count = cpu.reg[counterReg] | 0;
  if (count <= 0) return 0;

  const r = new Int32Array(8);
  for (let i = 0; i < 8; i++) r[i] = cpu.reg[i];
  let carry = 0, iters = 0;

  for (let n = count; n > 0; n--) {
    carry = 0;
    for (let i = 0; i < insns.length; i++) {
      const I = insns[i]; let a: number, b: number, s: number, addr: number;
      switch (I.op) {
        case Op.ADD_RR: a = r[I.dst]>>>0; b = r[I.src]>>>0; r[I.dst] = (a+b)|0; carry = (a+b) > 0xFFFFFFFF ? 1 : 0; break;
        case Op.ADD_RI: r[I.dst] = (r[I.dst]+I.imm)|0; break;
        case Op.SUB_RR: r[I.dst] = (r[I.dst]-r[I.src])|0; break;
        case Op.SUB_RI: r[I.dst] = (r[I.dst]-I.imm)|0; break;
        case Op.ADC_RR: a = r[I.dst]>>>0; b = r[I.src]>>>0; s = a+b+carry; r[I.dst] = s|0; carry = s > 0xFFFFFFFF ? 1 : 0; break;
        case Op.SBB_RR: a = r[I.dst]>>>0; b = r[I.src]>>>0; r[I.dst] = (a-b-carry)|0; carry = a < b+carry ? 1 : 0; break;
        case Op.AND_RR: r[I.dst] &= r[I.src]; break;
        case Op.AND_RI: r[I.dst] &= I.imm; break;
        case Op.OR_RR:  r[I.dst] |= r[I.src]; break;
        case Op.OR_RI:  r[I.dst] |= I.imm; break;
        case Op.XOR_RR: r[I.dst] ^= r[I.src]; break;
        case Op.XOR_RI: r[I.dst] ^= I.imm; break;
        case Op.NOT: r[I.dst] = ~r[I.dst]; break;
        case Op.NEG: r[I.dst] = (-r[I.dst])|0; break;
        case Op.SHL_RI: r[I.dst] = (r[I.dst] << I.imm)|0; break;
        case Op.SHR_RI: r[I.dst] = (r[I.dst] >>> I.imm)|0; break;
        case Op.SAR_RI: r[I.dst] = (r[I.dst] >> I.imm)|0; break;
        case Op.INC: r[I.dst] = (r[I.dst]+1)|0; break;
        case Op.DEC: r[I.dst] = (r[I.dst]-1)|0; break;
        case Op.MOV_RR: r[I.dst] = r[I.src]; break;
        case Op.MOV_RI: r[I.dst] = I.imm; break;
        case Op.CMP_RR: case Op.CMP_RI: case Op.TEST_RR: break; // flags-only, no effect on regs
        case Op.LEA: addr = I.disp; if (I.base >= 0) addr += r[I.base]; if (I.scale > 0) addr += r[I.src] * I.scale; r[I.dst] = addr|0; break;
        case Op.MOVZX8: r[I.dst] = r[I.src] & 0xFF; break;
        case Op.LOAD8: addr = ((r[I.base]>>>0)+I.disp)>>>0; r[I.dst] = I.imm ? mem.readU8(addr) : (r[I.dst]&~0xFF)|mem.readU8(addr); break;
        case Op.LOAD32: r[I.dst] = mem.readU32(((r[I.base]>>>0)+I.disp)>>>0)|0; break;
        case Op.LOAD32_SIB: r[I.dst] = mem.readU32(((r[I.src]>>>0)*I.scale+I.disp)>>>0)|0; break;
        case Op.LOAD32_BSIB: r[I.dst] = mem.readU32(((r[I.base]>>>0)+(r[I.src]>>>0)*I.scale+I.disp)>>>0)|0; break;
        case Op.STORE8: mem.writeU8(((r[I.base]>>>0)+I.disp)>>>0, r[I.src]&0xFF); break;
        case Op.STORE16: mem.writeU16(((r[I.base]>>>0)+I.disp)>>>0, r[I.src]&0xFFFF); break;
        case Op.STORE32: mem.writeU32(((r[I.base]>>>0)+I.disp)>>>0, r[I.src]); break;
      }
    }
    iters++;
  }
  for (let i = 0; i < 8; i++) cpu.reg[i] = r[i];
  cpu.eip = endAddr;
  return iters;
}

// ---- Public API ----

/**
 * Attempt to detect and fast-forward a tight loop at the current EIP.
 * Returns the number of iterations completed, or 0 if no loop was found.
 */
export function tryFastLoop(cpu: { reg: Int32Array; eip: number },
                            mem: { readU8(a: number): number; readU16(a: number): number; readU32(a: number): number;
                                   writeU8(a: number, v: number): void; writeU16(a: number, v: number): void; writeU32(a: number, v: number): void }): number {
  const eip = cpu.eip >>> 0;

  const jcc = findBackwardJcc(mem, eip);
  if (!jcc) return 0;

  // Only fast-forward when EIP is exactly at the loop start.
  // Stepping forward to reach loop start is unsafe: cpu.step() may write
  // memory that we can't roll back, causing subtle data corruption.
  if (eip !== jcc.loopStart) return 0;

  const insns = decodeLoopBody(mem, jcc.loopStart, jcc.jccAddr);
  if (!insns || insns.length === 0 || insns.length > 32) return 0;

  // Find counter: a DEC'd register, or LOOP instruction (implicit ECX)
  let counterReg = -1;
  let cmpReg = -1;
  let cmpImm = 0;

  if (jcc.jccType === 0xE2) {
    // LOOP instruction: ECX is implicitly decremented
    counterReg = REG_ECX;
  } else {
    // Look for a single DEC
    let decCount = 0;
    for (const i of insns) {
      if (i.op === Op.DEC) { counterReg = i.dst; decCount++; }
    }
    if (decCount > 1) return 0; // multiple DECs — too complex

    // If no DEC, look for SUB reg, 1 (equivalent to DEC)
    if (counterReg < 0) {
      for (const i of insns) {
        if (i.op === Op.SUB_RI && i.imm === 1) {
          counterReg = i.dst;
          break;
        }
      }
    }
  }
  if (counterReg < 0) return 0;
  if (counterReg === REG_ESP || counterReg === REG_EBP) return 0;

  // Must write memory (side effect)
  const hasWrite = insns.some(i => i.op === Op.STORE8 || i.op === Op.STORE16 || i.op === Op.STORE32);
  if (!hasWrite) return 0;

  const loop: LoopInfo = {
    startAddr: jcc.loopStart,
    endAddr: jcc.jccAddr + jcc.jccLen,
    insns, counterReg, cmpReg, cmpImm,
    jccType: jcc.jccType,
  };

  const iters = executeLoop(cpu, mem, loop);
  if (iters > 0) {
    console.log(`[FAST-LOOP] ${iters} iters @ 0x${loop.startAddr.toString(16)}-0x${loop.endAddr.toString(16)} (${insns.length} ops, counter=r${counterReg})`);
  }
  return iters;
}
