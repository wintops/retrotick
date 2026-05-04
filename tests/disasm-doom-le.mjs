// Disassemble the LE segments dumped by dump-doom-le.mjs using capstone-wasm.
// Writes full .asm files alongside each .bin.
//
// Usage:
//   npx tsx tests/dump-doom-le.mjs     # first, dump the segments
//   npx tsx tests/disasm-doom-le.mjs   # then disassemble them
import { readFileSync, writeFileSync } from 'fs';
import { Capstone, Const, loadCapstone } from 'capstone-wasm';

await loadCapstone();

// The LE segments in DOOM's embedded DOS/4GW have D=0 (16-bit) mode.
// Even though DOS/4GW operates in protected mode with 32-bit semantics via
// 66/67 prefixes, the CS descriptors are 16-bit (D=0).
const cs16 = new Capstone(Const.CS_ARCH_X86, Const.CS_MODE_16);

// DOOM's flat code selector cs=0x168 is D=1 (32-bit).
const cs32 = new Capstone(Const.CS_ARCH_X86, Const.CS_MODE_32);

// Segments to disassemble. D bit from observation:
// - 0x98, 0x1569, 0x1b4e, 0x26be, 0x271e, 0x2eef: D=0 (16-bit mode)
// - 0x168: D=1 (DOOM's flat 32-bit code)
const segments = [
  { sel: 0x98,   mode: 16 },
  { sel: 0x1569, mode: 16 },
  { sel: 0x1b4e, mode: 16 },
  { sel: 0x26be, mode: 16 },
  { sel: 0x271e, mode: 16 },
  { sel: 0x2eef, mode: 16 },
];

for (const { sel, mode } of segments) {
  const binPath = `D:/tmp/doom-cs-${sel.toString(16)}.bin`;
  const asmPath = `D:/tmp/doom-cs-${sel.toString(16)}.asm`;
  let bytes;
  try {
    bytes = readFileSync(binPath);
  } catch (e) {
    console.log(`[SKIP] ${binPath} not found`);
    continue;
  }

  const disasm = mode === 16 ? cs16 : cs32;
  const baseAddr = 0; // disassemble offsets relative to segment start

  const insns = disasm.disasm(new Uint8Array(bytes), { address: baseAddr });

  let out = `; Segment cs=0x${sel.toString(16)} base=0x${(sel*16).toString(16)} size=0x${bytes.length.toString(16)} mode=${mode}-bit\n`;
  out += `; Disassembled by capstone-wasm (D bit = ${mode === 16 ? 0 : 1})\n\n`;

  // Track where we are in the byte stream — insns may skip over bad bytes
  let lastEnd = 0;
  for (const ins of insns) {
    const addr = Number(ins.address);
    // Fill any gap with db directives (data bytes capstone couldn't decode)
    while (lastEnd < addr) {
      const b = bytes[lastEnd];
      out += `${lastEnd.toString(16).padStart(5, '0')}: ${b.toString(16).padStart(2, '0').padEnd(17)}  db 0${b.toString(16)}h\n`;
      lastEnd++;
    }
    const bh = Array.from(ins.bytes).map(b => b.toString(16).padStart(2,'0')).join(' ');
    out += `${addr.toString(16).padStart(5, '0')}: ${bh.padEnd(17)}  ${ins.mnemonic.padEnd(8)} ${ins.opStr}\n`;
    lastEnd = addr + ins.size;
  }
  // Trailing undecoded bytes
  while (lastEnd < bytes.length) {
    const b = bytes[lastEnd];
    out += `${lastEnd.toString(16).padStart(5, '0')}: ${b.toString(16).padStart(2, '0').padEnd(17)}  db 0${b.toString(16)}h\n`;
    lastEnd++;
  }

  writeFileSync(asmPath, out);
  console.log(`[DISASM] cs=0x${sel.toString(16)}: ${insns.length} instructions → ${asmPath} (${Math.round(out.length / 1024)}KB)`);
}

cs16.close();
cs32.close();
console.log(`\n[DONE] Open the .asm files with a text editor and search for 'push 0x7d2' or 'push 7d2h' to find the exit(2002) call site.`);
