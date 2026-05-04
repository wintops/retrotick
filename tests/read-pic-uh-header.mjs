import { readFileSync } from 'fs';
const b = readFileSync('D:\\Perso\\SideProjects\\SecondReality\\END\\PIC.UH');
console.log('Size:', b.length);
console.log('magic:', b.readUInt16LE(0).toString(16));
console.log('wid:', b.readUInt16LE(2));
console.log('hig:', b.readUInt16LE(4));
console.log('cols:', b.readUInt16LE(6));
console.log('add:', b.readUInt16LE(8));
