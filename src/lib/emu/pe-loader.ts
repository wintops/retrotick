import { Memory } from './memory';

export interface LoadedPE {
  imageBase: number;
  entryPoint: number;
  stackTop: number;
  thunkBase: number;
  apiMap: Map<number, { dll: string; name: string }>;
  sizeOfImage: number;
  resourceRva: number;
  resourceSize: number;
}

export function loadPE(arrayBuffer: ArrayBuffer, memory: Memory): LoadedPE {
  const dv = new DataView(arrayBuffer);

  // DOS header
  const e_magic = dv.getUint16(0, true);
  if (e_magic !== 0x5A4D) throw new Error('Not a valid PE file');
  const e_lfanew = dv.getUint32(0x3C, true);

  // PE signature
  const peSignature = dv.getUint32(e_lfanew, true);
  if (peSignature !== 0x00004550) throw new Error('Invalid PE signature');

  // COFF header
  const coffOffset = e_lfanew + 4;
  const numberOfSections = dv.getUint16(coffOffset + 2, true);
  const sizeOfOptionalHeader = dv.getUint16(coffOffset + 16, true);

  // Optional header
  const optOffset = coffOffset + 20;
  const magic = dv.getUint16(optOffset, true);
  if (magic !== 0x010B) throw new Error('Only PE32 (32-bit) executables are supported');

  const entryPointRva = dv.getUint32(optOffset + 16, true);
  const imageBase = dv.getUint32(optOffset + 28, true);
  const sectionAlignment = dv.getUint32(optOffset + 32, true);
  const sizeOfImage = dv.getUint32(optOffset + 56, true);
  const sizeOfHeaders = dv.getUint32(optOffset + 60, true);

  // Data directories
  const dataDirOffset = optOffset + 96;
  const numDataDirs = dv.getUint32(dataDirOffset - 4, true);

  const dataDirectories: { virtualAddress: number; size: number }[] = [];
  for (let i = 0; i < numDataDirs; i++) {
    dataDirectories.push({
      virtualAddress: dv.getUint32(dataDirOffset + i * 8, true),
      size: dv.getUint32(dataDirOffset + i * 8 + 4, true),
    });
  }

  // Section headers
  const sectionOffset = optOffset + sizeOfOptionalHeader;
  interface Section {
    name: string;
    virtualSize: number;
    virtualAddress: number;
    sizeOfRawData: number;
    pointerToRawData: number;
    characteristics: number;
  }
  const sections: Section[] = [];
  for (let i = 0; i < numberOfSections; i++) {
    const off = sectionOffset + i * 40;
    let name = '';
    for (let j = 0; j < 8; j++) {
      const ch = dv.getUint8(off + j);
      if (ch === 0) break;
      name += String.fromCharCode(ch);
    }
    sections.push({
      name,
      virtualSize: dv.getUint32(off + 8, true),
      virtualAddress: dv.getUint32(off + 12, true),
      sizeOfRawData: dv.getUint32(off + 16, true),
      pointerToRawData: dv.getUint32(off + 20, true),
      characteristics: dv.getUint32(off + 36, true),
    });
  }

  // Copy PE headers to memory
  const headerBytes = new Uint8Array(arrayBuffer, 0, Math.min(sizeOfHeaders, arrayBuffer.byteLength));
  memory.copyFrom(imageBase, headerBytes);

  // Map sections
  for (const section of sections) {
    if (section.sizeOfRawData > 0 && section.pointerToRawData > 0) {
      const rawSize = Math.min(section.sizeOfRawData, arrayBuffer.byteLength - section.pointerToRawData);
      if (rawSize > 0) {
        const data = new Uint8Array(arrayBuffer, section.pointerToRawData, rawSize);
        memory.copyFrom(imageBase + section.virtualAddress, data);
      }
    }
  }

  // Base relocations (dataDirectories[5])
  // Relocation is not needed if loading at preferred imageBase
  if (dataDirectories.length > 5 && dataDirectories[5].virtualAddress !== 0) {
    // Relocation is not needed if loading at preferred base — skip for now
  }

  // Process imports and set up thunk table
  const thunkBase = ((imageBase + sizeOfImage + 0xFFFF) & ~0xFFFF) >>> 0; // Align to 64KB
  const apiMap = new Map<number, { dll: string; name: string }>();
  let thunkAddr = thunkBase;

  if (dataDirectories.length > 1 && dataDirectories[1].virtualAddress !== 0) {
    const importRva = dataDirectories[1].virtualAddress;

    function rvaToFileOffset(rva: number): number {
      for (const section of sections) {
        if (rva >= section.virtualAddress && rva < section.virtualAddress + section.sizeOfRawData) {
          return rva - section.virtualAddress + section.pointerToRawData;
        }
      }
      // Try mapping to memory (for headers)
      if (rva < sizeOfHeaders) return rva;
      throw new Error(`Cannot map RVA 0x${rva.toString(16)}`);
    }

    function readNullStr(offset: number): string {
      let s = '';
      for (let i = 0; offset + i < arrayBuffer.byteLength; i++) {
        const ch = dv.getUint8(offset + i);
        if (ch === 0) break;
        s += String.fromCharCode(ch);
      }
      return s;
    }

    let descOffset: number;
    try {
      descOffset = rvaToFileOffset(importRva);
    } catch {
      descOffset = -1;
    }

    if (descOffset >= 0) {
      for (let i = 0; ; i++) {
        const off = descOffset + i * 20;
        if (off + 20 > arrayBuffer.byteLength) break;

        const iltRva = dv.getUint32(off, true);
        const nameRva = dv.getUint32(off + 12, true);
        const iatRva = dv.getUint32(off + 16, true);

        if (iltRva === 0 && nameRva === 0 && iatRva === 0) break;

        let dllName: string;
        try {
          dllName = readNullStr(rvaToFileOffset(nameRva));
        } catch {
          continue;
        }

        // Use ILT if available, else IAT
        const lookupRva = iltRva !== 0 ? iltRva : iatRva;
        if (lookupRva === 0) continue;

        let lookupOffset: number;
        try {
          lookupOffset = rvaToFileOffset(lookupRva);
        } catch {
          continue;
        }

        let importCount = 0;
        for (let j = 0; ; j++) {
          const entryOff = lookupOffset + j * 4;
          if (entryOff + 4 > arrayBuffer.byteLength) break;

          const entry = dv.getUint32(entryOff, true);
          if (entry === 0) break;

          let funcName: string;
          if (entry & 0x80000000) {
            // Import by ordinal
            funcName = `ord_${entry & 0xFFFF}`;
          } else {
            // Import by name
            try {
              const hintNameOffset = rvaToFileOffset(entry & 0x7FFFFFFF);
              funcName = readNullStr(hintNameOffset + 2);
            } catch {
              funcName = `unknown_${j}`;
            }
          }

          // Write thunk address to IAT entry in memory
          const iatAddr = imageBase + iatRva + j * 4;
          memory.writeU32(iatAddr, thunkAddr);
          // IAT mapping logged at trace level only

          // Register the API mapping
          apiMap.set(thunkAddr, { dll: dllName.toUpperCase(), name: funcName });

          thunkAddr += 4; // 4 bytes per thunk slot
          importCount++;
        }
        // DLL import summary logged at trace level only
      }
    }
  }

  // Allocate stack (1MB)
  const STACK_SIZE = 0x100000;
  const stackBase = ((thunkAddr + 0xFFFF) & ~0xFFFF) >>> 0;
  const stackTop = (stackBase + STACK_SIZE) >>> 0;

  // Resource directory info
  const resourceRva = dataDirectories.length > 2 ? dataDirectories[2].virtualAddress : 0;
  const resourceSize = dataDirectories.length > 2 ? dataDirectories[2].size : 0;

  return {
    imageBase,
    entryPoint: imageBase + entryPointRva,
    stackTop,
    thunkBase,
    apiMap,
    sizeOfImage,
    resourceRva,
    resourceSize,
    sections,
  };
}
