// Find all sites in DOOM.EXE that PUSH imm32 0x000003E9 (= 1001 decimal).
// Patterns: 68 E9 03 00 00 (PUSH imm32) or 6A E9 (PUSH imm8 sign-extended,
// won't match since 1001 > 127). Also look for `MOV reg, 0x3E9` patterns:
// B8 E9 03 00 00 (MOV EAX, imm32) and similar for other registers.
import { readFileSync } from 'fs';

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/DoomShw';
const buf = new Uint8Array(readFileSync(`${BASE}/DOOM.EXE`));

// Pattern 1: PUSH imm32 0x000003E9 = 68 E9 03 00 00
const PUSH32 = [0x68, 0xE9, 0x03, 0x00, 0x00];
// Pattern 2: PUSH imm16 0x03E9 = 66 68 E9 03 (operand-size override) or just 68 E9 03 ?
// In 16-bit code: 68 E9 03 — yes
const PUSH16 = [0x68, 0xE9, 0x03];
// Pattern 3: MOV EAX, imm32 = B8 E9 03 00 00, MOV EBX, imm32 = BB E9 03 00 00, etc.
const MOV_REG_BASE = [0xB8, 0xB9, 0xBA, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF];

function findAll(pattern) {
  const positions = [];
  for (let i = 0; i + pattern.length <= buf.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) if (buf[i + j] !== pattern[j]) { match = false; break; }
    if (match) positions.push(i);
  }
  return positions;
}

console.log('[PUSH imm32 0x3E9] — pattern 68 E9 03 00 00');
const push32 = findAll(PUSH32);
console.log(`  ${push32.length} matches`);
for (const p of push32.slice(0, 30)) {
  // Show 20 bytes context
  const slice = buf.slice(Math.max(0, p - 4), Math.min(buf.length, p + 20));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16)}: ${hex}`);
}

console.log('\n[PUSH imm16 0x3E9] — pattern 68 E9 03 (16-bit code)');
const push16 = findAll(PUSH16);
console.log(`  ${push16.length} matches (may include false positives)`);
for (const p of push16.slice(0, 30)) {
  const slice = buf.slice(Math.max(0, p - 4), Math.min(buf.length, p + 20));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16)}: ${hex}`);
}

// MOV reg, 0x3E9 (32-bit immediate)
console.log('\n[MOV r32, 0x3E9] — patterns Bx E9 03 00 00');
for (const op of MOV_REG_BASE) {
  const pat = [op, 0xE9, 0x03, 0x00, 0x00];
  const m = findAll(pat);
  if (m.length > 0) {
    const reg = ['EAX','ECX','EDX','EBX','ESP','EBP','ESI','EDI'][op - 0xB8];
    console.log(`  MOV ${reg}, 0x3E9 — ${m.length} matches: ${m.map(p => '0x' + p.toString(16)).join(', ')}`);
  }
}

// Pattern 4: CMP / TEST against 0x3E9 — less likely but check
console.log('\n[Word 03 E9 in PE/data context]');
// Search for the LE-relative offset of "fatal error (%d):" string
// File offset 0x24625 — within LE image. Let's see the LE data layout.
const LE_OFF = 0x1af6b;
const fileOffsetOfFatalErr = 0x24625;
const leRel = fileOffsetOfFatalErr - LE_OFF;
console.log(`[LE-rel] "fatal error (%d):" at LE+0x${leRel.toString(16)} = ${leRel}`);

// 0x9701? Now look for references to that offset in code.
const hi = (leRel >>> 16) & 0xFFFF;
const lo = leRel & 0xFFFF;
const refLE = [lo & 0xFF, (lo >>> 8) & 0xFF, hi & 0xFF, (hi >>> 8) & 0xFF];
console.log(`[ref bytes for LE+0x${leRel.toString(16)}]: ${refLE.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
const refs = findAll(refLE);
console.log(`  ${refs.length} matches`);
for (const p of refs.slice(0, 20)) {
  const slice = buf.slice(Math.max(0, p - 8), Math.min(buf.length, p + 16));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`    @0x${p.toString(16)}: ${hex}`);
}
