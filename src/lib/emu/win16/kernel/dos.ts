import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';
import { handleInt21 } from '../../dos/int21';

export function registerKernelDos(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  const fs = emu.fs;

  // --- Ordinal 3: GetVersion() — 0 bytes ---
  kernel.register('GetVersion', 0, () => 0x0A03, 3);

  // --- Ordinal 39: GetTickCount() — 0 bytes ---
  kernel.register('GetTickCount', 0, () => Date.now() & 0xFFFFFFFF, 39);

  // --- Ordinal 41: EnableDos() — 0 bytes ---
  kernel.register('EnableDos', 0, () => 0, 41);

  // --- Ordinal 42: DisableDos() — 0 bytes ---
  kernel.register('DisableDos', 0, () => 0, 42);

  // --- Ordinal 92: GetTempDrive(word) — 2 bytes ---
  kernel.register('GetTempDrive', 2, () => 0x43, 92); // 'C'

  // --- Ordinal 102: DOS3Call() — 0 bytes, register-based ---
  // Delegates to the shared INT 21h handler in dos-int.ts
  // Must return current DX:AX so emuCompleteThunk16 preserves the INT 21h results
  kernel.register('DOS3Call', 0, () => {
    handleInt21(emu.cpu, emu);
    const retAx = emu.cpu.reg[0] & 0xFFFF;
    const retDx = emu.cpu.reg[2] & 0xFFFF;
    return (retDx << 16) | retAx;
  }, 102);

  // --- Ordinal 105: GetExeVersion() — 0 bytes ---
  kernel.register('GetExeVersion', 0, () => 0x030A, 105);

  // --- Ordinal 131: GetDOSEnvironment() — 0 bytes ---
  kernel.register('GetDOSEnvironment', 0, () => {
    const envAddr = emu.allocHeap(4);
    emu.memory.writeU8(envAddr, 0);
    emu.memory.writeU8(envAddr + 1, 0);
    const seg = emu.cpu.ds;
    emu.cpu.setReg16(2, seg);
    emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (envAddr & 0xFFFF);
    return (seg << 16) | (envAddr & 0xFFFF);
  }, 131);

  // --- Ordinal 132: GetWinFlags() — 0 bytes ---
  kernel.register('GetWinFlags', 0, () => 0x0413, 132);

  // --- Ordinal 134: GetWindowsDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('GetWindowsDirectory', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  }, 134);

  // --- Ordinal 135: GetSystemDirectory(ptr word) — 6 bytes (ptr+word) ---
  kernel.register('GetSystemDirectory', 6, () => {
    const [lpBuffer, nSize] = emu.readPascalArgs16([4, 2]);
    const dir = 'C:\\WINDOWS\\SYSTEM';
    const buf = emu.resolveFarPtr(lpBuffer);
    if (buf && nSize > 0) {
      const maxCopy = Math.min(dir.length, nSize - 1);
      for (let i = 0; i < maxCopy; i++) emu.memory.writeU8(buf + i, dir.charCodeAt(i));
      emu.memory.writeU8(buf + maxCopy, 0);
      return maxCopy;
    }
    return 0;
  }, 135);

  // --- Ordinal 136: GetDriveType(nDrive) — 2 bytes (word) ---
  // Win16 return values: 0=unknown, 1=does not exist, 2=removable, 3=fixed, 4=remote
  // WINFILE checks type==0 to skip non-existent drives, so return 0 (not 1)
  kernel.register('GetDriveType', 2, () => {
    const nDrive = emu.readPascalArgs16([2])[0]; // 0=A, 1=B, 2=C, ...
    if (nDrive >= 2 && nDrive <= 4) return 3; // C:, D:, E: = DRIVE_FIXED
    return 0; // non-existent
  }, 136);

  // --- Ordinal 167: GetExpWinVer(word) — 2 bytes ---
  kernel.register('GetExpWinVer', 2, () => 0x030A, 167);
}
