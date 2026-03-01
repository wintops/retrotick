import type { Emulator } from '../../emulator';
import type { Win16Module } from '../../emulator';
import { registerKernelMemory } from './memory';
import { registerKernelFile } from './file';
import { registerKernelModule } from './module';
import { registerKernelTask } from './task';
import { registerKernelString } from './string';
import { registerKernelAtom } from './atom';
import { registerKernelResource } from './resource';
import { registerKernelProfile } from './profile';
import { registerKernelDos } from './dos';
import { registerKernelError } from './error';
import { registerKernelRegistry } from './registry';
import { registerKernelMisc } from './misc';

/** Shared state across all KERNEL sub-modules */
export interface KernelState {
  nextGlobalSelector: number;
  globalHandleToAddr: Map<number, number>;
  globalHandleToSize: Map<number, number>;
  globalHandleFlags: Map<number, number>;
  globalLockCount: Map<number, number>;
  localSizes: Map<number, number>;
  localLockCounts: Map<number, number>;
  atomTable: Map<number, string>;
  nextAtom: number;
  moduleHandles: Map<string, number>;
  nextModuleHandle: number;
  savedStack: { ss: number; sp: number } | null;
  lastError: number;
}

export function registerWin16Kernel(emu: Emulator): void {
  const kernel = emu.registerModule16('KERNEL');

  const state: KernelState = {
    nextGlobalSelector: 0x100,
    globalHandleToAddr: new Map(),
    globalHandleToSize: new Map(),
    globalHandleFlags: new Map(),
    globalLockCount: new Map(),
    localSizes: new Map(),
    localLockCounts: new Map(),
    atomTable: new Map(),
    nextAtom: 0xC000,
    moduleHandles: new Map(),
    nextModuleHandle: 2,
    savedStack: null,
    lastError: 0,
  };

  registerKernelMemory(kernel, emu, state);
  registerKernelFile(kernel, emu, state);
  registerKernelModule(kernel, emu, state);
  registerKernelTask(kernel, emu, state);
  registerKernelString(kernel, emu, state);
  registerKernelAtom(kernel, emu, state);
  registerKernelResource(kernel, emu, state);
  registerKernelProfile(kernel, emu, state);
  registerKernelDos(kernel, emu, state);
  registerKernelError(kernel, emu, state);
  registerKernelRegistry(kernel, emu, state);
  registerKernelMisc(kernel, emu, state);
}
