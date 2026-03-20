import type { CPU } from './cpu';
import { exec0FExt } from './ops-0f-ext';

// Flag bits
const CF = 0x001;
const ZF = 0x040;
const OF = 0x800;

export function exec0F(
  cpu: CPU,
  opSize: number,
  prefixF3: boolean,
  _prefixF2: boolean,
): void {
  const op2 = cpu.fetch8();

  switch (op2) {
    // Jcc near (0F 80-8F)
    case 0x80: case 0x81: case 0x82: case 0x83:
    case 0x84: case 0x85: case 0x86: case 0x87:
    case 0x88: case 0x89: case 0x8A: case 0x8B:
    case 0x8C: case 0x8D: case 0x8E: case 0x8F: {
      const disp = opSize === 16 ? (cpu.fetch16() << 16 >> 16) : cpu.fetchI32();
      if (cpu.testCC(op2 - 0x80)) {
        cpu.eip = (cpu.eip + disp) | 0;
      }
      break;
    }

    // SETcc (0F 90-9F)
    case 0x90: case 0x91: case 0x92: case 0x93:
    case 0x94: case 0x95: case 0x96: case 0x97:
    case 0x98: case 0x99: case 0x9A: case 0x9B:
    case 0x9C: case 0x9D: case 0x9E: case 0x9F: {
      const d = cpu.decodeModRM(8);
      cpu.writeModRM(d, cpu.testCC(op2 - 0x90) ? 1 : 0, 8);
      break;
    }

    // CMOVcc (0F 40-4F)
    case 0x40: case 0x41: case 0x42: case 0x43:
    case 0x44: case 0x45: case 0x46: case 0x47:
    case 0x48: case 0x49: case 0x4A: case 0x4B:
    case 0x4C: case 0x4D: case 0x4E: case 0x4F: {
      const d = cpu.decodeModRM(opSize);
      if (cpu.testCC(op2 - 0x40)) {
        if (opSize === 16) cpu.setReg16(d.regField, d.val);
        else cpu.reg[d.regField] = d.val | 0;
      }
      break;
    }

    // MOVZX r32, r/m8
    case 0xB6: {
      const d = cpu.decodeModRM(8);
      if (opSize === 16) cpu.setReg16(d.regField, d.val & 0xFF);
      else cpu.reg[d.regField] = d.val & 0xFF;
      break;
    }

    // MOVZX r32, r/m16
    case 0xB7: {
      const d = cpu.decodeModRM(16);
      if (opSize === 16) cpu.setReg16(d.regField, d.val & 0xFFFF);
      else cpu.reg[d.regField] = d.val & 0xFFFF;
      break;
    }

    // MOVSX r32, r/m8
    case 0xBE: {
      const d = cpu.decodeModRM(8);
      const sx = (d.val << 24) >> 24;
      if (opSize === 16) cpu.setReg16(d.regField, sx & 0xFFFF);
      else cpu.reg[d.regField] = sx;
      break;
    }

    // MOVSX r32, r/m16
    case 0xBF: {
      const d = cpu.decodeModRM(16);
      const sx = (d.val << 16) >> 16;
      if (opSize === 16) cpu.setReg16(d.regField, sx & 0xFFFF);
      else cpu.reg[d.regField] = sx;
      break;
    }

    // IMUL r32, r/m32
    case 0xAF: {
      const d = cpu.decodeModRM(opSize);
      if (opSize === 16) {
        const result = (cpu.getReg16(d.regField) << 16 >> 16) * (d.val << 16 >> 16);
        cpu.setReg16(d.regField, result & 0xFFFF);
        const truncated = (result << 16) >> 16;
        const of = truncated !== result;
        cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
      } else {
        const r64 = BigInt(cpu.reg[d.regField] | 0) * BigInt(d.val | 0);
        const result = Number(r64 & 0xFFFFFFFFn) | 0;
        cpu.reg[d.regField] = result;
        const of = r64 !== BigInt(result);
        cpu.setFlags((cpu.getFlags() & ~(CF | OF)) | (of ? CF | OF : 0));
      }
      break;
    }

    // 0F 01 — privileged/system instructions (SGDT, SIDT, LGDT, LIDT, SMSW, LMSW)
    case 0x01: {
      const modrm = cpu.mem.readU8(cpu.eip);
      const reg = (modrm >> 3) & 7;
      switch (reg) {
        case 0: { // SGDT m — Store GDT register
          const d = cpu.decodeModRM(opSize);
          if (!d.isReg) {
            const emu = cpu.emu;
            cpu.mem.writeU16(d.addr, emu?._gdtLimit ?? 0);
            cpu.mem.writeU32((d.addr + 2) >>> 0, emu?._gdtBase ?? 0);
          }
          break;
        }
        case 1: { // SIDT m — Store IDT register
          const d = cpu.decodeModRM(opSize);
          if (!d.isReg) {
            const emu = cpu.emu;
            cpu.mem.writeU16(d.addr, emu?._idtLimit ?? 0x3FF);
            cpu.mem.writeU32((d.addr + 2) >>> 0, emu?._idtBase ?? 0);
          }
          break;
        }
        case 2: { // LGDT m — Load GDT register
          const d = cpu.decodeModRM(opSize);
          if (!d.isReg && cpu.emu) {
            cpu.emu._gdtLimit = cpu.mem.readU16(d.addr);
            cpu.emu._gdtBase = cpu.mem.readU32((d.addr + 2) >>> 0);
          }
          break;
        }
        case 3: { // LIDT m — Load IDT register
          const d = cpu.decodeModRM(opSize);
          if (!d.isReg && cpu.emu) {
            cpu.emu._idtLimit = cpu.mem.readU16(d.addr);
            cpu.emu._idtBase = cpu.mem.readU32((d.addr + 2) >>> 0);
          }
          break;
        }
        case 4: { // SMSW r/m16 — Store Machine Status Word (low 16 bits of CR0)
          const d = cpu.decodeModRM(16);
          const cr0 = cpu.emu?._cr0 ?? 0x0000;
          cpu.writeModRM(d, cr0 & 0xFFFF, 16);
          break;
        }
        case 6: { // LMSW r/m16 — Load Machine Status Word
          const d = cpu.decodeModRM(16);
          if (cpu.emu) {
            // LMSW can set PE but cannot clear it
            const val = d.val & 0xFFFF;
            cpu.emu._cr0 = (cpu.emu._cr0 & ~0x000E) | (val & 0x000F);
            if (cpu.emu._cr0 & 1) cpu.realMode = false;
          }
          break;
        }
        default:
          console.warn(`Unimplemented 0F 01 /${reg} at EIP=0x${(cpu.eip - 2).toString(16)}`);
          break;
      }
      break;
    }

    // LAR r, r/m16 — Load Access Rights (always fails in real mode: clear ZF)
    case 0x02: {
      const d = cpu.decodeModRM(opSize);
      cpu.setFlags(cpu.getFlags() & ~ZF);
      break;
    }

    // NOP (0F 1F /0 — multi-byte NOP)
    case 0x1F: {
      cpu.decodeModRM(opSize);
      break;
    }

    // MOV r32, CRn (0F 20 /r) — Read control register
    case 0x20: {
      const d = cpu.decodeModRM(32);
      const crn = d.regField;
      let val = 0;
      if (crn === 0) val = cpu.emu?._cr0 ?? 0;
      // CR2 (page fault address), CR3 (page dir base), CR4 (extensions) — return 0
      cpu.writeModRM(d, val, 32);
      break;
    }

    // MOV CRn, r32 (0F 22 /r) — Write control register
    case 0x22: {
      const d = cpu.decodeModRM(32);
      const crn = d.regField;
      if (crn === 0 && cpu.emu) {
        const oldPE = cpu.emu._cr0 & 1;
        cpu.emu._cr0 = d.val >>> 0;
        const newPE = cpu.emu._cr0 & 1;
        if (!oldPE && newPE) {
          // Transition to protected mode — set up segment bases from GDT
          cpu.realMode = false;
        } else if (oldPE && !newPE) {
          // Back to real mode
          cpu.realMode = true;
        }
      }
      break;
    }

    // MOVNTI (0F C3) — treat as MOV
    case 0xC3: {
      const d = cpu.decodeModRM(32);
      cpu.writeModRM(d, cpu.reg[d.regField], 32);
      break;
    }

    // 0F 18-1E: hints/NOPs — just consume modrm
    case 0x18: case 0x19: case 0x1A: case 0x1B:
    case 0x1C: case 0x1D: case 0x1E: {
      cpu.decodeModRM(opSize);
      break;
    }

    // SSE/SSE2: MOVD xmm, r/m32 (66 0F 6E) / MOVQ mm, r/m64
    case 0x6E: {
      const d = cpu.decodeModRM(32);
      const xmmIdx = d.regField;
      // Zero entire XMM register, then set low 32 bits
      cpu.xmmI32[xmmIdx * 4] = d.val;
      cpu.xmmI32[xmmIdx * 4 + 1] = 0;
      cpu.xmmI32[xmmIdx * 4 + 2] = 0;
      cpu.xmmI32[xmmIdx * 4 + 3] = 0;
      break;
    }

    // SSE/SSE2: MOVD r/m32, xmm (66 0F 7E)
    case 0x7E: {
      const d = cpu.decodeModRM(32);
      cpu.writeModRM(d, cpu.xmmI32[d.regField * 4], 32);
      break;
    }

    // SSE2: MOVDQA xmm, xmm/m128 (66 0F 6F) or MOVDQU (F3 0F 6F)
    case 0x6F: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField * 4;
      if (d.isReg) {
        // d.addr = rm index when isReg (see decodeModRM line 21)
        const src = d.addr * 4;
        cpu.xmmI32[dst] = cpu.xmmI32[src];
        cpu.xmmI32[dst + 1] = cpu.xmmI32[src + 1];
        cpu.xmmI32[dst + 2] = cpu.xmmI32[src + 2];
        cpu.xmmI32[dst + 3] = cpu.xmmI32[src + 3];
      } else {
        cpu.xmmI32[dst] = cpu.mem.readU32(d.addr) | 0;
        cpu.xmmI32[dst + 1] = cpu.mem.readU32(d.addr + 4) | 0;
        cpu.xmmI32[dst + 2] = cpu.mem.readU32(d.addr + 8) | 0;
        cpu.xmmI32[dst + 3] = cpu.mem.readU32(d.addr + 12) | 0;
      }
      break;
    }

    // SSE2: MOVDQA xmm/m128, xmm (66 0F 7F) or MOVDQU (F3 0F 7F)
    case 0x7F: {
      const d = cpu.decodeModRM(32);
      const src = d.regField * 4;
      if (d.isReg) {
        const dst2 = d.addr * 4;
        cpu.xmmI32[dst2] = cpu.xmmI32[src]; cpu.xmmI32[dst2+1] = cpu.xmmI32[src+1];
        cpu.xmmI32[dst2+2] = cpu.xmmI32[src+2]; cpu.xmmI32[dst2+3] = cpu.xmmI32[src+3];
      } else {
        cpu.mem.writeU32(d.addr, cpu.xmmI32[src] >>> 0);
        cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src + 1] >>> 0);
        cpu.mem.writeU32(d.addr + 8, cpu.xmmI32[src + 2] >>> 0);
        cpu.mem.writeU32(d.addr + 12, cpu.xmmI32[src + 3] >>> 0);
      }
      break;
    }

    // SSE2: CVTDQ2PD (F3 0F E6), CVTTPD2DQ (66 0F E6), CVTPD2DQ (F2 0F E6)
    case 0xE6: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      if (prefixF3) {
        // CVTDQ2PD: convert 2 packed int32 to 2 packed double
        let lo: number, hi: number;
        if (d.isReg) {
          const src = d.addr;
          lo = cpu.xmmI32[src * 4];
          hi = cpu.xmmI32[src * 4 + 1];
        } else {
          lo = cpu.mem.readU32(d.addr) | 0;
          hi = cpu.mem.readU32(d.addr + 4) | 0;
        }
        cpu.xmmF64[dst * 2] = lo;      // convert int32 to double
        cpu.xmmF64[dst * 2 + 1] = hi;  // convert int32 to double
      }
      break;
    }

    // SSE: MOVAPS/MOVAPD xmm, xmm/m128 (0F 28) — treated as 128-bit move
    case 0x28: case 0x29: {
      const d = cpu.decodeModRM(32);
      if (op2 === 0x28) {
        // MOVAPS/MOVAPD xmm, xmm/m128
        const dst = d.regField * 4;
        if (d.isReg) {
          const src = d.addr * 4;
          cpu.xmmI32[dst] = cpu.xmmI32[src]; cpu.xmmI32[dst+1] = cpu.xmmI32[src+1];
          cpu.xmmI32[dst+2] = cpu.xmmI32[src+2]; cpu.xmmI32[dst+3] = cpu.xmmI32[src+3];
        } else {
          cpu.xmmI32[dst] = cpu.mem.readU32(d.addr) | 0;
          cpu.xmmI32[dst + 1] = cpu.mem.readU32(d.addr + 4) | 0;
          cpu.xmmI32[dst + 2] = cpu.mem.readU32(d.addr + 8) | 0;
          cpu.xmmI32[dst + 3] = cpu.mem.readU32(d.addr + 12) | 0;
        }
      } else {
        // MOVAPS/MOVAPD xmm/m128, xmm
        const src = d.regField * 4;
        if (d.isReg) {
          const dst2 = d.addr * 4;
          cpu.xmmI32[dst2] = cpu.xmmI32[src]; cpu.xmmI32[dst2+1] = cpu.xmmI32[src+1];
          cpu.xmmI32[dst2+2] = cpu.xmmI32[src+2]; cpu.xmmI32[dst2+3] = cpu.xmmI32[src+3];
        } else {
          cpu.mem.writeU32(d.addr, cpu.xmmI32[src] >>> 0);
          cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src + 1] >>> 0);
          cpu.mem.writeU32(d.addr + 8, cpu.xmmI32[src + 2] >>> 0);
          cpu.mem.writeU32(d.addr + 12, cpu.xmmI32[src + 3] >>> 0);
        }
      }
      break;
    }

    // SSE: MOVUPS xmm, xmm/m128 (0F 10) / MOVUPS xmm/m128, xmm (0F 11)
    // Also MOVSD (F2 0F 10/11), MOVSS (F3 0F 10/11)
    case 0x10: case 0x11: {
      const d = cpu.decodeModRM(32);
      if (op2 === 0x10) {
        const dst = d.regField;
        if (_prefixF2) {
          // MOVSD xmm, xmm/m64
          if (d.isReg) {
            const src = d.addr;
            cpu.xmmI32[dst * 4] = cpu.xmmI32[src * 4];
            cpu.xmmI32[dst * 4 + 1] = cpu.xmmI32[src * 4 + 1];
            // reg-reg MOVSD: upper 64 bits of dst unchanged
          } else {
            const lo = cpu.mem.readU32(d.addr);
            const hi = cpu.mem.readU32(d.addr + 4);
            cpu.xmmI32[dst * 4] = lo | 0;
            cpu.xmmI32[dst * 4 + 1] = hi | 0;
            cpu.xmmI32[dst * 4 + 2] = 0;
            cpu.xmmI32[dst * 4 + 3] = 0;
          }
        } else if (prefixF3) {
          // MOVSS xmm, xmm/m32
          if (d.isReg) {
            cpu.xmmI32[dst * 4] = cpu.xmmI32[d.addr * 4];
            // reg-reg MOVSS: upper bits unchanged
          } else {
            cpu.xmmI32[dst * 4] = cpu.mem.readU32(d.addr) | 0;
            cpu.xmmI32[dst * 4 + 1] = 0;
            cpu.xmmI32[dst * 4 + 2] = 0;
            cpu.xmmI32[dst * 4 + 3] = 0;
          }
        } else {
          // MOVUPS xmm, xmm/m128
          if (d.isReg) {
            const src = d.addr * 4;
            cpu.xmmI32[dst * 4] = cpu.xmmI32[src]; cpu.xmmI32[dst * 4 + 1] = cpu.xmmI32[src + 1];
            cpu.xmmI32[dst * 4 + 2] = cpu.xmmI32[src + 2]; cpu.xmmI32[dst * 4 + 3] = cpu.xmmI32[src + 3];
          } else {
            cpu.xmmI32[dst * 4] = cpu.mem.readU32(d.addr) | 0;
            cpu.xmmI32[dst * 4 + 1] = cpu.mem.readU32(d.addr + 4) | 0;
            cpu.xmmI32[dst * 4 + 2] = cpu.mem.readU32(d.addr + 8) | 0;
            cpu.xmmI32[dst * 4 + 3] = cpu.mem.readU32(d.addr + 12) | 0;
          }
        }
      } else {
        // Store variants
        const src = d.regField;
        if (d.isReg) {
          const dst2 = d.addr;
          if (_prefixF2) {
            cpu.xmmI32[dst2 * 4] = cpu.xmmI32[src * 4];
            cpu.xmmI32[dst2 * 4 + 1] = cpu.xmmI32[src * 4 + 1];
          } else if (prefixF3) {
            cpu.xmmI32[dst2 * 4] = cpu.xmmI32[src * 4];
          } else {
            cpu.xmmI32[dst2 * 4] = cpu.xmmI32[src * 4]; cpu.xmmI32[dst2 * 4 + 1] = cpu.xmmI32[src * 4 + 1];
            cpu.xmmI32[dst2 * 4 + 2] = cpu.xmmI32[src * 4 + 2]; cpu.xmmI32[dst2 * 4 + 3] = cpu.xmmI32[src * 4 + 3];
          }
        } else {
          if (_prefixF2) {
            cpu.mem.writeU32(d.addr, cpu.xmmI32[src * 4] >>> 0);
            cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src * 4 + 1] >>> 0);
          } else if (prefixF3) {
            cpu.mem.writeU32(d.addr, cpu.xmmI32[src * 4] >>> 0);
          } else {
            cpu.mem.writeU32(d.addr, cpu.xmmI32[src * 4] >>> 0);
            cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src * 4 + 1] >>> 0);
            cpu.mem.writeU32(d.addr + 8, cpu.xmmI32[src * 4 + 2] >>> 0);
            cpu.mem.writeU32(d.addr + 12, cpu.xmmI32[src * 4 + 3] >>> 0);
          }
        }
      }
      break;
    }

    // SSE2: CVTPS2PD (0F 5A) / CVTPD2PS (66 0F 5A) / CVTSD2SS (F2 0F 5A) / CVTSS2SD (F3 0F 5A)
    case 0x5A: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      if (_prefixF2) {
        // CVTSD2SS: convert scalar double in src to scalar float in dst xmm
        let srcDouble: number;
        if (d.isReg) {
          srcDouble = cpu.xmmF64[d.addr * 2];
        } else {
          const lo = cpu.mem.readU32(d.addr);
          const hi = cpu.mem.readU32(d.addr + 4);
          const tmpBuf = new DataView(new ArrayBuffer(8));
          tmpBuf.setUint32(0, lo, true);
          tmpBuf.setUint32(4, hi, true);
          srcDouble = tmpBuf.getFloat64(0, true);
        }
        // Convert double to float and store as float in low 32 bits of dst xmm
        const tmpBuf = new DataView(new ArrayBuffer(4));
        tmpBuf.setFloat32(0, srcDouble, true);
        cpu.xmmI32[dst * 4] = tmpBuf.getInt32(0, true);
        // Upper bits of low qword cleared, upper qword unchanged for scalar
        cpu.xmmI32[dst * 4 + 1] = 0;
      } else if (prefixF3) {
        // CVTSS2SD: convert scalar float in src to scalar double in dst xmm
        let srcFloat: number;
        if (d.isReg) {
          const tmpBuf = new DataView(new ArrayBuffer(4));
          tmpBuf.setInt32(0, cpu.xmmI32[d.addr * 4], true);
          srcFloat = tmpBuf.getFloat32(0, true);
        } else {
          const tmpBuf = new DataView(new ArrayBuffer(4));
          tmpBuf.setInt32(0, cpu.mem.readU32(d.addr) | 0, true);
          srcFloat = tmpBuf.getFloat32(0, true);
        }
        cpu.xmmF64[dst * 2] = srcFloat;
      } else if (opSize === 16) {
        // CVTPD2PS: convert packed double(s) in src to packed float(s) in dst xmm
        // For reg-reg, convert low 2 doubles to 2 floats in low 64 bits
        let d0: number, d1: number;
        if (d.isReg) {
          d0 = cpu.xmmF64[d.addr * 2];
          d1 = cpu.xmmF64[d.addr * 2 + 1];
        } else {
          const tmpBuf = new DataView(new ArrayBuffer(16));
          for (let i = 0; i < 4; i++) tmpBuf.setUint32(i * 4, cpu.mem.readU32(d.addr + i * 4), true);
          d0 = tmpBuf.getFloat64(0, true);
          d1 = tmpBuf.getFloat64(8, true);
        }
        const tmpBuf = new DataView(new ArrayBuffer(4));
        tmpBuf.setFloat32(0, d0, true);
        cpu.xmmI32[dst * 4] = tmpBuf.getInt32(0, true);
        tmpBuf.setFloat32(0, d1, true);
        cpu.xmmI32[dst * 4 + 1] = tmpBuf.getInt32(0, true);
        cpu.xmmI32[dst * 4 + 2] = 0;
        cpu.xmmI32[dst * 4 + 3] = 0;
      } else {
        // CVTPS2PD: convert packed float(s) in src to packed double(s) in dst xmm
        // Convert low 2 floats to 2 doubles
        const tmpBuf = new DataView(new ArrayBuffer(4));
        let f0bits: number, f1bits: number;
        if (d.isReg) {
          f0bits = cpu.xmmI32[d.addr * 4];
          f1bits = cpu.xmmI32[d.addr * 4 + 1];
        } else {
          f0bits = cpu.mem.readU32(d.addr) | 0;
          f1bits = cpu.mem.readU32(d.addr + 4) | 0;
        }
        tmpBuf.setInt32(0, f0bits, true);
        cpu.xmmF64[dst * 2] = tmpBuf.getFloat32(0, true);
        tmpBuf.setInt32(0, f1bits, true);
        cpu.xmmF64[dst * 2 + 1] = tmpBuf.getFloat32(0, true);
      }
      break;
    }

    // SSE2: CVTDQ2PS (0F 5B) / CVTPS2DQ (66 0F 5B) / CVTTPS2DQ (F3 0F 5B)
    case 0x5B: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      const tmpBuf = new DataView(new ArrayBuffer(4));
      if (opSize === 16 || prefixF3) {
        // CVTPS2DQ / CVTTPS2DQ: convert 4 packed floats to 4 packed int32s
        for (let i = 0; i < 4; i++) {
          const srcBits = d.isReg ? cpu.xmmI32[d.addr * 4 + i] : (cpu.mem.readU32(d.addr + i * 4) | 0);
          tmpBuf.setInt32(0, srcBits, true);
          const f = tmpBuf.getFloat32(0, true);
          cpu.xmmI32[dst * 4 + i] = (prefixF3 ? Math.trunc(f) : Math.round(f)) | 0;
        }
      } else {
        // CVTDQ2PS: convert 4 packed int32s to 4 packed floats
        for (let i = 0; i < 4; i++) {
          const srcI32 = d.isReg ? cpu.xmmI32[d.addr * 4 + i] : (cpu.mem.readU32(d.addr + i * 4) | 0);
          tmpBuf.setFloat32(0, srcI32, true);
          cpu.xmmI32[dst * 4 + i] = tmpBuf.getInt32(0, true);
        }
      }
      break;
    }

    // SSE/SSE2: arithmetic — ADDSS/SD, MULSS/SD, SUBSS/SD, DIVSS/SD, MINSS/SD, MAXSS/SD, SQRTSS/SD
    // Also packed: ANDPS/PD, ANDNPS/PD, ORPS/PD, XORPS/PD
    case 0x58: case 0x59: case 0x5C: case 0x5E: // ADD, MUL, SUB, DIV
    case 0x5D: case 0x5F: case 0x51: case 0x54: case 0x55: case 0x56: case 0x57: { // MIN, MAX, SQRT, AND, ANDN, OR, XOR
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      if (_prefixF2) {
        // Scalar double operations (F2 prefix)
        let srcVal: number;
        if (d.isReg) {
          srcVal = cpu.xmmF64[d.addr * 2];
        } else {
          const lo = cpu.mem.readU32(d.addr);
          const hi = cpu.mem.readU32(d.addr + 4);
          const buf = new DataView(new ArrayBuffer(8));
          buf.setUint32(0, lo, true);
          buf.setUint32(4, hi, true);
          srcVal = buf.getFloat64(0, true);
        }
        const dstVal = cpu.xmmF64[dst * 2];
        switch (op2) {
          case 0x58: cpu.xmmF64[dst * 2] = dstVal + srcVal; break; // ADDSD
          case 0x59: cpu.xmmF64[dst * 2] = dstVal * srcVal; break; // MULSD
          case 0x5C: cpu.xmmF64[dst * 2] = dstVal - srcVal; break; // SUBSD
          case 0x5E: cpu.xmmF64[dst * 2] = dstVal / srcVal; break; // DIVSD
          case 0x5D: cpu.xmmF64[dst * 2] = Math.min(dstVal, srcVal); break; // MINSD
          case 0x5F: cpu.xmmF64[dst * 2] = Math.max(dstVal, srcVal); break; // MAXSD
          case 0x51: cpu.xmmF64[dst * 2] = Math.sqrt(srcVal); break; // SQRTSD
        }
      } else if (prefixF3) {
        // Scalar single (float) operations (F3 prefix)
        const tmpBuf = new DataView(new ArrayBuffer(4));
        let srcBits: number;
        if (d.isReg) {
          srcBits = cpu.xmmI32[d.addr * 4];
        } else {
          srcBits = cpu.mem.readU32(d.addr) | 0;
        }
        tmpBuf.setInt32(0, srcBits, true);
        const srcVal = tmpBuf.getFloat32(0, true);
        tmpBuf.setInt32(0, cpu.xmmI32[dst * 4], true);
        const dstVal = tmpBuf.getFloat32(0, true);
        let result: number;
        switch (op2) {
          case 0x58: result = dstVal + srcVal; break; // ADDSS
          case 0x59: result = dstVal * srcVal; break; // MULSS
          case 0x5C: result = dstVal - srcVal; break; // SUBSS
          case 0x5E: result = dstVal / srcVal; break; // DIVSS
          case 0x5D: result = Math.min(dstVal, srcVal); break; // MINSS
          case 0x5F: result = Math.max(dstVal, srcVal); break; // MAXSS
          case 0x51: result = Math.sqrt(srcVal); break; // SQRTSS
          default: result = dstVal; break;
        }
        tmpBuf.setFloat32(0, result, true);
        cpu.xmmI32[dst * 4] = tmpBuf.getInt32(0, true);
      } else {
        // Packed operations (no F2/F3 prefix, or 66 prefix)
        // Handle bitwise ops (ANDPS/ORPS/XORPS) which operate on 128-bit values
        if (op2 === 0x54 || op2 === 0x55 || op2 === 0x56 || op2 === 0x57) {
          const s = d.isReg ? d.addr * 4 : -1;
          for (let i = 0; i < 4; i++) {
            const srcI32 = s >= 0 ? cpu.xmmI32[s + i] : (cpu.mem.readU32(d.addr + i * 4) | 0);
            switch (op2) {
              case 0x54: cpu.xmmI32[dst * 4 + i] &= srcI32; break; // ANDPS
              case 0x55: cpu.xmmI32[dst * 4 + i] = ~cpu.xmmI32[dst * 4 + i] & srcI32; break; // ANDNPS
              case 0x56: cpu.xmmI32[dst * 4 + i] |= srcI32; break; // ORPS
              case 0x57: cpu.xmmI32[dst * 4 + i] ^= srcI32; break; // XORPS
            }
          }
        }
        // Other packed arithmetic ops — NOP for now
      }
      break;
    }

    // SSE2: UCOMISD/COMISD (66 0F 2E/2F) / UCOMISS/COMISS (0F 2E/2F)
    case 0x2E: case 0x2F: {
      const d = cpu.decodeModRM(32);
      let dstVal: number, srcVal: number;
      if (opSize === 16) {
        // 66 prefix: UCOMISD/COMISD — compare scalar doubles
        dstVal = cpu.xmmF64[d.regField * 2];
        if (d.isReg) {
          srcVal = cpu.xmmF64[d.addr * 2];
        } else {
          const buf = new DataView(new ArrayBuffer(8));
          buf.setUint32(0, cpu.mem.readU32(d.addr), true);
          buf.setUint32(4, cpu.mem.readU32(d.addr + 4), true);
          srcVal = buf.getFloat64(0, true);
        }
      } else {
        // No 66 prefix: UCOMISS/COMISS — compare scalar floats
        const tmpBuf = new DataView(new ArrayBuffer(4));
        tmpBuf.setInt32(0, cpu.xmmI32[d.regField * 4], true);
        dstVal = tmpBuf.getFloat32(0, true);
        if (d.isReg) {
          tmpBuf.setInt32(0, cpu.xmmI32[d.addr * 4], true);
          srcVal = tmpBuf.getFloat32(0, true);
        } else {
          tmpBuf.setInt32(0, cpu.mem.readU32(d.addr) | 0, true);
          srcVal = tmpBuf.getFloat32(0, true);
        }
      }
      // Set ZF, PF, CF based on comparison
      let flags = cpu.getFlags() & ~(CF | ZF | 0x004 /* PF */ | OF);
      if (isNaN(dstVal) || isNaN(srcVal)) {
        flags |= CF | ZF | 0x004; // unordered
      } else if (dstVal < srcVal) {
        flags |= CF;
      } else if (dstVal === srcVal) {
        flags |= ZF;
      }
      cpu.setFlags(flags);
      break;
    }

    // SSE2: CVTSI2SD (F2 0F 2A) / CVTSI2SS (F3 0F 2A)
    case 0x2A: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      if (_prefixF2) {
        cpu.xmmF64[dst * 2] = d.val | 0; // int32 to double
      } else if (prefixF3) {
        // CVTSI2SS: convert int32 to scalar float
        const tmpBuf = new DataView(new ArrayBuffer(4));
        tmpBuf.setFloat32(0, d.val | 0, true);
        cpu.xmmI32[dst * 4] = tmpBuf.getInt32(0, true);
      }
      break;
    }

    // SSE2: CVTTSD2SI (F2 0F 2C) / CVTSD2SI (F2 0F 2D)
    case 0x2C: case 0x2D: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField;
      let srcVal: number;
      if (d.isReg) {
        srcVal = cpu.xmmF64[d.addr * 2];
      } else {
        const lo = cpu.mem.readU32(d.addr);
        const hi = cpu.mem.readU32(d.addr + 4);
        const buf = new ArrayBuffer(8);
        new DataView(buf).setUint32(0, lo, true);
        new DataView(buf).setUint32(4, hi, true);
        srcVal = new DataView(buf).getFloat64(0, true);
      }
      if (_prefixF2) {
        if (op2 === 0x2C) {
          cpu.reg[dst] = Math.trunc(srcVal) | 0; // truncate toward zero
        } else {
          cpu.reg[dst] = Math.round(srcVal) | 0; // round to nearest
        }
      } else if (prefixF3) {
        // CVTTSS2SI / CVTSS2SI - read float
        const buf = new DataView(new ArrayBuffer(4));
        if (d.isReg) {
          buf.setInt32(0, cpu.xmmI32[d.addr * 4], true);
        } else {
          buf.setUint32(0, cpu.mem.readU32(d.addr), true);
        }
        srcVal = buf.getFloat32(0, true);
        cpu.reg[dst] = (op2 === 0x2C ? Math.trunc(srcVal) : Math.round(srcVal)) | 0;
      }
      break;
    }

    // SSE: XORPS (0F 57), ANDPS (0F 54), ORPS (0F 56) — with 66 prefix: XORPD, ANDPD, ORPD
    // Already handled above in the combined case

    // SSE2: PXOR (66 0F EF), PAND (66 0F DB), POR (66 0F EB), PANDN (66 0F DF)
    case 0xEF: case 0xDB: case 0xEB: case 0xDF: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField * 4;
      let s0: number, s1: number, s2: number, s3: number;
      if (d.isReg) {
        const src = d.addr * 4;
        s0 = cpu.xmmI32[src]; s1 = cpu.xmmI32[src+1];
        s2 = cpu.xmmI32[src+2]; s3 = cpu.xmmI32[src+3];
      } else {
        s0 = cpu.mem.readU32(d.addr);
        s1 = cpu.mem.readU32(d.addr + 4);
        s2 = cpu.mem.readU32(d.addr + 8);
        s3 = cpu.mem.readU32(d.addr + 12);
      }
      switch (op2) {
        case 0xEF: // PXOR
          cpu.xmmI32[dst] ^= s0; cpu.xmmI32[dst+1] ^= s1;
          cpu.xmmI32[dst+2] ^= s2; cpu.xmmI32[dst+3] ^= s3;
          break;
        case 0xDB: // PAND
          cpu.xmmI32[dst] &= s0; cpu.xmmI32[dst+1] &= s1;
          cpu.xmmI32[dst+2] &= s2; cpu.xmmI32[dst+3] &= s3;
          break;
        case 0xEB: // POR
          cpu.xmmI32[dst] |= s0; cpu.xmmI32[dst+1] |= s1;
          cpu.xmmI32[dst+2] |= s2; cpu.xmmI32[dst+3] |= s3;
          break;
        case 0xDF: // PANDN
          cpu.xmmI32[dst] = ~cpu.xmmI32[dst] & s0;
          cpu.xmmI32[dst+1] = ~cpu.xmmI32[dst+1] & s1;
          cpu.xmmI32[dst+2] = ~cpu.xmmI32[dst+2] & s2;
          cpu.xmmI32[dst+3] = ~cpu.xmmI32[dst+3] & s3;
          break;
      }
      break;
    }

    // SSE: MOVLPS/MOVLPD (0F 12/13), UNPCKLPS/PD (0F 14), UNPCKHPS/PD (0F 15),
    //      MOVHPS/MOVHPD (0F 16/17)
    case 0x12: case 0x13: case 0x16: case 0x17: {
      const d = cpu.decodeModRM(32);
      if (op2 === 0x12) {
        // MOVLPS/MOVLPD xmm, m64 — load 64 bits into low qword of xmm
        const dst = d.regField;
        if (!d.isReg) {
          cpu.xmmI32[dst * 4] = cpu.mem.readU32(d.addr) | 0;
          cpu.xmmI32[dst * 4 + 1] = cpu.mem.readU32(d.addr + 4) | 0;
          // Upper qword unchanged
        }
        // reg-reg: MOVHLPS — move high to low
        else {
          cpu.xmmI32[dst * 4] = cpu.xmmI32[d.addr * 4 + 2];
          cpu.xmmI32[dst * 4 + 1] = cpu.xmmI32[d.addr * 4 + 3];
        }
      } else if (op2 === 0x13) {
        // MOVLPS/MOVLPD m64, xmm — store low qword of xmm to memory
        const src = d.regField;
        if (!d.isReg) {
          cpu.mem.writeU32(d.addr, cpu.xmmI32[src * 4] >>> 0);
          cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src * 4 + 1] >>> 0);
        }
      } else if (op2 === 0x16) {
        // MOVHPS/MOVHPD xmm, m64 — load 64 bits into high qword of xmm
        const dst = d.regField;
        if (!d.isReg) {
          cpu.xmmI32[dst * 4 + 2] = cpu.mem.readU32(d.addr) | 0;
          cpu.xmmI32[dst * 4 + 3] = cpu.mem.readU32(d.addr + 4) | 0;
        }
        // reg-reg: MOVLHPS — move low to high
        else {
          cpu.xmmI32[dst * 4 + 2] = cpu.xmmI32[d.addr * 4];
          cpu.xmmI32[dst * 4 + 3] = cpu.xmmI32[d.addr * 4 + 1];
        }
      } else { // 0x17
        // MOVHPS/MOVHPD m64, xmm — store high qword of xmm to memory
        const src = d.regField;
        if (!d.isReg) {
          cpu.mem.writeU32(d.addr, cpu.xmmI32[src * 4 + 2] >>> 0);
          cpu.mem.writeU32(d.addr + 4, cpu.xmmI32[src * 4 + 3] >>> 0);
        }
      }
      break;
    }
    case 0x14: case 0x15: {
      // UNPCKLPS/UNPCKHPS — consume modrm, NOP for now
      cpu.decodeModRM(32);
      break;
    }

    // SSE2: PSHUFD (66 0F 70 imm8), SHUFPS (0F C6 imm8)
    case 0x70: {
      const d = cpu.decodeModRM(32);
      const imm = cpu.fetch8();
      const dst = d.regField;
      if (opSize === 16) {
        // PSHUFD: shuffle dwords from src using imm8 control
        const s = new Int32Array(4);
        if (d.isReg) {
          for (let i = 0; i < 4; i++) s[i] = cpu.xmmI32[d.addr * 4 + i];
        } else {
          for (let i = 0; i < 4; i++) s[i] = cpu.mem.readU32(d.addr + i * 4) | 0;
        }
        cpu.xmmI32[dst * 4]     = s[(imm) & 3];
        cpu.xmmI32[dst * 4 + 1] = s[(imm >> 2) & 3];
        cpu.xmmI32[dst * 4 + 2] = s[(imm >> 4) & 3];
        cpu.xmmI32[dst * 4 + 3] = s[(imm >> 6) & 3];
      }
      // F3: PSHUFHW, F2: PSHUFLW — less common, consume and NOP
      break;
    }

    // SSE2: PSRLW/PSRAW/PSLLW (0F 71), PSRLD/PSRAD/PSLLD (0F 72), PSRLQ/PSRLDQ/PSLLQ (0F 73)
    case 0x71: case 0x72: case 0x73: {
      const d = cpu.decodeModRM(32);
      const imm = cpu.fetch8();
      const reg = d.addr; // rm field is the register
      const regField = d.regField; // /2=SRL, /4=SRA, /6=SLL, /3=SRLDQ, /7=SLLDQ
      if (op2 === 0x72) {
        // PSRLD (/2), PSRAD (/4), PSLLD (/6)
        for (let i = 0; i < 4; i++) {
          if (regField === 2) cpu.xmmI32[reg * 4 + i] = (cpu.xmmI32[reg * 4 + i] >>> imm); // logical right
          else if (regField === 4) cpu.xmmI32[reg * 4 + i] = (cpu.xmmI32[reg * 4 + i] >> imm); // arithmetic right
          else if (regField === 6) cpu.xmmI32[reg * 4 + i] = (cpu.xmmI32[reg * 4 + i] << imm); // left
        }
      } else if (op2 === 0x73) {
        if (regField === 3) {
          // PSRLDQ: byte shift right
          const bytes = new Uint8Array(cpu.xmmI32.buffer, reg * 16, 16);
          const tmp = new Uint8Array(16);
          for (let i = 0; i < 16; i++) tmp[i] = i + imm < 16 ? bytes[i + imm] : 0;
          tmp.forEach((v, i) => bytes[i] = v);
        } else if (regField === 7) {
          // PSLLDQ: byte shift left
          const bytes = new Uint8Array(cpu.xmmI32.buffer, reg * 16, 16);
          const tmp = new Uint8Array(16);
          for (let i = 0; i < 16; i++) tmp[i] = i - imm >= 0 ? bytes[i - imm] : 0;
          tmp.forEach((v, i) => bytes[i] = v);
        } else if (regField === 2) {
          // PSRLQ: shift each qword right by imm bits
          // Use BigInt or manual bit manipulation
          for (let q = 0; q < 2; q++) {
            const lo = cpu.xmmI32[reg * 4 + q * 2] >>> 0;
            const hi = cpu.xmmI32[reg * 4 + q * 2 + 1] >>> 0;
            if (imm >= 64) {
              cpu.xmmI32[reg * 4 + q * 2] = 0;
              cpu.xmmI32[reg * 4 + q * 2 + 1] = 0;
            } else if (imm >= 32) {
              cpu.xmmI32[reg * 4 + q * 2] = hi >>> (imm - 32);
              cpu.xmmI32[reg * 4 + q * 2 + 1] = 0;
            } else if (imm > 0) {
              cpu.xmmI32[reg * 4 + q * 2] = (lo >>> imm) | (hi << (32 - imm));
              cpu.xmmI32[reg * 4 + q * 2 + 1] = hi >>> imm;
            }
          }
        } else if (regField === 6) {
          // PSLLQ: shift each qword left by imm bits
          for (let q = 0; q < 2; q++) {
            const lo = cpu.xmmI32[reg * 4 + q * 2] >>> 0;
            const hi = cpu.xmmI32[reg * 4 + q * 2 + 1] >>> 0;
            if (imm >= 64) {
              cpu.xmmI32[reg * 4 + q * 2] = 0;
              cpu.xmmI32[reg * 4 + q * 2 + 1] = 0;
            } else if (imm >= 32) {
              cpu.xmmI32[reg * 4 + q * 2] = 0;
              cpu.xmmI32[reg * 4 + q * 2 + 1] = lo << (imm - 32);
            } else if (imm > 0) {
              cpu.xmmI32[reg * 4 + q * 2 + 1] = (hi << imm) | (lo >>> (32 - imm));
              cpu.xmmI32[reg * 4 + q * 2] = lo << imm;
            }
          }
        }
      } else { // 0x71
        // PSRLW/PSRAW/PSLLW — operate on 16-bit words, less common, NOP for now
      }
      break;
    }

    // SSE2: PCMPEQB (0F 74), PCMPEQW (0F 75), PCMPEQD (0F 76)
    case 0x74: case 0x75: case 0x76: {
      const d = cpu.decodeModRM(32);
      const dst = d.regField * 4;
      if (op2 === 0x76) {
        // PCMPEQD: compare packed dwords
        for (let i = 0; i < 4; i++) {
          const s = d.isReg ? cpu.xmmI32[d.addr * 4 + i] : (cpu.mem.readU32(d.addr + i * 4) | 0);
          cpu.xmmI32[dst + i] = cpu.xmmI32[dst + i] === s ? -1 : 0;
        }
      } else if (op2 === 0x74) {
        // PCMPEQB: compare packed bytes
        for (let i = 0; i < 16; i++) {
          const dstOff = d.regField * 16;
          const srcByte = d.isReg
            ? new Uint8Array(cpu.xmmI32.buffer, d.addr * 16, 16)[i]
            : cpu.mem.readU8(d.addr + i);
          const dstBytes = new Uint8Array(cpu.xmmI32.buffer, dstOff, 16);
          dstBytes[i] = dstBytes[i] === srcByte ? 0xFF : 0;
        }
      }
      // 0x75 PCMPEQW — less common, NOP for now
      break;
    }

    // SSE2: pack/unpack/compare — consume modrm
    case 0x60: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65: case 0x66:
    case 0x67: case 0x68: case 0x69: case 0x6A: case 0x6B: case 0x6C: case 0x6D: {
      cpu.decodeModRM(32);
      break;
    }

    // SSE2: PSHUFD (66 0F 70 imm8) — handled above

    // SSE2: various packed ops — consume modrm as NOP
    case 0xD0: case 0xD1: case 0xD2: case 0xD3: case 0xD4: case 0xD5: case 0xD6:
    case 0xD8: case 0xD9: case 0xDA: case 0xDC: case 0xDD: case 0xDE:
    case 0xE0: case 0xE1: case 0xE2: case 0xE3: case 0xE4: case 0xE5:
    case 0xE7: case 0xE8: case 0xE9: case 0xEA: case 0xEC: case 0xED: case 0xEE:
    case 0xF1: case 0xF2: case 0xF3: case 0xF4: case 0xF5: case 0xF6: case 0xF7:
    case 0xF8: case 0xF9: case 0xFA: case 0xFB: case 0xFC: case 0xFD: case 0xFE: {
      cpu.decodeModRM(32);
      break;
    }

    // SSE: COMISS/UCOMISS (0F 2E/2F without 66 prefix) — already handled above

    // SSE: SHUFPS (0F C6 imm8) / SHUFPD (66 0F C6 imm8)
    case 0xC6: {
      const d = cpu.decodeModRM(32);
      const imm = cpu.fetch8();
      const dst = d.regField;
      // SHUFPS: select floats from dst (low 2 from dst) and src (high 2 from src)
      const dstArr = [cpu.xmmI32[dst*4], cpu.xmmI32[dst*4+1], cpu.xmmI32[dst*4+2], cpu.xmmI32[dst*4+3]];
      const srcArr = new Int32Array(4);
      if (d.isReg) {
        for (let i = 0; i < 4; i++) srcArr[i] = cpu.xmmI32[d.addr * 4 + i];
      } else {
        for (let i = 0; i < 4; i++) srcArr[i] = cpu.mem.readU32(d.addr + i * 4) | 0;
      }
      cpu.xmmI32[dst*4]   = dstArr[(imm) & 3];
      cpu.xmmI32[dst*4+1] = dstArr[(imm >> 2) & 3];
      cpu.xmmI32[dst*4+2] = srcArr[(imm >> 4) & 3];
      cpu.xmmI32[dst*4+3] = srcArr[(imm >> 6) & 3];
      break;
    }

    // SSE2: PMOVMSKB (66 0F D7)
    case 0xD7: {
      const d = cpu.decodeModRM(32);
      const src = d.isReg ? d.addr : d.regField; // actually always reg-reg
      let mask = 0;
      const bytes = new Uint8Array(cpu.xmmI32.buffer, src * 16, 16);
      for (let i = 0; i < 16; i++) {
        if (bytes[i] & 0x80) mask |= (1 << i);
      }
      cpu.reg[d.regField] = mask;
      break;
    }

    // SSE: MOVMSKPS (0F 50) / MOVMSKPD (66 0F 50)
    case 0x50: {
      const d = cpu.decodeModRM(32);
      const src = d.addr; // always reg
      let mask = 0;
      for (let i = 0; i < 4; i++) {
        if (cpu.xmmI32[src * 4 + i] < 0) mask |= (1 << i);
      }
      cpu.reg[d.regField] = mask;
      break;
    }

    // SSE: LDMXCSR (0F AE /2), STMXCSR (0F AE /3), LFENCE/MFENCE/SFENCE
    case 0xAE: {
      const d = cpu.decodeModRM(32);
      // Just consume modrm, NOP behavior
      break;
    }

    default: {
      // Delegate to extended handler (BT/BSF/BSR/SHLD/SHRD/XADD/CMPXCHG/BSWAP/RDTSC/CPUID)
      if (exec0FExt(cpu, op2, opSize)) break;

      const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;
      const faultEip = (cpu.eip - 2) >>> 0;
      const bytes: string[] = [];
      for (let j = -4; j < 16; j++) bytes.push(cpu.mem.readU8((faultEip + j) >>> 0).toString(16).padStart(2, '0'));
      console.warn(
        `Unimplemented 0F ${op2.toString(16).padStart(2, '0')} at EIP=0x${faultEip.toString(16)}\n` +
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
