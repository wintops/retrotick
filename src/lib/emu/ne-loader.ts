import { Memory } from './memory';

export interface NESegmentInfo {
  index: number;          // 1-based segment index
  fileOffset: number;     // data offset in file
  fileSize: number;       // data size in file (0 → 0x10000)
  flags: number;          // bit 0: DATA, bit 4: has relocations
  minAlloc: number;       // minimum allocation size (0 → 0x10000)
  linearBase: number;     // mapped linear address
  selector: number;       // selector value (= segment index)
}

export interface NEResourceEntry {
  typeID: number;     // resource type (e.g. 2=RT_BITMAP, 6=RT_STRING, 4=RT_MENU)
  id: number;         // resource ID (integer, or 0 for string-named)
  name?: string;      // resource name (for string-named resources)
  fileOffset: number; // absolute file offset
  length: number;     // data length in bytes
}

export interface LoadedNE {
  segments: NESegmentInfo[];
  entryPoint: number;     // linear address (segBase[CS] + IP)
  stackTop: number;       // linear address (segBase[SS] + SP)
  stackSegSelector: number;
  codeSegSelector: number;
  dataSegSelector: number; // auto-data segment
  thunkBase: number;
  apiMap: Map<number, { dll: string; name: string; ordinal: number }>;
  moduleNames: string[];   // imported module names
  selectorToBase: Map<number, number>; // selector → linear base
  resources: NEResourceEntry[]; // parsed resource entries
  autoDataSegIndex: number;
  autoDataStaticSize: number;  // file size of auto-data segment (static data)
  heapSize: number;            // local heap size from NE header
  stackSize: number;           // stack size from NE header
  thunkAddrEnd: number;        // next free thunk address after this module
  entryPoints: Map<number, { seg: number; offset: number }>; // ordinal → {seg, offset}
  nameToOrdinal: Map<string, number>; // export name (uppercase) → ordinal
  nextSelector: number;        // next available selector after this module
  flags: number;               // NE header flags
}

// Thunk segment selector
const THUNK_SELECTOR = 0xFE;
const THUNK_LINEAR_BASE = 0x000F0000;

export interface LoadNEOptions {
  selectorBase?: number;       // first selector to use (default 1)
  thunkStartAddr?: number;     // start address for thunks (default THUNK_LINEAR_BASE + 1)
  selectorToBase?: Map<number, number>; // shared selector map (default new Map)
}

export function loadNE(arrayBuffer: ArrayBuffer, memory: Memory, opts?: LoadNEOptions): LoadedNE {
  const dv = new DataView(arrayBuffer);
  const data = new Uint8Array(arrayBuffer);

  // Read DOS header
  const e_lfanew = dv.getUint32(0x3C, true);
  const neOffset = e_lfanew;

  // Verify NE signature
  const sig = dv.getUint16(neOffset, true);
  if (sig !== 0x454E) throw new Error('Not a valid NE file (missing NE signature)');

  // NE header fields
  const entryTableOffset = dv.getUint16(neOffset + 0x04, true); // relative to NE header
  const entryTableSize = dv.getUint16(neOffset + 0x06, true);
  const flags = dv.getUint16(neOffset + 0x0C, true);
  const autoDataSeg = dv.getUint16(neOffset + 0x0E, true); // auto-data segment index
  const heapSize = dv.getUint16(neOffset + 0x10, true);
  const stackSize = dv.getUint16(neOffset + 0x12, true);
  const csip = dv.getUint32(neOffset + 0x14, true); // CS:IP
  const sssp = dv.getUint32(neOffset + 0x18, true); // SS:SP
  const segTableCount = dv.getUint16(neOffset + 0x1C, true);
  const modRefCount = dv.getUint16(neOffset + 0x1E, true);
  const nonResNameTableSize = dv.getUint16(neOffset + 0x20, true);
  const nonResNameTableOffset = dv.getUint32(neOffset + 0x2C, true); // absolute file offset
  const segTableOffset = dv.getUint16(neOffset + 0x22, true); // relative to NE header
  const resourceTableOffset = dv.getUint16(neOffset + 0x24, true);
  const residentNameTableOffset = dv.getUint16(neOffset + 0x26, true);
  const moduleRefTableOffset = dv.getUint16(neOffset + 0x28, true);
  const importedNamesTableOffset = dv.getUint16(neOffset + 0x2A, true);
  const alignShift = dv.getUint16(neOffset + 0x32, true);

  const entryCS = (csip >> 16) & 0xFFFF;
  const entryIP = csip & 0xFFFF;
  const entrySS = (sssp >> 16) & 0xFFFF;
  let entrySP = sssp & 0xFFFF;

  console.log(`[NE] NE header at 0x${neOffset.toString(16)}, alignShift=${alignShift}, segments=${segTableCount}, modules=${modRefCount}`);
  console.log(`[NE] CS:IP = ${entryCS}:0x${entryIP.toString(16)}, SS:SP = ${entrySS}:0x${entrySP.toString(16)}`);
  console.log(`[NE] autoDataSeg=${autoDataSeg}, heap=${heapSize}, stack=${stackSize}`);

  // Parse segment table
  const selectorBase = opts?.selectorBase ?? 1;
  const segments: NESegmentInfo[] = [];
  const selectorToBase = opts?.selectorToBase ?? new Map<number, number>();
  const segTableBase = neOffset + segTableOffset;
  // Track selector assignment — skip 0x0F (thunk page at 0xF0000) and 0xFE (thunk selector)
  let nextSel = selectorBase;

  for (let i = 0; i < segTableCount; i++) {
    const off = segTableBase + i * 8;
    const sectorOffset = dv.getUint16(off, true);
    const fileLength = dv.getUint16(off + 2, true);
    const segFlags = dv.getUint16(off + 4, true);
    const minAllocRaw = dv.getUint16(off + 6, true);

    // Skip selectors whose linear base would conflict with thunk region
    while (nextSel === 0x0F || nextSel === THUNK_SELECTOR) nextSel++;
    const selector = nextSel;
    nextSel++;
    const linearBase = selector * 0x10000; // each segment at 64KB-aligned address
    const fileOffset = sectorOffset === 0 ? 0 : sectorOffset << alignShift;
    const fileSize = fileLength === 0 ? 0x10000 : fileLength;
    const minAlloc = minAllocRaw === 0 ? 0x10000 : minAllocRaw;

    segments.push({
      index: selector,
      fileOffset,
      fileSize: sectorOffset === 0 ? 0 : fileSize,
      flags: segFlags,
      minAlloc,
      linearBase,
      selector,
    });

    selectorToBase.set(selector, linearBase);

    console.log(`[NE] Seg ${selector}: fileOff=0x${fileOffset.toString(16)} fileSize=0x${fileSize.toString(16)} minAlloc=0x${minAlloc.toString(16)} flags=0x${segFlags.toString(16)} → linear=0x${linearBase.toString(16)}`);
  }

  // Add thunk segment
  selectorToBase.set(THUNK_SELECTOR, THUNK_LINEAR_BASE);

  // Parse module reference table → get imported module names
  const moduleNames: string[] = [];
  const modRefBase = neOffset + moduleRefTableOffset;
  const impNamesBase = neOffset + importedNamesTableOffset;

  for (let i = 0; i < modRefCount; i++) {
    const nameOffset = dv.getUint16(modRefBase + i * 2, true);
    const absOffset = impNamesBase + nameOffset;
    const nameLen = data[absOffset];
    let name = '';
    for (let j = 0; j < nameLen; j++) {
      name += String.fromCharCode(data[absOffset + 1 + j]);
    }
    moduleNames.push(name.toUpperCase());
  }

  console.log(`[NE] Modules: ${moduleNames.join(', ')}`);

  // Parse resource table
  const resources: NEResourceEntry[] = [];
  if (resourceTableOffset !== residentNameTableOffset) { // resource table exists
    const resTableBase = neOffset + resourceTableOffset;
    const rscAlignShift = dv.getUint16(resTableBase, true);
    let resOff = resTableBase + 2;

    while (resOff + 8 <= arrayBuffer.byteLength) {
      const rtTypeID = dv.getUint16(resOff, true);
      if (rtTypeID === 0) break; // end of resource table

      const rtCount = dv.getUint16(resOff + 2, true);
      // Skip 4 bytes reserved
      resOff += 8; // past typeID(2) + count(2) + reserved(4)

      const typeID = (rtTypeID & 0x8000) ? (rtTypeID & 0x7FFF) : rtTypeID;

      for (let i = 0; i < rtCount; i++) {
        if (resOff + 12 > arrayBuffer.byteLength) break;
        const rnOffset = dv.getUint16(resOff, true);
        const rnLength = dv.getUint16(resOff + 2, true);
        // rnFlags at resOff + 4
        const rnID = dv.getUint16(resOff + 6, true);
        // rnHandle(2) + rnUsage(2) at resOff + 8..11
        resOff += 12;

        const fileOffset = rnOffset << rscAlignShift;
        const length = rnLength << rscAlignShift;
        const entry: NEResourceEntry = { typeID, id: 0, fileOffset, length };
        if (rnID & 0x8000) {
          entry.id = rnID & 0x7FFF;
        } else {
          // String-named resource: rnID is offset from resource table start
          const strPos = resTableBase + rnID;
          const strLen = data[strPos];
          let name = '';
          for (let j = 0; j < strLen; j++) name += String.fromCharCode(data[strPos + 1 + j]);
          entry.name = name;
        }

        resources.push(entry);
      }
    }
    console.log(`[NE] Resources: ${resources.length} entries (types: ${[...new Set(resources.map(r => r.typeID))].join(', ')})`);
  }

  // Parse entry table to resolve moveable segment references
  // Entry table format: bundles of entries, each bundle has count + segment indicator
  // Ordinals are 1-based and assigned sequentially across bundles
  const entryTableBase = neOffset + entryTableOffset;
  const entryPoints = new Map<number, { seg: number; offset: number }>(); // ordinal → {seg, offset}
  {
    let pos = entryTableBase;
    let ordinal = 1;
    while (pos < entryTableBase + entryTableSize) {
      const count = data[pos];
      if (count === 0) break;
      const segIndicator = data[pos + 1];
      pos += 2;
      if (segIndicator === 0) {
        // Empty entries — skip ordinals
        ordinal += count;
      } else if (segIndicator === 0xFF) {
        // Moveable entries: 6 bytes each (flags, INT3Fh word, seg#, offset)
        for (let i = 0; i < count; i++) {
          const _flags = data[pos];
          // skip INT 3Fh (2 bytes)
          const seg = data[pos + 3];
          const off = dv.getUint16(pos + 4, true);
          entryPoints.set(ordinal, { seg, offset: off });
          pos += 6;
          ordinal++;
        }
      } else {
        // Fixed entries: 3 bytes each (flags, offset)
        for (let i = 0; i < count; i++) {
          const _flags = data[pos];
          const off = dv.getUint16(pos + 1, true);
          entryPoints.set(ordinal, { seg: segIndicator, offset: off });
          pos += 3;
          ordinal++;
        }
      }
    }
  }

  // Parse resident name table → name→ordinal map
  const nameToOrdinal = new Map<string, number>();
  {
    let pos = neOffset + residentNameTableOffset;
    while (pos < data.length) {
      const len = data[pos];
      if (len === 0) break;
      pos++;
      let name = '';
      for (let i = 0; i < len; i++) name += String.fromCharCode(data[pos + i]);
      pos += len;
      const ord = dv.getUint16(pos, true);
      pos += 2;
      if (ord !== 0) nameToOrdinal.set(name.toUpperCase(), ord);
    }
  }

  // Parse non-resident name table → also adds to nameToOrdinal
  if (nonResNameTableOffset > 0 && nonResNameTableSize > 0) {
    let pos = nonResNameTableOffset;
    const end = pos + nonResNameTableSize;
    while (pos < end && pos < data.length) {
      const len = data[pos];
      if (len === 0) break;
      pos++;
      let name = '';
      for (let i = 0; i < len; i++) name += String.fromCharCode(data[pos + i]);
      pos += len;
      const ord = dv.getUint16(pos, true);
      pos += 2;
      if (ord !== 0) nameToOrdinal.set(name.toUpperCase(), ord);
    }
  }

  // Load segment data into memory
  for (const seg of segments) {
    if (seg.fileOffset > 0 && seg.fileSize > 0) {
      const segData = new Uint8Array(arrayBuffer, seg.fileOffset, seg.fileSize);
      memory.copyFrom(seg.linearBase, segData);
    }
  }

  // Patch Win16 function prologs in code segments
  // The standard prolog "push ds; pop ax; nop" (1E 58 90) must be patched to
  // "mov ax, DGROUP_selector" (B8 xx xx) so DS gets set to the module's own data segment.
  if (autoDataSeg) {
    const dgroupSelector = segments[autoDataSeg - 1].selector;
    for (const seg of segments) {
      if (seg.flags & 0x01) continue; // skip DATA segments, only patch CODE segments
      const base = seg.linearBase;
      const size = seg.fileSize > 0 ? seg.fileSize : seg.minAlloc;
      // Scan for exported entry points and patch their prologs
      // ep.seg is 1-based local segment index; convert to global selector
      for (const [, ep] of entryPoints) {
        const epSelector = segments[ep.seg - 1]?.selector ?? (selectorBase + ep.seg - 1);
        if (epSelector !== seg.selector) continue;
        const addr = base + ep.offset;
        if (memory.readU8(addr) === 0x1E && memory.readU8(addr + 1) === 0x58 &&
            memory.readU8(addr + 2) === 0x90) {
          memory.writeU8(addr, 0xB8); // mov ax, imm16
          memory.writeU16(addr + 1, dgroupSelector);
        }
      }
    }
  }

  // Process relocations and build thunk table
  const apiMap = new Map<number, { dll: string; name: string; ordinal: number }>();
  let thunkAddr = opts?.thunkStartAddr ?? (THUNK_LINEAR_BASE + 1); // Start at odd offset so OFFSET fixups have bit 0 set
  // Cache: "MODULE:ordinal" → thunk linear address
  const thunkCache = new Map<string, number>();

  function getOrCreateThunk(dll: string, ordinal: number): number {
    const key = `${dll}:${ordinal}`;
    const existing = thunkCache.get(key);
    if (existing !== undefined) return existing;
    const addr = thunkAddr;
    thunkAddr += 4;
    thunkCache.set(key, addr);
    apiMap.set(addr, { dll, name: `ord_${ordinal}`, ordinal });
    return addr;
  }

  function getOrCreateThunkByName(dll: string, name: string): number {
    const key = `${dll}:name:${name}`;
    const existing = thunkCache.get(key);
    if (existing !== undefined) return existing;
    const addr = thunkAddr;
    thunkAddr += 4;
    thunkCache.set(key, addr);
    apiMap.set(addr, { dll, name, ordinal: 0 });
    return addr;
  }

  for (const seg of segments) {
    if (!(seg.flags & 0x0100)) continue; // bit 8: has relocations
    if (seg.fileOffset === 0) continue;

    // Relocation data follows segment data in the file
    const relocBase = seg.fileOffset + seg.fileSize;
    if (relocBase + 2 > arrayBuffer.byteLength) continue;
    const relocCount = dv.getUint16(relocBase, true);
    console.log(`[NE] Seg ${seg.index}: ${relocCount} relocations at file offset 0x${relocBase.toString(16)}`);

    for (let r = 0; r < relocCount; r++) {
      const recOff = relocBase + 2 + r * 8;
      if (recOff + 8 > arrayBuffer.byteLength) break;

      const srcType = data[recOff]; // source type
      const flagsByte = data[recOff + 1]; // flags (target type in low 2 bits)
      const srcOffset = dv.getUint16(recOff + 2, true); // offset within segment
      const targetType = flagsByte & 0x03;
      const additive = !!(flagsByte & 0x04);

      if (targetType === 0) {
        // Internal reference
        const targetSegIndex = data[recOff + 4]; // 1-based segment index
        let resolvedSeg: NESegmentInfo | undefined;
        let targetOffset: number;

        if (targetSegIndex === 0xFF) {
          // Moveable entry point reference — byte 5 is reserved,
          // bytes 6-7 contain entry table ordinal
          const entryOrdinal = dv.getUint16(recOff + 6, true);
          const entry = entryPoints.get(entryOrdinal);
          if (!entry) {
            console.warn(`[NE] Reloc: entry ordinal ${entryOrdinal} not found`);
            continue;
          }
          resolvedSeg = segments[entry.seg - 1];
          targetOffset = entry.offset;
        } else {
          resolvedSeg = segments[targetSegIndex - 1];
          targetOffset = dv.getUint16(recOff + 6, true);
        }

        if (!resolvedSeg) {
          console.warn(`[NE] Reloc: invalid target seg ${targetSegIndex}`);
          continue;
        }

        // Apply fixup at srcOffset within this segment
        applyFixup(memory, seg, srcType, srcOffset, additive,
          resolvedSeg.selector, targetOffset, resolvedSeg.linearBase + targetOffset);

      } else if (targetType === 1) {
        // Imported by ordinal
        const moduleIndex = dv.getUint16(recOff + 4, true); // 1-based
        const ordinal = dv.getUint16(recOff + 6, true);
        const dll = moduleNames[moduleIndex - 1] || `MODULE${moduleIndex}`;
        const thunkLinear = getOrCreateThunk(dll, ordinal);
        const thunkOffset = thunkLinear - THUNK_LINEAR_BASE;

        applyFixup(memory, seg, srcType, srcOffset, additive,
          THUNK_SELECTOR, thunkOffset, thunkLinear);

      } else if (targetType === 2) {
        // Imported by name
        const moduleIndex = dv.getUint16(recOff + 4, true);
        const nameOffsetRel = dv.getUint16(recOff + 6, true);
        const dll = moduleNames[moduleIndex - 1] || `MODULE${moduleIndex}`;
        // Read the name from imported names table
        const nameAbsOff = impNamesBase + nameOffsetRel;
        const nameLen = data[nameAbsOff];
        let funcName = '';
        for (let j = 0; j < nameLen; j++) {
          funcName += String.fromCharCode(data[nameAbsOff + 1 + j]);
        }
        const thunkLinear = getOrCreateThunkByName(dll, funcName);
        const thunkOffset = thunkLinear - THUNK_LINEAR_BASE;

        applyFixup(memory, seg, srcType, srcOffset, additive,
          THUNK_SELECTOR, thunkOffset, thunkLinear);

      } else if (targetType === 3) {
        // OSFIXUP — ignore
      }
    }
  }

  // Compute entry point — entryCS/entrySS are 1-based relative to this module
  const entrySegInfo = segments[entryCS - 1];
  const entryPoint = entrySegInfo ? entrySegInfo.linearBase + entryIP : 0;

  // Compute stack
  const ssSegInfo = segments[entrySS - 1];
  let stackTop = 0;
  if (ssSegInfo) {
    if (entrySP === 0) {
      // SP=0: compute full DGROUP allocation size
      const baseAlloc = ssSegInfo.minAlloc === 0 ? 0x10000 : ssSegInfo.minAlloc;
      const dataSize = Math.max(baseAlloc, ssSegInfo.fileSize);
      if (entrySS === autoDataSeg) {
        // Auto-data segment: place stack at top of 64KB segment
        // so the heap can grow freely between static data and stack bottom.
        // Windows 3.x allows DGROUP to expand up to 64KB.
        entrySP = 0xFFFE; // top of 64KB, word-aligned
      } else {
        entrySP = dataSize & 0xFFFF;
      }
    }
    stackTop = ssSegInfo.linearBase + entrySP;
  }

  console.log(`[NE] Entry point: linear=0x${entryPoint.toString(16)} (seg ${entryCS}:0x${entryIP.toString(16)})`);
  console.log(`[NE] Stack top: linear=0x${stackTop.toString(16)} (seg ${entrySS}:SP=0x${entrySP.toString(16)})`);
  console.log(`[NE] API thunks: ${apiMap.size} entries, thunk range: 0x${THUNK_LINEAR_BASE.toString(16)}-0x${thunkAddr.toString(16)}`);

  // Map 1-based NE-header indices to actual selectors
  const codeSegSelector = segments[entryCS - 1].selector;
  const stackSegSelector = segments[entrySS - 1].selector;
  const dataSegSelector = autoDataSeg ? segments[autoDataSeg - 1].selector : 0;

  return {
    segments,
    entryPoint,
    stackTop,
    stackSegSelector,
    codeSegSelector,
    dataSegSelector,
    thunkBase: THUNK_LINEAR_BASE,
    apiMap,
    moduleNames,
    selectorToBase,
    resources,
    autoDataSegIndex: autoDataSeg,
    autoDataStaticSize: segments[autoDataSeg - 1]?.fileSize || 0,
    heapSize,
    stackSize,
    thunkAddrEnd: thunkAddr,
    entryPoints,
    nameToOrdinal,
    nextSelector: nextSel,
    flags,
  };
}

function applyFixup(
  memory: Memory,
  seg: NESegmentInfo,
  srcType: number,
  srcOffset: number,
  additive: boolean,
  targetSelector: number,
  targetOffset: number,
  targetLinear: number,
): void {
  // Walk the fixup chain: each location contains a pointer to the next location
  // until we hit 0xFFFF (end of chain). For additive fixups, the value at the
  // location is added to the fixup value rather than being a chain pointer.
  let offset = srcOffset;
  const MAX_CHAIN = 4096;

  for (let i = 0; i < MAX_CHAIN; i++) {
    const addr = seg.linearBase + offset;

    if (additive) {
      // Additive: apply fixup and stop (no chain)
      applyFixupAtAddr(memory, addr, srcType, targetSelector, targetOffset, targetLinear);
      break;
    }

    // Non-additive chain: read next pointer before overwriting
    const nextOffset = memory.readU16(addr);
    applyFixupAtAddr(memory, addr, srcType, targetSelector, targetOffset, targetLinear);

    if (nextOffset === 0xFFFF) break;
    offset = nextOffset;
  }
}

function applyFixupAtAddr(
  memory: Memory,
  addr: number,
  srcType: number,
  targetSelector: number,
  targetOffset: number,
  targetLinear: number,
): void {
  switch (srcType & 0x0F) {
    case 0: // LOBYTE
      memory.writeU8(addr, targetOffset & 0xFF);
      break;
    case 2: // SEGMENT (selector)
      memory.writeU16(addr, targetSelector);
      break;
    case 3: // FAR_ADDR (offset:selector, 4 bytes)
      memory.writeU16(addr, targetOffset & 0xFFFF);
      memory.writeU16(addr + 2, targetSelector);
      break;
    case 5: // OFFSET (16-bit offset)
      memory.writeU16(addr, targetOffset & 0xFFFF);
      break;
    default:
      console.warn(`[NE] Unknown relocation source type: ${srcType} at addr 0x${addr.toString(16)}`);
      break;
  }
}
