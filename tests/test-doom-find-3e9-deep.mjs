// Deeper search: find 0x3E9 (1001) in any encoding form throughout DOOM.EXE.
// Also find "PUSH 0x1514" patterns that often pair with PUSH 0x3E9.
import { readFileSync } from 'fs';

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/DoomShw';
const buf = new Uint8Array(readFileSync(`${BASE}/DOOM.EXE`));

function findAll(pattern) {
  const positions = [];
  for (let i = 0; i + pattern.length <= buf.length; i++) {
    let match = true;
    for (let j = 0; j < pattern.length; j++) if (buf[i + j] !== pattern[j]) { match = false; break; }
    if (match) positions.push(i);
  }
  return positions;
}

// 0x000003E9 anywhere as 32-bit LE word
console.log('[search 32-bit word 0x000003E9]');
const w32 = findAll([0xE9, 0x03, 0x00, 0x00]);
console.log(`  ${w32.length} matches`);
for (const p of w32.slice(0, 40)) {
  const slice = buf.slice(Math.max(0, p - 6), Math.min(buf.length, p + 12));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16).padStart(6, '0')}: ${hex}`);
}

// 0x03E9 as 16-bit word (less specific)
console.log('\n[search 16-bit word 0x03E9 — bytes E9 03 only]');
const w16 = findAll([0xE9, 0x03]);
console.log(`  ${w16.length} matches (will include unrelated)`);

// PUSH 0x1514 as imm16: 68 14 15
console.log('\n[search PUSH 0x1514 — 68 14 15]');
const p1514 = findAll([0x68, 0x14, 0x15]);
console.log(`  ${p1514.length} matches`);
for (const p of p1514.slice(0, 30)) {
  const slice = buf.slice(Math.max(0, p - 6), Math.min(buf.length, p + 12));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16)}: ${hex}`);
}

// PUSH 0x1514 as imm32: 68 14 15 00 00
console.log('\n[search PUSH 0x00001514 — 68 14 15 00 00]');
const p1514_32 = findAll([0x68, 0x14, 0x15, 0x00, 0x00]);
console.log(`  ${p1514_32.length} matches`);
for (const p of p1514_32.slice(0, 30)) {
  const slice = buf.slice(Math.max(0, p - 6), Math.min(buf.length, p + 12));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16)}: ${hex}`);
}

// "error in interrupt chain" file offset is 0x22341. Let's look for refs to its
// LE-relative offset. LE starts at 0x1af6b so LE-rel = 0x22341 - 0x1af6b = 0x73d6
const fatalErrLE = 0x24625 - 0x1af6b; // = 0x96ba
const errChainLE = 0x22341 - 0x1af6b;  // = 0x73d6
console.log(`\n[LE-rel] fatal err format string @LE+0x${fatalErrLE.toString(16)}`);
console.log(`[LE-rel] err in chain string    @LE+0x${errChainLE.toString(16)}`);

// Search LE-data offsets in 16-bit form
console.log('\n[16-bit refs to "error in interrupt chain" @0x73d6 — bytes d6 73]');
const errRef16 = findAll([0xd6, 0x73]);
console.log(`  ${errRef16.length} matches (will be many false positives)`);

// More specific: PUSH 0x73d6 = 68 d6 73
console.log('\n[PUSH 0x73d6 — 68 d6 73]');
const pushErrRef = findAll([0x68, 0xd6, 0x73]);
console.log(`  ${pushErrRef.length} matches`);
for (const p of pushErrRef.slice(0, 30)) {
  const slice = buf.slice(Math.max(0, p - 6), Math.min(buf.length, p + 16));
  const hex = [...slice].map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`  @0x${p.toString(16)}: ${hex}`);
}

// MZ MZSize = bytes 0..1 == "MZ" — tell us where MZ extra data ends
const mzPages = (buf[2] | (buf[3] << 8));
const mzLastPgBytes = (buf[4] | (buf[5] << 8));
const mzHdrParas = (buf[8] | (buf[9] << 8));
const mzImgEnd = ((mzPages - 1) * 512 + mzLastPgBytes);
console.log(`\n[MZ HEADER] pages=${mzPages} lastPgBytes=${mzLastPgBytes} hdrParas=${mzHdrParas}`);
console.log(`[MZ image end] = 0x${mzImgEnd.toString(16)} (inclusive)`);
console.log(`[MZ image start of code at] 0x${(mzHdrParas * 16).toString(16)}`);
