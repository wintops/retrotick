import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelMemory(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // ---- Global Memory ----

  const GMEM_FIXED = 0x0000;
  const GMEM_MOVEABLE = 0x0002;
  const GMEM_ZEROINIT = 0x0040;
  const GMEM_MODIFY = 0x0080;
  const GMEM_DISCARDABLE = 0x0F00;

  // --- Ordinal 15: GlobalAlloc(flags, size_long) — 6 bytes (word+dword) ---
  kernel.register('GlobalAlloc', 6, () => {
    const [flags, size] = emu.readPascalArgs16([2, 4]);
    const allocSize = size || 1;
    const addr = emu.allocHeap64K(allocSize);
    const selector = state.nextGlobalSelector++;
    emu.cpu.segBases.set(selector, addr);
    state.globalHandleToAddr.set(selector, addr);
    state.globalHandleToSize.set(selector, allocSize);
    state.globalHandleFlags.set(selector, flags & 0xFFFF);
    state.globalLockCount.set(selector, 0);
    if (flags & GMEM_ZEROINIT) {
      for (let i = 0; i < allocSize; i++) emu.memory.writeU8(addr + i, 0);
    }
    console.log(`[KERNEL16] GlobalAlloc(flags=0x${flags.toString(16)}, size=${allocSize}) → sel=0x${selector.toString(16)} addr=0x${addr.toString(16)}`);
    return selector;
  }, 15);

  // --- Ordinal 16: GlobalReAlloc(handle, size_long, flags) — 8 bytes (word+dword+word) ---
  kernel.register('GlobalReAlloc', 8, () => {
    const [handle, size, flags] = emu.readPascalArgs16([2, 4, 2]);

    // GMEM_MODIFY: change flags only, don't reallocate
    if (flags & GMEM_MODIFY) {
      console.log(`[KERNEL16] GlobalReAlloc(handle=0x${handle.toString(16)}, size=${size}, flags=0x${flags.toString(16)}) MODIFY only`);
      state.globalHandleFlags.set(handle, flags & 0xFFFF);
      return handle;
    }

    let oldAddr = state.globalHandleToAddr.get(handle);
    let oldSize = state.globalHandleToSize.get(handle) || 0;
    if (oldAddr === undefined) {
      oldAddr = emu.cpu.segBases.get(handle);
      if (oldAddr !== undefined) oldSize = 0x10000;
    }
    const allocSize = Math.max(size, oldSize);
    const newAddr = emu.allocHeap(allocSize || 1);
    if (oldAddr !== undefined && oldSize > 0) {
      const copyLen = Math.min(oldSize, allocSize);
      for (let i = 0; i < copyLen; i++) {
        emu.memory.writeU8(newAddr + i, emu.memory.readU8(oldAddr + i));
      }
    }
    if ((flags & GMEM_ZEROINIT) && size > oldSize) {
      for (let i = oldSize; i < size; i++) emu.memory.writeU8(newAddr + i, 0);
    }
    emu.cpu.segBases.set(handle, newAddr);
    state.globalHandleToAddr.set(handle, newAddr);
    state.globalHandleToSize.set(handle, size);
    console.log(`[KERNEL16] GlobalReAlloc(handle=0x${handle.toString(16)}, size=${size}, flags=0x${flags.toString(16)}) old=0x${(oldAddr ?? 0).toString(16)} → new=0x${newAddr.toString(16)}`);
    // Update DGROUP if needed
    if (oldAddr !== undefined && emu.ne && handle === emu.ne.dataSegSelector) {
      const delta = newAddr - oldAddr;
      emu.localHeapBase += delta;
      emu.localHeapPtr += delta;
      emu.localHeapEnd = newAddr + size;
    }
    return handle;
  }, 16);

  // --- Ordinal 17: GlobalFree(handle) — 2 bytes (word) ---
  kernel.register('GlobalFree', 2, () => {
    const handle = emu.readArg16(0);
    console.log(`[KERNEL16] GlobalFree(handle=0x${handle.toString(16)})`);
    state.globalHandleToAddr.delete(handle);
    state.globalHandleToSize.delete(handle);
    state.globalHandleFlags.delete(handle);
    state.globalLockCount.delete(handle);
    return 0;
  }, 17);

  // --- Ordinal 18: GlobalLock(handle) — 2 bytes (word) ---
  kernel.register('GlobalLock', 2, () => {
    const handle = emu.readArg16(0);
    const addr = state.globalHandleToAddr.get(handle);
    if (addr === undefined) {
      emu.cpu.setReg16(2, 0);
      emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000);
      return 0;
    }
    state.globalLockCount.set(handle, (state.globalLockCount.get(handle) || 0) + 1);
    emu.cpu.setReg16(2, handle); // DX = selector
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000); // AX = 0 (offset)
    return (handle << 16) >>> 0;
  }, 18);

  // --- Ordinal 19: GlobalUnlock(handle) — 2 bytes (word) ---
  kernel.register('GlobalUnlock', 2, () => {
    const handle = emu.readArg16(0);
    const count = state.globalLockCount.get(handle) || 0;
    if (count > 0) state.globalLockCount.set(handle, count - 1);
    return count > 1 ? 1 : 0;
  }, 19);

  // --- Ordinal 20: GlobalSize(handle) — 2 bytes (word) ---
  kernel.register('GlobalSize', 2, () => {
    const handle = emu.readArg16(0);
    const size = state.globalHandleToSize.get(handle);
    if (size !== undefined) return size;
    // For NE segments not tracked via GlobalAlloc, return 64K
    if (emu.cpu.segBases.has(handle)) return 0x10000;
    return 0;
  }, 20);

  // --- Ordinal 21: GlobalHandle(word) — 2 bytes (word) ---
  kernel.register('GlobalHandle', 2, () => {
    const sel = emu.readArg16(0);
    emu.cpu.setReg16(2, sel);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | sel;
    return (sel << 16) | sel;
  }, 21);

  // --- Ordinal 22: GlobalFlags(handle) — 2 bytes (word) ---
  kernel.register('GlobalFlags', 2, () => {
    const handle = emu.readArg16(0);
    const flags = state.globalHandleFlags.get(handle) || 0;
    const lockCount = state.globalLockCount.get(handle) || 0;
    return (flags & 0xFF00) | (lockCount & 0xFF);
  }, 22);

  // --- Ordinal 23: LockSegment(segment) — 2 bytes (word) ---
  kernel.register('LockSegment', 2, () => 0, 23);

  // --- Ordinal 24: UnlockSegment(segment) — 2 bytes (word) ---
  kernel.register('UnlockSegment', 2, () => 0, 24);

  // --- Ordinal 25: GlobalCompact(minFree_long) — 4 bytes (dword) ---
  kernel.register('GlobalCompact', 4, () => 0x100000, 25);

  // --- Ordinal 26: GlobalFreeAll(word) — 2 bytes (word) ---
  kernel.register('GlobalFreeAll', 2, () => 0, 26);

  // --- Ordinal 28: GlobalMasterHandle() — 0 bytes ---
  kernel.register('GlobalMasterHandle', 0, () => 0, 28);

  // --- Ordinal 111: GlobalWire(word) — 2 bytes ---
  kernel.register('GlobalWire', 2, () => {
    const handle = emu.readArg16(0);
    const addr = state.globalHandleToAddr.get(handle);
    if (addr === undefined) return 0;
    emu.cpu.setReg16(2, handle);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000);
    return (handle << 16) >>> 0;
  }, 111);

  // --- Ordinal 112: GlobalUnWire(word) — 2 bytes ---
  kernel.register('GlobalUnWire', 2, () => 1, 112);

  // --- Ordinal 159: GlobalHandleNoRIP(word) — 2 bytes ---
  kernel.register('GlobalHandleNoRIP', 2, () => {
    const sel = emu.readArg16(0);
    return (sel << 16) | sel;
  }, 159);

  // --- Ordinal 163: GlobalLRUOldest(word) — 2 bytes ---
  kernel.register('GlobalLRUOldest', 2, () => emu.readArg16(0), 163);

  // --- Ordinal 164: GlobalLRUNewest(word) — 2 bytes ---
  kernel.register('GlobalLRUNewest', 2, () => emu.readArg16(0), 164);

  // --- Ordinal 168: DirectResAlloc(word word word) — 6 bytes ---
  kernel.register('DirectResAlloc', 6, () => 0, 168);

  // --- Ordinal 169: GetFreeSpace(flags) — 2 bytes (word) ---
  kernel.register('GetFreeSpace', 2, () => 0x00100000, 169);

  // --- Ordinal 184: GlobalDOSAlloc(long) — 4 bytes ---
  kernel.register('GlobalDOSAlloc', 4, () => 0, 184);

  // --- Ordinal 185: GlobalDOSFree(word) — 2 bytes ---
  kernel.register('GlobalDOSFree', 2, () => 0, 185);

  // --- Ordinal 191: GlobalPageLock(word) — 2 bytes ---
  kernel.register('GlobalPageLock', 2, () => 1, 191);

  // --- Ordinal 192: GlobalPageUnlock(word) — 2 bytes ---
  kernel.register('GlobalPageUnlock', 2, () => 1, 192);

  // --- Ordinal 154: GlobalNotify(segptr) — 4 bytes ---
  kernel.register('GlobalNotify', 4, () => 0, 154);

  // --- Ordinal 197: GlobalFix(word) — 2 bytes ---
  kernel.register('GlobalFix', 2, () => 0, 197);

  // --- Ordinal 198: GlobalUnfix(word) — 2 bytes ---
  kernel.register('GlobalUnfix', 2, () => 0, 198);

  // --- Ordinal 206: AllocSelectorArray(word) — 2 bytes ---
  kernel.register('AllocSelectorArray', 2, () => {
    const count = emu.readArg16(0);
    const firstSel = state.nextGlobalSelector;
    for (let i = 0; i < count; i++) {
      emu.cpu.segBases.set(state.nextGlobalSelector++, 0);
    }
    return firstSel;
  }, 206);

  // ---- Selector management ----

  // --- Ordinal 170: AllocCStoDSAlias(selector) — 2 bytes (word) ---
  // Creates a writable data selector aliasing the given code selector
  kernel.register('AllocCStoDSAlias', 2, () => {
    const srcSel = emu.readArg16(0);
    const base = emu.cpu.segBases.get(srcSel);
    const newSel = state.nextGlobalSelector++;
    emu.cpu.segBases.set(newSel, base ?? 0);
    console.log(`[KERNEL16] AllocCStoDSAlias(0x${srcSel.toString(16)}) → 0x${newSel.toString(16)} base=0x${(base??0).toString(16)}`);
    return newSel;
  }, 170);

  // --- Ordinal 171: AllocDStoCSAlias(word) — 2 bytes ---
  // Creates an executable code selector aliasing the given data selector
  kernel.register('AllocDStoCSAlias', 2, () => {
    const srcSel = emu.readArg16(0);
    const base = emu.cpu.segBases.get(srcSel);
    const newSel = state.nextGlobalSelector++;
    emu.cpu.segBases.set(newSel, base ?? 0);
    return newSel;
  }, 171);

  // --- Ordinal 172: AllocAlias(word) — 2 bytes ---
  kernel.register('AllocAlias', 2, () => {
    const srcSel = emu.readArg16(0);
    const base = emu.cpu.segBases.get(srcSel);
    const newSel = state.nextGlobalSelector++;
    emu.cpu.segBases.set(newSel, base ?? 0);
    return newSel;
  }, 172);

  // --- Ordinal 175: AllocSelector(word) — 2 bytes ---
  kernel.register('AllocSelector', 2, () => {
    const sel = state.nextGlobalSelector++;
    emu.cpu.segBases.set(sel, 0);
    return sel;
  }, 175);

  // --- Ordinal 176: FreeSelector(selector) — 2 bytes (word) ---
  kernel.register('FreeSelector', 2, () => 0, 176);

  // --- Ordinal 177: PrestoChangoSelector(word word) — 4 bytes ---
  // Copies descriptor from srcSel to dstSel, toggling code/data attribute
  kernel.register('PrestoChangoSelector', 4, () => {
    const [srcSel, dstSel] = emu.readPascalArgs16([2, 2]);
    const base = emu.cpu.segBases.get(srcSel);
    if (base !== undefined) emu.cpu.segBases.set(dstSel, base);
    console.log(`[KERNEL16] PrestoChangoSelector(src=0x${srcSel.toString(16)}, dst=0x${dstSel.toString(16)}) base=0x${(base??0).toString(16)}`);
    return dstSel;
  }, 177);

  // --- Ordinal 186: GetSelectorBase(word) — 2 bytes ---
  kernel.register('GetSelectorBase', 2, () => {
    const sel = emu.readArg16(0);
    return emu.cpu.segBases.get(sel) || 0;
  }, 186);

  // --- Ordinal 187: SetSelectorBase(word long) — 6 bytes ---
  kernel.register('SetSelectorBase', 6, () => {
    const [sel, base] = emu.readPascalArgs16([2, 4]);
    emu.cpu.segBases.set(sel, base);
    return 1;
  }, 187);

  // --- Ordinal 188: GetSelectorLimit(word) — 2 bytes ---
  kernel.register('GetSelectorLimit', 2, () => 0xFFFF, 188);

  // --- Ordinal 189: SetSelectorLimit(word long) — 6 bytes ---
  kernel.register('SetSelectorLimit', 6, () => 1, 189);

  // --- Ordinal 196: SelectorAccessRights(word word word) — 6 bytes ---
  kernel.register('SelectorAccessRights', 6, () => 0, 196);

  // ---- Local Memory ----

  // --- Ordinal 4: LocalInit(segment, start, end) — 6 bytes (word+word+word) ---
  kernel.register('LocalInit', 6, () => {
    const [segment, start, end] = emu.readPascalArgs16([2, 2, 2]);
    const base = emu.cpu.segBases.get(segment) ?? (segment * 16);
    // When start=0, the heap must begin AFTER initialized static data in the segment
    // to avoid clobbering global variables loaded from the NE file.
    const staticEnd = emu.segStaticEnd.get(segment) || 0;
    const effectiveStart = (start === 0 && staticEnd > 0) ? staticEnd : start;
    // Reserve 4 bytes at heap start for the heap header — real Windows local heap
    // stores management info there, so the first allocation offset is never 0
    // (callers treat offset 0 as NULL/failure).
    const heapStart = Math.max(effectiveStart, 4) + 4;
    emu.segLocalHeaps.set(segment, { ptr: base + heapStart, end: base + end });
    return 1;
  }, 4);

  // --- Ordinal 5: LocalAlloc(flags, bytes) — 4 bytes (word+word) ---
  kernel.register('LocalAlloc', 4, () => {
    const [flags, size] = emu.readPascalArgs16([2, 2]);
    const actualSize = size || 1;
    const result = emu.allocLocal(actualSize);
    if (result) state.localSizes.set(result, actualSize);
    console.log(`[KERNEL16] LocalAlloc(flags=0x${flags.toString(16)}, size=${actualSize}) DS=0x${emu.cpu.ds.toString(16)} → 0x${result.toString(16)}`);
    return result;
  }, 5);

  // --- Ordinal 6: LocalReAlloc(handle, bytes, flags) — 6 bytes (word+word+word) ---
  kernel.register('LocalReAlloc', 6, () => {
    const [handle, bytes, flags] = emu.readPascalArgs16([2, 2, 2]);
    if (!handle) return 0;
    const LMEM_MODIFY = 0x80;
    if (flags & LMEM_MODIFY) {
      // LMEM_MODIFY: only change flags, don't reallocate
      console.log(`[KERNEL16] LocalReAlloc(handle=0x${handle.toString(16)}, bytes=${bytes}, flags=0x${flags.toString(16)}) MODIFY only`);
      return handle;
    }
    const oldSize = state.localSizes.get(handle) || 0;
    if (bytes <= oldSize && oldSize > 0) {
      console.log(`[KERNEL16] LocalReAlloc(handle=0x${handle.toString(16)}, bytes=${bytes}, flags=0x${flags.toString(16)}) shrink in-place`);
      state.localSizes.set(handle, bytes);
      return handle;
    }
    // Allocate new block and copy
    const newHandle = emu.allocLocal(bytes);
    if (!newHandle) return 0;
    const dsBase = emu.cpu.segBases.get(emu.cpu.ds) ?? 0;
    const oldAddr = dsBase + handle;
    const newAddr = dsBase + newHandle;
    // If oldSize is unknown (handle not tracked), copy the full requested size
    // from the old location to preserve any pre-existing data (e.g. static/DLL data)
    const copyLen = oldSize > 0 ? Math.min(oldSize, bytes) : bytes;
    for (let i = 0; i < copyLen; i++) {
      emu.memory.writeU8(newAddr + i, emu.memory.readU8(oldAddr + i));
    }
    if ((flags & GMEM_ZEROINIT) && bytes > oldSize && oldSize > 0) {
      for (let i = oldSize; i < bytes; i++) emu.memory.writeU8(newAddr + i, 0);
    }
    state.localSizes.set(newHandle, bytes);
    console.log(`[KERNEL16] LocalReAlloc(handle=0x${handle.toString(16)}, bytes=${bytes}, flags=0x${flags.toString(16)}) → 0x${newHandle.toString(16)}`);
    return newHandle;
  }, 6);

  // --- Ordinal 7: LocalFree(handle) — 2 bytes (word) ---
  kernel.register('LocalFree', 2, () => {
    const handle = emu.readArg16(0);
    console.log(`[KERNEL16] LocalFree(handle=0x${handle.toString(16)})`);
    state.localSizes.delete(handle);
    state.localLockCounts.delete(handle);
    return 0;
  }, 7);

  // --- Ordinal 8: LocalLock(handle) — 2 bytes (word) ---
  kernel.register('LocalLock', 2, () => {
    const handle = emu.readArg16(0);
    state.localLockCounts.set(handle, (state.localLockCounts.get(handle) || 0) + 1);
    return handle;
  }, 8);

  // --- Ordinal 9: LocalUnlock(handle) — 2 bytes (word) ---
  kernel.register('LocalUnlock', 2, () => {
    const handle = emu.readArg16(0);
    const count = state.localLockCounts.get(handle) || 0;
    if (count > 0) state.localLockCounts.set(handle, count - 1);
    return count > 1 ? 1 : 0;
  }, 9);

  // --- Ordinal 10: LocalSize(handle) — 2 bytes (word) ---
  kernel.register('LocalSize', 2, () => {
    const handle = emu.readArg16(0);
    return state.localSizes.get(handle) || 0;
  }, 10);

  // --- Ordinal 11: LocalHandle(mem) — 2 bytes (word) ---
  kernel.register('LocalHandle', 2, () => emu.readArg16(0), 11);

  // --- Ordinal 12: LocalFlags(handle) — 2 bytes (word) ---
  kernel.register('LocalFlags', 2, () => {
    const handle = emu.readArg16(0);
    return (state.localLockCounts.get(handle) || 0) & 0xFF;
  }, 12);

  // --- Ordinal 13: LocalCompact(minFree) — 2 bytes (word) ---
  kernel.register('LocalCompact', 2, () => 0x2000, 13);

  // --- Ordinal 14: LocalNotify(lpNotifyProc) — 4 bytes (long) ---
  kernel.register('LocalNotify', 4, () => 0, 14);

  // --- Ordinal 121: LocalShrink(word word) — 4 bytes ---
  kernel.register('LocalShrink', 4, () => 0x2000, 121);

  // --- Ordinal 161: LocalCountFree() — 0 bytes ---
  kernel.register('LocalCountFree', 0, () => 0x100, 161);

  // --- Ordinal 162: LocalHeapSize() — 0 bytes ---
  kernel.register('LocalHeapSize', 0, () => 0x2000, 162);

  // --- Ordinal 310: LocalHandleDelta(word) — 2 bytes ---
  kernel.register('LocalHandleDelta', 2, () => emu.readArg16(0), 310);
}
