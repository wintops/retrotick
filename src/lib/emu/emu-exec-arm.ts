import type { Emulator } from './emulator';
import { ArmCPU, SP, LR, PC, R0 } from './arm/cpu';

const BATCH_SIZE = 50000;

/** Complete an ARM thunk: set return value in R0, branch to LR */
export function emuCompleteThunkARM(emu: Emulator, retVal: number): void {
  const cpu = emu.armCpu!;
  cpu.reg[R0] = retVal | 0;
  // Return to caller via LR (ARM calling convention)
  cpu.reg[PC] = cpu.reg[LR];
}

/** ARM-mode tick: execute instructions until time budget or waiting */
export function emuTickARM(emu: Emulator): void {
  if (!emu.running || emu.halted) return;
  if (emu._tickRunning) return;
  emu._tickRunning = true;

  // Thunk trace ring buffer for crash debugging
  const TRACE_SIZE = 16;
  const thunkTrace: string[] = [];

  try {
    const cpu = emu.armCpu!;
    const tickStart = performance.now();

    for (let i = 0; i < BATCH_SIZE; i++) {
      if (emu.halted || emu.waitingForMessage) break;
      if ((i & 0xFFF) === 0 && i > 0) {
        if (performance.now() - tickStart > 50) break;
        // Yield after screen draws so browser can render intermediate frames
        if (emu.screenDirty) { emu.screenDirty = false; break; }
      }

      const eip = cpu.reg[PC] >>> 0;

      // Check if we hit a thunk address
      const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
      if (thunk) {
        const key = `${thunk.dll}:${thunk.name}`;
        const handler = emu.apiDefs.get(key)?.handler;
        if (handler) {
          if (emu.traceApi) console.log(`[API] ${key}`);
          thunkTrace.push(`${key} R0=0x${(cpu.reg[0]>>>0).toString(16)} LR=0x${(cpu.reg[LR]>>>0).toString(16)}`);
          if (thunkTrace.length > TRACE_SIZE) thunkTrace.shift();
          const retVal = handler(emu);
          if (emu.halted || emu.waitingForMessage) break;
          if (retVal !== undefined) {
            emuCompleteThunkARM(emu, retVal);
          }
        } else {
          console.warn(`Unimplemented API: ${key}`);
          emuCompleteThunkARM(emu, 0);
        }
      } else {
        if (cpu.halted) {
          emu.halted = true;
          emu.haltReason = cpu.haltReason;
          console.log('[ARM] THUNK TRACE (last API calls before crash):');
          for (const t of thunkTrace) console.log(`  ${t}`);
          break;
        }
        // PC=0: WinMain returned — treat as ExitProcess
        if (eip === 0) {
          emu.halted = true;
          emu.haltReason = 'WinMain returned (ExitProcess)';
          break;
        }
        // Wild PC detection: if PC leaves valid code range, halt
        if (emu.pe && (eip < emu.pe.imageBase || eip >= emu.pe.imageBase + emu.pe.sizeOfImage) && eip !== 0x00FE0000) {
          emu.halted = true;
          emu.haltReason = `[WILD EIP] PC=0x${eip.toString(16)} LR=0x${(cpu.reg[LR]>>>0).toString(16)} SP=0x${(cpu.reg[SP]>>>0).toString(16)} R11=0x${(cpu.reg[11]>>>0).toString(16)}`;
          console.log('[ARM] THUNK TRACE (last API calls before wild PC):');
          for (const t of thunkTrace) console.log(`  ${t}`);
          break;
        }
        cpu.step();
      }
    }
  } finally {
    emu._tickRunning = false;
  }

  // Schedule next tick if still running
  if (emu.running && !emu.halted && !emu.waitingForMessage) {
    requestAnimationFrame(emu.tick);
  }
}

/** Call an ARM WndProc: addr(hwnd, msg, wParam, lParam) */
export function emuCallWndProcARM(emu: Emulator, wndProc: number, hwnd: number, message: number, wParam: number, lParam: number): number | undefined {
  const cpu = emu.armCpu!;
  // ARM calling convention: args in R0-R3
  cpu.reg[0] = hwnd;
  cpu.reg[1] = message;
  cpu.reg[2] = wParam;
  cpu.reg[3] = lParam;

  // Save state
  const savedLR = cpu.reg[LR];
  const savedPC = cpu.reg[PC];
  const savedR4 = cpu.reg[4];
  const savedR5 = cpu.reg[5];
  const savedR6 = cpu.reg[6];
  const savedR7 = cpu.reg[7];
  const savedR8 = cpu.reg[8];
  const savedR9 = cpu.reg[9];
  const savedR10 = cpu.reg[10];
  const savedR11 = cpu.reg[11];

  // Set LR to a thunk address so we know when to return
  const WNDPROC_RETURN_THUNK = 0x00FE0000;
  cpu.reg[LR] = WNDPROC_RETURN_THUNK;
  cpu.reg[PC] = wndProc;

  emu.wndProcDepth++;

  // Run until we return to the thunk or halt
  let steps = 0;
  const targetDepth = emu.wndProcDepth - 1;
  while (!emu.halted && !cpu.halted && !emu.waitingForMessage) {
    const eip = cpu.reg[PC] >>> 0;

    if (eip === WNDPROC_RETURN_THUNK) {
      emu.wndProcDepth--;
      break;
    }

    const thunk = emu.thunkPages.has(eip >>> 12) ? emu.thunkToApi.get(eip) : undefined;
    if (thunk) {
      const key = `${thunk.dll}:${thunk.name}`;
      const handler = emu.apiDefs.get(key)?.handler;
      if (handler) {
        if (emu.traceApi) console.log(`[API] ${key}`);
        const retVal = handler(emu);
        if (emu.halted || emu.waitingForMessage) break;
        if (retVal !== undefined) {
          emuCompleteThunkARM(emu, retVal);
        }
      } else {
        console.warn(`Unimplemented API: ${key}`);
        emuCompleteThunkARM(emu, 0);
      }
    } else {
      // Wild PC check
      if (emu.pe && (eip < emu.pe.imageBase || eip >= emu.pe.imageBase + emu.pe.sizeOfImage) && eip !== WNDPROC_RETURN_THUNK) {
        emu.halted = true;
        emu.haltReason = `[WILD EIP in WndProc] PC=0x${eip.toString(16)} LR=0x${(cpu.reg[LR]>>>0).toString(16)} SP=0x${(cpu.reg[SP]>>>0).toString(16)}`;
        break;
      }
      cpu.step();
    }
    steps++;
    if (steps > 500000) {
      emu.halted = true;
      emu.haltReason = `ARM WndProc infinite loop at 0x${(cpu.reg[PC] >>> 0).toString(16)}`;
      break;
    }
  }

  // Restore callee-saved registers AND LR (which was clobbered by BL instructions inside the wndProc)
  cpu.reg[4] = savedR4;
  cpu.reg[5] = savedR5;
  cpu.reg[6] = savedR6;
  cpu.reg[7] = savedR7;
  cpu.reg[8] = savedR8;
  cpu.reg[9] = savedR9;
  cpu.reg[10] = savedR10;
  cpu.reg[11] = savedR11;
  cpu.reg[LR] = savedLR;

  return cpu.reg[R0];
}
