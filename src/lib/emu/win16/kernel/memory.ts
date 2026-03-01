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
  kernel.register('ord_15', 6, () => {
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
  });

  // --- Ordinal 16: GlobalReAlloc(handle, size_long, flags) — 8 bytes (word+dword+word) ---
  kernel.register('ord_16', 8, () => {
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
  });

  // --- Ordinal 17: GlobalFree(handle) — 2 bytes (word) ---
  kernel.register('ord_17', 2, () => {
    const handle = emu.readArg16(0);
    console.log(`[KERNEL16] GlobalFree(handle=0x${handle.toString(16)})`);
    state.globalHandleToAddr.delete(handle);
    state.globalHandleToSize.delete(handle);
    state.globalHandleFlags.delete(handle);
    state.globalLockCount.delete(handle);
    return 0;
  });

  // --- Ordinal 18: GlobalLock(handle) — 2 bytes (word) ---
  kernel.register('ord_18', 2, () => {
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
  });

  // --- Ordinal 19: GlobalUnlock(handle) — 2 bytes (word) ---
  kernel.register('ord_19', 2, () => {
    const handle = emu.readArg16(0);
    const count = state.globalLockCount.get(handle) || 0;
    if (count > 0) state.globalLockCount.set(handle, count - 1);
    return count > 1 ? 1 : 0;
  });

  // --- Ordinal 20: GlobalSize(handle) — 2 bytes (word) ---
  kernel.register('ord_20', 2, () => {
    const handle = emu.readArg16(0);
    const size = state.globalHandleToSize.get(handle);
    if (size !== undefined) return size;
    // For NE segments not tracked via GlobalAlloc, return 64K
    if (emu.cpu.segBases.has(handle)) return 0x10000;
    return 0;
  });

  // --- Ordinal 21: GlobalHandle(word) — 2 bytes (word) ---
  kernel.register('ord_21', 2, () => {
    const sel = emu.readArg16(0);
    emu.cpu.setReg16(2, sel);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | sel;
    return (sel << 16) | sel;
  });

  // --- Ordinal 22: GlobalFlags(handle) — 2 bytes (word) ---
  kernel.register('ord_22', 2, () => {
    const handle = emu.readArg16(0);
    const flags = state.globalHandleFlags.get(handle) || 0;
    const lockCount = state.globalLockCount.get(handle) || 0;
    return (flags & 0xFF00) | (lockCount & 0xFF);
  });

  // --- Ordinal 23: LockSegment(segment) — 2 bytes (word) ---
  kernel.register('ord_23', 2, () => 0);

  // --- Ordinal 24: UnlockSegment(segment) — 2 bytes (word) ---
  kernel.register('ord_24', 2, () => 0);

  // --- Ordinal 25: GlobalCompact(minFree_long) — 4 bytes (dword) ---
  kernel.register('ord_25', 4, () => 0x100000);

  // --- Ordinal 26: GlobalFreeAll(word) — 2 bytes (word) ---
  kernel.register('ord_26', 2, () => 0);

  // --- Ordinal 28: GlobalMasterHandle() — 0 bytes ---
  kernel.register('ord_28', 0, () => 0);

  // --- Ordinal 111: GlobalWire(word) — 2 bytes ---
  kernel.register('ord_111', 2, () => {
    const handle = emu.readArg16(0);
    const addr = state.globalHandleToAddr.get(handle);
    if (addr === undefined) return 0;
    emu.cpu.setReg16(2, handle);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000);
    return (handle << 16) >>> 0;
  });

  // --- Ordinal 112: GlobalUnWire(word) — 2 bytes ---
  kernel.register('ord_112', 2, () => 1);

  // --- Ordinal 159: GlobalHandleNoRIP(word) — 2 bytes ---
  kernel.register('ord_159', 2, () => {
    const sel = emu.readArg16(0);
    return (sel << 16) | sel;
  });

  // --- Ordinal 163: GlobalLRUOldest(word) — 2 bytes ---
  kernel.register('ord_163', 2, () => emu.readArg16(0));

  // --- Ordinal 164: GlobalLRUNewest(word) — 2 bytes ---
  kernel.register('ord_164', 2, () => emu.readArg16(0));

  // --- Ordinal 168: DirectResAlloc(word word word) — 6 bytes ---
  kernel.register('ord_168', 6, () => 0);

  // --- Ordinal 169: GetFreeSpace(flags) — 2 bytes (word) ---
  kernel.register('ord_169', 2, () => 0x00100000);

  // --- Ordinal 184: GlobalDOSAlloc(long) — 4 bytes ---
  kernel.register('ord_184', 4, () => 0);

  // --- Ordinal 185: GlobalDOSFree(word) — 2 bytes ---
  kernel.register('ord_185', 2, () => 0);

  // --- Ordinal 191: GlobalPageLock(word) — 2 bytes ---
  kernel.register('ord_191', 2, () => 1);

  // --- Ordinal 192: GlobalPageUnlock(word) — 2 bytes ---
  kernel.register('ord_192', 2, () => 1);

  // --- Ordinal 154: GlobalNotify(segptr) — 4 bytes ---
  kernel.register('ord_154', 4, () => 0);

  // --- Ordinal 197: GlobalFix(word) — 2 bytes ---
  kernel.register('ord_197', 2, () => 0);

  // --- Ordinal 198: GlobalUnfix(word) — 2 bytes ---
  kernel.register('ord_198', 2, () => 0);

  // --- Ordinal 206: AllocSelectorArray(word) — 2 bytes ---
  kernel.register('ord_206', 2, () => {
    const count = emu.readArg16(0);
    const firstSel = state.nextGlobalSelector;
    for (let i = 0; i < count; i++) {
      emu.cpu.segBases.set(state.nextGlobalSelector++, 0);
    }
    return firstSel;
  });

  // ---- Selector management ----

  // --- Ordinal 170: AllocCStoDSAlias(selector) — 2 bytes (word) ---
  kernel.register('ord_170', 2, () => emu.cpu.ds);

  // --- Ordinal 171: AllocDStoCSAlias(word) — 2 bytes ---
  kernel.register('ord_171', 2, () => emu.cpu.cs);

  // --- Ordinal 172: AllocAlias(word) — 2 bytes ---
  kernel.register('ord_172', 2, () => emu.cpu.ds);

  // --- Ordinal 175: AllocSelector(word) — 2 bytes ---
  kernel.register('ord_175', 2, () => {
    const sel = state.nextGlobalSelector++;
    emu.cpu.segBases.set(sel, 0);
    return sel;
  });

  // --- Ordinal 176: FreeSelector(selector) — 2 bytes (word) ---
  kernel.register('ord_176', 2, () => 0);

  // --- Ordinal 177: PrestoChangoSelector(word word) — 4 bytes ---
  kernel.register('ord_177', 4, () => {
    const [srcSel, dstSel] = emu.readPascalArgs16([2, 2]);
    return dstSel;
  });

  // --- Ordinal 186: GetSelectorBase(word) — 2 bytes ---
  kernel.register('ord_186', 2, () => {
    const sel = emu.readArg16(0);
    return emu.cpu.segBases.get(sel) || 0;
  });

  // --- Ordinal 187: SetSelectorBase(word long) — 6 bytes ---
  kernel.register('ord_187', 6, () => {
    const [sel, base] = emu.readPascalArgs16([2, 4]);
    emu.cpu.segBases.set(sel, base);
    return 1;
  });

  // --- Ordinal 188: GetSelectorLimit(word) — 2 bytes ---
  kernel.register('ord_188', 2, () => 0xFFFF);

  // --- Ordinal 189: SetSelectorLimit(word long) — 6 bytes ---
  kernel.register('ord_189', 6, () => 1);

  // --- Ordinal 196: SelectorAccessRights(word word word) — 6 bytes ---
  kernel.register('ord_196', 6, () => 0);

  // ---- Local Memory ----

  // --- Ordinal 4: LocalInit(segment, start, end) — 6 bytes (word+word+word) ---
  kernel.register('ord_4', 6, () => {
    const [segment, start, end] = emu.readPascalArgs16([2, 2, 2]);
    const base = emu.cpu.segBases.get(segment) ?? (segment * 16);
    console.log(`[KERNEL16] LocalInit(seg=0x${segment.toString(16)}, start=0x${start.toString(16)}, end=0x${end.toString(16)}) base=0x${base.toString(16)}`);
    emu.segLocalHeaps.set(segment, { ptr: base + start, end: base + end });
    return 1;
  });

  // --- Ordinal 5: LocalAlloc(flags, bytes) — 4 bytes (word+word) ---
  kernel.register('ord_5', 4, () => {
    const [flags, size] = emu.readPascalArgs16([2, 2]);
    const actualSize = size || 1;
    const result = emu.allocLocal(actualSize);
    if (result) state.localSizes.set(result, actualSize);
    console.log(`[KERNEL16] LocalAlloc(flags=0x${flags.toString(16)}, size=${actualSize}) DS=0x${emu.cpu.ds.toString(16)} → 0x${result.toString(16)}`);
    return result;
  });

  // --- Ordinal 6: LocalReAlloc(handle, bytes, flags) — 6 bytes (word+word+word) ---
  kernel.register('ord_6', 6, () => {
    const [handle, bytes, flags] = emu.readPascalArgs16([2, 2, 2]);
    if (!handle) return 0;
    const oldSize = state.localSizes.get(handle) || 0;
    if (bytes <= oldSize) {
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
    const copyLen = Math.min(oldSize, bytes);
    for (let i = 0; i < copyLen; i++) {
      emu.memory.writeU8(newAddr + i, emu.memory.readU8(oldAddr + i));
    }
    if ((flags & GMEM_ZEROINIT) && bytes > oldSize) {
      for (let i = oldSize; i < bytes; i++) emu.memory.writeU8(newAddr + i, 0);
    }
    state.localSizes.set(newHandle, bytes);
    console.log(`[KERNEL16] LocalReAlloc(handle=0x${handle.toString(16)}, bytes=${bytes}, flags=0x${flags.toString(16)}) → 0x${newHandle.toString(16)}`);
    return newHandle;
  });

  // --- Ordinal 7: LocalFree(handle) — 2 bytes (word) ---
  kernel.register('ord_7', 2, () => {
    const handle = emu.readArg16(0);
    console.log(`[KERNEL16] LocalFree(handle=0x${handle.toString(16)})`);
    state.localSizes.delete(handle);
    state.localLockCounts.delete(handle);
    return 0;
  });

  // --- Ordinal 8: LocalLock(handle) — 2 bytes (word) ---
  kernel.register('ord_8', 2, () => {
    const handle = emu.readArg16(0);
    state.localLockCounts.set(handle, (state.localLockCounts.get(handle) || 0) + 1);
    return handle;
  });

  // --- Ordinal 9: LocalUnlock(handle) — 2 bytes (word) ---
  kernel.register('ord_9', 2, () => {
    const handle = emu.readArg16(0);
    const count = state.localLockCounts.get(handle) || 0;
    if (count > 0) state.localLockCounts.set(handle, count - 1);
    return count > 1 ? 1 : 0;
  });

  // --- Ordinal 10: LocalSize(handle) — 2 bytes (word) ---
  kernel.register('ord_10', 2, () => {
    const handle = emu.readArg16(0);
    return state.localSizes.get(handle) || 0;
  });

  // --- Ordinal 11: LocalHandle(mem) — 2 bytes (word) ---
  kernel.register('ord_11', 2, () => emu.readArg16(0));

  // --- Ordinal 12: LocalFlags(handle) — 2 bytes (word) ---
  kernel.register('ord_12', 2, () => {
    const handle = emu.readArg16(0);
    return (state.localLockCounts.get(handle) || 0) & 0xFF;
  });

  // --- Ordinal 13: LocalCompact(minFree) — 2 bytes (word) ---
  kernel.register('ord_13', 2, () => 0x2000);

  // --- Ordinal 14: LocalNotify(lpNotifyProc) — 4 bytes (long) ---
  kernel.register('ord_14', 4, () => 0);

  // --- Ordinal 121: LocalShrink(word word) — 4 bytes ---
  kernel.register('ord_121', 4, () => 0x2000);

  // --- Ordinal 161: LocalCountFree() — 0 bytes ---
  kernel.register('ord_161', 0, () => 0x100);

  // --- Ordinal 162: LocalHeapSize() — 0 bytes ---
  kernel.register('ord_162', 0, () => 0x2000);

  // --- Ordinal 310: LocalHandleDelta(word) — 2 bytes ---
  kernel.register('ord_310', 2, () => emu.readArg16(0));
}
