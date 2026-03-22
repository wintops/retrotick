import { Memory } from './memory';
import type { MZHeader } from '../pe/types';

export interface LoadedMZ {
  loadSegment: number;     // real-mode segment where PSP is loaded
  pspLinear: number;       // linear address of PSP
  entryCS: number;         // real-mode CS value
  entryIP: number;         // IP value
  entrySS: number;         // real-mode SS value
  entrySP: number;         // SP value
  imageSize: number;       // total bytes of program image loaded
  mcbFirstSeg: number;     // first MCB segment for LoL
}

export function loadMZ(arrayBuffer: ArrayBuffer, memory: Memory, mzHeader: MZHeader, exePath: string): LoadedMZ {
  const data = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);

  // Calculate image size from MZ header
  const headerSize = mzHeader.e_cparhdr * 16;
  let imageSize: number;
  if (mzHeader.e_cp === 0) {
    imageSize = arrayBuffer.byteLength - headerSize;
  } else {
    imageSize = (mzHeader.e_cp - 1) * 512 + (mzHeader.e_cblp || 512) - headerSize;
  }
  imageSize = Math.min(imageSize, arrayBuffer.byteLength - headerSize);

  const topSeg = 0xA000; // 640KB
  const LOAD_SEG = 0x0100; // PSP segment

  // Memory layout:
  // 0x0060: MCB for env block
  // 0x0061: environment data (ENV_PARAS paragraphs)
  // 0x00FF: MCB for program
  // 0x0100: PSP (LOAD_SEG)
  // 0x0110: program image (progSeg)

  const ENV_MCB_SEG = 0x0060;
  const ENV_SEG = ENV_MCB_SEG + 1; // 0x0061
  // Env block size must reach exactly up to LOAD_SEG - 1
  const ENV_PARAS = LOAD_SEG - 1 - ENV_SEG; // 0xFF - 0x61 = 0x9E
  const PROG_MCB_SEG = LOAD_SEG - 1; // 0x00FF

  const pspLinear = LOAD_SEG * 16;
  const progSeg = LOAD_SEG + 0x10;
  const progLinear = progSeg * 16;

  // Total program paragraphs
  const imageParas = Math.ceil(imageSize / 16);
  const totalParas = 0x10 + imageParas + mzHeader.e_minalloc;

  // --- MCB chain ---
  // MCB 1: environment block
  const envMcbLinear = ENV_MCB_SEG * 16;
  memory.writeU8(envMcbLinear + 0, 0x4D);       // 'M'
  memory.writeU16(envMcbLinear + 1, LOAD_SEG);   // owner = PSP
  memory.writeU16(envMcbLinear + 3, ENV_PARAS);

  // MCB 2: program block
  const progMcbLinear = PROG_MCB_SEG * 16;
  memory.writeU8(progMcbLinear + 0, 0x4D);       // 'M'
  memory.writeU16(progMcbLinear + 1, LOAD_SEG);   // owner = PSP
  memory.writeU16(progMcbLinear + 3, totalParas);

  // MCB 3: free memory after program
  const freeMcbSeg = LOAD_SEG + totalParas;
  if (freeMcbSeg < topSeg) {
    const freeMcbLinear = freeMcbSeg * 16;
    const freeParas = topSeg - freeMcbSeg - 1;
    memory.writeU8(freeMcbLinear + 0, 0x5A);       // 'Z'
    memory.writeU16(freeMcbLinear + 1, 0x0000);     // free
    memory.writeU16(freeMcbLinear + 3, freeParas);
  } else {
    // Program fills all memory — mark MCB 2 as last
    memory.writeU8(progMcbLinear + 0, 0x5A);       // 'Z'
  }

  // --- Build PSP ---
  memory.writeU8(pspLinear + 0x00, 0xCD); // INT 20h
  memory.writeU8(pspLinear + 0x01, 0x20);
  memory.writeU16(pspLinear + 0x02, topSeg);

  // Write environment
  const envLinear = ENV_SEG * 16;
  let envOff = 0;
  const comspec = 'COMSPEC=C:\\COMMAND.COM\0';
  for (let i = 0; i < comspec.length; i++) memory.writeU8(envLinear + envOff++, comspec.charCodeAt(i));
  const pathEnv = 'PATH=C:\\\0';
  for (let i = 0; i < pathEnv.length; i++) memory.writeU8(envLinear + envOff++, pathEnv.charCodeAt(i));
  const blasterEnv = 'BLASTER=A220 I7 D1 T4\0';
  for (let i = 0; i < blasterEnv.length; i++) memory.writeU8(envLinear + envOff++, blasterEnv.charCodeAt(i));
  const ultrasndEnv = 'ULTRASND=240,1,1,5,5\0';
  for (let i = 0; i < ultrasndEnv.length; i++) memory.writeU8(envLinear + envOff++, ultrasndEnv.charCodeAt(i));
  memory.writeU8(envLinear + envOff++, 0); // double null terminator
  memory.writeU16(envLinear + envOff, 1);
  envOff += 2;
  const progName = exePath + '\0';
  for (let i = 0; i < progName.length; i++) memory.writeU8(envLinear + envOff++, progName.charCodeAt(i));

  memory.writeU16(pspLinear + 0x2C, ENV_SEG);

  // Command tail at offset 0x80 (empty)
  memory.writeU8(pspLinear + 0x80, 0x00);
  memory.writeU8(pspLinear + 0x81, 0x0D);

  // --- Copy program image ---
  for (let i = 0; i < imageSize; i++) {
    memory.writeU8(progLinear + i, data[headerSize + i]);
  }

  // Apply relocations
  const relocCount = mzHeader.e_crlc;
  const relocOffset = mzHeader.e_lfarlc;
  for (let i = 0; i < relocCount; i++) {
    const rOff = relocOffset + i * 4;
    if (rOff + 4 > arrayBuffer.byteLength) break;
    const off = dv.getUint16(rOff, true);
    const seg = dv.getUint16(rOff + 2, true);
    const linearAddr = progLinear + seg * 16 + off;
    const oldVal = memory.readU16(linearAddr);
    memory.writeU16(linearAddr, (oldVal + progSeg) & 0xFFFF);
  }

  // Entry point
  const entryCS = (mzHeader.e_cs + progSeg) & 0xFFFF;
  const entryIP = mzHeader.e_ip;
  const entrySS = (mzHeader.e_ss + progSeg) & 0xFFFF;
  const entrySP = mzHeader.e_sp;

  return {
    loadSegment: LOAD_SEG,
    pspLinear,
    entryCS,
    entryIP,
    entrySS,
    entrySP,
    imageSize,
    mcbFirstSeg: ENV_MCB_SEG,
  };
}

export function loadCOM(arrayBuffer: ArrayBuffer, memory: Memory, exePath: string): LoadedMZ {
  const data = new Uint8Array(arrayBuffer);
  const imageSize = data.byteLength;

  const topSeg = 0xA000; // 640KB
  const LOAD_SEG = 0x0100; // PSP segment

  // Memory layout (same as MZ):
  // 0x0060: MCB for env block
  // 0x0061: environment data
  // 0x00FF: MCB for program
  // 0x0100: PSP (LOAD_SEG)
  // 0x0100:0100: program image (offset 0x100 within PSP segment)

  const ENV_MCB_SEG = 0x0060;
  const ENV_SEG = ENV_MCB_SEG + 1;
  const ENV_PARAS = LOAD_SEG - 1 - ENV_SEG;
  const PROG_MCB_SEG = LOAD_SEG - 1;

  const pspLinear = LOAD_SEG * 16;

  // COM programs load at PSP:0100h (within the same segment as PSP)
  const imageParas = Math.ceil((imageSize + 0x100) / 16);
  const totalParas = imageParas;

  // --- MCB chain ---
  const envMcbLinear = ENV_MCB_SEG * 16;
  memory.writeU8(envMcbLinear + 0, 0x4D);       // 'M'
  memory.writeU16(envMcbLinear + 1, LOAD_SEG);   // owner = PSP
  memory.writeU16(envMcbLinear + 3, ENV_PARAS);

  const progMcbLinear = PROG_MCB_SEG * 16;
  memory.writeU8(progMcbLinear + 0, 0x4D);       // 'M'
  memory.writeU16(progMcbLinear + 1, LOAD_SEG);   // owner = PSP
  memory.writeU16(progMcbLinear + 3, totalParas);

  const freeMcbSeg = LOAD_SEG + totalParas;
  if (freeMcbSeg < topSeg) {
    const freeMcbLinear = freeMcbSeg * 16;
    const freeParas = topSeg - freeMcbSeg - 1;
    memory.writeU8(freeMcbLinear + 0, 0x5A);
    memory.writeU16(freeMcbLinear + 1, 0x0000);
    memory.writeU16(freeMcbLinear + 3, freeParas);
  } else {
    memory.writeU8(progMcbLinear + 0, 0x5A);
  }

  // --- Build PSP ---
  memory.writeU8(pspLinear + 0x00, 0xCD); // INT 20h
  memory.writeU8(pspLinear + 0x01, 0x20);
  memory.writeU16(pspLinear + 0x02, topSeg);

  // Write environment
  const envLinear = ENV_SEG * 16;
  let envOff = 0;
  const comspec = 'COMSPEC=C:\\COMMAND.COM\0';
  for (let i = 0; i < comspec.length; i++) memory.writeU8(envLinear + envOff++, comspec.charCodeAt(i));
  const pathEnv = 'PATH=C:\\\0';
  for (let i = 0; i < pathEnv.length; i++) memory.writeU8(envLinear + envOff++, pathEnv.charCodeAt(i));
  const blasterEnv = 'BLASTER=A220 I7 D1 T4\0';
  for (let i = 0; i < blasterEnv.length; i++) memory.writeU8(envLinear + envOff++, blasterEnv.charCodeAt(i));
  const ultrasndEnv = 'ULTRASND=240,1,1,5,5\0';
  for (let i = 0; i < ultrasndEnv.length; i++) memory.writeU8(envLinear + envOff++, ultrasndEnv.charCodeAt(i));
  memory.writeU8(envLinear + envOff++, 0); // double null terminator
  memory.writeU16(envLinear + envOff, 1);
  envOff += 2;
  const progName = exePath + '\0';
  for (let i = 0; i < progName.length; i++) memory.writeU8(envLinear + envOff++, progName.charCodeAt(i));

  memory.writeU16(pspLinear + 0x2C, ENV_SEG);

  // Command tail at offset 0x80 (empty)
  memory.writeU8(pspLinear + 0x80, 0x00);
  memory.writeU8(pspLinear + 0x81, 0x0D);

  // --- Copy program image at PSP:0100h ---
  const loadLinear = pspLinear + 0x100;
  for (let i = 0; i < imageSize; i++) {
    memory.writeU8(loadLinear + i, data[i]);
  }

  // COM entry: CS=DS=ES=SS=PSP segment, IP=0x0100, SP=0xFFFE (top of segment)
  return {
    loadSegment: LOAD_SEG,
    pspLinear,
    entryCS: LOAD_SEG,
    entryIP: 0x0100,
    entrySS: LOAD_SEG,
    entrySP: 0xFFFE,
    imageSize,
    mcbFirstSeg: ENV_MCB_SEG,
  };
}
