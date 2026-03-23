/**
 * WASM JIT module assembly — ties together analyzer, codegen, and builder
 * to produce compilable WASM modules from hot x86 code regions.
 */

import { WasmBuilder } from './wasm-builder';
import { FlatMemory, OFF_REGS, OFF_FLAGS, OFF_EIP, OFF_EXIT, OFF_ENTRY } from './flat-memory';
import { analyzeRegion, type WasmBasicBlock } from './wasm-analyzer';
import { emitInstruction, initCodegenLocals, type CodegenCtx } from './wasm-codegen';
import { emitFusedJcc } from './wasm-codegen-flags';
import type { Memory } from '../memory';
import type { Label } from './wasm-builder';

const TYPE_I32 = 0x7F;
const MAX_INSN_PER_ENTRY = 8192;

/** A compiled WASM region ready for execution */
export interface WasmCompiledRegion {
  run: () => number;
  entryMap: Map<number, number>;  // EIP → br_table state index
  blockCount: number;
  segKeys: number[];
}

/** WASM import functions provided by the emulator */
export interface WasmImports {
  writeVGA: (addr: number, val: number) => void;
  testCC: (cc: number) => number;
  portIn: (port: number) => number;
  portOut: (port: number, val: number) => void;
}

/** Compile a hot code region to a WASM module. Returns null if compilation fails. */
export async function compileWasmRegion(
  mem: Memory, startAddr: number, use32: boolean, flatMem: FlatMemory,
  wasmImports?: WasmImports,
): Promise<WasmCompiledRegion | null> {
  // Step 1: Analyze region — discover basic blocks
  const blocks = analyzeRegion(mem, startAddr, use32);
  if (blocks.size === 0) return null;

  // Step 2: Assign br_table state indices
  const blockAddrs = [...blocks.keys()].sort((a, b) => a - b);
  const addrToState = new Map<number, number>();
  for (let i = 0; i < blockAddrs.length; i++) {
    addrToState.set(blockAddrs[i], i);
  }

  // Step 3: Build WASM module
  const b = new WasmBuilder();

  // Imports
  b.addMemoryImport('e', 'mem', 1);
  const writeVGAIdx = b.addFuncImport('e', 'writeVGA', [TYPE_I32, TYPE_I32], []);
  const testCCIdx = b.addFuncImport('e', 'testCC', [TYPE_I32], [TYPE_I32]);
  const portInIdx = b.addFuncImport('e', 'portIn', [TYPE_I32], [TYPE_I32]);
  const portOutIdx = b.addFuncImport('e', 'portOut', [TYPE_I32, TYPE_I32], []);

  // Function: run() -> i32 (returns nextEIP). Entry state read from memory.
  b.setParams(0);
  b.setResults([TYPE_I32]);

  // Allocate locals: 0-7 = EAX-EDI (register cache), 8+ = control & temps
  for (let i = 0; i < 8; i++) b.allocLocal(); // locals 0-7 = registers
  const stateLocal = b.allocLocal();  // 8
  const counterLocal = b.allocLocal(); // 9
  const tmp1 = b.allocLocal(); // 10
  const tmp2 = b.allocLocal(); // 11
  const tmp3 = b.allocLocal(); // 12

  // Initialize codegen local indices
  initCodegenLocals(tmp1, tmp2, tmp3, stateLocal, counterLocal);

  // Load registers from shared memory into locals 0-7
  for (let i = 0; i < 8; i++) {
    b.constI32(0);
    b.loadI32(OFF_REGS + i * 4);
    b.setLocal(i);
  }

  // Read entry state from shared memory
  b.constI32(0); b.loadI32(OFF_ENTRY); b.setLocal(stateLocal);

  // Initialize counter
  b.constI32(0); b.setLocal(counterLocal);

  // Main dispatch loop
  const exitLabel = b.blockVoid();
  const dispatchLabel = b.loopVoid();

  // Check instruction limit
  b.getLocal(counterLocal);
  b.constI32(MAX_INSN_PER_ENTRY);
  b.geUI32();
  b.brIf(exitLabel);

  // Build br_table: one block label per basic block + default exit
  const bbLabels: Label[] = [];
  // We need nested blocks for br_table targets
  // br_table target 0 → innermost block, target N → outermost
  // So we create blocks in reverse order
  const defaultLabel = b.blockVoid(); // default case = exit
  for (let i = blockAddrs.length - 1; i >= 0; i--) {
    bbLabels[i] = b.blockVoid();
  }

  // Emit br_table dispatch
  b.getLocal(stateLocal);
  b.brTable(bbLabels, defaultLabel);

  // Emit each basic block's code
  for (let i = 0; i < blockAddrs.length; i++) {
    b.end(); // close this block's label

    const block = blocks.get(blockAddrs[i])!;

    // Create codegen context
    const ctx: CodegenCtx = {
      b, mem, use32, is16: !use32, addrSize16: !use32,
      writeVGAIdx, testCCIdx, portInIdx, portOutIdx,
      tmp1, tmp2, tmp3,
    };

    // Emit instructions for this block (excluding the terminator)
    let instrAddr = block.addr;
    let emittedAll = true;
    while (instrAddr < block.endAddr) {
      // Check if this is the last instruction (terminator)
      // Terminators (Jcc, JMP, RET) are handled specially below
      const nextInsnResult = emitInstruction(ctx, instrAddr);
      if (nextInsnResult < 0) {
        // Unsupported opcode — store EIP and exit
        emittedAll = false;
        // Store current EIP
        b.constI32(0); b.constI32(instrAddr); b.storeI32(OFF_EIP);
        b.constI32(0); b.constI32(2); b.storeI32(OFF_EXIT); // exit_reason = unsupported
        b.br(exitLabel);
        break;
      }
      instrAddr += nextInsnResult;
    }

    if (emittedAll) {
      // Handle block terminator (control flow)
      emitBlockTerminator(b, block, addrToState, stateLocal, dispatchLabel, exitLabel, use32, testCCIdx);
    }
  }

  // Default case: unknown state → exit
  b.end(); // close default block
  // Store EIP for unknown state
  b.constI32(0); b.constI32(startAddr); b.storeI32(OFF_EIP);
  b.constI32(0); b.constI32(1); b.storeI32(OFF_EXIT); // exit_reason = unknown

  b.end(); // close loop
  b.end(); // close exit block

  // Store registers back to shared memory
  for (let i = 0; i < 8; i++) {
    b.constI32(0);
    b.getLocal(i);
    b.storeI32(OFF_REGS + i * 4);
  }

  // Store lazy flags back
  // (flags are already stored by codegen inline — just store flagsValid=false as safety)

  // Return EIP
  b.constI32(0);
  b.loadI32(OFF_EIP);

  // Step 4: Finalize and compile
  let wasmBytes: Uint8Array;
  try {
    wasmBytes = b.finish();
  } catch {
    return null;
  }

  // Step 5: Async WASM compilation
  try {
    const wi = wasmImports || { writeVGA: () => {}, testCC: () => 0, portIn: () => 0xFF, portOut: () => {} };
    const imports = {
      e: {
        mem: flatMem.wasmMemory,
        writeVGA: wi.writeVGA,
        testCC: wi.testCC,
        portIn: wi.portIn,
        portOut: wi.portOut,
      }
    };
    const result = await WebAssembly.instantiate(wasmBytes, imports);
    const run = result.instance.exports.run as () => number;

    // Collect segment keys for invalidation
    const segKeys = new Set<number>();
    for (const addr of blockAddrs) {
      segKeys.add(addr >>> 16);
      const block = blocks.get(addr)!;
      segKeys.add((block.endAddr - 1) >>> 16);
    }

    return {
      run,
      entryMap: addrToState,
      blockCount: blocks.size,
      segKeys: [...segKeys],
    };
  } catch {
    return null;
  }
}

/** Emit control flow for block terminator (Jcc, JMP, RET, etc.) */
function emitBlockTerminator(
  b: WasmBuilder, block: WasmBasicBlock,
  addrToState: Map<number, number>,
  stateLocal: number, dispatchLabel: Label, exitLabel: Label,
  use32: boolean, testCCIdx: number,
): void {
  switch (block.exitType) {
    case 'jcc': {
      const takenState = addrToState.get(block.branchTarget);
      const fallState = addrToState.get(block.fallthrough);
      const cc = block.conditionCode;

      if (takenState !== undefined && cc >= 0) {
        // Call imported testCC(cc) — it materializes flags and evaluates the condition
        b.constI32(cc);
        b.call(testCCIdx);
        // testCC returns 1 if condition is true, 0 if false
        b.ifVoid();
          b.constI32(takenState); b.setLocal(stateLocal); b.br(dispatchLabel);
        b.end();
      }

      if (fallState !== undefined) {
        b.constI32(fallState); b.setLocal(stateLocal); b.br(dispatchLabel);
      } else {
        b.constI32(0); b.constI32(block.fallthrough); b.storeI32(OFF_EIP);
        b.br(exitLabel);
      }
      break;
    }

    case 'jmp': {
      const targetState = addrToState.get(block.branchTarget);
      if (targetState !== undefined) {
        b.constI32(targetState); b.setLocal(stateLocal); b.br(dispatchLabel);
      } else {
        b.constI32(0); b.constI32(block.branchTarget); b.storeI32(OFF_EIP);
        b.br(exitLabel);
      }
      break;
    }

    case 'ret':
      // Return: exit module. EIP is on the stack (popped by RET).
      // The RET instruction itself should have been emitted... but we don't emit RET in codegen yet.
      // For now, just exit.
      b.constI32(0); b.constI32(0); b.storeI32(OFF_EXIT);
      b.br(exitLabel);
      break;

    case 'call': {
      // CALL falls through — target may be inside or outside region
      const fallState = addrToState.get(block.fallthrough);
      if (fallState !== undefined) {
        b.constI32(fallState); b.setLocal(stateLocal); b.br(dispatchLabel);
      } else {
        b.constI32(0); b.constI32(block.fallthrough); b.storeI32(OFF_EIP);
        b.br(exitLabel);
      }
      break;
    }

    case 'fallthrough': {
      const nextState = addrToState.get(block.fallthrough);
      if (nextState !== undefined) {
        b.constI32(nextState); b.setLocal(stateLocal); b.br(dispatchLabel);
      } else {
        b.constI32(0); b.constI32(block.fallthrough); b.storeI32(OFF_EIP);
        b.br(exitLabel);
      }
      break;
    }

    case 'bail':
      b.constI32(0); b.constI32(block.endAddr); b.storeI32(OFF_EIP);
      b.constI32(0); b.constI32(2); b.storeI32(OFF_EXIT);
      b.br(exitLabel);
      break;
  }
}
