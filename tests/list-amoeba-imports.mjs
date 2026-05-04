import { readFileSync } from 'fs';
import { parsePE } from '../src/lib/pe/index.ts';
import { extractImports } from '../src/lib/pe/extract-import.ts';

const b = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo-win32.exe');
const ab = new ArrayBuffer(b.byteLength);
new Uint8Array(ab).set(b);
const pe = parsePE(ab);
const imports = extractImports(pe, ab);
for (const imp of imports) {
  console.log(`\n=== ${imp.dllName} ===`);
  for (const fn of imp.functions) console.log(`  ${fn.name || '#' + fn.ordinal}`);
}
