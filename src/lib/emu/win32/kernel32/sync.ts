import type { Emulator } from '../../emulator';
import { emuCompleteThunk } from '../../emu-exec';

export function registerSync(emu: Emulator): void {
  const kernel32 = emu.registerDll('KERNEL32.DLL');

  // Critical sections (no-op for single-threaded)
  kernel32.register('InitializeCriticalSection', 1, () => 0);
  kernel32.register('InitializeCriticalSectionAndSpinCount', 2, () => 1);
  kernel32.register('InitializeCriticalSectionEx', 3, () => 1);
  kernel32.register('EnterCriticalSection', 1, () => 0);
  kernel32.register('LeaveCriticalSection', 1, () => 0);
  kernel32.register('DeleteCriticalSection', 1, () => 0);
  kernel32.register('TryEnterCriticalSection', 1, () => 1);

  // Interlocked operations
  kernel32.register('InterlockedIncrement', 1, () => {
    const ptr = emu.readArg(0);
    const val = (emu.memory.readI32(ptr) + 1) | 0;
    emu.memory.writeU32(ptr, val >>> 0);
    return val;
  });

  kernel32.register('InterlockedDecrement', 1, () => {
    const ptr = emu.readArg(0);
    const val = (emu.memory.readI32(ptr) - 1) | 0;
    emu.memory.writeU32(ptr, val >>> 0);
    return val;
  });

  kernel32.register('InterlockedExchange', 2, () => {
    const ptr = emu.readArg(0);
    const newVal = emu.readArg(1);
    const old = emu.memory.readU32(ptr);
    emu.memory.writeU32(ptr, newVal);
    return old;
  });

  kernel32.register('InterlockedCompareExchange', 3, () => {
    const ptr = emu.readArg(0);
    const exchange = emu.readArg(1);
    const comparand = emu.readArg(2);
    const old = emu.memory.readU32(ptr);
    if (old === comparand) emu.memory.writeU32(ptr, exchange);
    return old;
  });

  // Events
  kernel32.register('CreateEventA', 4, () => emu.handles.alloc('event', { signaled: false }));
  kernel32.register('CreateEventW', 4, () => emu.handles.alloc('event', { signaled: false }));
  kernel32.register('ResetEvent', 1, () => {
    const h = emu.readArg(0);
    const ev = emu.handles.get<{ signaled: boolean }>(h);
    if (ev) ev.signaled = false;
    return 1;
  });
  kernel32.register('SetEvent', 1, () => {
    const h = emu.readArg(0);
    const ev = emu.handles.get<{ signaled: boolean }>(h);
    if (ev) ev.signaled = true;
    return 1;
  });
  const STD_INPUT_HANDLE = 0xFFFFFFF6;
  const WAIT_OBJECT_0 = 0;
  const WAIT_TIMEOUT = 0x102;
  kernel32.register('WaitForSingleObject', 2, () => {
    const hHandle = emu.readArg(0);
    // If waiting on stdin and no input available, wait
    if (hHandle === (STD_INPUT_HANDLE >>> 0) && emu.consoleInputBuffer.length === 0) {
      const stackBytes = emu._currentThunkStackBytes;
      emu.waitingForMessage = true;
      emu._consoleInputResume = { stackBytes, completer: emuCompleteThunk };
      return undefined;
    }
    // Check handle state
    const obj = emu.handles.get<{ signaled?: boolean; childEmu?: unknown; childExited?: boolean }>(hHandle);
    // Child process handle — block until child exits
    if (obj && obj.childEmu !== undefined) {
      if (obj.childExited) return WAIT_OBJECT_0;
      // Block: save resume info and wait for child to exit
      const stackBytes = emu._currentThunkStackBytes;
      emu._childProcessWaiting = true;
      emu._childProcessResume = { stackBytes, retVal: WAIT_OBJECT_0, completer: emuCompleteThunk };
      emu.waitingForMessage = true;
      return undefined;
    }
    // Check event state
    if (obj && obj.signaled !== undefined) {
      if (obj.signaled) { obj.signaled = false; return WAIT_OBJECT_0; }
      return WAIT_TIMEOUT;
    }
    return WAIT_OBJECT_0;
  });

  // WaitForMultipleObjects(nCount, lpHandles, bWaitAll, dwMilliseconds)
  kernel32.register('WaitForMultipleObjects', 4, () => {
    const nCount = emu.readArg(0);
    const lpHandles = emu.readArg(1);
    // Check each handle — return index of first signaled event
    for (let i = 0; i < nCount; i++) {
      const h = emu.memory.readU32(lpHandles + i * 4);
      const ev = emu.handles.get<{ signaled?: boolean }>(h);
      if (ev && ev.signaled) {
        ev.signaled = false;
        return i; // WAIT_OBJECT_0 + i
      }
    }
    return WAIT_TIMEOUT;
  });

  kernel32.register('Sleep', 1, () => {
    const dwMilliseconds = emu.readArg(0);
    if (dwMilliseconds === 0) return 0; // yield — return immediately
    const stackBytes = emu._currentThunkStackBytes;
    emu.waitingForMessage = true;
    setTimeout(() => {
      emu.waitingForMessage = false;
      emuCompleteThunk(emu, 0, stackBytes);
      if (emu.running && !emu.halted) {
        requestAnimationFrame(emu.tick);
      }
    }, dwMilliseconds);
    return undefined;
  });

  // Mutex stubs
  kernel32.register('CreateMutexA', 3, () => emu.handles.alloc('mutex', {}));
  kernel32.register('CreateMutexW', 3, () => emu.handles.alloc('mutex', {}));
  kernel32.register('OpenMutexA', 3, () => emu.handles.alloc('mutex', {}));
  kernel32.register('ReleaseMutex', 1, () => 1);
  kernel32.register('CreateSemaphoreA', 4, () => emu.handles.alloc('semaphore', {}));

  kernel32.register('CreateSemaphoreW', 4, () => {
    return emu.handles.alloc('semaphore', {});
  });

  kernel32.register('ReleaseSemaphore', 3, () => {
    return 1;
  });

  // WaitForMultipleObjectsEx(nCount, lpHandles, bWaitAll, dwMilliseconds, bAlertable) → DWORD
  kernel32.register('WaitForMultipleObjectsEx', 5, () => {
    const nCount = emu.readArg(0);
    const lpHandles = emu.readArg(1);
    for (let i = 0; i < nCount; i++) {
      const h = emu.memory.readU32(lpHandles + i * 4);
      const ev = emu.handles.get<{ signaled?: boolean }>(h);
      if (ev && ev.signaled) {
        ev.signaled = false;
        return i; // WAIT_OBJECT_0 + i
      }
    }
    return WAIT_TIMEOUT;
  });

  // OpenMutexW: return 0 (not found) — sakura checks single instance
  kernel32.register('OpenMutexW', 3, () => 0);

  // OpenEventA(dwDesiredAccess, bInheritHandle, lpName) — return a new event handle
  kernel32.register('OpenEventA', 3, () => emu.handles.alloc('event', { signaled: false }));

  // FlushInstructionCache(hProcess, lpBaseAddress, dwSize) — no-op for emulator
  kernel32.register('FlushInstructionCache', 3, () => 1);
}
