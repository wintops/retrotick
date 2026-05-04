import { readFileSync } from 'fs';
const b = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo-win32.exe');
// Look at section names
const peOff = b.readUInt32LE(0x3c);
const numSections = b.readUInt16LE(peOff + 6);
const sizeOfOptHdr = b.readUInt16LE(peOff + 20);
const sectHdrOff = peOff + 24 + sizeOfOptHdr;
console.log(`Sections (${numSections}):`);
for (let i = 0; i < numSections; i++) {
  const off = sectHdrOff + i * 40;
  const name = b.slice(off, off + 8).toString('ascii').replace(/\0.*/, '');
  const vsize = b.readUInt32LE(off + 8);
  const vaddr = b.readUInt32LE(off + 12);
  const rsize = b.readUInt32LE(off + 16);
  const raddr = b.readUInt32LE(off + 20);
  const flags = b.readUInt32LE(off + 36);
  console.log(`  ${name.padEnd(10)} vaddr=0x${vaddr.toString(16).padStart(6,'0')} vsize=0x${vsize.toString(16).padStart(6,'0')} raddr=0x${raddr.toString(16).padStart(6,'0')} rsize=0x${rsize.toString(16).padStart(6,'0')} flags=0x${flags.toString(16)}`);
}
// UPX signature search
const upxSig = b.includes(Buffer.from('UPX!'));
console.log('Contains "UPX!":', upxSig);
