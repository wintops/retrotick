// Find all branches (jmp/call/jcc) to a specific offset in a segment
import { readFileSync } from 'fs';
const sel = parseInt(process.argv[2] || '1569', 16);
const targets = process.argv.slice(3).map(x => parseInt(x, 16));
if (!targets.length) {
  console.log('Usage: npx tsx tests/find-branches-to.mjs <sel-hex> <off1-hex> [off2-hex ...]');
  process.exit(1);
}
const bytes = readFileSync(`D:/tmp/doom-cs-${sel.toString(16)}.bin`);
console.log(`Branches to ${targets.map(t => '0x' + t.toString(16)).join(', ')} in cs=${sel.toString(16)}:`);

function check(addr, op, len, target) {
  if (targets.includes(target)) {
    const ctx = [];
    for (let j = Math.max(0, addr - 4); j < Math.min(bytes.length, addr + len + 2); j++) {
      ctx.push(bytes[j].toString(16).padStart(2, '0'));
    }
    console.log(`  @0x${addr.toString(16)}: ${op} → 0x${target.toString(16)}  [${ctx.join(' ')}]`);
  }
}

for (let i = 0; i < bytes.length; i++) {
  const b = bytes[i];
  // E8 near call (+3)
  if (b === 0xE8 && i + 3 <= bytes.length) {
    const rel = bytes[i+1] | (bytes[i+2] << 8);
    const signedRel = (rel & 0x8000) ? rel - 0x10000 : rel;
    const target = ((i + 3) + signedRel) & 0xFFFF;
    check(i, 'call near', 3, target);
  }
  // E9 near jmp (+3)
  if (b === 0xE9 && i + 3 <= bytes.length) {
    const rel = bytes[i+1] | (bytes[i+2] << 8);
    const signedRel = (rel & 0x8000) ? rel - 0x10000 : rel;
    const target = ((i + 3) + signedRel) & 0xFFFF;
    check(i, 'jmp near', 3, target);
  }
  // EB short jmp (+2)
  if (b === 0xEB && i + 2 <= bytes.length) {
    const rel = bytes[i+1];
    const signedRel = (rel & 0x80) ? rel - 0x100 : rel;
    const target = ((i + 2) + signedRel) & 0xFFFF;
    check(i, 'jmp short', 2, target);
  }
  // Jcc short 70-7F (+2)
  if (b >= 0x70 && b <= 0x7F && i + 2 <= bytes.length) {
    const rel = bytes[i+1];
    const signedRel = (rel & 0x80) ? rel - 0x100 : rel;
    const target = ((i + 2) + signedRel) & 0xFFFF;
    check(i, `jcc short (${b.toString(16)})`, 2, target);
  }
  // Jcc near 0F 80-8F (+4)
  if (b === 0x0F && i + 4 <= bytes.length) {
    const op = bytes[i+1];
    if (op >= 0x80 && op <= 0x8F) {
      const rel = bytes[i+2] | (bytes[i+3] << 8);
      const signedRel = (rel & 0x8000) ? rel - 0x10000 : rel;
      const target = ((i + 4) + signedRel) & 0xFFFF;
      check(i, `jcc near (0F${op.toString(16)})`, 4, target);
    }
  }
  // EA ptr16:16 far jmp (+5)
  if (b === 0xEA && i + 5 <= bytes.length) {
    const off = bytes[i+1] | (bytes[i+2] << 8);
    const seg = bytes[i+3] | (bytes[i+4] << 8);
    if (seg === sel) check(i, `far jmp (EA)`, 5, off);
  }
  // 9A ptr16:16 far call (+5)
  if (b === 0x9A && i + 5 <= bytes.length) {
    const off = bytes[i+1] | (bytes[i+2] << 8);
    const seg = bytes[i+3] | (bytes[i+4] << 8);
    if (seg === sel) check(i, `far call (9A)`, 5, off);
  }
}
