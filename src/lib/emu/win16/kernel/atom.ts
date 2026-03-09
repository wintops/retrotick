import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelAtom(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  function readAtomString(farPtr: number): string {
    const addr = emu.resolveFarPtr(farPtr);
    return addr ? emu.memory.readCString(addr).toUpperCase() : '';
  }

  // --- Ordinal 68: InitAtomTable(size) — 2 bytes (word) ---
  kernel.register('InitAtomTable', 2, () => 1, 68);

  // --- Ordinal 69: FindAtom(str) — 4 bytes (str) ---
  kernel.register('FindAtom', 4, () => {
    const lpString = emu.readArg16DWord(0);
    if (!lpString) return 0;
    const str = readAtomString(lpString);
    // Check for integer atom (#nnn)
    if (str.startsWith('#')) {
      const val = parseInt(str.substring(1), 10);
      if (!isNaN(val) && val >= 1 && val <= 0xBFFF) return val;
    }
    for (const [atom, name] of state.atomTable) {
      if (name === str) return atom;
    }
    return 0;
  }, 69);

  // --- Ordinal 70: AddAtom(str) — 4 bytes (str) ---
  kernel.register('AddAtom', 4, () => {
    const lpString = emu.readArg16DWord(0);
    if (!lpString) return 0;
    const str = readAtomString(lpString);
    // Integer atom
    if (str.startsWith('#')) {
      const val = parseInt(str.substring(1), 10);
      if (!isNaN(val) && val >= 1 && val <= 0xBFFF) return val;
    }
    // Check if already exists
    for (const [atom, name] of state.atomTable) {
      if (name === str) return atom;
    }
    const atom = state.nextAtom++;
    state.atomTable.set(atom, str);
    return atom;
  }, 70);

  // --- Ordinal 71: DeleteAtom(word) — 2 bytes ---
  kernel.register('DeleteAtom', 2, () => {
    const atom = emu.readArg16(0);
    if (atom >= 0xC000) state.atomTable.delete(atom);
    return 0;
  }, 71);

  // --- Ordinal 72: GetAtomName(word ptr word) — 8 bytes (word+ptr+word) ---
  kernel.register('GetAtomName', 8, () => {
    const [atom, lpBuffer, nSize] = emu.readPascalArgs16([2, 4, 2]);
    const buf = emu.resolveFarPtr(lpBuffer);
    const str = state.atomTable.get(atom);
    if (!str || !buf || nSize === 0) {
      if (buf && nSize > 0) emu.memory.writeU8(buf, 0);
      return 0;
    }
    const maxCopy = Math.min(str.length, nSize - 1);
    for (let i = 0; i < maxCopy; i++) {
      emu.memory.writeU8(buf + i, str.charCodeAt(i));
    }
    emu.memory.writeU8(buf + maxCopy, 0);
    return maxCopy;
  }, 72);

  // --- Ordinal 73: GetAtomHandle(word) — 2 bytes ---
  kernel.register('GetAtomHandle', 2, () => {
    const atom = emu.readArg16(0);
    return state.atomTable.has(atom) ? atom : 0;
  }, 73);
}
