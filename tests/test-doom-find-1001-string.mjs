// Static analysis: find the "DOS/4GW Professional fatal error (1001):" string
// inside DOOM.EXE and dump bytes around it. Goal: identify the code that
// references it (via `MOV r,imm32` with that linear address, or `LEA r,[rip+...]`).
import { readFileSync } from 'fs';

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/DoomShw';
const buf = new Uint8Array(readFileSync(`${BASE}/DOOM.EXE`));

console.log(`[INFO] DOOM.EXE size = ${buf.length} bytes`);

// Search for various candidate strings
const needles = [
  'DOS/4GW',
  'fatal error',
  'interrupt chain',
  '(1001)',
  'error in',
  'Professional',
];

for (const needle of needles) {
  const positions = [];
  const target = new TextEncoder().encode(needle);
  for (let i = 0; i + target.length <= buf.length; i++) {
    let match = true;
    for (let j = 0; j < target.length; j++) {
      if (buf[i + j] !== target[j]) { match = false; break; }
    }
    if (match) positions.push(i);
  }
  console.log(`[NEEDLE] "${needle}" — ${positions.length} matches: ${positions.map(p => '0x' + p.toString(16)).join(', ')}`);
  // Dump context around first match
  if (positions.length > 0) {
    const p = positions[0];
    const start = Math.max(0, p - 16);
    const end = Math.min(buf.length, p + 64);
    const slice = buf.slice(start, end);
    let dump = '';
    for (const b of slice) {
      if (b >= 32 && b <= 126) dump += String.fromCharCode(b);
      else dump += '·';
    }
    console.log(`  context @0x${start.toString(16)}: ${dump}`);
  }
}

// Search for PM segment patterns. The DOS/4GW LE binary lives starting at some
// offset inside the MZ wrapper. Find LE signature:
const LE_OFF = buf.indexOf(0x4C); // 'L'
let leOffset = -1;
for (let i = 0; i < buf.length - 1; i++) {
  if (buf[i] === 0x4C && buf[i + 1] === 0x45) { // "LE"
    leOffset = i;
    break;
  }
}
console.log(`\n[LE signature] found at 0x${leOffset.toString(16)}`);

// Try locating specifically the literal full string
const fullStr = 'fatal error (1001)';
const fullEnc = new TextEncoder().encode(fullStr);
let fullPos = -1;
for (let i = 0; i + fullEnc.length <= buf.length; i++) {
  let m = true;
  for (let j = 0; j < fullEnc.length; j++) if (buf[i + j] !== fullEnc[j]) { m = false; break; }
  if (m) { fullPos = i; break; }
}
console.log(`\n[FULL STRING] "${fullStr}" found at 0x${fullPos.toString(16)}`);
if (fullPos >= 0) {
  const start = Math.max(0, fullPos - 64);
  const end = Math.min(buf.length, fullPos + 128);
  const slice = buf.slice(start, end);
  // Print as hex+ASCII
  let line = '';
  for (let i = 0; i < slice.length; i += 16) {
    const chunk = slice.slice(i, Math.min(slice.length, i + 16));
    const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.').join('');
    console.log(`  0x${(start + i).toString(16).padStart(8, '0')}: ${hex.padEnd(48)} ${ascii}`);
  }
}
