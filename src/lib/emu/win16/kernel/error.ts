import type { Emulator, Win16Module } from '../../emulator';
import type { KernelState } from './index';

export function registerKernelError(kernel: Win16Module, emu: Emulator, state: KernelState): void {
  // --- Ordinal 1: FatalExit(code) — 2 bytes ---
  kernel.register('ord_1', 2, () => { emu.halted = true; return 0; });

  // --- Ordinal 2: ExitKernel() — 0 bytes ---
  kernel.register('ord_2', 0, () => { emu.halted = true; return 0; });

  // --- Ordinal 55: Catch(lpCatchBuf) — 4 bytes (ptr) ---
  // Saves register state to CATCHBUF (9 words = 18 bytes):
  // SP, BP, SI, DI, DS, SS, IP_lo, CS, IP_hi (Wine layout)
  kernel.register('ord_55', 4, () => {
    const lpCatchBuf = emu.readArg16DWord(0);
    const buf = emu.resolveFarPtr(lpCatchBuf);
    if (buf) {
      emu.memory.writeU16(buf + 0, emu.cpu.reg[4] & 0xFFFF);  // SP
      emu.memory.writeU16(buf + 2, emu.cpu.reg[5] & 0xFFFF);  // BP
      emu.memory.writeU16(buf + 4, emu.cpu.reg[6] & 0xFFFF);  // SI
      emu.memory.writeU16(buf + 6, emu.cpu.reg[7] & 0xFFFF);  // DI
      emu.memory.writeU16(buf + 8, emu.cpu.ds);                // DS
      emu.memory.writeU16(buf + 10, emu.cpu.ss);               // SS
      // Save return address (IP after Catch returns)
      // The return address is on the stack from the CALL
      const retAddr = emu.cpu.eip;
      emu.memory.writeU16(buf + 12, retAddr & 0xFFFF);         // IP low
      emu.memory.writeU16(buf + 14, emu.cpu.cs);               // CS
      emu.memory.writeU16(buf + 16, (retAddr >>> 16) & 0xFFFF); // IP high (usually 0 for 16-bit)
    }
    return 0;
  });

  // --- Ordinal 56: Throw(lpCatchBuf, nThrowBack) — 6 bytes (ptr+word) ---
  kernel.register('ord_56', 6, () => {
    const [lpCatchBuf, nThrowBack] = emu.readPascalArgs16([4, 2]);
    const buf = emu.resolveFarPtr(lpCatchBuf);
    if (buf) {
      emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | emu.memory.readU16(buf + 0);  // SP
      emu.cpu.reg[5] = (emu.cpu.reg[5] & 0xFFFF0000) | emu.memory.readU16(buf + 2);  // BP
      emu.cpu.reg[6] = (emu.cpu.reg[6] & 0xFFFF0000) | emu.memory.readU16(buf + 4);  // SI
      emu.cpu.reg[7] = (emu.cpu.reg[7] & 0xFFFF0000) | emu.memory.readU16(buf + 6);  // DI
      emu.cpu.ds = emu.memory.readU16(buf + 8);
      emu.cpu.ss = emu.memory.readU16(buf + 10);
      const ip = emu.memory.readU16(buf + 12);
      emu.cpu.cs = emu.memory.readU16(buf + 14);
      emu.cpu.eip = ip;
    }
    return nThrowBack || 1;
  });

  // --- Ordinal 107: SetErrorMode(uMode) — 2 bytes (word) ---
  kernel.register('ord_107', 2, () => 0);

  // --- Ordinal 108: SwitchStackTo(segment, size, offset) — 6 bytes ---
  kernel.register('ord_108', 6, () => {
    const [segment, size, offset] = emu.readPascalArgs16([2, 2, 2]);
    // Save current stack
    state.savedStack = { ss: emu.cpu.ss, sp: emu.cpu.reg[4] & 0xFFFF };
    // Switch to new stack
    emu.cpu.ss = segment;
    emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | (offset & 0xFFFF);
    return 0;
  });

  // --- Ordinal 109: SwitchStackBack() — 0 bytes ---
  kernel.register('ord_109', 0, () => {
    if (state.savedStack) {
      emu.cpu.ss = state.savedStack.ss;
      emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | (state.savedStack.sp & 0xFFFF);
      state.savedStack = null;
    }
    return 0;
  });

  // --- Ordinal 137: FatalAppExit(action, lpMsg) — 6 bytes (word+str) ---
  kernel.register('ord_137', 6, () => {
    const msg = emu.memory.readCString(emu.resolveFarPtr(emu.readArg16DWord(2)));
    console.error(`[KERNEL] FatalAppExit: "${msg}"`);
    emu.haltReason = `FatalAppExit: ${msg}`;
    emu.halted = true;
    return 0;
  });

  // --- Ordinal 140: SetSigHandler(segptr ptr ptr word word) — 14 bytes ---
  kernel.register('ord_140', 14, () => 0);

  // --- Ordinal 147: SetLastError(long) — 4 bytes ---
  kernel.register('ord_147', 4, () => {
    const [err] = emu.readPascalArgs16([4]);
    state.lastError = err;
    return 0;
  });

  // --- Ordinal 148: GetLastError() — 0 bytes ---
  kernel.register('ord_148', 0, () => state.lastError);

  // --- Ordinal 139: DoSignal — 0 bytes ---
  kernel.register('ord_139', 0, () => 0);

  // --- Ordinal 203: DebugBreak — 0 bytes ---
  kernel.register('ord_203', 0, () => 0);
}
