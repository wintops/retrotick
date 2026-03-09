import type { Emulator } from './emulator';
import type { WindowInfo } from './win32/user32/types';
import { syncVideoMemory, handleDosInt } from './dos/index';
import { syncGraphics } from './dos/vga';

// A special "return from WndProc" thunk address
const WNDPROC_RETURN_THUNK = 0x00FE0000;

export function emuCompleteThunk(emu: Emulator, retVal: number, stackBytes: number): void {
  emu.cpu.reg[0] = retVal | 0; // EAX
  const retAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
  emu.cpu.reg[4] = (emu.cpu.reg[4] + 4 + stackBytes) | 0; // pop retAddr + args (stdcall)
  emu.cpu.eip = retAddr;
}

export function emuCompleteThunk16(emu: Emulator, retVal: number, stackBytes: number): void {
  // Win16 PASCAL: 16-bit returns in AX, 32-bit returns (DWORD/FARPROC) in DX:AX
  emu.cpu.reg[0] = (emu.cpu.reg[0] & 0xFFFF0000) | (retVal & 0xFFFF); // AX = low word
  emu.cpu.reg[2] = (emu.cpu.reg[2] & 0xFFFF0000) | ((retVal >>> 16) & 0xFFFF); // DX = high word
  // Pop FAR return address (IP, then CS)
  const ip = emu.cpu.pop16();
  const cs = emu.cpu.pop16();
  // Pop PASCAL args
  if (stackBytes > 0) {
    const sp = (emu.cpu.reg[4] & 0xFFFF) + stackBytes;
    emu.cpu.reg[4] = (emu.cpu.reg[4] & ~0xFFFF) | (sp & 0xFFFF);
  }
  // Return to caller
  emu.cpu.cs = cs;
  emu.cpu.eip = (emu.cpu.segBase(cs)) + ip;
}

export function emuResume(emu: Emulator): void {
  // Legacy: only used for DOS keyboard resume (INT 16h)
  if (!emu.waitingForMessage) return;
  if (emu._dosWaitingForKey && emu.dosKeyBuffer.length > 0) {
    emu.deliverDosKey();
  }
}

export function emuCallWndProc(emu: Emulator, wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
  if (!wndProc || wndProc === 0) return 0;
  // Skip WndProc calls to addresses outside image and thunk ranges (garbage/unimplemented pointers)
  if (!emu.isNE && emu.pe) {
    const isThunk = emu.thunkToApi.has(wndProc);
    let inImage = wndProc >= emu.pe.imageBase && wndProc < emu.pe.imageBase + emu.pe.sizeOfImage;
    if (!inImage) {
      for (const mod of emu.loadedModules.values()) {
        if (mod.sizeOfImage && wndProc >= mod.imageBase && wndProc < mod.imageBase + mod.sizeOfImage) {
          inImage = true;
          break;
        }
      }
    }
    if (!isThunk && !inImage) {
      return 0;
    }
  }
  emu.wndProcDepth++;

  // Save callee-saved registers
  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];

  // Set up stack for WndProc call
  emu.cpu.push32(lParam);
  emu.cpu.push32(wParam);
  emu.cpu.push32(message);
  emu.cpu.push32(hwnd);
  emu.cpu.push32(WNDPROC_RETURN_THUNK);
  const wndProcRetThunkAddr = emu.cpu.reg[4] >>> 0; // remember where the thunk was pushed
  emu.cpu.eip = wndProc;

  // Run a local step loop until the wndproc returns or goes async.
  // This reuses the frame stack so that WNDPROC_RETURN in emuTick
  // can also handle completion if we yield to async.
  const frame = {
    savedEBX, savedEBP, savedESI, savedEDI,
    outerStackBytes: 0,
    outerCompleter: emuCompleteThunk,
  };

  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  const MAX_STEPS = 20000000;

  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted && steps < MAX_STEPS) {
    const eip = emu.cpu.eip >>> 0;
    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        // If a nested callWndProc was set up, execute it within this loop
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          // The nested call pushed its own frame; fill in its outer thunk info
          const nestedFrame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
          nestedFrame.outerStackBytes = thunk.stackBytes;
          nestedFrame.outerCompleter = emuCompleteThunk;
          // If still waiting (e.g. nested async API like MessageBox), propagate up
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          steps++;
          continue;
        }
        if (retVal === undefined) {
          // Handler returned undefined — either:
          // 1. It handled EIP/ESP itself (e.g. _EH_prolog) — continue executing
          // 2. It set waitingForMessage — break and push frame for async completion
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          // Case 1: handler adjusted EIP/ESP directly, continue execution
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
      } else {
        emu.haltReason = `Unimplemented API: ${key}`;
        emu.halted = true;
        break;
      }
    } else {
      emu.cpu.step();
    }
    steps++;
  }

  // If we're waiting (handler set waitingForMessage), push frame for emuTick to complete
  if ((emu.waitingForMessage || emu._wndProcSetupPending) && !emu._wndProcFrames.includes(frame)) {
    emu._wndProcFrames.push(frame);
    emu._wndProcSetupPending = true;
    return undefined;
  }
  if (emu._wndProcSetupPending) {
    return undefined;
  }

  if (steps >= MAX_STEPS) {
    console.warn(`WndProc exceeded max steps for msg 0x${message.toString(16)}, EIP=0x${(emu.cpu.eip >>> 0).toString(16)}`);
  }

  // Zero out the stale WNDPROC_RETURN_THUNK from stack memory to prevent
  // it from being picked up by a later RET instruction when the stack grows
  emu.memory.writeU32(wndProcRetThunkAddr, 0);

  // Synchronous return — restore callee-saved registers
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;

  return emu.wndProcResult;
}

export function emuCallWndProc16(emu: Emulator, wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
  if (!wndProc) return 0;

  emu.wndProcDepth++;

  const savedSP = emu.cpu.reg[4] & 0xFFFF;
  const savedDS = emu.cpu.ds;
  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];

  // Ensure DS points to the auto-data segment (MakeProcInstance would set this)
  if (emu.isNE && emu.ne) {
    emu.cpu.ds = emu.ne.dataSegSelector;
  }

  // Push PASCAL args (left to right): hwnd, message, wParam, lParam
  emu.cpu.push16(hwnd & 0xFFFF);
  emu.cpu.push16(message & 0xFFFF);
  emu.cpu.push16(wParam & 0xFFFF);
  emu.cpu.push32(lParam); // LONG = 4 bytes

  // Push FAR return address (WNDPROC_RETURN thunk)
  const WNDPROC_RETURN_SELECTOR = 0xFE;
  const WNDPROC_RETURN_OFFSET = 0xFF04;
  emu.cpu.push16(WNDPROC_RETURN_SELECTOR);
  emu.cpu.push16(WNDPROC_RETURN_OFFSET);

  // Set CS:IP to wndProc
  if (wndProc > 0xFFFF) {
    for (const [sel, base] of emu.cpu.segBases) {
      if (wndProc >= base && wndProc < base + 0x10000) {
        emu.cpu.cs = sel;
        emu.cpu.eip = wndProc;
        break;
      }
    }
  } else {
    emu.cpu.eip = (emu.cpu.segBase(emu.cpu.cs)) + wndProc;
  }

  const frame = {
    savedEBX, savedEBP, savedESI, savedEDI,
    savedDS, savedSP,
    outerStackBytes: 0,
    outerCompleter: emuCompleteThunk16,
  };

  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  const MAX_STEPS = 200000000;
  const YIELD_MS = 40;
  const startTime = performance.now();

  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted && steps < MAX_STEPS) {
    // Yield to browser periodically so the UI stays responsive
    if ((steps & 0xFFF) === 0 && steps > 0 && performance.now() - startTime > YIELD_MS) {
      // Push frame so the tick loop continues executing this wndproc
      emu._wndProcFrames.push(frame);
      emu._wndProcSetupPending = true;
      return undefined;
    }

    const eip = emu.cpu.eip >>> 0;
    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        // If a nested callWndProc16 was set up, execute it within this loop
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          const nestedFrame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
          nestedFrame.outerStackBytes = thunk.stackBytes;
          nestedFrame.outerCompleter = emuCompleteThunk16;
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          steps++;
          continue;
        }
        if (retVal === undefined) {
          if (emu.waitingForMessage) {
            emu._wndProcFrames.push(frame);
            emu._wndProcSetupPending = true;
            break;
          }
          // Handler adjusted EIP/ESP directly — continue execution
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        emuCompleteThunk16(emu, retVal as number, thunk.stackBytes);
      } else {
        console.warn(`Unimplemented Win16 API: ${key}`);
        emuCompleteThunk16(emu, 0, thunk.stackBytes);
      }
    } else {
      emu.cpu.step();
    }
    steps++;
  }

  // If waiting, push frame for emuTick to complete
  if ((emu.waitingForMessage || emu._wndProcSetupPending) && !emu._wndProcFrames.includes(frame)) {
    emu._wndProcFrames.push(frame);
    emu._wndProcSetupPending = true;
    return undefined;
  }
  if (emu._wndProcSetupPending) {
    return undefined;
  }

  if (steps >= MAX_STEPS) {
    console.warn(`[MSG16] WndProc exceeded max steps for msg 0x${message.toString(16)} EIP=0x${(emu.cpu.eip >>> 0).toString(16)} CS=${emu.cpu.cs}`);
    emu.cpu.reg[4] = (emu.cpu.reg[4] & 0xFFFF0000) | (savedSP & 0xFFFF);
    emu.wndProcDepth = targetDepth;
  }

  // Synchronous return — restore callee-saved registers
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;

  return emu.wndProcResult;
}

/**
 * Call a DLL entry point: DllMain(hModule, DLL_PROCESS_ATTACH, 0)
 * Uses the same nested-loop mechanism as callWndProc.
 */
export function emuCallDllMain(emu: Emulator, entryPoint: number, hModule: number): number {
  if (!entryPoint) return 1;

  const savedEBX = emu.cpu.reg[3];
  const savedESI = emu.cpu.reg[6];
  const savedEDI = emu.cpu.reg[7];
  const savedEBP = emu.cpu.reg[5];
  const savedESP = emu.cpu.reg[4];

  const DLL_PROCESS_ATTACH = 1;
  // stdcall: push args right-to-left
  emu.cpu.push32(0);                     // lpReserved
  emu.cpu.push32(DLL_PROCESS_ATTACH);    // fdwReason
  emu.cpu.push32(hModule);               // hinstDLL
  emu.cpu.push32(WNDPROC_RETURN_THUNK);  // return address
  emu.cpu.eip = entryPoint;

  emu.wndProcDepth++;
  const targetDepth = emu.wndProcDepth - 1;
  let steps = 0;
  const MAX_STEPS = 5000000;

  while (emu.wndProcDepth > targetDepth && !emu.halted && !emu.cpu.halted && steps < MAX_STEPS) {
    const eip = emu.cpu.eip >>> 0;
    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          handler(emu);
          break;
        }
        emu._currentThunkStackBytes = thunk.stackBytes;
        const retVal = handler(emu);
        if (emu._wndProcSetupPending) {
          emu._wndProcSetupPending = false;
          steps++;
          continue;
        }
        if (emu.waitingForMessage || emu.halted) break;
        if (retVal !== undefined) {
          emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
        }
      } else {
        emuCompleteThunk(emu, 0, thunk.stackBytes);
      }
    } else {
      emu.cpu.step();
    }
    steps++;
  }

  const retVal = emu.cpu.reg[0]; // EAX
  emu.cpu.reg[3] = savedEBX;
  emu.cpu.reg[5] = savedEBP;
  emu.cpu.reg[6] = savedESI;
  emu.cpu.reg[7] = savedEDI;
  emu.cpu.reg[4] = savedESP;

  console.log(`[DLL] DllMain(0x${hModule.toString(16)}, DLL_PROCESS_ATTACH) => ${retVal} (${steps} steps)`);
  return retVal;
}

export function emuCallNative(emu: Emulator, addr: number): number | undefined {
  const savedESP = emu.cpu.reg[4];
  const result = emuCallWndProc(emu, addr, 0, 0, 0, 0);
  emu.cpu.reg[4] = savedESP;
  return result;
}

const BATCH_SIZE = 500000;
const DOS_POST_KEY_STEPS = 0x80;

export function emuTick(emu: Emulator): void {
  if (!emu.running || emu.halted) return;

  try {
  const tickStart = performance.now();
  let stepCount = 0;
  const DOS_TICK_MS = 14; // run close to one frame (~16ms) for throughput
  const tickMs = emu.isDOS ? DOS_TICK_MS : 50;
  let dosYieldAfterKeyAt = -1;
  let prevDosKeyBufferLen = emu.dosKeyBuffer.length;
  let prevBdaKeyHead = emu.isDOS ? emu.memory.readU16(0x41A) : 0;
  emu._dosKeyConsumedThisTick = false;
  emu._dosHwKeyReadThisTick = false;

  // Wake from HLT: check if a timer interrupt is due
  if (emu._dosHalted && emu.isDOS) {
    const now = performance.now();
    const pitReload = emu._pitCounters[0] || 0x10000;
    const timerIntervalMs = (pitReload / 1193182) * 1000;
    if (now - emu._dosLastTimerTick >= timerIntervalMs) {
      emu._dosLastTimerTick = now;
      emu._pendingHwInts.push(0x08);
      emu._dosHalted = false;
    }
    // Also wake on pending keyboard interrupt
    if (emu._pendingHwInts.length > 0 || emu.dosKeyBuffer.length > 0) {
      emu._dosHalted = false;
    }
    // If still halted, fall through to bottom where next tick is scheduled
  }

  for (let i = 0; i < BATCH_SIZE; i++) {
    if (emu._int09ReturnCS >= 0) {
      const ip16 = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;
      if (emu.cpu.cs === emu._int09ReturnCS && ip16 === emu._int09ReturnIP) {
        // INT 09h handler returned (IRET) to interrupted context.
        emu._kbdReplayPending = false;
        emu._kbdDataReadsLeft = 0;
        emu._int09ReturnCS = -1;
      }
    }
    if (emu.halted || emu.waitingForMessage || emu._dosHalted) break;
    if (emu.isDOS && dosYieldAfterKeyAt < 0 && (emu._dosKeyConsumedThisTick || emu._dosHwKeyReadThisTick)) {
      // A DOS key was consumed this tick (INT 16h or direct port 0x60 path):
      // let guest run a little longer
      // so it can finish drawing before we yield/sync the frame.
      dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
    }
    if (dosYieldAfterKeyAt >= 0 && i >= dosYieldAfterKeyAt) break;
    if ((i & 0xFFF) === 0 && i > 0) {
      const waitingForPostKeyWindow = dosYieldAfterKeyAt >= 0 && i < dosYieldAfterKeyAt;
      if (!waitingForPostKeyWindow && performance.now() - tickStart > tickMs) break;
      // Yield after screen draws so browser can render intermediate frames (Win32 only —
      // DOS games do rapid VGA writes and yielding on each one kills throughput)
      if (!emu.isDOS && emu.screenDirty) { emu.screenDirty = false; break; }
    }

    // DOS timer interrupt (INT 08h) — frequency derived from PIT channel 0
    if (emu.isDOS) {
      const now = performance.now();
      const pitReload = emu._pitCounters[0] || 0x10000;
      const timerIntervalMs = (pitReload / 1193182) * 1000; // PIT frequency → ms
      if (now - emu._dosLastTimerTick >= timerIntervalMs) {
        emu._dosLastTimerTick = now;
        if (!emu._pendingHwInts.includes(0x08)) emu._pendingHwInts.push(0x08);
        emu._dosHalted = false; // wake from HLT
      }
    }

    // Deliver queued scancodes one at a time, with a delay between each
    // to avoid overwriting port 0x60 before the previous INT 09h completes
    if (
      emu._pendingHwInts.length === 0 &&
      emu._pendingHwKeys.length > 0 &&
      emu._int09ReturnCS < 0
    ) {
      const code = emu._pendingHwKeys[0];
      const delay = 0;
      emu._hwKeyDelay++;
      if (emu._hwKeyDelay >= delay) {
        const code = emu._pendingHwKeys.shift()!;
        emu._currentHwKeyChar = emu._pendingHwKeyChars.get(code);
        emu._pendingHwKeyChars.delete(code);
        emu._ioPorts.set(0x60, code);
        emu._ioPorts.set(0x64, (emu._ioPorts.get(0x64) ?? 0) | 0x01);
        emu._kbdReplayPending = false;
        emu._kbdDataReadsLeft = 0;
        // Pre-update BDA shift flags for modifier keys so programs that hook
        // INT 09h without chaining to BIOS still see correct modifier state
        const BDA_SHIFT = 0x417;
        const flags = emu.memory.readU8(BDA_SHIFT);
        if (code === 0x2A) emu.memory.writeU8(BDA_SHIFT, flags | 0x02);       // LShift make
        else if (code === 0x36) emu.memory.writeU8(BDA_SHIFT, flags | 0x01);  // RShift make
        else if (code === 0x1D) emu.memory.writeU8(BDA_SHIFT, flags | 0x04);  // Ctrl make
        else if (code === 0x38) emu.memory.writeU8(BDA_SHIFT, flags | 0x08);  // Alt make
        else if (code === 0xAA) emu.memory.writeU8(BDA_SHIFT, flags & ~0x02); // LShift break
        else if (code === 0xB6) emu.memory.writeU8(BDA_SHIFT, flags & ~0x01); // RShift break
        else if (code === 0x9D) emu.memory.writeU8(BDA_SHIFT, flags & ~0x04); // Ctrl break
        else if (code === 0xB8) emu.memory.writeU8(BDA_SHIFT, flags & ~0x08); // Alt break
        emu._pendingHwInts.push(0x09);
        if (emu.isDOS && dosYieldAfterKeyAt < 0 && code !== 0xE0) {
          // Hardware key delivered this tick: give DOS app a short execution window
          // to finish drawing, then yield/sync so the frame is observable.
          dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
        }
        emu._hwKeyDelay = 0;
      }
    } else if (emu._pendingHwInts.length === 0) {
      emu._hwKeyDelay = 0;
    }
    if (emu._pendingHwInts.length > 0) {
      const intNum = emu._pendingHwInts.shift()!;
      const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
      let vec = emu._dosIntVectors.get(intNum);
      // Also check the actual IVT in memory — programs may write vectors
      // directly without using INT 21h AH=25h
      if (!vec || vec === biosDefault) {
        const ivtOff = emu.memory.readU16(intNum * 4);
        const ivtSeg = emu.memory.readU16(intNum * 4 + 2);
        const ivtVec = (ivtSeg << 16) | ivtOff;
        if (ivtVec !== biosDefault && ivtSeg !== 0xF000) vec = ivtVec;
      }
      if (vec && vec !== biosDefault) {
        // Custom handler installed — dispatch via INT (push flags/CS/IP, jump)
        const seg = (vec >>> 16) & 0xFFFF;
        const off = vec & 0xFFFF;
        emu._ioPorts.set(0x64, (emu._ioPorts.get(0x64) ?? 0) | 0x01);
        const returnIP = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;
        // On real hardware, interrupts only fire when IF=1, so pushed FLAGS
        // always have IF=1. We deliver regardless of IF, so force IF=1 in
        // the saved FLAGS so IRET restores an interrupt-enabled context.
        emu.cpu.push16((emu.cpu.getFlags() | 0x0200) & 0xFFFF);
        emu.cpu.push16(emu.cpu.cs);
        emu.cpu.push16(returnIP);
        // Hardware interrupt entry clears IF+TF until IRET restores FLAGS.
        emu.cpu.setFlags(emu.cpu.getFlags() & ~0x0300);
        if (intNum === 0x09) {
          emu._int09ReturnCS = emu.cpu.cs;
          emu._int09ReturnIP = returnIP;
        }
        emu.cpu.cs = seg;
        emu.cpu.eip = emu.cpu.segBase(seg) + off;
      } else {
        // No custom handler — call built-in BIOS handler directly
        handleDosInt(emu.cpu, intNum, emu);
        if (intNum === 0x09) {
          emu._kbdReplayPending = false;
          emu._kbdDataReadsLeft = 0;
        }
      }
    }

    stepCount++;

    const eip = emu.cpu.eip >>> 0;

    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      stepCount += 999; // thunks represent significant work (~1000 real instructions)
      emu._lastThunkTick = emu._tickCount;
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;

      const origESP = emu.cpu.reg[4] + thunk.stackBytes + 4;

      if (handler) {
        if (key === 'SYSTEM:WNDPROC_RETURN') {
          // Check if this is a legitimate WNDPROC_RETURN or a stale value on the stack.
          const frame = emu._wndProcFrames.length > 0 ? emu._wndProcFrames.shift() : undefined;
          if (!frame && emu.wndProcDepth <= 0) {
            // Stale WNDPROC_RETURN_THUNK on stack — treat as a no-op function.
            // The RET instruction already popped this address. Read next value from
            // the stack as the real return address and continue.
            const realRetAddr = emu.memory.readU32(emu.cpu.reg[4] >>> 0);
            emu.cpu.reg[4] = (emu.cpu.reg[4] + 4) | 0;
            emu.cpu.eip = realRetAddr;
            continue;
          }
          handler(emu);
          // Pop saved frame, restore callee-saved registers, complete outer thunk
          if (frame) {
            emu.cpu.reg[3] = frame.savedEBX;
            emu.cpu.reg[5] = frame.savedEBP;
            emu.cpu.reg[6] = frame.savedESI;
            emu.cpu.reg[7] = frame.savedEDI;
            if (frame.savedDS !== undefined) emu.cpu.ds = frame.savedDS;
            // Complete the outer thunk (e.g. DispatchMessage) that triggered this wndproc
            frame.outerCompleter(emu, emu.wndProcResult, frame.outerStackBytes);
          }
          // Continue executing — don't break
          continue;
        } else {
          emu._currentThunkStackBytes = thunk.stackBytes;
          const retVal = handler(emu);
          // If handler called callWndProc (which sets up stack and returns Promise),
          // store outer thunk info in the frame and continue executing the wndproc code.
          if (emu._wndProcSetupPending) {
            emu._wndProcSetupPending = false;
            const frame = emu._wndProcFrames[emu._wndProcFrames.length - 1];
            frame.outerStackBytes = thunk.stackBytes;
            frame.outerCompleter = emu.isNE ? emuCompleteThunk16 : emuCompleteThunk;
            continue;
          }
          // Handler returned undefined — skip thunk completion (handler adjusted EIP/ESP or set waitingForMessage)
          if (retVal === undefined) break;
          if (emu.halted || emu.waitingForMessage || emu._dosHalted) break;
          if (emu.isNE) {
            emuCompleteThunk16(emu, retVal as number, thunk.stackBytes);
          } else {
            emuCompleteThunk(emu, retVal as number, thunk.stackBytes);
          }
        }
      } else {
        emu.haltReason = `Unimplemented API: ${thunk.dll}:${thunk.displayName || thunk.name}`;
        emu.halted = true;
        break;
      }
      continue;
    }

    const prevEip = eip;
    emu.cpu.step();
    emu._pitInsnCount++;
    if (emu.isDOS) {
      const curDosKeyBufferLen = emu.dosKeyBuffer.length;
      if (dosYieldAfterKeyAt < 0 && curDosKeyBufferLen < prevDosKeyBufferLen) {
        // Key was consumed this tick (direct INT 16h/INT 21h path): keep running
        // briefly so app can finish rendering before we sync/yield.
        dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
      }
      prevDosKeyBufferLen = curDosKeyBufferLen;
      const curBdaKeyHead = emu.memory.readU16(0x41A);
      if (dosYieldAfterKeyAt < 0 && curBdaKeyHead !== prevBdaKeyHead) {
        // Some programs consume keys from BDA ring buffer directly.
        dosYieldAfterKeyAt = i + DOS_POST_KEY_STEPS;
      }
      prevBdaKeyHead = curBdaKeyHead;
    }
    if (emu.cpu.halted) {
      const hBytes: string[] = [];
      for (let j = 0; j < 8; j++) hBytes.push(emu.memory.readU8((prevEip + j) >>> 0).toString(16).padStart(2, '0'));
      console.warn(`[CPU-HALT] at EIP=0x${prevEip.toString(16)} bytes: ${hBytes.join(' ')} ESP=0x${(emu.cpu.reg[4]>>>0).toString(16)}`);
      emu.haltReason = emu.cpu.haltReason || 'illegal instruction';
      emu.halted = true;
      break;
    }
    // Detect wild EIP
    const newEip = emu.cpu.eip >>> 0;
    if (newEip !== 0 && !emu.thunkToApi.has(newEip)) {
      let inImage = false;
      if (emu.isNE && emu.ne) {
        for (const seg of emu.ne.segments) {
          if (newEip >= seg.linearBase && newEip < seg.linearBase + 0x10000) {
            inImage = true;
            break;
          }
        }
        if (!inImage && newEip >= emu.heapBase && newEip < emu.virtualPtr + 0x100000) {
          inImage = true;
        }
      } else if (emu.isDOS) {
        // DOS mode: any address in conventional memory (0-0xFFFFF) or heap is valid
        inImage = newEip < 0x100000 || (newEip >= emu.heapBase && newEip < emu.virtualPtr + 0x100000);
      } else {
        inImage = emu.pe && newEip >= emu.pe.imageBase && newEip < emu.pe.imageBase + emu.pe.sizeOfImage;
        if (!inImage) {
          for (const mod of emu.loadedModules.values()) {
            if (mod.sizeOfImage && newEip >= mod.imageBase && newEip < mod.imageBase + mod.sizeOfImage) {
              inImage = true;
              break;
            }
          }
        }
      }
      if (!inImage) {
        const before: string[] = [];
        for (let j = -16; j < 0; j++) before.push(emu.memory.readU8((prevEip + j) >>> 0).toString(16).padStart(2, '0'));
        const at: string[] = [];
        for (let j = 0; j < 16; j++) at.push(emu.memory.readU8((prevEip + j) >>> 0).toString(16).padStart(2, '0'));
        const bt: string[] = [];
        let bp = emu.cpu.reg[5] >>> 0;
        for (let f = 0; f < 10 && bp > 0x10000 && bp < 0xFFF00000; f++) {
          const retAddr = emu.memory.readU32((bp + 4) >>> 0);
          const prevBp = emu.memory.readU32(bp >>> 0);
          bt.push(`  [${f}] EBP=0x${bp.toString(16)} ret=0x${retAddr.toString(16)}`);
          bp = prevBp;
        }
        console.error(
          `[WILD EIP] jumped to 0x${newEip.toString(16)} from 0x${prevEip.toString(16)}\n` +
          `  bytes before: [${before.join(' ')}]\n` +
          `  bytes at:     [${at.join(' ')}]\n` +
          `  EAX=0x${(emu.cpu.reg[0] >>> 0).toString(16)} ECX=0x${(emu.cpu.reg[1] >>> 0).toString(16)} EDX=0x${(emu.cpu.reg[2] >>> 0).toString(16)} EBX=0x${(emu.cpu.reg[3] >>> 0).toString(16)}\n` +
          `  ESP=0x${(emu.cpu.reg[4] >>> 0).toString(16)} EBP=0x${(emu.cpu.reg[5] >>> 0).toString(16)} ESI=0x${(emu.cpu.reg[6] >>> 0).toString(16)} EDI=0x${(emu.cpu.reg[7] >>> 0).toString(16)}\n` +
          `  stack top 12 dwords:\n` +
          `    ${[0,4,8,12,16,20,24,28,32,36,40,44].map(o => '0x' + emu.memory.readU32((emu.cpu.reg[4] + o) >>> 0).toString(16)).join(' ')}\n` +
          `  EBP backtrace:\n${bt.join('\n')}`
        );
        emu.haltReason = 'access violation';
        emu.halted = true;
        // WILD EIP detected
        break;
      }
    }
  }
  emu.cpuSteps += stepCount;
  } catch (err) {
    console.error(`[EMU] tick() error at EIP=0x${(emu.cpu.eip >>> 0).toString(16)}:`, err);
    emu.haltReason = 'internal emulator error';
    emu.halted = true;
  }

  // Sync video memory for DOS mode (picks up direct B800:0000 writes)
  if (emu.isDOS) {
    if (emu.isGraphicsMode) {
      syncGraphics(emu);
    } else {
      syncVideoMemory(emu);
    }
  }

  if (emu.running && !emu.halted && !emu.waitingForMessage) {
    emu._tickCount++;
    if (emu._dosHalted) {
      // HLT: sleep until next timer tick instead of busy-spinning
      const pitReload = emu._pitCounters[0] || 0x10000;
      const timerIntervalMs = (pitReload / 1193182) * 1000;
      const elapsed = performance.now() - emu._dosLastTimerTick;
      const delay = Math.max(1, timerIntervalMs - elapsed);
      setTimeout(emu.tick, delay);
    } else if (emu.isDOS) {
      // DOS games need maximum throughput — setTimeout(0) yields to browser
      // for rendering/input but resumes much faster than requestAnimationFrame (~16ms)
      setTimeout(emu.tick, 0);
    } else {
      requestAnimationFrame(emu.tick);
    }
  } else if (emu.waitingForMessage) {
    // Idle — waiting for input or message
  } else if (emu.halted) {
    if (emu.exitedNormally) {
      emu.onExit?.();
    } else if (!emu._crashFired) {
      emu._crashFired = true;
      const eip = '0x' + (emu.cpu.eip >>> 0).toString(16).padStart(8, '0');
      emu.onCrash?.(eip, emu.haltReason || 'unknown error');
    }
  }
}
