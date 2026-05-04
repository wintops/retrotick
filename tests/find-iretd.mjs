// Find all IRETD/IRET locations in a segment dump
import { readFileSync } from 'fs';
const sel = parseInt(process.argv[2] || '1569', 16);
const bytes = readFileSync(`D:/tmp/doom-cs-${sel.toString(16)}.bin`);
console.log(`IRETD (66 cf) in cs=${sel.toString(16)}:`);
for (let i = 0; i < bytes.length - 1; i++) {
  if (bytes[i] === 0x66 && bytes[i+1] === 0xcf) {
    const ctx = [];
    for (let j = Math.max(0, i-8); j < Math.min(bytes.length, i+4); j++) {
      ctx.push(bytes[j].toString(16).padStart(2, '0'));
    }
    console.log(`  @0x${i.toString(16)}: ${ctx.join(' ')}`);
  }
}
console.log('\nIRET (cf alone) in cs=' + sel.toString(16) + ':');
for (let i = 0; i < bytes.length - 1; i++) {
  if (bytes[i] === 0xcf && (i === 0 || bytes[i-1] !== 0x66)) {
    const ctx = [];
    for (let j = Math.max(0, i-8); j < Math.min(bytes.length, i+4); j++) {
      ctx.push(bytes[j].toString(16).padStart(2, '0'));
    }
    console.log(`  @0x${i.toString(16)}: ${ctx.join(' ')}`);
  }
}
