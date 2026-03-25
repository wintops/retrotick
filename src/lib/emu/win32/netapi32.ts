import type { Emulator } from '../emulator';

export function registerNetapi32(emu: Emulator): void {
  const netapi32 = emu.registerDll('NETAPI32.DLL');

  // NetWkstaGetInfo(servername, level, bufptr) → NET_API_STATUS
  netapi32.register('NetWkstaGetInfo', 3, () => 2136); // NERR_WkstaNotStarted
  // NetApiBufferFree(Buffer) → NET_API_STATUS
  netapi32.register('NetApiBufferFree', 1, () => 0); // NERR_Success
}
