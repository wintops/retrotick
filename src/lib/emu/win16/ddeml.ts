import type { Emulator } from '../emulator';

// Win16 DDEML module — all stubs (network play not supported)

export function registerWin16Ddeml(emu: Emulator): void {
  const ddeml = emu.registerModule16('DDEML');

  // All DDEML functions return 0 (failure/no-op)
  ddeml.register('DdeInitialize', 16, () => 0, 2);   // DdeInitialize
  ddeml.register('DdeUninitialize', 4, () => 0, 3);   // DdeUninitialize
  ddeml.register('DdeConnect', 12, () => 0, 5);   // DdeConnect
  ddeml.register('DdeDisconnect', 2, () => 0, 6);   // DdeDisconnect
  ddeml.register('DdeClientTransaction', 24, () => 0, 11);  // DdeClientTransaction
  ddeml.register('DdeCreateStringHandle', 10, () => 0, 14);  // DdeCreateStringHandle
  ddeml.register('DdeFreeStringHandle', 6, () => 0, 15);  // DdeFreeStringHandle
  ddeml.register('DdeKeepStringHandle', 6, () => 0, 16);  // DdeKeepStringHandle
  ddeml.register('DdeGetLastError', 4, () => 0, 18);  // DdeGetLastError
  ddeml.register('DdePostAdvise', 8, () => 0, 19);  // DdePostAdvise
  ddeml.register('DdeNameService', 10, () => 0, 20);  // DdeNameService
  ddeml.register('DdeCreateDataHandle', 20, () => 0, 26);  // DdeCreateDataHandle
  ddeml.register('DdeReconnect', 16, () => 0, 7);   // DdeReconnect
  ddeml.register('DdeDisconnectList', 4, () => 0, 8);   // DdeDisconnectList
  ddeml.register('DdeAbandonTransaction', 12, () => 0, 13);  // DdePostAdvise (different ordinal)
  ddeml.register('DdeQueryString', 10, () => 0, 21);  // DdeCreateStringHandle (alt)
  ddeml.register('DdeFreeStringHandle16', 8, () => 0, 22);  // DdeFreeStringHandle (alt)
  ddeml.register('DdeNameService16', 14, () => 0, 27);  // DdeNameService (alt)
}
