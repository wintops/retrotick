import type { CPU } from './cpu';
import { execFPU } from './fpu';
import { exec0F } from './ops-0f';
import { doShift } from './shift';
import { doMovs, doStos, doLods, doCmps, doScas } from './string';
import { handleDosInt } from '../dos/index';
import { LazyOp } from './lazy-op';

// Register indices
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

// Flag bits
const CF = 0x001;
const ZF = 0x040;
const IF = 0x200;
const DF = 0x400;
const OF = 0x800;

/** Dispatch a CPU exception/interrupt through handleDosInt or IDT (protected mode). */
function dispatchException(cpu: CPU, intNum: number): boolean {
  // Try JS-handled DOS/BIOS interrupts first
  if (cpu.emu && handleDosInt(cpu, intNum, cpu.emu)) return true;
  // Protected mode: dispatch through IDT
  if (!cpu.realMode && cpu.emu && cpu.emu._idtBase) {
    const idtEntry = cpu.emu._idtBase + intNum * 8;
    if (intNum * 8 + 7 <= cpu.emu._idtLimit) {
      const lo = cpu.mem.readU32(idtEntry);
      const hi = cpu.mem.readU32(idtEntry + 4);
      const offsetLo = lo & 0xFFFF;
      const selector = (lo >>> 16) & 0xFFFF;
      const typeAttr = (hi >>> 8) & 0xFF;
      const offsetHi = (hi >>> 16) & 0xFFFF;
      const present = (typeAttr & 0x80) !== 0;
      const gateType = typeAttr & 0x0F;
      if (present && selector !== 0) {
        const is32 = (gateType === 0x0E || gateType === 0x0F);
        const offset = is32 ? ((offsetHi << 16) | offsetLo) >>> 0 : offsetLo;
        const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & (is32 ? 0xFFFFFFFF : 0xFFFF);
        if (is32) {
          cpu.push32(cpu.getFlags());
          cpu.push32(cpu.cs);
          cpu.push32(returnIP);
        } else {
          cpu.push16(cpu.getFlags() & 0xFFFF);
          cpu.push16(cpu.cs);
          cpu.push16(returnIP & 0xFFFF);
        }
        if (gateType === 0x06 || gateType === 0x0E) {
          cpu.setFlags(cpu.getFlags() & ~0x0200); // clear IF
        }
        cpu.setFlags(cpu.getFlags() & ~0x0100); // clear TF
        cpu.loadCS(selector);
        cpu.eip = cpu.segBase(selector) + offset;
        return true;
      }
    }
  }
  return false;
}

function raiseDivideError(cpu: CPU, instrEip: number): void {
  const csBase = (cpu.cs << 4) >>> 0;
  const ip = (instrEip - csBase) & 0xFFFF;
  console.warn(`[DIV ERROR] at CS:IP=${cpu.cs.toString(16)}:${ip.toString(16)} (linear 0x${instrEip.toString(16)}) AX=0x${(cpu.reg[0] & 0xFFFF).toString(16)} BX=0x${(cpu.reg[3] & 0xFFFF).toString(16)} CX=0x${(cpu.reg[1] & 0xFFFF).toString(16)} DX=0x${(cpu.reg[2] & 0xFFFF).toString(16)}`);
  const bytes: string[] = [];
  for (let i = 0; i < 8; i++) bytes.push(cpu.mem.readU8((instrEip + i) >>> 0).toString(16).padStart(2, '0'));
  console.warn(`[DIV ERROR] bytes: ${bytes.join(' ')}`);
  cpu.eip = instrEip; // rewind to faulting instruction
  if (dispatchException(cpu, 0)) return;
  cpu.haltReason = 'integer divide by zero';
  cpu.halted = true;
}

export function dumpInstrTrace(): void {}
const _instrRing: string[] = new Array(200).fill('');
let _instrRingIdx = 0;
let _instrRingDumped = false;

export function cpuStep(cpu: CPU): void {
  const instrEip = cpu.eip; // save for fault reporting (e.g. divide error)
  // Per-instruction trace ring buffer (disabled for perf)
  if (false && cpu.emu && cpu.emu.cpuSteps > 90000000) {
    const csBase_t = (cpu.cs << 4) >>> 0;
    const ip_t = (instrEip - csBase_t) & 0xFFFF;
    const ax = cpu.reg[0] & 0xFFFF, bx = cpu.reg[3] & 0xFFFF, cx = cpu.reg[1] & 0xFFFF, dx = cpu.reg[2] & 0xFFFF;
    const sp_t = cpu.reg[4] & 0xFFFF, bp_t = cpu.reg[5] & 0xFFFF;
    const si_t = cpu.reg[6] & 0xFFFF, di_t = cpu.reg[7] & 0xFFFF;
    const b0 = cpu.mem.readU8(instrEip), b1 = cpu.mem.readU8((instrEip+1)>>>0), b2 = cpu.mem.readU8((instrEip+2)>>>0);
    _instrRing[_instrRingIdx % 200] = `${cpu.cs.toString(16)}:${ip_t.toString(16).padStart(4,'0')} [${b0.toString(16).padStart(2,'0')} ${b1.toString(16).padStart(2,'0')} ${b2.toString(16).padStart(2,'0')}] AX=${ax.toString(16)} BX=${bx.toString(16)} CX=${cx.toString(16)} DX=${dx.toString(16)} SP=${sp_t.toString(16)} BP=${bp_t.toString(16)} SI=${si_t.toString(16)} DI=${di_t.toString(16)} SS=${cpu.ss.toString(16)} DS=${cpu.ds.toString(16)} ES=${cpu.es.toString(16)}`;
    _instrRingIdx++;
    // Dump when we hit the XMS stub with srcOffset=0 for handle 12
    if (cpu.cs === 0xf000 && ip_t === 0x0800 && !_instrRingDumped && (cpu.reg[0] >>> 8) === 0x0B) {
      // Check if this is the bad XMS move (srcHandle=12, srcOffset=0)
      const structAddr2 = cpu.segBase(cpu.ds) + (cpu.reg[6] & 0xFFFF);
      const srcH = cpu.mem.readU16(structAddr2 + 4);
      const srcO = cpu.mem.readU32(structAddr2 + 6);
      if (srcH === 12 && srcO === 0) {
      _instrRingDumped = true;
      console.warn(`[TRACE] Last 200 instructions before bad XMS move (step ${cpu.emu.cpuSteps}):`);
      for (let i = 0; i < 200; i++) {
        const idx = (_instrRingIdx - 200 + i) % 200;
        if (_instrRing[idx]) console.warn(`  ${_instrRing[idx]}`);
      }
    }}
  }
  let prefix66 = false;  // operand-size override
  let prefix67 = false;  // address-size override
  let prefixF2 = false;  // REPNE
  let prefixF3 = false;  // REP
  cpu._segOverride = 0;

  // Parse prefixes + fetch opcode in a single pass (avoids double-reading the first byte)
  let opcode = cpu.mem.readU8(cpu.eip >>> 0);
  cpu.eip = (cpu.eip + 1) | 0;
  for (;;) {
    if (opcode === 0x66) { prefix66 = true; }
    else if (opcode === 0x67) { prefix67 = true; }
    else if (opcode === 0xF2) { prefixF2 = true; }
    else if (opcode === 0xF3) { prefixF3 = true; }
    else if (opcode === 0x64) { cpu._segOverride = 0x64; }
    else if (opcode === 0x26 || opcode === 0x2E || opcode === 0x36 || opcode === 0x3E || opcode === 0x65) {
      cpu._segOverride = opcode;
    } else {
      break; // opcode is set, EIP already past it
    }
    opcode = cpu.mem.readU8(cpu.eip >>> 0);
    cpu.eip = (cpu.eip + 1) | 0;
  }

  const defaultOpSize = cpu.use32 ? 32 : 16;
  const opSize = prefix66 ? (defaultOpSize === 32 ? 16 : 32) : defaultOpSize;
  cpu._addrSize16 = cpu.use32 ? prefix67 : !prefix67;

  // ALU pattern: opcodes 0x00-0x3F
  if (opcode < 0x40 && (opcode & 0x06) !== 0x06) {
    const aluOp = (opcode >> 3) & 7;
    const dir = opcode & 7;

    if (dir === 4) {
      // AL, imm8
      const imm = cpu.fetch8();
      const result = cpu.alu(aluOp, cpu.getReg8(EAX), imm, 8);
      if (aluOp !== 7) cpu.setReg8(EAX, result);
    } else if (dir === 5) {
      // EAX/AX, imm16/32
      if (opSize === 16) {
        const imm = cpu.fetch16();
        const result = cpu.alu(aluOp, cpu.getReg16(EAX), imm, 16);
        if (aluOp !== 7) cpu.setReg16(EAX, result);
      } else {
        const imm = cpu.fetch32();
        const result = cpu.alu(aluOp, cpu.reg[EAX] | 0, imm | 0, 32);
        if (aluOp !== 7) cpu.reg[EAX] = result;
      }
    } else if (dir === 0) {
      // r/m8, reg8
      const d = cpu.decodeModRM(8);
      const result = cpu.alu(aluOp, d.val, cpu.getReg8(d.regField), 8);
      if (aluOp !== 7) cpu.writeModRM(d, result, 8);
    } else if (dir === 1) {
      // r/m16/32, reg16/32
      const d = cpu.decodeModRM(opSize);
      const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField] | 0;
      const result = cpu.alu(aluOp, d.val, regVal, opSize as 8 | 16 | 32);
      if (aluOp !== 7) cpu.writeModRM(d, result, opSize);
    } else if (dir === 2) {
      // reg8, r/m8
      const d = cpu.decodeModRM(8);
      const result = cpu.alu(aluOp, cpu.getReg8(d.regField), d.val, 8);
      if (aluOp !== 7) cpu.setReg8(d.regField, result);
    } else if (dir === 3) {
      // reg16/32, r/m16/32
      const d = cpu.decodeModRM(opSize);
      const regVal = opSize === 16 ? cpu.getReg16(d.regField) : cpu.reg[d.regField] | 0;
      const result = cpu.alu(aluOp, regVal, d.val, opSize as 8 | 16 | 32);
      if (aluOp !== 7) {
        if (opSize === 16) cpu.setReg16(d.regField, result);
        else cpu.reg[d.regField] = result;
      }
    }
    return;
  }

  switch (opcode) {
    // INC r32 (0x40-0x47)
    case 0x40: case 0x41: case 0x42: case 0x43:
    case 0x44: case 0x45: case 0x46: case 0x47: {
      const r = opcode - 0x40;
      if (opSize === 16) {
        const v = (cpu.getReg16(r) + 1) & 0xFFFF;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF16 = cpu.flagsCache & (DF | 0x7300);
        cpu.setReg16(r, v);
        cpu.setLazy(LazyOp.INC16, v, 0, 0);
        cpu.flagsCache = savedCF | savedDF16;
      } else {
        const v = (cpu.reg[r] + 1) | 0;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF32 = cpu.flagsCache & (DF | 0x7300);
        cpu.reg[r] = v;
        cpu.setLazy(LazyOp.INC32, v, 0, 0);
        cpu.flagsCache = savedCF | savedDF32;
      }
      break;
    }

    // DEC r32 (0x48-0x4F)
    case 0x48: case 0x49: case 0x4A: case 0x4B:
    case 0x4C: case 0x4D: case 0x4E: case 0x4F: {
      const r = opcode - 0x48;
      if (opSize === 16) {
        const v = (cpu.getReg16(r) - 1) & 0xFFFF;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF = cpu.flagsCache & (DF | 0x7300);
        cpu.setReg16(r, v);
        cpu.setLazy(LazyOp.DEC16, v, 0, 0);
        cpu.flagsCache = savedCF | savedDF;
      } else {
        const v = (cpu.reg[r] - 1) | 0;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF = cpu.flagsCache & (DF | 0x7300);
        cpu.reg[r] = v;
        cpu.setLazy(LazyOp.DEC32, v, 0, 0);
        cpu.flagsCache = savedCF | savedDF;
      }
      break;
    }

    // PUSH ES (0x06), PUSH CS (0x0E), PUSH SS (0x16), PUSH DS (0x1E)
    case 0x06:
      if (opSize === 16) cpu.push16(cpu.es);
      else cpu.push32(cpu.es);
      break;
    case 0x0E:
      if (opSize === 16) cpu.push16(cpu.cs);
      else cpu.push32(cpu.cs);
      break;
    case 0x16:
      if (opSize === 16) cpu.push16(cpu.ss);
      else cpu.push32(cpu.ss);
      break;
    case 0x1E:
      if (opSize === 16) cpu.push16(cpu.ds);
      else cpu.push32(cpu.ds);
      break;

    // POP ES (0x07), POP SS (0x17), POP DS (0x1F)
    case 0x07:
      cpu.es = opSize === 16 ? cpu.pop16() : cpu.pop32() & 0xFFFF;
      break;
    case 0x17:
      cpu.ss = opSize === 16 ? cpu.pop16() : cpu.pop32() & 0xFFFF;
      cpu._inhibitTF = true; // POP SS suppresses TF trap
      cpu._inhibitIRQ = true; // POP SS inhibits HW IRQ for next instruction
      break;
    case 0x1F:
      cpu.ds = opSize === 16 ? cpu.pop16() : cpu.pop32() & 0xFFFF;
      break;

    // PUSH r32 (0x50-0x57)
    case 0x50: case 0x51: case 0x52: case 0x53:
    case 0x54: case 0x55: case 0x56: case 0x57:
      if (opSize === 16) cpu.push16(cpu.getReg16(opcode - 0x50));
      else cpu.push32(cpu.reg[opcode - 0x50] | 0);
      break;

    // POP r32 (0x58-0x5F)
    case 0x58: case 0x59: case 0x5A: case 0x5B:
    case 0x5C: case 0x5D: case 0x5E: case 0x5F:
      if (opSize === 16) cpu.setReg16(opcode - 0x58, cpu.pop16());
      else cpu.reg[opcode - 0x58] = cpu.pop32() | 0;
      break;

    // PUSHAD / PUSHA
    case 0x60: {
      if (opSize === 16) {
        const tmp = cpu.getReg16(ESP);
        cpu.push16(cpu.getReg16(EAX));
        cpu.push16(cpu.getReg16(ECX));
        cpu.push16(cpu.getReg16(EDX));
        cpu.push16(cpu.getReg16(EBX));
        cpu.push16(tmp);
        cpu.push16(cpu.getReg16(EBP));
        cpu.push16(cpu.getReg16(ESI));
        cpu.push16(cpu.getReg16(EDI));
      } else {
        const tmp = cpu.reg[ESP] | 0;
        cpu.push32(cpu.reg[EAX]);
        cpu.push32(cpu.reg[ECX]);
        cpu.push32(cpu.reg[EDX]);
        cpu.push32(cpu.reg[EBX]);
        cpu.push32(tmp);
        cpu.push32(cpu.reg[EBP]);
        cpu.push32(cpu.reg[ESI]);
        cpu.push32(cpu.reg[EDI]);
      }
      break;
    }

    // POPAD / POPA
    case 0x61: {
      if (opSize === 16) {
        cpu.setReg16(EDI, cpu.pop16());
        cpu.setReg16(ESI, cpu.pop16());
        cpu.setReg16(EBP, cpu.pop16());
        cpu.pop16(); // skip SP
        cpu.setReg16(EBX, cpu.pop16());
        cpu.setReg16(EDX, cpu.pop16());
        cpu.setReg16(ECX, cpu.pop16());
        cpu.setReg16(EAX, cpu.pop16());
      } else {
        cpu.reg[EDI] = cpu.pop32() | 0;
        cpu.reg[ESI] = cpu.pop32() | 0;
        cpu.reg[EBP] = cpu.pop32() | 0;
        cpu.pop32(); // skip ESP
        cpu.reg[EBX] = cpu.pop32() | 0;
        cpu.reg[EDX] = cpu.pop32() | 0;
        cpu.reg[ECX] = cpu.pop32() | 0;
        cpu.reg[EAX] = cpu.pop32() | 0;
      }
      break;
    }

    // BOUND r16/32, m16/32&16/32 — check array index against bounds
    case 0x62: {
      const d = cpu.decodeModRM(opSize);
      if (d.isReg) break; // undefined for register operand
      if (opSize === 16) {
        const idx = d.regField;
        const val = cpu.getReg16(idx) << 16 >> 16; // sign-extend
        const lo = cpu.mem.readI16(d.addr);
        const hi = cpu.mem.readI16((d.addr + 2) >>> 0);
        if (val < lo || val > hi) {
          // BOUND range exceeded — dispatch INT 5
          cpu.eip = instrEip;
          if (dispatchException(cpu, 5)) break;
          cpu.haltReason = 'BOUND range exceeded';
          cpu.halted = true;
        }
      } else {
        const idx = d.regField;
        const val = cpu.reg[idx] | 0;
        const lo = cpu.mem.readI32(d.addr);
        const hi = cpu.mem.readI32((d.addr + 4) >>> 0);
        if (val < lo || val > hi) {
          cpu.eip = instrEip;
          if (dispatchException(cpu, 5)) break;
          cpu.haltReason = 'BOUND range exceeded';
          cpu.halted = true;
        }
      }
      break;
    }

    // PUSH imm32
    case 0x68:
      if (opSize === 16) cpu.push16(cpu.fetch16());
      else cpu.push32(cpu.fetch32());
      break;

    // IMUL r32, r/m32, imm32
    case 0x69: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const imm = (cpu.fetch16() << 16 >> 16); // sign extend
        const result = (d.val << 16 >> 16) * imm;
        cpu.setReg16(d.regField, result & 0xFFFF);
        const truncated = (result << 16) >> 16;
        const of = truncated !== result;
        const f = cpu.getFlags() & ~(CF | OF);
        cpu.setFlags(f | (of ? CF | OF : 0));
      } else {
        const imm = cpu.fetchI32();
        const r64 = BigInt(d.val | 0) * BigInt(imm);
        const result = Number(r64 & 0xFFFFFFFFn) | 0;
        cpu.reg[d.regField] = result;
        // CF and OF are set if result overflows signed 32-bit range
        const of = r64 !== BigInt(result);
        cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
      }
      break;
    }

    // PUSH imm8 (sign-extended)
    case 0x6A: {
      const imm = cpu.fetchI8();
      if (opSize === 16) cpu.push16(imm & 0xFFFF);
      else cpu.push32(imm);
      break;
    }

    // IMUL r32, r/m32, imm8
    case 0x6B: {
      const d = cpu.decodeModRM(opSize);
      const imm = cpu.fetchI8();
      if (opSize === 16) {
        const result = (d.val << 16 >> 16) * imm;
        cpu.setReg16(d.regField, result & 0xFFFF);
        const truncated = (result << 16) >> 16;
        const of = truncated !== result;
        cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
      } else {
        const r64 = BigInt(d.val | 0) * BigInt(imm);
        const result = Number(r64 & 0xFFFFFFFFn) | 0;
        cpu.reg[d.regField] = result;
        // CF and OF are set if result overflows signed 32-bit range
        const of = r64 !== BigInt(result);
        cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
      }
      break;
    }

    // INSB — Input byte from port DX into ES:DI
    case 0x6C: {
      const port = cpu.getReg16(EDX);
      const rep = prefixF3 || prefixF2;
      const delta = cpu.getFlag(DF) ? -1 : 1;
      const doOne = () => {
        const val = cpu.emu?.portIn(port) ?? 0xFF;
        let addr: number;
        if (cpu._addrSize16) {
          addr = (cpu.segBase(cpu.es) + (cpu.reg[EDI] & 0xFFFF)) >>> 0;
        } else {
          addr = cpu.reg[EDI] >>> 0;
          if (!cpu.use32) addr = (cpu.segBase(cpu.es) + addr) >>> 0;
        }
        cpu.mem.writeU8(addr, val);
        if (cpu._addrSize16) {
          cpu.reg[EDI] = (cpu.reg[EDI] & ~0xFFFF) | (((cpu.reg[EDI] & 0xFFFF) + delta) & 0xFFFF);
        } else {
          cpu.reg[EDI] = (cpu.reg[EDI] + delta) | 0;
        }
      };
      if (rep) {
        while ((cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) : cpu.reg[ECX]) !== 0) {
          doOne();
          if (cpu._addrSize16) {
            cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | (((cpu.reg[ECX] & 0xFFFF) - 1) & 0xFFFF);
          } else {
            cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
          }
        }
      } else {
        doOne();
      }
      break;
    }

    // INSW/INSD — Input word/dword from port DX into ES:DI
    case 0x6D: {
      const port = cpu.getReg16(EDX);
      const unitSize = opSize === 16 ? 2 : 4;
      const rep = prefixF3 || prefixF2;
      const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
      const doOne = () => {
        const val = cpu.emu?.portIn(port) ?? (unitSize === 2 ? 0xFFFF : 0xFFFFFFFF);
        let addr: number;
        if (cpu._addrSize16) {
          addr = (cpu.segBase(cpu.es) + (cpu.reg[EDI] & 0xFFFF)) >>> 0;
        } else {
          addr = cpu.reg[EDI] >>> 0;
          if (!cpu.use32) addr = (cpu.segBase(cpu.es) + addr) >>> 0;
        }
        if (unitSize === 2) cpu.mem.writeU16(addr, val & 0xFFFF);
        else cpu.mem.writeU32(addr, val >>> 0);
        if (cpu._addrSize16) {
          cpu.reg[EDI] = (cpu.reg[EDI] & ~0xFFFF) | (((cpu.reg[EDI] & 0xFFFF) + delta) & 0xFFFF);
        } else {
          cpu.reg[EDI] = (cpu.reg[EDI] + delta) | 0;
        }
      };
      if (rep) {
        while ((cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) : cpu.reg[ECX]) !== 0) {
          doOne();
          if (cpu._addrSize16) {
            cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | (((cpu.reg[ECX] & 0xFFFF) - 1) & 0xFFFF);
          } else {
            cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
          }
        }
      } else {
        doOne();
      }
      break;
    }

    // OUTSB — Output byte from DS:SI to port DX
    case 0x6E: {
      const port = cpu.getReg16(EDX);
      const rep = prefixF3 || prefixF2;
      const delta = cpu.getFlag(DF) ? -1 : 1;
      const doOne = () => {
        let addr: number;
        if (cpu._addrSize16) {
          const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
          addr = (cpu.segBase(segSel) + (cpu.reg[ESI] & 0xFFFF)) >>> 0;
        } else {
          addr = cpu.reg[ESI] >>> 0;
          if (cpu._segOverride === 0x64) addr = (addr + cpu.fsBase) >>> 0;
          else if (cpu._segOverride) addr = (addr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
          else if (!cpu.use32) addr = (addr + cpu.segBase(cpu.ds)) >>> 0;
        }
        const val = cpu.mem.readU8(addr);
        cpu.emu?.portOut(port, val);
        if (cpu._addrSize16) {
          cpu.reg[ESI] = (cpu.reg[ESI] & ~0xFFFF) | (((cpu.reg[ESI] & 0xFFFF) + delta) & 0xFFFF);
        } else {
          cpu.reg[ESI] = (cpu.reg[ESI] + delta) | 0;
        }
      };
      if (rep) {
        while ((cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) : cpu.reg[ECX]) !== 0) {
          doOne();
          if (cpu._addrSize16) {
            cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | (((cpu.reg[ECX] & 0xFFFF) - 1) & 0xFFFF);
          } else {
            cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
          }
        }
      } else {
        doOne();
      }
      break;
    }

    // OUTSW/OUTSD — Output word/dword from DS:SI to port DX
    case 0x6F: {
      const port = cpu.getReg16(EDX);
      const unitSize = opSize === 16 ? 2 : 4;
      const rep = prefixF3 || prefixF2;
      const delta = cpu.getFlag(DF) ? -unitSize : unitSize;
      const doOne = () => {
        let addr: number;
        if (cpu._addrSize16) {
          const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
          addr = (cpu.segBase(segSel) + (cpu.reg[ESI] & 0xFFFF)) >>> 0;
        } else {
          addr = cpu.reg[ESI] >>> 0;
          if (cpu._segOverride === 0x64) addr = (addr + cpu.fsBase) >>> 0;
          else if (cpu._segOverride) addr = (addr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
          else if (!cpu.use32) addr = (addr + cpu.segBase(cpu.ds)) >>> 0;
        }
        const val = unitSize === 2 ? cpu.mem.readU16(addr) : cpu.mem.readU32(addr);
        cpu.emu?.portOut(port, val);
        if (cpu._addrSize16) {
          cpu.reg[ESI] = (cpu.reg[ESI] & ~0xFFFF) | (((cpu.reg[ESI] & 0xFFFF) + delta) & 0xFFFF);
        } else {
          cpu.reg[ESI] = (cpu.reg[ESI] + delta) | 0;
        }
      };
      if (rep) {
        while ((cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) : cpu.reg[ECX]) !== 0) {
          doOne();
          if (cpu._addrSize16) {
            cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | (((cpu.reg[ECX] & 0xFFFF) - 1) & 0xFFFF);
          } else {
            cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
          }
        }
      } else {
        doOne();
      }
      break;
    }

    // Jcc short (0x70-0x7F)
    case 0x70: case 0x71: case 0x72: case 0x73:
    case 0x74: case 0x75: case 0x76: case 0x77:
    case 0x78: case 0x79: case 0x7A: case 0x7B:
    case 0x7C: case 0x7D: case 0x7E: case 0x7F: {
      const disp = cpu.fetchI8();
      if (cpu.testCC(opcode - 0x70)) {
        if (!cpu.use32) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        } else {
          cpu.eip = (cpu.eip + disp) | 0;
        }
      }
      break;
    }

    // ALU r/m8, imm8 (0x80)
    case 0x80: {
      const d = cpu.decodeModRM(8);
      const imm = cpu.fetch8();
      const result = cpu.alu(d.regField, d.val, imm, 8);
      if (d.regField !== 7) cpu.writeModRM(d, result, 8);
      break;
    }

    // ALU r/m32, imm32 (0x81)
    case 0x81: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const imm = cpu.fetch16();
        const result = cpu.alu(d.regField, d.val, imm, 16);
        if (d.regField !== 7) cpu.writeModRM(d, result, 16);
      } else {
        const imm = cpu.fetch32();
        const result = cpu.alu(d.regField, d.val | 0, imm | 0, 32);
        if (d.regField !== 7) cpu.writeModRM(d, result, 32);
      }
      break;
    }

    // ALU r/m8, imm8 (same as 80h for 8-bit)
    case 0x82: {
      const d = cpu.decodeModRM(8);
      const imm = cpu.fetch8();
      const result = cpu.alu(d.regField, d.val, imm, 8);
      if (d.regField !== 7) cpu.writeModRM(d, result, 8);
      break;
    }

    // ALU r/m32, imm8 sign-extended (0x83)
    case 0x83: {
      const d = cpu.decodeModRM(opSize);
      const imm = cpu.fetchI8();
      if (opSize === 16) {
        const result = cpu.alu(d.regField, d.val, imm & 0xFFFF, 16);
        if (d.regField !== 7) cpu.writeModRM(d, result, 16);
      } else {
        const result = cpu.alu(d.regField, d.val | 0, imm, 32);
        if (d.regField !== 7) cpu.writeModRM(d, result, 32);
      }
      break;
    }

    // TEST r/m8, r8
    case 0x84: {
      const d = cpu.decodeModRM(8);
      const result = d.val & cpu.getReg8(d.regField);
      cpu.setLazy(LazyOp.AND8, result, d.val, cpu.getReg8(d.regField));
      break;
    }

    // TEST r/m32, r32
    case 0x85: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const result = d.val & cpu.getReg16(d.regField);
        cpu.setLazy(LazyOp.AND16, result, d.val, cpu.getReg16(d.regField));
      } else {
        const result = (d.val & cpu.reg[d.regField]) | 0;
        cpu.setLazy(LazyOp.AND32, result, d.val, cpu.reg[d.regField]);
      }
      break;
    }

    // XCHG r/m8, r8
    case 0x86: {
      const d = cpu.decodeModRM(8);
      const regVal = cpu.getReg8(d.regField);
      cpu.setReg8(d.regField, d.val);
      cpu.writeModRM(d, regVal, 8);
      break;
    }

    // XCHG r/m32, r32
    case 0x87: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const regVal = cpu.getReg16(d.regField);
        cpu.setReg16(d.regField, d.val);
        cpu.writeModRM(d, regVal, 16);
      } else {
        const regVal = cpu.reg[d.regField] | 0;
        cpu.reg[d.regField] = d.val | 0;
        cpu.writeModRM(d, regVal, 32);
      }
      break;
    }

    // MOV r/m8, r8
    case 0x88: {
      const d = cpu.decodeModRM(8);
      cpu.writeModRM(d, cpu.getReg8(d.regField), 8);
      break;
    }

    // MOV r/m32, r32
    case 0x89: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) cpu.writeModRM(d, cpu.getReg16(d.regField), 16);
      else cpu.writeModRM(d, cpu.reg[d.regField] | 0, 32);
      break;
    }

    // MOV r8, r/m8
    case 0x8A: {
      const d = cpu.decodeModRM(8);
      cpu.setReg8(d.regField, d.val);
      break;
    }

    // MOV r32, r/m32
    case 0x8B: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) cpu.setReg16(d.regField, d.val);
      else cpu.reg[d.regField] = d.val | 0;
      break;
    }

    // MOV r/m16, Sreg
    case 0x8C: {
      const d = cpu.decodeModRM(16);
      let sregVal = 0;
      switch (d.regField) {
        case 0: sregVal = cpu.es; break;
        case 1: sregVal = cpu.cs; break;
        case 2: sregVal = cpu.ss; break;
        case 3: sregVal = cpu.ds; break;
        case 4: sregVal = cpu.fs; break;
        case 5: sregVal = cpu.gs; break;
      }
      cpu.writeModRM(d, sregVal, 16);
      break;
    }

    // LEA r32, m — loads effective address (offset only, no segment base)
    case 0x8D: {
      const d = cpu.decodeModRM(opSize) as { isReg: boolean; regField: number; val: number; addr: number; ea?: number };
      // Use raw EA (without segment base) — LEA computes offset only
      const leaAddr = d.ea !== undefined ? d.ea : d.addr;
      if (opSize === 16) {
        cpu.setReg16(d.regField, leaAddr & 0xFFFF);
      } else {
        cpu.reg[d.regField] = leaAddr | 0;
      }
      break;
    }

    // MOV Sreg, r/m16
    case 0x8E: {
      const d = cpu.decodeModRM(16);
      switch (d.regField) {
        case 0: cpu.es = d.val & 0xFFFF; break;
        case 1: cpu.loadCS(d.val & 0xFFFF); break;
        case 2: cpu.ss = d.val & 0xFFFF; cpu._inhibitTF = true; cpu._inhibitIRQ = true; break; // MOV SS suppresses TF + IRQ
        case 3: cpu.ds = d.val & 0xFFFF; break;
        case 4: cpu.fs = d.val & 0xFFFF; break;
        case 5: cpu.gs = d.val & 0xFFFF; break;
      }
      break;
    }

    // POP r/m32
    case 0x8F: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) cpu.writeModRM(d, cpu.pop16(), 16);
      else cpu.writeModRM(d, cpu.pop32(), 32);
      break;
    }

    // NOP / XCHG EAX, r32
    case 0x90:
      break; // NOP

    case 0x91: case 0x92: case 0x93:
    case 0x94: case 0x95: case 0x96: case 0x97: {
      const r = opcode - 0x90;
      if (opSize === 16) {
        const tmp = cpu.getReg16(EAX);
        cpu.setReg16(EAX, cpu.getReg16(r));
        cpu.setReg16(r, tmp);
      } else {
        const tmp = cpu.reg[EAX];
        cpu.reg[EAX] = cpu.reg[r];
        cpu.reg[r] = tmp;
      }
      break;
    }

    // CWDE / CBW
    case 0x98:
      if (opSize === 16) {
        cpu.setReg16(EAX, (cpu.getReg8(EAX) << 24 >> 24) & 0xFFFF);
      } else {
        cpu.reg[EAX] = (cpu.getReg16(EAX) << 16 >> 16);
      }
      break;

    // CDQ / CWD
    case 0x99:
      if (opSize === 16) {
        cpu.setReg16(EDX, (cpu.getReg16(EAX) & 0x8000) ? 0xFFFF : 0);
      } else {
        cpu.reg[EDX] = (cpu.reg[EAX] | 0) < 0 ? -1 : 0;
      }
      break;

    // CALL FAR ptr16:16/32
    case 0x9A: {
      if (!cpu.use32) {
        const offset = cpu.fetch16();
        const selector = cpu.fetch16();
        cpu.push16(cpu.cs);
        cpu.push16((cpu.eip - (cpu.segBase(cpu.cs))) & 0xFFFF);
        cpu.loadCS(selector);
        cpu.eip = (cpu.segBase(selector)) + offset;
      } else {
        const offset = opSize === 16 ? cpu.fetch16() : cpu.fetch32();
        const selector = cpu.fetch16();
        const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
        cpu.push32(cpu.cs);
        cpu.push32(returnIP);
        cpu.loadCS(selector);
        cpu.eip = (cpu.segBase(selector)) + offset;
      }
      break;
    }

    // PUSHF/PUSHFD
    case 0x9C:
      if (opSize === 16) cpu.push16(cpu.getFlags() & 0xFFFF);
      else cpu.push32(cpu.getFlags());
      break;

    // POPF/POPFD
    case 0x9D:
      if (opSize === 16) cpu.setFlags(cpu.pop16() | 0x0002);
      else cpu.setFlags(cpu.pop32() | 0x0002);
      break;

    // SAHF
    case 0x9E:
      cpu.setFlags((cpu.getFlags() & ~0xFF) | (cpu.getReg8(4) & 0xD7) | 0x02);
      break;

    // LAHF
    case 0x9F:
      cpu.setReg8(4, cpu.getFlags() & 0xFF);
      break;

    // FWAIT / WAIT
    case 0x9B:
      break;

    // MOV AL, moffs8
    case 0xA0: {
      let maddr: number;
      if (cpu._addrSize16) {
        maddr = cpu.fetch16();
        const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
        maddr = ((cpu.segBase(segSel)) + maddr) >>> 0;
      } else {
        maddr = cpu.fetch32();
        if (cpu._segOverride === 0x64) maddr = (maddr + cpu.fsBase) >>> 0;
        else if (cpu._segOverride) maddr = (maddr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
        else if (!cpu.use32) maddr = (maddr + cpu.segBase(cpu.ds)) >>> 0;
        else maddr >>>= 0;
      }
      cpu.setReg8(EAX, cpu.mem.readU8(maddr));
      break;
    }

    // MOV EAX/AX, moffs16/32
    case 0xA1: {
      let maddr: number;
      if (cpu._addrSize16) {
        maddr = cpu.fetch16();
        const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
        maddr = ((cpu.segBase(segSel)) + maddr) >>> 0;
      } else {
        maddr = cpu.fetch32();
        if (cpu._segOverride === 0x64) maddr = (maddr + cpu.fsBase) >>> 0;
        else if (cpu._segOverride) maddr = (maddr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
        else if (!cpu.use32) maddr = (maddr + cpu.segBase(cpu.ds)) >>> 0;
        else maddr >>>= 0;
      }
      if (opSize === 16) cpu.setReg16(EAX, cpu.mem.readU16(maddr));
      else cpu.reg[EAX] = cpu.mem.readU32(maddr) | 0;
      break;
    }

    // MOV moffs8, AL
    case 0xA2: {
      let maddr: number;
      if (cpu._addrSize16) {
        maddr = cpu.fetch16();
        const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
        maddr = ((cpu.segBase(segSel)) + maddr) >>> 0;
      } else {
        maddr = cpu.fetch32();
        if (cpu._segOverride === 0x64) maddr = (maddr + cpu.fsBase) >>> 0;
        else if (cpu._segOverride) maddr = (maddr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
        else if (!cpu.use32) maddr = (maddr + cpu.segBase(cpu.ds)) >>> 0;
        else maddr >>>= 0;
      }
      cpu.mem.writeU8(maddr, cpu.getReg8(EAX));
      break;
    }

    // MOV moffs32/16, EAX/AX
    case 0xA3: {
      let maddr: number;
      if (cpu._addrSize16) {
        maddr = cpu.fetch16();
        const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
        maddr = ((cpu.segBase(segSel)) + maddr) >>> 0;
      } else {
        maddr = cpu.fetch32();
        if (cpu._segOverride === 0x64) maddr = (maddr + cpu.fsBase) >>> 0;
        else if (cpu._segOverride) maddr = (maddr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
        else if (!cpu.use32) maddr = (maddr + cpu.segBase(cpu.ds)) >>> 0;
        else maddr >>>= 0;
      }
      if (opSize === 16) cpu.mem.writeU16(maddr, cpu.getReg16(EAX));
      else cpu.mem.writeU32(maddr, cpu.reg[EAX] >>> 0);
      break;
    }

    // MOVSB
    case 0xA4:
      doMovs(cpu, 1, prefixF3 || prefixF2);
      break;

    // MOVSD
    case 0xA5:
      doMovs(cpu, opSize === 16 ? 2 : 4, prefixF3 || prefixF2);
      break;

    // CMPSB
    case 0xA6:
      doCmps(cpu, 1, prefixF3, prefixF2);
      break;

    // CMPSD
    case 0xA7:
      doCmps(cpu, opSize === 16 ? 2 : 4, prefixF3, prefixF2);
      break;

    // TEST AL, imm8
    case 0xA8: {
      const imm = cpu.fetch8();
      cpu.setLazy(LazyOp.AND8, cpu.getReg8(EAX) & imm, cpu.getReg8(EAX), imm);
      break;
    }

    // TEST EAX, imm32
    case 0xA9: {
      if (opSize === 16) {
        const imm = cpu.fetch16();
        cpu.setLazy(LazyOp.AND16, cpu.getReg16(EAX) & imm, cpu.getReg16(EAX), imm);
      } else {
        const imm = cpu.fetch32();
        cpu.setLazy(LazyOp.AND32, (cpu.reg[EAX] & (imm | 0)) | 0, cpu.reg[EAX], imm);
      }
      break;
    }

    // STOSB
    case 0xAA:
      doStos(cpu, 1, prefixF3 || prefixF2);
      break;

    // STOSD
    case 0xAB:
      doStos(cpu, opSize === 16 ? 2 : 4, prefixF3 || prefixF2);
      break;

    // LODSB
    case 0xAC:
      doLods(cpu, 1, prefixF3 || prefixF2);
      break;

    // LODSD
    case 0xAD:
      doLods(cpu, opSize === 16 ? 2 : 4, prefixF3 || prefixF2);
      break;

    // SCASB
    case 0xAE:
      doScas(cpu, 1, prefixF3, prefixF2);
      break;

    // SCASD
    case 0xAF:
      doScas(cpu, opSize === 16 ? 2 : 4, prefixF3, prefixF2);
      break;

    // MOV r8, imm8 (0xB0-0xB7)
    case 0xB0: case 0xB1: case 0xB2: case 0xB3:
    case 0xB4: case 0xB5: case 0xB6: case 0xB7:
      cpu.setReg8(opcode - 0xB0, cpu.fetch8());
      break;

    // MOV r32, imm32 (0xB8-0xBF)
    case 0xB8: case 0xB9: case 0xBA: case 0xBB:
    case 0xBC: case 0xBD: case 0xBE: case 0xBF:
      if (opSize === 16) cpu.setReg16(opcode - 0xB8, cpu.fetch16());
      else cpu.reg[opcode - 0xB8] = cpu.fetch32() | 0;
      break;

    // Shift/Rotate r/m8, imm8 (0xC0)
    case 0xC0: {
      const d = cpu.decodeModRM(8);
      const count = cpu.fetch8() & 0x1F;
      if (count) cpu.writeModRM(d, doShift(cpu, d.regField, d.val, count, 8), 8);
      break;
    }

    // Shift/Rotate r/m32, imm8 (0xC1)
    case 0xC1: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.fetch8() & 0x1F;
      if (count) cpu.writeModRM(d, doShift(cpu, d.regField, d.val, count, opSize as 8 | 16 | 32), opSize);
      break;
    }

    // RET imm16
    case 0xC2: {
      const imm = cpu.fetch16();
      if (!cpu.use32 && opSize === 16) {
        const ip = cpu.pop16();
        const csBase = cpu.segBase(cpu.cs);
        cpu.eip = csBase + ip;
        const newSp = (cpu.reg[ESP] & 0xFFFF) + imm;
        cpu.reg[ESP] = (cpu.reg[ESP] & ~0xFFFF) | (newSp & 0xFFFF);
      } else {
        cpu.eip = cpu.pop32();
        cpu.reg[ESP] = (cpu.reg[ESP] + imm) | 0;
      }
      break;
    }

    // RET
    case 0xC3:
      if (!cpu.use32 && opSize === 16) {
        const ip = cpu.pop16();
        const csBase = cpu.segBase(cpu.cs);
        cpu.eip = csBase + ip;
      } else {
        cpu.eip = cpu.pop32();
      }
      break;

    // RETF imm16
    case 0xCA: {
      const imm = cpu.fetch16();
      if (!cpu.use32) {
        const ip = cpu.pop16();
        const cs = cpu.pop16();
        cpu.loadCS(cs);
        cpu.eip = (cpu.segBase(cs)) + ip;
        const newSp = (cpu.reg[ESP] & 0xFFFF) + imm;
        cpu.reg[ESP] = (cpu.reg[ESP] & ~0xFFFF) | (newSp & 0xFFFF);
      } else {
        const eip2 = cpu.pop32();
        const cs = cpu.pop32() & 0xFFFF;
        cpu.loadCS(cs);
        cpu.eip = (cpu.segBase(cs) + eip2) >>> 0;
        cpu.reg[ESP] = (cpu.reg[ESP] + imm) | 0;
      }
      break;
    }

    // RETF
    case 0xCB:
      if (!cpu.use32) {
        const ip = cpu.pop16();
        const cs = cpu.pop16();
        cpu.loadCS(cs);
        cpu.eip = (cpu.segBase(cs)) + ip;
      } else {
        const eip2 = cpu.pop32();
        const cs = cpu.pop32() & 0xFFFF;
        cpu.loadCS(cs);
        cpu.eip = (cpu.segBase(cs) + eip2) >>> 0;
      }
      break;

    // LES (0xC4) / LDS (0xC5) — load far pointer
    case 0xC4: case 0xC5: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const offset = d.val & 0xFFFF;
        const selector = cpu.mem.readU16((d.addr + 2) >>> 0);
        cpu.setReg16(d.regField, offset);
        if (opcode === 0xC4) cpu.es = selector;
        else cpu.ds = selector;
      } else {
        const offset = d.val;
        const selector = cpu.mem.readU16((d.addr + 4) >>> 0);
        cpu.reg[d.regField] = offset | 0;
        if (opcode === 0xC4) cpu.es = selector;
        else cpu.ds = selector;
      }
      break;
    }

    // MOV r/m8, imm8
    case 0xC6: {
      const d = cpu.decodeModRM(8);
      cpu.writeModRM(d, cpu.fetch8(), 8);
      break;
    }

    // MOV r/m32, imm32
    case 0xC7: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) cpu.writeModRM(d, cpu.fetch16(), 16);
      else cpu.writeModRM(d, cpu.fetch32(), 32);
      break;
    }

    // ENTER
    case 0xC8: {
      const frameSize = cpu.fetch16();
      const nestingLevel = cpu.fetch8() & 0x1F;
      if (!cpu.use32 && opSize === 16) {
        cpu.push16(cpu.getReg16(EBP));
        const framePtr = cpu.reg[ESP] & 0xFFFF;
        cpu.setReg16(EBP, framePtr);
        const newSp = (cpu.reg[ESP] & 0xFFFF) - frameSize;
        cpu.reg[ESP] = (cpu.reg[ESP] & ~0xFFFF) | (newSp & 0xFFFF);
      } else {
        cpu.push32(cpu.reg[EBP]);
        const framePtr = cpu.reg[ESP] | 0;
        if (nestingLevel > 0) {
          for (let i = 1; i < nestingLevel; i++) {
            cpu.reg[EBP] = (cpu.reg[EBP] - 4) | 0;
            cpu.push32(cpu.mem.readU32(cpu.reg[EBP] >>> 0));
          }
          cpu.push32(framePtr);
        }
        cpu.reg[EBP] = framePtr;
        cpu.reg[ESP] = (cpu.reg[ESP] - frameSize) | 0;
      }
      break;
    }

    // LEAVE
    case 0xC9:
      if (!cpu.use32 && opSize === 16) {
        cpu.setReg16(ESP, cpu.getReg16(EBP));
        cpu.setReg16(EBP, cpu.pop16());
      } else {
        cpu.reg[ESP] = cpu.reg[EBP];
        cpu.reg[EBP] = cpu.pop32() | 0;
      }
      break;

    // INT 3 — dispatch like any software interrupt (UCDOS uses this as API entry)
    case 0xCC:
      cpu._inhibitTF = true; // INT suppresses TF trap
      if (cpu.emu && handleDosInt(cpu, 3, cpu.emu)) {
        break;
      }
      break;

    // ICEBP / INT1 — debug breakpoint, treat as NOP
    case 0xF1:
      break;

    // INTO — INT 4 if OF=1
    case 0xCE:
      if (cpu.getFlag(OF)) {
        cpu._inhibitTF = true;
        if (cpu.emu && cpu.emu.cpuSteps > 70000000) {
          const csBase_into = (cpu.cs << 4) >>> 0;
          const ip_into = (instrEip - csBase_into) & 0xFFFF;
          console.warn(`[INTO] CS:IP=${cpu.cs.toString(16)}:${ip_into.toString(16)} AX=${(cpu.reg[EAX]&0xFFFF).toString(16)} DX=${(cpu.reg[EDX]&0xFFFF).toString(16)} SP=${(cpu.reg[ESP]&0xFFFF).toString(16)} steps=${cpu.emu.cpuSteps}`);
        }
        if (cpu.emu && handleDosInt(cpu, 4, cpu.emu)) break;
      }
      break;

    // INT imm8
    case 0xCD: {
      cpu._inhibitTF = true; // INT suppresses TF trap
      const num = cpu.fetch8();
      if (dispatchException(cpu, num)) break;
      if (num === 0x03) {
        // INT 3: breakpoint — treat as NOP
      } else {
        console.warn(`INT 0x${num.toString(16)} at 0x${((cpu.eip - 2) >>> 0).toString(16)}`);
      }
      break;
    }

    // IRET (0xCF) — return from interrupt
    case 0xCF: {
      cpu._inhibitTF = true; // IRET suppresses TF trap
      if (!cpu.use32) {
        const ip = cpu.pop16();
        const cs = cpu.pop16();
        const flags = cpu.pop16();
        cpu.loadCS(cs);
        cpu.eip = cpu.segBase(cs) + ip;
        cpu.setFlags((cpu.getFlags() & 0xFFFF0000) | (flags & 0xFFFF));
      } else {
        const eip2 = cpu.pop32() >>> 0;
        const cs2 = cpu.pop32() & 0xFFFF;
        const eflags = cpu.pop32() >>> 0;
        cpu.loadCS(cs2);
        cpu.eip = (cpu.segBase(cs2) + eip2) >>> 0;
        cpu.setFlags(eflags);
      }
      break;
    }

    // Shift/Rotate r/m8, 1 (0xD0)
    case 0xD0: {
      const d = cpu.decodeModRM(8);
      cpu.writeModRM(d, doShift(cpu, d.regField, d.val, 1, 8), 8);
      break;
    }

    // Shift/Rotate r/m32, 1 (0xD1)
    case 0xD1: {
      const d = cpu.decodeModRM(opSize);
      cpu.writeModRM(d, doShift(cpu, d.regField, d.val, 1, opSize as 8 | 16 | 32), opSize);
      break;
    }

    // Shift/Rotate r/m8, CL (0xD2)
    case 0xD2: {
      const d = cpu.decodeModRM(8);
      const count = cpu.getReg8(ECX) & 0x1F;
      if (count) cpu.writeModRM(d, doShift(cpu, d.regField, d.val, count, 8), 8);
      break;
    }

    // Shift/Rotate r/m32, CL (0xD3)
    case 0xD3: {
      const d = cpu.decodeModRM(opSize);
      const count = cpu.getReg8(ECX) & 0x1F;
      if (count) cpu.writeModRM(d, doShift(cpu, d.regField, d.val, count, opSize as 8 | 16 | 32), opSize);
      break;
    }

    // CALL rel16/32
    case 0xE8: {
      if (opSize === 16) {
        const disp = (cpu.fetch16() << 16 >> 16);
        if (!cpu.use32) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.push16((cpu.eip - csBase) & 0xFFFF);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        } else {
          cpu.push32(cpu.eip);
          cpu.eip = (cpu.eip + disp) | 0;
        }
      } else {
        const disp = cpu.fetchI32();
        cpu.push32(cpu.eip);
        cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }

    // JMP rel16/32
    case 0xE9: {
      if (opSize === 16) {
        const disp = (cpu.fetch16() << 16 >> 16);
        if (!cpu.use32) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        } else {
          cpu.eip = (cpu.eip + disp) | 0;
        }
      } else {
        const disp = cpu.fetchI32();
        cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }

    // JMP FAR ptr16:16/32
    case 0xEA: {
      if (!cpu.use32) {
        const offset = cpu.fetch16();
        const selector = cpu.fetch16();
        cpu.loadCS(selector);
        cpu.eip = (cpu.segBase(selector)) + offset;
      } else {
        const offset = opSize === 16 ? cpu.fetch16() : cpu.fetch32();
        const selector = cpu.fetch16();
        cpu.loadCS(selector);
        cpu.eip = (cpu.segBase(selector)) + offset;
      }
      break;
    }

    // JMP rel8
    case 0xEB: {
      const disp = cpu.fetchI8();
      if (!cpu.use32) {
        const csBase = cpu.segBase(cpu.cs);
        cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
      } else {
        cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }

    // IN AL, imm8 / IN AX, imm8
    case 0xE4: {
      const port = cpu.fetch8();
      cpu.setReg8(EAX, cpu.emu?.portIn(port) ?? 0xFF);
      break;
    }
    case 0xE5: {
      const port = cpu.fetch8();
      const val = cpu.emu?.portIn(port) ?? 0xFFFF;
      if (opSize === 16) cpu.setReg16(EAX, val & 0xFFFF);
      else cpu.reg[EAX] = val >>> 0;
      break;
    }

    // OUT imm8, AL / OUT imm8, AX
    case 0xE6: {
      const port = cpu.fetch8();
      cpu.emu?.portOut(port, cpu.getReg8(EAX));
      break;
    }
    case 0xE7: {
      const port = cpu.fetch8();
      if (opSize === 16) {
        // 16-bit OUT: write low byte to port, high byte to port+1
        const val16 = cpu.getReg16(EAX);
        cpu.emu?.portOut(port, val16 & 0xFF);
        cpu.emu?.portOut(port + 1, (val16 >> 8) & 0xFF);
      } else {
        cpu.emu?.portOut(port, cpu.reg[EAX]);
      }
      break;
    }

    // IN AL, DX / IN AX, DX
    case 0xEC:
      cpu.setReg8(EAX, cpu.emu?.portIn(cpu.getReg16(EDX)) ?? 0xFF);
      break;
    case 0xED: {
      const port = cpu.getReg16(EDX);
      if (opSize === 16) {
        // 16-bit IN: read low byte from port, high byte from port+1
        const lo = cpu.emu?.portIn(port) ?? 0xFF;
        const hi = cpu.emu?.portIn(port + 1) ?? 0xFF;
        cpu.setReg16(EAX, (hi << 8) | lo);
      } else {
        cpu.reg[EAX] = (cpu.emu?.portIn(port) ?? 0xFFFFFFFF) >>> 0;
      }
      break;
    }

    // OUT DX, AL / OUT DX, AX
    case 0xEE:
      cpu.emu?.portOut(cpu.getReg16(EDX), cpu.getReg8(EAX));
      break;
    case 0xEF: {
      const port = cpu.getReg16(EDX);
      if (opSize === 16) {
        // 16-bit OUT: write low byte to port, high byte to port+1
        const val16 = cpu.getReg16(EAX);
        cpu.emu?.portOut(port, val16 & 0xFF);
        cpu.emu?.portOut(port + 1, (val16 >> 8) & 0xFF);
      } else {
        cpu.emu?.portOut(port, cpu.reg[EAX]);
      }
      break;
    }

    // LOCK prefix (ignore)
    case 0xF0:
      cpu.step();
      break;

    // CMC - Complement Carry Flag
    case 0xF5:
      cpu.materializeFlags();
      cpu.flagsCache ^= CF;
      break;

    // CLC - Clear Carry Flag
    case 0xF8:
      cpu.materializeFlags();
      cpu.flagsCache &= ~CF;
      break;

    // STC - Set Carry Flag
    case 0xF9:
      cpu.materializeFlags();
      cpu.flagsCache |= CF;
      break;

    // CLI — clear interrupt flag
    case 0xFA:
      cpu.flagsCache &= ~IF;
      break;

    // STI — set interrupt flag
    case 0xFB:
      cpu.flagsCache |= IF;
      break;

    // CLD
    case 0xFC:
      cpu.flagsCache &= ~DF;
      break;

    // STD
    case 0xFD:
      cpu.flagsCache |= DF;
      break;

    // Group 3 (0xF6): TEST/NOT/NEG/MUL/IMUL/DIV/IDIV r/m8
    case 0xF6: {
      const d = cpu.decodeModRM(8);
      switch (d.regField) {
        case 0: case 1: { // TEST r/m8, imm8
          const imm = cpu.fetch8();
          cpu.setLazy(LazyOp.AND8, d.val & imm, d.val, imm);
          break;
        }
        case 2: // NOT r/m8
          cpu.writeModRM(d, ~d.val & 0xFF, 8);
          break;
        case 3: { // NEG r/m8
          const result = (-d.val) & 0xFF;
          cpu.writeModRM(d, result, 8);
          cpu.setLazy(LazyOp.NEG8, result, d.val, 0);
          break;
        }
        case 4: { // MUL r/m8
          const ax = (cpu.getReg8(EAX) & 0xFF) * (d.val & 0xFF);
          cpu.setReg16(EAX, ax & 0xFFFF);
          const of = (ax & 0xFF00) !== 0;
          cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          break;
        }
        case 5: { // IMUL r/m8
          const ax = ((cpu.getReg8(EAX) << 24 >> 24)) * ((d.val << 24 >> 24));
          cpu.setReg16(EAX, ax & 0xFFFF);
          const of = ax < -128 || ax > 127;
          cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          break;
        }
        case 6: { // DIV r/m8
          const dividend = cpu.getReg16(EAX);
          const divisor = d.val & 0xFF;
          if (divisor === 0) { raiseDivideError(cpu, instrEip); break; }
          const quot = (dividend / divisor) >>> 0;
          if (quot > 0xFF) { raiseDivideError(cpu, instrEip); break; }
          const rem = dividend % divisor;
          cpu.setReg8(EAX, quot & 0xFF);
          cpu.setReg8(4, rem & 0xFF); // AH
          break;
        }
        case 7: { // IDIV r/m8
          const dividend = cpu.getReg16(EAX) << 16 >> 16;
          const divisor = d.val << 24 >> 24;
          if (divisor === 0) { raiseDivideError(cpu, instrEip); break; }
          const quot = (dividend / divisor) | 0;
          if (quot < -0x80 || quot > 0x7F) { raiseDivideError(cpu, instrEip); break; }
          const rem = dividend - quot * divisor;
          cpu.setReg8(EAX, quot & 0xFF);
          cpu.setReg8(4, rem & 0xFF);
          break;
        }
      }
      break;
    }

    // Group 3 (0xF7): TEST/NOT/NEG/MUL/IMUL/DIV/IDIV r/m32
    case 0xF7: {
      const d = cpu.decodeModRM(opSize);
      switch (d.regField) {
        case 0: case 1: { // TEST r/m32, imm32
          if (opSize === 16) {
            const imm = cpu.fetch16();
            cpu.setLazy(LazyOp.AND16, d.val & imm, d.val, imm);
          } else {
            const imm = cpu.fetch32();
            cpu.setLazy(LazyOp.AND32, (d.val & imm) | 0, d.val, imm);
          }
          break;
        }
        case 2: // NOT
          if (opSize === 16) cpu.writeModRM(d, ~d.val & 0xFFFF, 16);
          else cpu.writeModRM(d, ~d.val, 32);
          break;
        case 3: { // NEG
          if (opSize === 16) {
            const result = (-d.val) & 0xFFFF;
            cpu.writeModRM(d, result, 16);
            cpu.setLazy(LazyOp.NEG16, result, d.val, 0);
          } else {
            const result = (-d.val) | 0;
            cpu.writeModRM(d, result, 32);
            cpu.setLazy(LazyOp.NEG32, result, d.val, 0);
          }
          break;
        }
        case 4: { // MUL r/m32
          if (opSize === 16) {
            const result = (cpu.getReg16(EAX) & 0xFFFF) * (d.val & 0xFFFF);
            cpu.setReg16(EAX, result & 0xFFFF);
            cpu.setReg16(EDX, (result >> 16) & 0xFFFF);
            const of = (result >> 16) !== 0;
            cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          } else {
            const a = cpu.reg[EAX] >>> 0;
            const b = d.val >>> 0;
            const lo = Math.imul(a, b) >>> 0;
            const hi = Number(BigInt(a) * BigInt(b) >> 32n) >>> 0;
            cpu.reg[EAX] = lo | 0;
            cpu.reg[EDX] = hi | 0;
            const of = hi !== 0;
            cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          }
          break;
        }
        case 5: { // IMUL r/m32
          if (opSize === 16) {
            const result = (d.val << 16 >> 16) * (cpu.getReg16(EAX) << 16 >> 16);
            cpu.setReg16(EAX, result & 0xFFFF);
            cpu.setReg16(EDX, (result >> 16) & 0xFFFF);
            const truncated = (result << 16) >> 16;
            const of = truncated !== result;
            cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          } else {
            const a = cpu.reg[EAX] | 0;
            const b = d.val | 0;
            const r64 = BigInt(a) * BigInt(b);
            cpu.reg[EAX] = Number(r64 & 0xFFFFFFFFn) | 0;
            cpu.reg[EDX] = Number((r64 >> 32n) & 0xFFFFFFFFn) | 0;
            const of = r64 !== BigInt(cpu.reg[EAX]);
            cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
          }
          break;
        }
        case 6: { // DIV r/m32
          if (opSize === 16) {
            const dividend = ((cpu.getReg16(EDX) & 0xFFFF) << 16) | (cpu.getReg16(EAX) & 0xFFFF);
            const divisor = d.val & 0xFFFF;
            if (divisor === 0) { raiseDivideError(cpu, instrEip); break; }
            const quot = (dividend >>> 0) / divisor >>> 0;
            if (quot > 0xFFFF) { raiseDivideError(cpu, instrEip); break; }
            const rem = (dividend >>> 0) % divisor;
            cpu.setReg16(EAX, quot & 0xFFFF);
            cpu.setReg16(EDX, rem & 0xFFFF);
          } else {
            const dividend = (BigInt(cpu.reg[EDX] >>> 0) << 32n) | BigInt(cpu.reg[EAX] >>> 0);
            const divisor = BigInt(d.val >>> 0);
            if (divisor === 0n) { raiseDivideError(cpu, instrEip); break; }
            const quot = dividend / divisor;
            if (quot > 0xFFFFFFFFn) { raiseDivideError(cpu, instrEip); break; }
            const rem = dividend % divisor;
            cpu.reg[EAX] = Number(quot & 0xFFFFFFFFn) | 0;
            cpu.reg[EDX] = Number(rem & 0xFFFFFFFFn) | 0;
          }
          break;
        }
        case 7: { // IDIV r/m32
          if (opSize === 16) {
            const dividend = ((cpu.getReg16(EDX) << 16) | (cpu.getReg16(EAX) & 0xFFFF)) | 0;
            const divisor = d.val << 16 >> 16;
            if (divisor === 0) { raiseDivideError(cpu, instrEip); break; }
            const quot = (dividend / divisor) | 0;
            if (quot < -0x8000 || quot > 0x7FFF) { raiseDivideError(cpu, instrEip); break; }
            const rem = dividend - quot * divisor;
            cpu.setReg16(EAX, quot & 0xFFFF);
            cpu.setReg16(EDX, rem & 0xFFFF);
          } else {
            const dividend = (BigInt(cpu.reg[EDX] | 0) << 32n) | BigInt(cpu.reg[EAX] >>> 0);
            const divisor = BigInt(d.val | 0);
            if (divisor === 0n) { raiseDivideError(cpu, instrEip); break; }
            const quot = dividend / divisor;
            if (quot < -0x80000000n || quot > 0x7FFFFFFFn) { raiseDivideError(cpu, instrEip); break; }
            const rem = dividend - quot * divisor;
            cpu.reg[EAX] = Number(BigInt.asIntN(32, quot)) | 0;
            cpu.reg[EDX] = Number(BigInt.asIntN(32, rem)) | 0;
          }
          break;
        }
      }
      break;
    }

    // Group 4/5 (0xFE/0xFF)
    case 0xFE: {
      const d = cpu.decodeModRM(8);
      if (d.regField === 0) {
        const result = (d.val + 1) & 0xFF;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF8i = cpu.flagsCache & (DF | 0x7300);
        cpu.writeModRM(d, result, 8);
        cpu.setLazy(LazyOp.INC8, result, 0, 0);
        cpu.flagsCache = savedCF | savedDF8i;
      } else if (d.regField === 1) {
        const result = (d.val - 1) & 0xFF;
        const savedCF = cpu.getFlag(CF) ? CF : 0;
        const savedDF8d = cpu.flagsCache & (DF | 0x7300);
        cpu.writeModRM(d, result, 8);
        cpu.setLazy(LazyOp.DEC8, result, 0, 0);
        cpu.flagsCache = savedCF | savedDF8d;
      }
      break;
    }

    case 0xFF: {
      const d = cpu.decodeModRM(opSize);
      switch (d.regField) {
        case 0: { // INC r/m32
          if (opSize === 16) {
            const result = (d.val + 1) & 0xFFFF;
            const savedCF = cpu.getFlag(CF) ? CF : 0;
            const savedDFi16 = cpu.flagsCache & (DF | 0x7300);
            cpu.writeModRM(d, result, 16);
            cpu.setLazy(LazyOp.INC16, result, 0, 0);
            cpu.flagsCache = savedCF | savedDFi16;
          } else {
            const result = (d.val + 1) | 0;
            const savedCF = cpu.getFlag(CF) ? CF : 0;
            const savedDFi32 = cpu.flagsCache & (DF | 0x7300);
            cpu.writeModRM(d, result, 32);
            cpu.setLazy(LazyOp.INC32, result, 0, 0);
            cpu.flagsCache = savedCF | savedDFi32;
          }
          break;
        }
        case 1: { // DEC r/m32
          if (opSize === 16) {
            const result = (d.val - 1) & 0xFFFF;
            const savedCF = cpu.getFlag(CF) ? CF : 0;
            const savedDFd16 = cpu.flagsCache & (DF | 0x7300);
            cpu.writeModRM(d, result, 16);
            cpu.setLazy(LazyOp.DEC16, result, 0, 0);
            cpu.flagsCache = savedCF | savedDFd16;
          } else {
            const result = (d.val - 1) | 0;
            const savedCF = cpu.getFlag(CF) ? CF : 0;
            const savedDFd32 = cpu.flagsCache & (DF | 0x7300);
            cpu.writeModRM(d, result, 32);
            cpu.setLazy(LazyOp.DEC32, result, 0, 0);
            cpu.flagsCache = savedCF | savedDFd32;
          }
          break;
        }
        case 2: // CALL r/m16/32
          if (!cpu.use32 && opSize === 16) {
            const csBase = cpu.segBase(cpu.cs);
            cpu.push16((cpu.eip - csBase) & 0xFFFF);
            cpu.eip = csBase + (d.val & 0xFFFF);
          } else {
            cpu.push32(cpu.eip);
            cpu.eip = d.val | 0;
          }
          break;
        case 3: // CALL FAR m16:16/32 (FF /3)
          if (!cpu.use32) {
            const farOff = d.val & 0xFFFF;
            const farSel = cpu.mem.readU16((d.addr + 2) >>> 0);
            cpu.push16(cpu.cs);
            cpu.push16((cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF);
            cpu.loadCS(farSel);
            cpu.eip = (cpu.segBase(farSel)) + farOff;
          } else {
            const farOff = cpu.mem.readU32(d.addr);
            const farSel = cpu.mem.readU16((d.addr + 4) >>> 0);
            const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
            cpu.push32(cpu.cs);
            cpu.push32(returnIP);
            cpu.loadCS(farSel);
            cpu.eip = (cpu.segBase(farSel)) + farOff;
          }
          break;
        case 4: // JMP r/m16/32
          if (!cpu.use32 && opSize === 16) {
            const csBase = cpu.segBase(cpu.cs);
            cpu.eip = csBase + (d.val & 0xFFFF);
          } else {
            cpu.eip = d.val | 0;
          }
          break;
        case 5: // JMP FAR m16:16/32 (FF /5)
          if (!cpu.use32) {
            const farOff = d.val & 0xFFFF;
            const farSel = cpu.mem.readU16((d.addr + 2) >>> 0);
            cpu.loadCS(farSel);
            cpu.eip = (cpu.segBase(farSel)) + farOff;
          } else {
            const farOff = cpu.mem.readU32(d.addr);
            const farSel = cpu.mem.readU16((d.addr + 4) >>> 0);
            cpu.loadCS(farSel);
            cpu.eip = (cpu.segBase(farSel)) + farOff;
          }
          break;
        case 6: // PUSH r/m32
          if (opSize === 16) cpu.push16(d.val);
          else cpu.push32(d.val);
          break;
        default:
          console.warn(`Unimplemented FF /${d.regField} at 0x${((cpu.eip) >>> 0).toString(16)}`);
          cpu.haltReason = 'illegal instruction';
          cpu.halted = true;
          break;
      }
      break;
    }

    // 0F prefix
    case 0x0F:
      exec0F(cpu, opSize, prefixF3, prefixF2);
      break;

    // LOOP
    case 0xE0: { // LOOPNE
      const disp = cpu.fetchI8();
      if (cpu._addrSize16) {
        const cx = (cpu.reg[ECX] - 1) & 0xFFFF;
        cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | cx;
        if (cx !== 0 && !cpu.getFlag(ZF)) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        }
      } else {
        cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
        if (cpu.reg[ECX] !== 0 && !cpu.getFlag(ZF)) cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }
    case 0xE1: { // LOOPE
      const disp = cpu.fetchI8();
      if (cpu._addrSize16) {
        const cx = (cpu.reg[ECX] - 1) & 0xFFFF;
        cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | cx;
        if (cx !== 0 && cpu.getFlag(ZF)) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        }
      } else {
        cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
        if (cpu.reg[ECX] !== 0 && cpu.getFlag(ZF)) cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }
    case 0xE2: { // LOOP
      const disp = cpu.fetchI8();
      if (cpu._addrSize16) {
        const cx = (cpu.reg[ECX] - 1) & 0xFFFF;
        cpu.reg[ECX] = (cpu.reg[ECX] & ~0xFFFF) | cx;
        if (cx !== 0) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        }
      } else {
        cpu.reg[ECX] = (cpu.reg[ECX] - 1) | 0;
        if (cpu.reg[ECX] !== 0) cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }

    // JECXZ/JCXZ rel8
    case 0xE3: {
      const disp = cpu.fetchI8();
      const cxZero = cpu._addrSize16 ? (cpu.reg[ECX] & 0xFFFF) === 0 : cpu.reg[ECX] === 0;
      if (cxZero) {
        if (!cpu.use32) {
          const csBase = cpu.segBase(cpu.cs);
          cpu.eip = csBase + (((cpu.eip - csBase) + disp) & 0xFFFF);
        } else {
          cpu.eip = (cpu.eip + disp) | 0;
        }
      }
      break;
    }

    // AAM imm8 — AH=AL/imm, AL=AL%imm
    case 0xD4: {
      const base = cpu.fetch8();
      if (base === 0) { console.warn('[AAM] divide by zero'); break; }
      const al = cpu.getReg8(EAX);
      cpu.setReg8(EAX + 4, Math.floor(al / base) & 0xFF); // AH
      cpu.setReg8(EAX, (al % base) & 0xFF); // AL
      cpu.setLazy(LazyOp.AND8, cpu.getReg8(EAX), cpu.getReg8(EAX), cpu.getReg8(EAX)); // set flags from AL
      break;
    }

    // AAD imm8 — AL = AH*imm + AL, AH = 0
    case 0xD5: {
      const base = cpu.fetch8();
      const al = cpu.getReg8(EAX);
      const ah = cpu.getReg8(EAX + 4); // AH
      const result = ((ah * base) + al) & 0xFF;
      cpu.setReg8(EAX, result); // AL
      cpu.setReg8(EAX + 4, 0); // AH = 0
      cpu.setLazy(LazyOp.AND8, result, result, result);
      break;
    }

    // SALC — undocumented: AL = 0xFF if CF, else 0x00
    case 0xD6:
      cpu.setReg8(EAX, cpu.getFlag(CF) ? 0xFF : 0x00);
      break;

    // XLAT — AL = [DS:BX+AL] or [DS:EBX+AL]
    case 0xD7: {
      const al = cpu.getReg8(EAX);
      let addr: number;
      if (cpu._addrSize16) {
        const bx = cpu.getReg16(EBX);
        const segSel = cpu._segOverride ? cpu.getSegOverrideSel() : cpu.ds;
        addr = (cpu.segBase(segSel) + ((bx + al) & 0xFFFF)) >>> 0;
      } else {
        addr = ((cpu.reg[EBX] + al) >>> 0);
        if (cpu._segOverride === 0x64) addr = (addr + cpu.fsBase) | 0;
        else if (cpu._segOverride) addr = (addr + cpu.segBase(cpu.getSegOverrideSel())) >>> 0;
        else if (!cpu.use32) addr = (addr + cpu.segBase(cpu.ds)) >>> 0;
      }
      cpu.setReg8(EAX, cpu.mem.readU8(addr));
      break;
    }

    // x87 FPU escape opcodes
    case 0xD8: case 0xD9: case 0xDA: case 0xDB:
    case 0xDC: case 0xDD: case 0xDE: case 0xDF:
      execFPU(cpu, opcode);
      break;

    // DAA / DAS — BCD adjust after add/subtract
    case 0x27: case 0x2F: {
      let al = cpu.reg[EAX] & 0xFF;
      const oldAL = al;
      const oldCF = cpu.getFlag(CF);
      let cf = false;
      if ((al & 0x0F) > 9 || cpu.getFlag(0x10 /* AF */)) {
        al = opcode === 0x27 ? (al + 6) & 0xFF : (al - 6) & 0xFF;
        cf = oldCF || ((opcode === 0x27 ? (oldAL + 6) : (oldAL - 6)) > 0xFF);
        cpu.setFlag(0x10 /* AF */, true);
      } else {
        cpu.setFlag(0x10 /* AF */, false);
      }
      if (oldAL > 0x99 || oldCF) {
        al = opcode === 0x27 ? (al + 0x60) & 0xFF : (al - 0x60) & 0xFF;
        cf = true;
      }
      cpu.setReg8(EAX, al);
      cpu.setFlag(CF, cf);
      cpu.setFlag(ZF, al === 0);
      cpu.setFlag(0x80 /* SF */, !!(al & 0x80));
      // PF = set if even number of set bits in low byte
      let bits = al; bits ^= bits >> 4; bits ^= bits >> 2; bits ^= bits >> 1;
      cpu.setFlag(0x04 /* PF */, !(bits & 1));
      break;
    }

    // ARPL — invalid in real mode, triggers #UD (INT 6)
    case 0x63: {
      if (cpu.realMode && cpu.emu) {
        // Point EIP at the ARPL opcode for the exception handler
        cpu.eip--;
        handleDosInt(cpu, 0x06, cpu.emu);
      }
      break;
    }

    // HLT — halt until next interrupt (yield current tick, resume on next)
    case 0xF4:
      if (cpu.emu && cpu.emu.isDOS) {
        // DOS: just end current tick; timer INT 08h will fire on next tick
        cpu.emu._dosHalted = true;
      } else if (cpu.emu) {
        cpu.emu.waitingForMessage = true;
      }
      break;

    // AAA / AAS — ASCII adjust after add/subtract
    case 0x37: case 0x3F: {
      let al = cpu.reg[EAX] & 0xFF;
      let ah = (cpu.reg[EAX] >> 8) & 0xFF;
      if ((al & 0x0F) > 9 || cpu.getFlag(0x10 /* AF */)) {
        if (opcode === 0x37) { al = (al + 6) & 0xFF; ah = (ah + 1) & 0xFF; }
        else { al = (al - 6) & 0xFF; ah = (ah - 1) & 0xFF; }
        cpu.setFlag(0x10 /* AF */, true);
        cpu.setFlag(CF, true);
      } else {
        cpu.setFlag(0x10 /* AF */, false);
        cpu.setFlag(CF, false);
      }
      al &= 0x0F;
      cpu.setReg16(EAX, (ah << 8) | al);
      break;
    }

    default: {
      const faultEip = (cpu.eip - 1) >>> 0;
      const bytes: string[] = [];
      for (let j = -4; j < 16; j++) bytes.push(cpu.mem.readU8((faultEip + j) >>> 0).toString(16).padStart(2, '0'));
      console.warn(
        `Unimplemented opcode 0x${opcode.toString(16).padStart(2, '0')} at EIP=0x${faultEip.toString(16)}\n` +
        `  bytes@EIP-4: [${bytes.join(' ')}]\n` +
        `  EAX=0x${(cpu.reg[EAX] >>> 0).toString(16)} ECX=0x${(cpu.reg[ECX] >>> 0).toString(16)} EDX=0x${(cpu.reg[EDX] >>> 0).toString(16)} EBX=0x${(cpu.reg[EBX] >>> 0).toString(16)}\n` +
        `  ESP=0x${(cpu.reg[ESP] >>> 0).toString(16)} EBP=0x${(cpu.reg[EBP] >>> 0).toString(16)} ESI=0x${(cpu.reg[ESI] >>> 0).toString(16)} EDI=0x${(cpu.reg[EDI] >>> 0).toString(16)}`
      );
      cpu.haltReason = 'illegal instruction';
      cpu.halted = true;
      break;
    }
  }
}
