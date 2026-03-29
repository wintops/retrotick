# WASM JIT Block Chaining Debug Notes

## The Problem

Block chaining (executing multiple basic blocks within one WASM invocation via br_table dispatch) causes **rare visual artifacts** (black dots that appear/disappear) in prh.exe. Without chaining (bail-all terminators), the JIT is clean but provides 0% speedup. With chaining, the potential is ~2x speedup on CPU-bound DOS programs.

## What We Tested

### Jcc evaluation methods
| Method | Result |
|--------|--------|
| Bail-all (no Jcc eval) | **Clean** — no artifacts |
| testCC import + if/else branch + block chain | **Crash** (EIP=0x1469e, garbage code) |
| testCC import + if/else branch + EXIT (no chain) | **Black dots** (many, growing) |
| testCC import + select (no if/else) + EXIT | **Clean** — no artifacts |
| testCC import + select + block chain | **Crash** (same EIP, missing EIP store) |
| testCC import + select + block chain + EIP store | **Black dots** (random, different pattern) |
| Inline ZF test (lazyResult == 0) + EXIT | **Black dots** (wrong mask for 8-bit) |
| Inline ZF with operand-size mask + EXIT | **Black dots** (persisted) |
| testCC call + drop (ignore result) + bail | **Clean** — testCC has no side effect |

### Block chaining without Jcc
| Method | Result |
|--------|--------|
| JMP + fallthrough inline (no Jcc) | **Rare black dots** (very few, fleeting) |
| JMP + fallthrough + writeVGA without if/else | **Still rare dots** (maybe fewer) |
| JIT completely disabled | **Clean** — no dots at all |

## Key Findings

1. **testCC import is correct** — calling it and ignoring the result causes no artifacts
2. **The select-based Jcc eval + EXIT is correct** — no artifacts without chaining
3. **if/else in WASM causes issues** — replaced with select everywhere (stores, Jcc)
4. **Missing EIP store on counter-limit exit** was a crash bug — fixed by storing EIP in every inline terminator
5. **Flag masking (lazyA/lazyB to operand size)** — fixed but didn't resolve the dots
6. **Even JMP/fallthrough-only chaining causes rare dots** — the bug is NOT in Jcc evaluation

## Root Cause Hypothesis

The bug is in the **block body instructions themselves** when executed consecutively. A single block body is correct (bail-all works). But when block A chains to block B, some subtle state difference accumulates:

- Registers carry over as WASM locals (not synced to flat memory between blocks)
- If any instruction produces a very slightly wrong result (e.g., wrong high bits in a 16-bit register), the next block uses that wrong value
- The error is small enough that individual blocks appear correct, but over many chained iterations it produces visible pixel errors

## Remaining Pistes

### 1. Dual-execution validation
Run each instruction in BOTH WASM and interpreter, compare results. This would pinpoint the exact instruction that diverges. Implementation: add a `validateInsn(addr)` import called after each instruction in WASM, which runs the same instruction through `cpu.step()` and compares registers.

### 2. Register sync between blocks
As a workaround: after each block body (before the terminator), store all 8 registers to flat memory AND read them back. This forces a "reset" of WASM locals from the flat buffer. If dots disappear, the bug is in register accumulation. If dots persist, it's in memory writes.

### 3. Reduce to minimal repro
Write a unit test with a specific x86 loop (e.g., the pixel copy loop from prh.exe) that chains 2 blocks. Run it many times and compare the output with the interpreter. This would be the fastest path to finding the bug.

### 4. Check `emitStoreU8WithVGA` (writeVGA import)
The writeVGA import calls `memory.writeU8(addr, val)`. In flat mode, this writes to `_flat[addr]`. But `memory.writeU8` also applies the A20 mask: `addr = (addr & this.a20Mask) >>> 0`. The WASM direct stores (for non-VGA addresses) do NOT apply A20. If a20Mask != 0xFFFFFFFF, direct stores and import stores write to different addresses.

### 5. Check if the bug is in the `emitStoreU8WithVGA` simplification
We replaced if/else VGA check with always calling writeVGA import. For non-VGA addresses, this adds import call overhead. But it also routes ALL stores through `memory.writeU8` which applies A20 mask. The direct `storeU8` in the else branch didn't apply A20. If this causes different behavior for certain addresses, that could be the dots.

### 6. Investigate WASM `if/else` label depth
The if/else bug was confirmed: Jcc with if/else crashes, Jcc with select works. But we never found the ROOT CAUSE in the WasmBuilder's label management. The `ifVoid()`/`elseBlock()`/`end()` implementation should be audited:
- Does `elseBlock()` correctly maintain the label stack?
- Does `br(exitLabel)` inside an if-block compute the correct depth?

## Current State (as of commit 02d2485)

- `wasmJitEnabled = false` by default (toggle on Emulator)
- Bail-all terminators (clean, 0 artifacts, 0 speedup)
- 50+ x86 opcodes compiled, 16-bit memory, segment overrides
- Flag masking (lazyA/lazyB masked to operand size)
- VGA stores via writeVGA import (no if/else)
- 111+ unit tests passing
- Second Reality: stable, frame-locked at ~23s (VGA_REFRESH_HZ=70)
- prh.exe: stable, CPU-bound at ~2min (no speedup without chaining)
