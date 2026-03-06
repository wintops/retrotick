import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelString(kernel: Win16Module, emu: Emulator, _state: KernelState): void {
  // --- Ordinal 87: lstrcmp(str str) — 8 bytes ---
  kernel.register('Reserved5', 8, () => {
    const [lpStr1, lpStr2] = emu.readPascalArgs16([4, 4]);
    if (!lpStr1 || !lpStr2) return 0;
    let i = 0;
    while (true) {
      const c1 = emu.memory.readU8(lpStr1 + i);
      const c2 = emu.memory.readU8(lpStr2 + i);
      if (c1 !== c2) return c1 < c2 ? -1 : 1;
      if (c1 === 0) return 0;
      i++;
      if (i > 0xFFFF) break;
    }
    return 0;
  }, 87);

  // --- Ordinal 88: lstrcpy(lpDst, lpSrc) — 8 bytes (segptr+str) ---
  kernel.register('lstrcpy', 8, () => {
    const [lpDstRaw, lpSrcRaw] = emu.readPascalArgs16([4, 4]);
    const lpDst = emu.resolveFarPtr(lpDstRaw);
    const lpSrc = emu.resolveFarPtr(lpSrcRaw);
    if (lpDst && lpSrc) {
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 0xFFFF) break;
      }
    }
    emu.cpu.setReg16(2, (lpDstRaw >>> 16) & 0xFFFF);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDstRaw & 0xFFFF);
    return lpDstRaw;
  }, 88);

  // --- Ordinal 89: lstrcat(lpDst, lpSrc) — 8 bytes (segstr+str) ---
  kernel.register('lstrlen', 8, () => {
    const [lpDstRaw, lpSrcRaw] = emu.readPascalArgs16([4, 4]);
    const lpDst = emu.resolveFarPtr(lpDstRaw);
    const lpSrc = emu.resolveFarPtr(lpSrcRaw);
    if (lpDst && lpSrc) {
      let dstLen = 0;
      while (emu.memory.readU8(lpDst + dstLen) !== 0 && dstLen < 0xFFFF) dstLen++;
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + dstLen + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 0xFFFF) break;
      }
    }
    emu.cpu.setReg16(2, (lpDstRaw >>> 16) & 0xFFFF);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDstRaw & 0xFFFF);
    return lpDstRaw;
  }, 89);

  // --- Ordinal 90: lstrlen(lpString) — 4 bytes (str) ---
  kernel.register('InitTask', 4, () => {
    const lpString = emu.readArg16FarPtr(0);
    if (!lpString) return 0;
    let len = 0;
    while (emu.memory.readU8(lpString + len) !== 0 && len < 0xFFFF) len++;
    return len;
  }, 90);

  // --- Ordinal 353: lstrcpyn(lpDst, lpSrc, iMaxLength) — 10 bytes (segptr+str+word) ---
  kernel.register('IsBadCodePtr', 10, () => {
    const [lpDst, lpSrc, iMaxLength] = emu.readPascalArgs16([4, 4, 2]);
    if (lpDst && lpSrc && iMaxLength > 0) {
      let i = 0;
      while (i < iMaxLength - 1) {
        const ch = emu.memory.readU8(lpSrc + i);
        emu.memory.writeU8(lpDst + i, ch);
        if (ch === 0) break;
        i++;
      }
      emu.memory.writeU8(lpDst + i, 0);
    }
    emu.cpu.setReg16(2, (lpDst >>> 16) & 0xFFFF);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (lpDst & 0xFFFF);
    return lpDst;
  }, 353);

  // --- Ordinal 348: hmemcpy(ptr ptr long) — 12 bytes ---
  kernel.register('hmemcpy', 12, () => {
    const [lpDest, lpSrc, cbCopy] = emu.readPascalArgs16([4, 4, 4]);
    if (lpDest && lpSrc && cbCopy > 0) {
      for (let i = 0; i < cbCopy; i++) {
        emu.memory.writeU8(lpDest + i, emu.memory.readU8(lpSrc + i));
      }
    }
    return 0;
  }, 348);
}
