import type { Emulator } from '../emulator';

export function registerSetupapi(emu: Emulator): void {
  const setupapi = emu.registerDll('SETUPAPI.DLL');
  setupapi.register('SetupDiGetClassDevsA', 4, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE
  setupapi.register('SetupDiEnumDeviceInfo', 3, () => 0); // FALSE
  setupapi.register('SetupDiOpenDevRegKey', 6, () => 0xFFFFFFFF); // INVALID_HANDLE_VALUE
}
