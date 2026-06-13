import type { Emulator } from '../emulator';

// WINSTA.DLL — Terminal Services WinStation API.
// taskmgr.exe loads this dynamically to query session info; we return "no
// terminal services" so the user page falls back to "current session only".

export function registerWinsta(emu: Emulator): void {
  const winsta = emu.registerDll('WINSTA.DLL');

  // WinStationFreeMemory(pMem) → BOOL
  winsta.register('WinStationFreeMemory', 1, () => 1);

  // WinStationEnumerateW(hServer, ppSessionInfo, pCount) → BOOL
  winsta.register('WinStationEnumerateW', 3, () => {
    const pCount = emu.readArg(2);
    if (pCount) emu.memory.writeU32(pCount, 0);
    return 1;
  });
  winsta.register('WinStationEnumerate', 3, () => {
    const pCount = emu.readArg(2);
    if (pCount) emu.memory.writeU32(pCount, 0);
    return 1;
  });

  // WinStationQueryInformationW(hServer, sessionId, infoClass, pBuf, cbBuf, pcbReturned) → BOOL
  const queryInfo = () => {
    const cbBuf = emu.readArg(4);
    const pBuf = emu.readArg(3);
    if (pBuf && cbBuf) {
      for (let i = 0; i < cbBuf; i++) emu.memory.writeU8(pBuf + i, 0);
    }
    const pcb = emu.readArg(5);
    if (pcb) emu.memory.writeU32(pcb, cbBuf);
    return 1;
  };
  winsta.register('WinStationQueryInformationW', 6, queryInfo);
  winsta.register('WinStationQueryInformationA', 6, queryInfo);
  winsta.register('WinStationQueryInformation', 6, queryInfo);

  // WinStationGetProcessSid(hServer, pid, processStartTime, pSid, pcbSid) → BOOL
  winsta.register('WinStationGetProcessSid', 5, () => 0); // not available

  // WinStationConnect(hServer, sessionId, targetId, pPassword, bWait) → BOOL
  winsta.register('WinStationConnectW', 5, () => 0);
  winsta.register('WinStationConnectA', 5, () => 0);
  winsta.register('WinStationConnect', 5, () => 0);

  // WinStationDisconnect(hServer, sessionId, bWait) → BOOL
  winsta.register('WinStationDisconnect', 3, () => 0);

  // WinStationReset(hServer, sessionId, bWait) → BOOL — used by "Log Off"
  winsta.register('WinStationReset', 3, () => 0);

  // WinStationShadow(hServer, pTargetServer, sessionId, hotkeyVk, hotkeyMod) → BOOL
  winsta.register('WinStationShadow', 5, () => 0);

  // WinStationShutdownSystem(hServer, shutdownFlags) → BOOL
  winsta.register('WinStationShutdownSystem', 2, () => 0);

  // WinStationSendMessageW(hServer, sessionId, pTitle, cbTitle, pMessage, cbMessage, style, timeout, pResult, bDoNotWait) → BOOL
  winsta.register('WinStationSendMessageW', 10, () => 0);
  winsta.register('WinStationSendMessageA', 10, () => 0);
  winsta.register('WinStationSendMessage', 10, () => 0);

  // WinStationOpenServerW/A(serverName) → HANDLE
  winsta.register('WinStationOpenServerW', 1, () => 0);
  winsta.register('WinStationOpenServerA', 1, () => 0);

  // WinStationCloseServer(hServer) → BOOL
  winsta.register('WinStationCloseServer', 1, () => 1);

  // WinStationServerPing(hServer) → BOOL
  winsta.register('WinStationServerPing', 1, () => 0);

  // WinStationGetAllProcesses(hServer, level, pCount, ppInfo) → BOOL
  winsta.register('WinStationGetAllProcesses', 4, () => {
    const pCount = emu.readArg(2);
    if (pCount) emu.memory.writeU32(pCount, 0);
    return 0;
  });

  // WinStationFreeGAPMemory(level, pInfo, count) → BOOL
  winsta.register('WinStationFreeGAPMemory', 3, () => 1);

  // WinStationTerminateProcess(hServer, pid, exitCode) → BOOL
  winsta.register('WinStationTerminateProcess', 3, () => 0);

  // WinStationNameFromLogonIdW(hServer, sessionId, pName) → BOOL
  winsta.register('WinStationNameFromLogonIdW', 3, () => 0);
  winsta.register('WinStationNameFromLogonIdA', 3, () => 0);

  // CachedGetUserFromSid(pSid, pBuf, pcb) → BOOL — exported by some winsta builds
  winsta.register('CachedGetUserFromSid', 3, () => 0);
}
