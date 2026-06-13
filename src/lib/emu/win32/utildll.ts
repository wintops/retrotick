import type { Emulator } from '../emulator';

// UTILDLL.DLL — Terminal Services utility library used by taskmgr to
// resolve a SID to a user/domain name for the Users tab. We simply report
// "not available" so the column falls back to the SID string.

export function registerUtildll(emu: Emulator): void {
  const utildll = emu.registerDll('UTILDLL.DLL');

  // CachedGetUserFromSid(pSid, pUserName, pcchUserName) → BOOL
  utildll.register('CachedGetUserFromSid', 3, () => 0);

  // GetUserFromSid(pSid, pUserName, pcchUserName, pDomainName, pcchDomainName) → DWORD
  utildll.register('GetUserFromSid', 5, () => 0);
}
