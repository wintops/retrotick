import type { Emulator } from '../emulator';

export function registerVdmdbg(emu: Emulator): void {
  const vdmdbg = emu.registerDll('VDMDBG.DLL');
  // VDMTerminateTaskWOW(dwProcessId, wTask) → BOOL
  vdmdbg.register('VDMTerminateTaskWOW', 2, () => 0); // fail
  // VDMEnumTaskWOWEx(dwProcessId, lpEnumFunc, lParam) → INT
  vdmdbg.register('VDMEnumTaskWOWEx', 3, () => 0); // no tasks
}
