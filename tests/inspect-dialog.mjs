import { readFileSync } from 'fs';
import { parsePE } from '../src/lib/pe/index.ts';
import { rvaToFileOffset } from '../src/lib/pe/read.ts';

const b = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo-win32.exe');
const ab = new ArrayBuffer(b.byteLength);
new Uint8Array(ab).set(b);
const pe = parsePE(ab);

const dlgType = pe.resources?.find(r => r.typeId === 5);
if (!dlgType) { console.log('No dialog resources'); process.exit(0); }

for (const entry of dlgType.entries) {
  for (const lang of entry.languages) {
    const off = rvaToFileOffset(lang.dataRva, pe.sections);
    console.log(`Dialog ${entry.id ?? entry.name} lang=${lang.languageId} RVA=0x${lang.dataRva.toString(16)} fileOff=0x${off.toString(16)} size=${lang.dataSize}`);
    const dv = new DataView(ab, off, lang.dataSize);
    const sig0 = dv.getUint16(0, true);
    const sig1 = dv.getUint16(2, true);
    console.log(`  sig0=0x${sig0.toString(16)} sig1=0x${sig1.toString(16)} (isEx = ${sig0 === 1 && sig1 === 0xFFFF})`);
    console.log(`  First 32 bytes:`, [...new Uint8Array(ab, off, Math.min(32, lang.dataSize))].map(x => x.toString(16).padStart(2, '0')).join(' '));
    const buf = new Uint8Array(ab, off, lang.dataSize);
    const asc = Array.from(buf).map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('');
    console.log(`  ASCII dump:`);
    for (let i = 0; i < asc.length; i += 64) console.log('    ', asc.slice(i, i + 64));
  }
}
