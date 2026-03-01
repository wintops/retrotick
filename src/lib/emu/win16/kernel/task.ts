import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelTask(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 29: Yield() — 0 bytes ---
  kernel.register('ord_29', 0, () => 0);

  // --- Ordinal 30: WaitEvent(hTask) — 2 bytes (word) ---
  kernel.register('ord_30', 2, () => 0);

  // --- Ordinal 31: PostEvent(word) — 2 bytes (word) ---
  kernel.register('ord_31', 2, () => 0);

  // --- Ordinal 32: SetPriority(word s_word) — 4 bytes ---
  kernel.register('ord_32', 4, () => 0);

  // --- Ordinal 33: LockCurrentTask(word) — 2 bytes ---
  kernel.register('ord_33', 2, () => 0);

  // --- Ordinal 34: SetTaskQueue(hTask, hQueue) — 4 bytes (word+word) ---
  kernel.register('ord_34', 4, () => {
    const [hTask, hQueue] = emu.readPascalArgs16([2, 2]);
    return hQueue;
  });

  // --- Ordinal 35: GetTaskQueue(word) — 2 bytes ---
  kernel.register('ord_35', 2, () => 0);

  // --- Ordinal 36: GetCurrentTask() — 0 bytes ---
  kernel.register('ord_36', 0, () => 1);

  // --- Ordinal 37: GetCurrentPDB() — 0 bytes ---
  kernel.register('ord_37', 0, () => 0);

  // --- Ordinal 38: SetTaskSignalProc(word segptr) — 6 bytes (word+long) ---
  kernel.register('ord_38', 6, () => 0);

  // --- Ordinal 91: InitTask() — 0 bytes, register-based ---
  kernel.register('ord_91', 2, () => {
    const hInstance = 1;
    emu.cpu.reg[0] = hInstance;
    emu.cpu.setReg16(3, 1);       // BX = cmdShow
    emu.cpu.setReg16(1, 0x1000);  // CX = stack size
    emu.cpu.setReg16(2, 1);       // DX = nCmdShow
    emu.cpu.setReg16(7, hInstance); // DI = hInstance
    emu.cpu.setReg16(6, 0);       // SI = hPrevInstance
    const cmdLineAddr = emu.allocHeap(16);
    emu.memory.writeU8(cmdLineAddr, 0);
    emu.cpu.es = emu.cpu.ds;
    emu.cpu.setReg16(3, 0x81);    // BX = offset 0x81
    return hInstance;
  });

  // --- Ordinal 117: OldYield() — 0 bytes ---
  kernel.register('ord_117', 0, () => 0);

  // --- Ordinal 118: GetTaskQueueDS() — 0 bytes ---
  kernel.register('ord_118', 0, () => emu.cpu.ds);

  // --- Ordinal 119: GetTaskQueueES() — 0 bytes ---
  kernel.register('ord_119', 0, () => emu.cpu.es);

  // --- Ordinal 122: IsTaskLocked() — 0 bytes ---
  kernel.register('ord_122', 0, () => 0);

  // --- Ordinal 150: DirectedYield(word) — 2 bytes ---
  kernel.register('ord_150', 2, () => 0);

  // --- Ordinal 152: GetNumTasks() — 0 bytes ---
  kernel.register('ord_152', 0, () => 1);

  // --- Ordinal 155: GetTaskDS() — 0 bytes ---
  kernel.register('ord_155', 0, () => emu.cpu.ds);

  // --- Ordinal 320: IsTask(word) — 2 bytes ---
  kernel.register('ord_320', 2, () => 1);
}
