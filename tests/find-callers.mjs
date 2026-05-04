// Find all CALL instructions in a segment that target a given offset.
// Scans for E8 XX XX (near CALL) and 9A XX XX SS SS (far CALL) patterns.
//
// Usage: npx tsx tests/find-callers.mjs <sel> <targetOffset> [otherSel]
// Example: npx tsx tests/find-callers.mjs 1b4e 30f9
import { readFileSync } from 'fs';

const args = process.argv.slice(2);
const sel = parseInt(args[0], 16);
const targetOff = parseInt(args[1], 16);
const otherSel = args[2] ? parseInt(args[2], 16) : null;

if (!args[0] || !args[1]) {
  console.log(`Usage: npx tsx tests/find-callers.mjs <sel-hex> <targetOffset-hex> [otherSelForFarCalls]`);
  process.exit(1);
}

const binPath = `D:/tmp/doom-cs-${sel.toString(16)}.bin`;
const bytes = readFileSync(binPath);

console.log(`Scanning ${binPath} (${bytes.length} bytes) for calls to 0x${targetOff.toString(16)} in same segment (cs=0x${sel.toString(16)})`);

// Near calls: E8 rel16. rel16 = targetOff - (i + 3)
// Scan every byte position — this produces false positives but we'll filter.
const nearHits = [];
for (let i = 0; i <= bytes.length - 3; i++) {
  if (bytes[i] !== 0xE8) continue;
  const rel = bytes[i+1] | (bytes[i+2] << 8);
  const signedRel = (rel & 0x8000) ? rel - 0x10000 : rel;
  const target = ((i + 3) + signedRel) & 0xFFFF;
  if (target === targetOff) {
    nearHits.push(i);
  }
}
console.log(`\nNear CALLs to 0x${targetOff.toString(16)} (E8 XX XX): ${nearHits.length}`);
for (const i of nearHits) {
  // Print context
  const ctx = [];
  for (let j = Math.max(0, i-4); j < Math.min(bytes.length, i+8); j++) {
    ctx.push(bytes[j].toString(16).padStart(2, '0'));
  }
  console.log(`  @0x${i.toString(16)} context: ${ctx.join(' ')}`);
}

// Far calls: 9A XX XX SS SS (target offset, then segment)
// We want to find far calls that target cs:targetOff where cs is some specific segment.
// If otherSel is provided, we scan for 9A loOff hiOff loSeg hiSeg where
// loOff|hiOff<<8 == targetOff and loSeg|hiSeg<<8 == otherSel.
// Note: far calls TO a segment come from a DIFFERENT segment, but within the same file
// we'd look in the caller's .bin (which we don't have here unless otherSel matches sel).
// For FAR CALLS TO cs=`sel`:<targetOff>, we'd need to scan ALL OTHER segments.
const farHits = [];
const scanForFar = otherSel !== null;
if (scanForFar) {
  console.log(`\nFar CALLs to cs=0x${sel.toString(16)}:0x${targetOff.toString(16)} from cs=0x${otherSel.toString(16)}:`);
  const callerBin = `D:/tmp/doom-cs-${otherSel.toString(16)}.bin`;
  let callerBytes;
  try { callerBytes = readFileSync(callerBin); } catch { console.log(`  (${callerBin} not found)`); }
  if (callerBytes) {
    for (let i = 0; i <= callerBytes.length - 5; i++) {
      if (callerBytes[i] !== 0x9A) continue;
      const off = callerBytes[i+1] | (callerBytes[i+2] << 8);
      const seg = callerBytes[i+3] | (callerBytes[i+4] << 8);
      if (off === targetOff && seg === sel) {
        const ctx = [];
        for (let j = Math.max(0, i-4); j < Math.min(callerBytes.length, i+10); j++) {
          ctx.push(callerBytes[j].toString(16).padStart(2, '0'));
        }
        console.log(`  @0x${i.toString(16)} context: ${ctx.join(' ')}`);
        farHits.push(i);
      }
    }
    console.log(`  total: ${farHits.length}`);
  }
}
