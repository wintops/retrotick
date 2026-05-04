import { readFileSync } from 'fs';
const b = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo.dat');
console.log('Size:', b.length);

// Parse PACK header
const dirpos = b.readUInt32LE(4);
const dirsize = b.readUInt32LE(8);
console.log('dirpos:', dirpos, 'dirsize:', dirsize);

// Each pak_direntry is {char filename[56]; int pos; int size;} = 64 bytes
const entrySize = 64;
const entries = [];
for (let i = 0; i < dirsize / entrySize; i++) {
  const off = dirpos + i * entrySize;
  const name = b.slice(off, off + 56).toString('ascii').split('\0')[0];
  const pos = b.readUInt32LE(off + 56);
  const size = b.readUInt32LE(off + 60);
  entries.push({ name, pos, size });
}
console.log(`Entries: ${entries.length}`);
const ogg = entries.find(e => e.name === 'data/amoeba-test.ogg');
if (ogg) {
  console.log(`\nOGG file: pos=0x${ogg.pos.toString(16)} size=${ogg.size}`);
  console.log('First 64 bytes:', [...b.slice(ogg.pos, ogg.pos + 64)].map(x => x.toString(16).padStart(2, '0')).join(' '));
  // Check Vorbis identification header: should be \x01vorbis (7 bytes) at some offset inside the first Ogg page
  for (let i = ogg.pos; i < ogg.pos + 200; i++) {
    if (b[i] === 0x01 && b.slice(i + 1, i + 7).toString('ascii') === 'vorbis') {
      console.log(`\\x01vorbis header at Ogg-offset ${i - ogg.pos}`);
      console.log('Vorbis ID header bytes:', [...b.slice(i, i + 30)].map(x => x.toString(16).padStart(2, '0')).join(' '));
      break;
    }
  }
}
