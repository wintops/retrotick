// Disassemble from a specific offset in one of the dumped LE segments.
// Usage: npx tsx tests/disasm-at.mjs <sel> <offset> [count]
// Example: npx tsx tests/disasm-at.mjs 1b4e 30F9 50
//   → disassembles 50 instructions starting at cs=0x1b4e:0x30F9
import { readFileSync } from 'fs';
import { Capstone, Const, loadCapstone } from 'capstone-wasm';

await loadCapstone();

const args = process.argv.slice(2);
const sel = parseInt(args[0], 16);
const offset = parseInt(args[1], 16);
const count = parseInt(args[2] || '100', 10);
const mode = args[3] === '32' ? 32 : 16;

if (!args[0] || !args[1]) {
  console.log(`Usage: npx tsx tests/disasm-at.mjs <sel-hex> <offset-hex> [count] [16|32]`);
  console.log(`Example: npx tsx tests/disasm-at.mjs 1b4e 30F9 100`);
  process.exit(1);
}

const binPath = `D:/tmp/doom-cs-${sel.toString(16)}.bin`;
const bytes = readFileSync(binPath);
const slice = bytes.slice(offset);

const cs = new Capstone(Const.CS_ARCH_X86, mode === 16 ? Const.CS_MODE_16 : Const.CS_MODE_32);
const insns = cs.disasm(new Uint8Array(slice), { address: offset, count });

console.log(`; cs=0x${sel.toString(16)}:0x${offset.toString(16)} (base=0x${(sel*16).toString(16)}) mode=${mode}-bit, ${insns.length} instructions\n`);
for (const ins of insns) {
  const addr = Number(ins.address);
  const bh = Array.from(ins.bytes).map(b => b.toString(16).padStart(2,'0')).join(' ');
  console.log(`  ${addr.toString(16).padStart(5, '0')}: ${bh.padEnd(22)} ${ins.mnemonic.padEnd(8)} ${ins.opStr}`);
}

cs.close();
