import { ArmCPU, PC, LR, SP, N_FLAG, Z_FLAG, C_FLAG, V_FLAG } from './cpu';

/**
 * Execute one ARM instruction.
 * ARM instruction encoding reference: ARM Architecture Reference Manual (ARMv5)
 */
export function armStep(cpu: ArmCPU): void {
  const pc = cpu.reg[PC] >>> 0;
  const instr = cpu.mem.readU32(pc);
  cpu.reg[PC] = (pc + 4) | 0;

  // Condition check
  const cond = (instr >>> 28) & 0xF;
  if (cond !== 0xE && !cpu.testCC(cond)) return;

  const bits27_25 = (instr >>> 25) & 0x7;
  const bit4 = (instr >>> 4) & 1;
  const bit7 = (instr >>> 7) & 1;

  switch (bits27_25) {
    case 0: // Data processing (register) / Multiply / Misc
      if ((instr & 0x0FC000F0) === 0x00000090) {
        // Multiply: MUL/MLA
        execMultiply(cpu, instr);
      } else if ((instr & 0x0F8000F0) === 0x00800090) {
        // Long multiply: UMULL/UMLAL/SMULL/SMLAL
        execLongMultiply(cpu, instr);
      } else if ((instr & 0x0FB00FF0) === 0x01000090) {
        // SWP/SWPB
        execSwap(cpu, instr);
      } else if (bit4 && bit7 && ((instr & 0xF0) === 0xB0 || (instr & 0xF0) === 0xD0 || (instr & 0xF0) === 0xF0)) {
        // Halfword / signed byte load/store
        execHalfwordTransfer(cpu, instr);
      } else if ((instr & 0x0FB00000) === 0x01000000 && !bit4) {
        // MRS / MSR (register form)
        execMsrMrs(cpu, instr);
      } else if ((instr & 0x0FFFFFF0) === 0x012FFF10) {
        // BX (Branch and Exchange)
        const rm = instr & 0xF;
        cpu.reg[PC] = cpu.reg[rm] & ~1; // Clear Thumb bit for ARM mode
      } else if ((instr & 0x0FFFFFF0) === 0x016F0F10) {
        // CLZ (Count Leading Zeros) - ARMv5
        const rm = instr & 0xF;
        const rd = (instr >>> 12) & 0xF;
        const val = cpu.reg[rm] >>> 0;
        cpu.reg[rd] = val === 0 ? 32 : Math.clz32(val);
      } else {
        // Data processing (register shift or immediate shift)
        execDataProcessing(cpu, instr, false);
      }
      break;

    case 1: // Data processing (immediate) / MSR immediate
      if ((instr & 0x0FB00000) === 0x03200000) {
        // MSR immediate
        execMsrImm(cpu, instr);
      } else {
        execDataProcessing(cpu, instr, true);
      }
      break;

    case 2: // Load/Store word/byte (immediate offset)
      execSingleTransfer(cpu, instr);
      break;

    case 3: // Load/Store word/byte (register offset)
      if (bit4) {
        // Media instructions or undefined in ARMv5
        cpu.halted = true;
        cpu.haltReason = `Unknown ARM instruction: ${instr.toString(16).padStart(8, '0')} at 0x${pc.toString(16)}`;
      } else {
        execSingleTransfer(cpu, instr);
      }
      break;

    case 4: // Load/Store Multiple (LDM/STM)
      execBlockTransfer(cpu, instr);
      break;

    case 5: { // Branch / Branch with Link
      const offset = ((instr & 0x00FFFFFF) << 8) >> 6; // sign-extend 24-bit, shift left 2
      const link = (instr >>> 24) & 1;
      if (link) cpu.reg[LR] = cpu.reg[PC]; // PC already advanced by 4, so LR = next instr
      // ARM: target = instruction_addr + 8 + offset. PC = instruction_addr + 4, so +4 more.
      cpu.reg[PC] = (cpu.reg[PC] + 4 + offset) | 0;
      break;
    }

    case 6: // Coprocessor load/store (not needed for basic WinCE)
    case 7: // Coprocessor data processing / SWI
      if ((instr & 0x0F000000) === 0x0F000000) {
        // SWI (Software Interrupt)
        cpu.halted = true;
        cpu.haltReason = `SWI 0x${(instr & 0xFFFFFF).toString(16)} at 0x${pc.toString(16)} LR=0x${(cpu.reg[LR] >>> 0).toString(16)}`;
      } else {
        // Coprocessor instructions — ignore for now
      }
      break;
  }
}

function execDataProcessing(cpu: ArmCPU, instr: number, isImm: boolean): void {
  const opcode = (instr >>> 21) & 0xF;
  const setFlags = !!((instr >>> 20) & 1);
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const oldCarry = cpu.getC();

  let op2: number;
  let shiftCarry: boolean;

  if (isImm) {
    const decoded = cpu.decodeImm(instr);
    op2 = decoded.val;
    shiftCarry = decoded.carry;
  } else {
    const rm = instr & 0xF;
    const shiftType = (instr >>> 5) & 0x3;
    let shiftAmt: number;
    if ((instr >>> 4) & 1) {
      // Register shift
      const rs = (instr >>> 8) & 0xF;
      shiftAmt = cpu.reg[rs] & 0xFF;
      // When shift amount is 0 in register form, no shift occurs
      if (shiftAmt === 0) {
        op2 = cpu.reg[rm];
        shiftCarry = oldCarry;
      } else {
        const shifted = cpu.barrelShift(cpu.reg[rm], shiftType, shiftAmt, oldCarry);
        op2 = shifted.val;
        shiftCarry = shifted.carry;
      }
    } else {
      // Immediate shift
      shiftAmt = (instr >>> 7) & 0x1F;
      const shifted = cpu.barrelShift(cpu.reg[rm], shiftType, shiftAmt, oldCarry);
      op2 = shifted.val;
      shiftCarry = shifted.carry;
    }
  }

  const a = (rn === PC) ? ((cpu.reg[PC] + 4) >>> 0) : cpu.reg[rn]; // PC reads as PC+8 from instruction address
  const ua = a >>> 0;
  const uop2 = op2 >>> 0;
  let result: number;
  let carry = oldCarry;
  let overflow = cpu.getV();

  switch (opcode) {
    case 0x0: // AND
      result = (a & op2) >>> 0;
      carry = shiftCarry;
      break;
    case 0x1: // EOR
      result = (a ^ op2) >>> 0;
      carry = shiftCarry;
      break;
    case 0x2: { // SUB
      const r = ua - uop2;
      result = r >>> 0;
      carry = ua >= uop2;
      overflow = !!((a ^ op2) & (a ^ (r | 0)) & 0x80000000);
      break;
    }
    case 0x3: { // RSB
      const r = uop2 - ua;
      result = r >>> 0;
      carry = uop2 >= ua;
      overflow = !!((op2 ^ a) & (op2 ^ (r | 0)) & 0x80000000);
      break;
    }
    case 0x4: { // ADD
      const r = ua + uop2;
      result = r >>> 0;
      carry = r > 0xFFFFFFFF;
      overflow = !!((~(a ^ op2)) & (a ^ (r | 0)) & 0x80000000);
      break;
    }
    case 0x5: { // ADC
      const c = oldCarry ? 1 : 0;
      const r = ua + uop2 + c;
      result = r >>> 0;
      carry = r > 0xFFFFFFFF;
      overflow = !!((~(a ^ op2)) & (a ^ (result | 0)) & 0x80000000);
      break;
    }
    case 0x6: { // SBC
      const c = oldCarry ? 0 : 1;
      const r = ua - uop2 - c;
      result = r >>> 0;
      carry = ua >= (uop2 + c);
      overflow = !!((a ^ op2) & (a ^ (r | 0)) & 0x80000000);
      break;
    }
    case 0x7: { // RSC
      const c = oldCarry ? 0 : 1;
      const r = uop2 - ua - c;
      result = r >>> 0;
      carry = uop2 >= (ua + c);
      overflow = !!((op2 ^ a) & (op2 ^ (r | 0)) & 0x80000000);
      break;
    }
    case 0x8: // TST
      result = (a & op2) >>> 0;
      carry = shiftCarry;
      if (setFlags) cpu.setNZCV(result, carry, overflow);
      return; // no write to Rd
    case 0x9: // TEQ
      result = (a ^ op2) >>> 0;
      carry = shiftCarry;
      if (setFlags) cpu.setNZCV(result, carry, overflow);
      return;
    case 0xA: { // CMP
      const r = ua - uop2;
      result = r >>> 0;
      carry = ua >= uop2;
      overflow = !!((a ^ op2) & (a ^ (r | 0)) & 0x80000000);
      if (setFlags) cpu.setNZCV(result, carry, overflow);
      return;
    }
    case 0xB: { // CMN
      const r = ua + uop2;
      result = r >>> 0;
      carry = r > 0xFFFFFFFF;
      overflow = !!((~(a ^ op2)) & (a ^ (r | 0)) & 0x80000000);
      if (setFlags) cpu.setNZCV(result, carry, overflow);
      return;
    }
    case 0xC: // ORR
      result = (a | op2) >>> 0;
      carry = shiftCarry;
      break;
    case 0xD: // MOV
      result = op2 >>> 0;
      carry = shiftCarry;
      break;
    case 0xE: // BIC
      result = (a & ~op2) >>> 0;
      carry = shiftCarry;
      break;
    case 0xF: // MVN
      result = (~op2) >>> 0;
      carry = shiftCarry;
      break;
    default:
      return;
  }

  if (rd === PC) {
    cpu.reg[PC] = result;
    if (setFlags) {
      // MOVS PC, ... restores CPSR from SPSR (not needed for user mode)
    }
  } else {
    cpu.reg[rd] = result;
    if (setFlags) cpu.setNZCV(result, carry, overflow);
  }
}

function execMultiply(cpu: ArmCPU, instr: number): void {
  const rd = (instr >>> 16) & 0xF;
  const rn = (instr >>> 12) & 0xF;
  const rs = (instr >>> 8) & 0xF;
  const rm = instr & 0xF;
  const setFlags = !!((instr >>> 20) & 1);
  const accumulate = !!((instr >>> 21) & 1);

  let result = Math.imul(cpu.reg[rm], cpu.reg[rs]);
  if (accumulate) result = (result + cpu.reg[rn]) | 0;

  cpu.reg[rd] = result;
  if (setFlags) cpu.setNZ(result >>> 0);
}

function execLongMultiply(cpu: ArmCPU, instr: number): void {
  const rdHi = (instr >>> 16) & 0xF;
  const rdLo = (instr >>> 12) & 0xF;
  const rs = (instr >>> 8) & 0xF;
  const rm = instr & 0xF;
  const setFlags = !!((instr >>> 20) & 1);
  const accumulate = !!((instr >>> 21) & 1);
  const isSigned = !!((instr >>> 22) & 1);

  let result: bigint;
  if (isSigned) {
    result = BigInt(cpu.reg[rm]) * BigInt(cpu.reg[rs]);
  } else {
    result = BigInt(cpu.reg[rm] >>> 0) * BigInt(cpu.reg[rs] >>> 0);
  }
  if (accumulate) {
    const hi = BigInt(cpu.reg[rdHi] >>> 0);
    const lo = BigInt(cpu.reg[rdLo] >>> 0);
    result += (hi << 32n) | lo;
  }

  cpu.reg[rdLo] = Number(result & 0xFFFFFFFFn);
  cpu.reg[rdHi] = Number((result >> 32n) & 0xFFFFFFFFn);
  if (setFlags) {
    cpu.setNZ(((cpu.reg[rdHi] >>> 0) === 0 && (cpu.reg[rdLo] >>> 0) === 0) ? 0 : (cpu.reg[rdHi] & 0x80000000) ? 0x80000000 : 1);
  }
}

function execSwap(cpu: ArmCPU, instr: number): void {
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const rm = instr & 0xF;
  const isByte = !!((instr >>> 22) & 1);
  const addr = cpu.reg[rn] >>> 0;

  if (isByte) {
    const tmp = cpu.mem.readU8(addr);
    cpu.mem.writeU8(addr, cpu.reg[rm] & 0xFF);
    cpu.reg[rd] = tmp;
  } else {
    const tmp = cpu.mem.readU32(addr);
    cpu.mem.writeU32(addr, cpu.reg[rm] >>> 0);
    cpu.reg[rd] = tmp;
  }
}

function execSingleTransfer(cpu: ArmCPU, instr: number): void {
  const isImm = !((instr >>> 25) & 1); // bit25=0 means immediate offset
  const preIndex = !!((instr >>> 24) & 1);
  const addOffset = !!((instr >>> 23) & 1);
  const isByte = !!((instr >>> 22) & 1);
  const writeBack = !!((instr >>> 21) & 1);
  const isLoad = !!((instr >>> 20) & 1);
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;

  let offset: number;
  if (isImm) {
    offset = instr & 0xFFF;
  } else {
    const rm = instr & 0xF;
    const shiftType = (instr >>> 5) & 0x3;
    const shiftAmt = (instr >>> 7) & 0x1F;
    const shifted = cpu.barrelShift(cpu.reg[rm], shiftType, shiftAmt, cpu.getC());
    offset = shifted.val;
  }

  let base = (rn === PC) ? ((cpu.reg[PC] + 4) >>> 0) : cpu.reg[rn]; // PC+8 from instr addr
  base = base >>> 0;
  const effectiveAddr = addOffset ? (base + offset) >>> 0 : (base - offset) >>> 0;
  const addr = preIndex ? effectiveAddr : base;

  if (isLoad) {
    if (isByte) {
      cpu.reg[rd] = cpu.mem.readU8(addr);
    } else {
      // Word load — unaligned addresses rotate
      const aligned = addr & ~3;
      let val = cpu.mem.readU32(aligned);
      const rot = (addr & 3) * 8;
      if (rot) val = ((val >>> rot) | (val << (32 - rot))) >>> 0;
      cpu.reg[rd] = val;
    }
    if (rd === PC) {
      // Branch via LDR PC — already set
    }
  } else {
    const val = (rd === PC) ? ((cpu.reg[PC] + 4) >>> 0) : cpu.reg[rd];
    if (isByte) {
      cpu.mem.writeU8(addr, val & 0xFF);
    } else {
      cpu.mem.writeU32(addr & ~3, val >>> 0);
    }
  }

  if (!preIndex) {
    // Post-index: always write back
    cpu.reg[rn] = effectiveAddr;
  } else if (writeBack) {
    cpu.reg[rn] = effectiveAddr;
  }
}

function execHalfwordTransfer(cpu: ArmCPU, instr: number): void {
  const preIndex = !!((instr >>> 24) & 1);
  const addOffset = !!((instr >>> 23) & 1);
  const isImmOffset = !!((instr >>> 22) & 1);
  const writeBack = !!((instr >>> 21) & 1);
  const isLoad = !!((instr >>> 20) & 1);
  const rn = (instr >>> 16) & 0xF;
  const rd = (instr >>> 12) & 0xF;
  const sh = (instr >>> 5) & 0x3; // SH bits: 01=H, 10=SB, 11=SH

  let offset: number;
  if (isImmOffset) {
    offset = ((instr >>> 4) & 0xF0) | (instr & 0xF);
  } else {
    const rm = instr & 0xF;
    offset = cpu.reg[rm] >>> 0;
  }

  let base = (rn === PC) ? ((cpu.reg[PC] + 4) >>> 0) : cpu.reg[rn];
  base = base >>> 0;
  const effectiveAddr = addOffset ? (base + offset) >>> 0 : (base - offset) >>> 0;
  const addr = preIndex ? effectiveAddr : base;

  if (isLoad) {
    switch (sh) {
      case 1: // LDRH
        cpu.reg[rd] = cpu.mem.readU16(addr & ~1);
        break;
      case 2: // LDRSB
        cpu.reg[rd] = cpu.mem.readI8(addr);
        break;
      case 3: // LDRSH
        cpu.reg[rd] = cpu.mem.readI16(addr & ~1);
        break;
    }
  } else {
    if (sh === 1) { // STRH
      cpu.mem.writeU16(addr & ~1, cpu.reg[rd] & 0xFFFF);
    }
    // LDRD/STRD (sh=2,3 when !isLoad) — rare, skip for now
  }

  if (!preIndex) {
    cpu.reg[rn] = effectiveAddr;
  } else if (writeBack) {
    cpu.reg[rn] = effectiveAddr;
  }
}

function execBlockTransfer(cpu: ArmCPU, instr: number): void {
  const preIndex = !!((instr >>> 24) & 1);
  const addOffset = !!((instr >>> 23) & 1);
  const writeBack = !!((instr >>> 21) & 1);
  const isLoad = !!((instr >>> 20) & 1);
  const rn = (instr >>> 16) & 0xF;
  const regList = instr & 0xFFFF;

  let base = cpu.reg[rn] >>> 0;
  const regCount = popcount16(regList);

  // Calculate start address based on addressing mode
  let addr: number;
  if (addOffset) {
    addr = preIndex ? (base + 4) >>> 0 : base;
  } else {
    addr = preIndex ? (base - regCount * 4) >>> 0 : ((base - regCount * 4 + 4) >>> 0);
  }

  for (let i = 0; i < 16; i++) {
    if (!(regList & (1 << i))) continue;
    if (isLoad) {
      cpu.reg[i] = cpu.mem.readU32(addr);
    } else {
      let val = cpu.reg[i];
      if (i === PC) val = (val + 4) >>> 0; // STM stores PC+12 in some implementations, but PC+8 is more common
      cpu.mem.writeU32(addr, val >>> 0);
    }
    addr = (addr + 4) >>> 0;
  }

  // Write-back: skip if Rn is in the register list for loads (loaded value takes precedence)
  if (writeBack && !(isLoad && (regList & (1 << rn)))) {
    if (addOffset) {
      cpu.reg[rn] = (base + regCount * 4) >>> 0;
    } else {
      cpu.reg[rn] = (base - regCount * 4) >>> 0;
    }
  }
}

function execMsrMrs(cpu: ArmCPU, instr: number): void {
  const isMSR = !!((instr >>> 21) & 1);
  if (isMSR) {
    // MSR CPSR, Rm
    const rm = instr & 0xF;
    const mask = (instr >>> 16) & 0xF;
    let val = cpu.reg[rm] >>> 0;
    let cpsr = cpu.cpsr;
    if (mask & 8) cpsr = (cpsr & 0x00FFFFFF) | (val & 0xFF000000); // flags
    if (mask & 1) cpsr = (cpsr & 0xFFFFFF00) | (val & 0x000000FF); // control
    cpu.cpsr = cpsr;
  } else {
    // MRS Rd, CPSR
    const rd = (instr >>> 12) & 0xF;
    cpu.reg[rd] = cpu.cpsr;
  }
}

function execMsrImm(cpu: ArmCPU, instr: number): void {
  const mask = (instr >>> 16) & 0xF;
  const imm8 = instr & 0xFF;
  const rotate = ((instr >>> 8) & 0xF) * 2;
  const val = rotate === 0 ? imm8 : (((imm8 >>> rotate) | (imm8 << (32 - rotate))) >>> 0);
  let cpsr = cpu.cpsr;
  if (mask & 8) cpsr = (cpsr & 0x00FFFFFF) | (val & 0xFF000000);
  if (mask & 1) cpsr = (cpsr & 0xFFFFFF00) | (val & 0x000000FF);
  cpu.cpsr = cpsr;
}

function popcount16(x: number): number {
  x = x - ((x >>> 1) & 0x5555);
  x = (x & 0x3333) + ((x >>> 2) & 0x3333);
  x = (x + (x >>> 4)) & 0x0F0F;
  return (x + (x >>> 8)) & 0x1F;
}
