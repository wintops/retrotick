// Find all writes to a specific memory offset in a dumped segment.
// Looks for `66 89 ?? XX XX` (mov dword [mem16], reg32) and `89 ?? XX XX` (mov word [mem16], reg16)
// where XX XX is the low/high byte of the target offset.
//
// Usage: npx tsx tests/find-writes.mjs <sel> <offset>
// Example: npx tsx tests/find-writes.mjs 1569 a42
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const sel = parseInt(args[0], 16);
const off = parseInt(args[1], 16);

if (!args[0] || !args[1]) {
  console.log(`Usage: npx tsx tests/find-writes.mjs <sel-hex> <memOffset-hex>`);
  process.exit(1);
}

const binPath = `D:/tmp/doom-cs-${sel.toString(16)}.bin`;
const bytes = readFileSync(binPath);

const loByte = off & 0xFF;
const hiByte = (off >> 8) & 0xFF;

console.log(`Scanning ${binPath} for writes to [0x${off.toString(16)}] (bytes ${loByte.toString(16)} ${hiByte.toString(16)})`);

// Pattern 1: MOV r/m16, r16 via [disp16] — "89 /r" with ModRM mod=00 r/m=110
// ModRM byte has: mod=00 (no disp or [bp]), r/m=110 ([disp16] when mod=00)
// reg field varies: 0=AX, 1=CX, 2=DX, 3=BX, 4=SP, 5=BP, 6=SI, 7=DI
// So opcodes: 89 06 (AX), 89 0E (CX), 89 16 (DX), 89 1E (BX), 89 26 (SP), 89 2E (BP), 89 36 (SI), 89 3E (DI)
// Followed by 2-byte disp16

// Pattern 2: 66-prefix = 32-bit operand: 66 89 /r + disp16 = mov dword [disp16], r32
// Pattern 3: MOV [disp16], imm: C7 06 XX XX imm16 (C7 /0)
// Pattern 4: MOVSW/MOVSB etc — too complex to match here

const modrmNames = ['AX/EAX', 'CX/ECX', 'DX/EDX', 'BX/EBX', 'SP/ESP', 'BP/EBP', 'SI/ESI', 'DI/EDI'];
const hits = [];
for (let i = 0; i < bytes.length - 4; i++) {
  const b = bytes[i];
  let base = i;
  let is32 = false;
  if (b === 0x66) { is32 = true; base = i + 1; }
  if (bytes[base] === 0x89) {
    const modrm = bytes[base + 1];
    const mod = (modrm >> 6) & 3;
    const reg = (modrm >> 3) & 7;
    const rm = modrm & 7;
    if (mod === 0 && rm === 6) {
      const disp = bytes[base + 2] | (bytes[base + 3] << 8);
      if (disp === off) {
        hits.push({ addr: i, reg, is32, op: `mov ${is32 ? 'dword' : 'word'} [0x${disp.toString(16)}], ${is32 ? 'E' : ''}${['AX','CX','DX','BX','SP','BP','SI','DI'][reg]}` });
      }
    }
  }
  // C7 06 XX XX imm = MOV word [disp16], imm
  if (b === 0xC7 && bytes[i+1] === 0x06) {
    const disp = bytes[i + 2] | (bytes[i + 3] << 8);
    if (disp === off) {
      const imm = bytes[i + 4] | (bytes[i + 5] << 8);
      hits.push({ addr: i, op: `mov word [0x${disp.toString(16)}], 0x${imm.toString(16)}` });
    }
  }
  // 66 C7 06 XX XX imm32 = MOV dword [disp16], imm32
  if (b === 0x66 && bytes[i+1] === 0xC7 && bytes[i+2] === 0x06) {
    const disp = bytes[i + 3] | (bytes[i + 4] << 8);
    if (disp === off) {
      const imm = bytes[i+5] | (bytes[i+6]<<8) | (bytes[i+7]<<16) | (bytes[i+8]<<24);
      hits.push({ addr: i, op: `mov dword [0x${disp.toString(16)}], 0x${(imm>>>0).toString(16)}` });
    }
  }
}

console.log(`\nFound ${hits.length} writes:`);
for (const h of hits) {
  console.log(`  cs=0x${sel.toString(16)}:0x${h.addr.toString(16).padStart(4,'0')}  ${h.op}`);
}
