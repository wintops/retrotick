import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelTask(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 29: Yield() — 0 bytes ---
  kernel.register('Yield', 0, () => 0, 29);

  // --- Ordinal 30: WaitEvent(hTask) — 2 bytes (word) ---
  kernel.register('WaitEvent', 2, () => 0, 30);

  // --- Ordinal 31: PostEvent(word) — 2 bytes (word) ---
  kernel.register('PostEvent', 2, () => 0, 31);

  // --- Ordinal 32: SetPriority(word s_word) — 4 bytes ---
  kernel.register('SetPriority', 4, () => 0, 32);

  // --- Ordinal 33: LockCurrentTask(word) — 2 bytes ---
  kernel.register('LockCurrentTask', 2, () => 0, 33);

  // --- Ordinal 34: SetTaskQueue(hTask, hQueue) — 4 bytes (word+word) ---
  kernel.register('SetTaskQueue', 4, () => {
    const [hTask, hQueue] = emu.readPascalArgs16([2, 2]);
    return hQueue;
  }, 34);

  // --- Ordinal 35: GetTaskQueue(word) — 2 bytes ---
  kernel.register('GetTaskQueue', 2, () => 0, 35);

  // --- Ordinal 36: GetCurrentTask() — 0 bytes ---
  kernel.register('GetCurrentTask', 0, () => 1, 36);

  // --- Ordinal 37: GetCurrentPDB() — 0 bytes ---
  kernel.register('GetCurrentPDB', 0, () => 0, 37);

  // --- Ordinal 38: SetTaskSignalProc(word segptr) — 6 bytes (word+long) ---
  kernel.register('SetTaskSignalProc', 6, () => 0, 38);

  // --- Ordinal 91: InitTask() — 0 bytes, register-based ---
  kernel.register('InitTask', 0, () => {
    const hInstance = 1;
    const SW_SHOWNORMAL = 1;
    emu.cpu.setReg16(1, 0x1000);  // CX = stack size
    emu.cpu.setReg16(7, hInstance); // DI = hInstance
    emu.cpu.setReg16(6, 0);       // SI = hPrevInstance
    const cmdLineAddr = emu.allocHeap(16);
    emu.memory.writeU8(cmdLineAddr, 0);
    emu.cpu.es = emu.cpu.ds;
    emu.cpu.setReg16(3, 0x81);    // BX = offset to command line in PSP
    // Return DWORD: DX:AX where AX=hInstance, DX=nCmdShow
    // emuCompleteThunk16 sets AX=low word, DX=high word
    return (SW_SHOWNORMAL << 16) | hInstance;
  }, 91);

  // --- Ordinal 117: OldYield() — 0 bytes ---
  kernel.register('OldYield', 0, () => 0, 117);

  // --- Ordinal 118: GetTaskQueueDS() — 0 bytes ---
  kernel.register('GetTaskQueueDS', 0, () => emu.cpu.ds, 118);

  // --- Ordinal 119: GetTaskQueueES() — 0 bytes ---
  kernel.register('GetTaskQueueES', 0, () => emu.cpu.es, 119);

  // --- Ordinal 122: IsTaskLocked() — 0 bytes ---
  kernel.register('IsTaskLocked', 0, () => 0, 122);

  // --- Ordinal 150: DirectedYield(word) — 2 bytes ---
  kernel.register('DirectedYield', 2, () => 0, 150);

  // --- Ordinal 152: GetNumTasks() — 0 bytes ---
  kernel.register('GetNumTasks', 0, () => 1, 152);

  // --- Ordinal 155: GetTaskDS() — 0 bytes ---
  kernel.register('GetTaskDS', 0, () => emu.cpu.ds, 155);

  // --- Ordinal 320: IsTask(word) — 2 bytes ---
  kernel.register('IsTask', 2, () => 1, 320);
}
