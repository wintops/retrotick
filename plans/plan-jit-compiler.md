# JIT Compiler Plan for RetroTick

## 1. Architecture Overview

### Why JavaScript `new Function()` instead of WebAssembly

v86 generates WebAssembly modules because its entire CPU state and memory live in a single WASM linear buffer. RetroTick cannot replicate this because:
- CPU state is in JavaScript objects (`CPU` class with `reg: Int32Array`, lazy flags, `Map<>` for segment bases)
- Memory uses sparse `Map<number, Uint8Array>` of 64KB segments with VGA hooks
- Refactoring to flat WASM memory would change the entire emulator architecture

Instead, generate **optimized JavaScript functions** via `new Function()`. These can directly reference closures over `cpu.reg`, `cpu.mem`, and all CPU methods. V8/SpiderMonkey JIT-compile the generated JS to native code.

Note: `new Function()` is used here intentionally for JIT compilation of x86 machine code into JavaScript. The generated code is deterministic (derived from the emulated program's machine code, not from user input), so there is no code injection risk. This is the same approach used by other browser-based emulators.

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────┐
│ emuTick() loop                                           │
│   ├─ thunk check (API dispatch) ── unchanged             │
│   ├─ JIT cache lookup ── NEW                             │
│   │    ├─ HIT: call compiled JS function                 │
│   │    │   function returns next EIP                     │
│   │    └─ MISS: interpret + increment hotness counter    │
│   └─ cpu.step() (interpreter fallback) ── unchanged      │
└──────────────────────────────────────────────────────────┘
```

### Expected Speedup

Per-instruction interpreter overhead: `fetch8() + prefix parse + switch dispatch + decodeModRM() + memory read + ALU + memory write + setLazy()`.

JIT eliminates: switch dispatch, prefix parsing, ModRM decoding, immediate fetching (all done at compile time). For a 10-instruction basic block, ~100 function calls eliminated.

Expected: **2-4x speedup** for compute-bound code (DOS demos, game loops).

## 2. Basic Block Detection and Caching

### Block Boundaries (end compilation at)

- **Jumps**: JMP, Jcc, CALL, RET, RETF, IRET
- **Interrupts**: INT n, INT 3, INTO
- **System**: HLT, STI (check pending interrupts after STI + 1 instruction)
- **Segment load**: MOV SS, far CALL/JMP/RET
- **Thunk addresses**: EIP enters a thunk page → exit JIT for API dispatch
- **Segment boundaries**: stop near end of 64KB segment
- **Port I/O**: IN, OUT, INS, OUTS (side effects)

### Data Structures

```typescript
// New file: src/lib/emu/x86/jit-cache.ts

interface CompiledBlock {
  fn: Function;              // The compiled JS function
  startAddr: number;         // Linear address of first instruction
  endAddr: number;           // Address after last instruction
  segKey: number;            // Memory segment key for invalidation
}

const blockCache = new Map<number, CompiledBlock>();
const hotness = new Map<number, number>();
const JIT_THRESHOLD = 50;   // Compile after 50 executions
```

### Block Chaining

After a block executes, if it ends with a direct jump to another compiled block, return the target address. The dispatcher immediately calls the next block without re-entering the interpreter.

## 3. Code Generation

### Generated Function Shape

```typescript
// JIT produces for a basic block at 0x401000:
// (r = cpu.reg, mem = cpu.mem, cpu = CPU instance)
function jit_401000(r, mem, cpu) {
  // push ebp; mov ebp, esp; sub esp, 0x10
  r[4] = (r[4] - 4) | 0; mem.writeU32(r[4] >>> 0, r[5]);
  r[5] = r[4];
  r[4] = (r[4] - 0x10) | 0;
  cpu.lazyOp = 5; cpu.lazyResult = r[4]; cpu.lazyA = r[4] + 0x10; cpu.lazyB = 0x10;
  cpu.flagsValid = false;
  return 0x401010; // next EIP
}
```

### Lazy Flags Strategy

- Instructions that SET flags: emit `cpu.lazyOp = X; cpu.lazyResult = ...; cpu.flagsValid = false;`
- Instructions that READ flags (Jcc, SETcc, ADC, SBB, PUSHF): emit `cpu.materializeFlags()` first
- **Optimization**: within a block, track if flags set but never read → skip lazy flag setup

### Instruction Compilation Phases

**Phase 1 — Core Integer** (~30 instructions, ~70% of execution):
- MOV reg/reg, reg/imm, reg/mem, mem/reg
- ADD, SUB, AND, OR, XOR, CMP, TEST
- INC, DEC
- PUSH, POP
- LEA
- CALL rel32, RET, JMP, Jcc

**Phase 2 — Extended Integer** (~20 instructions):
- SHL, SHR, SAR, ROL, ROR
- XCHG, MOVZX, MOVSX
- IMUL (2/3 operand), MUL, DIV, IDIV
- NEG, NOT, CDQ, CBW/CWDE

**Phase 3 — Memory and String** (~15 instructions):
- REP MOVSB/MOVSD, REP STOSB/STOSD
- ENTER, LEAVE

**Fallback**: Unhandled instructions end the block → interpreter handles them.

### Static Decoder

New file `src/lib/emu/x86/jit-decode.ts`:
```typescript
// Returns a JS expression string for the effective address
function jitDecodeModRM(bytes: Uint8Array, offset: number, use32: boolean):
  { expr: string; bytesConsumed: number; regField: number; isReg: boolean }
```

Runs at compile time, produces JavaScript expression strings.

## 4. Memory Model

### JIT Memory Access

Generated code calls `mem.readU32()` / `mem.writeU32()` directly. The hot-segment cache means consecutive accesses to the same 64KB segment hit the fast path.

**Future optimization**: For blocks that only access known-safe regions (stack, heap — not VGA), emit direct `Uint8Array` access bypassing the VGA check.

## 5. I/O and Interrupt Handling

- **Port I/O**: Block boundary. Fall back to interpreter.
- **Hardware interrupts**: Cannot fire mid-block (blocks are atomic, typically 3-20 instructions). Checked between blocks in `emuTick()`.
- **STI**: Block boundary (allow interrupt check after).
- **Thunks**: Checked before entering a JIT block. Indirect CALL/JMP end the block (target might be a thunk).

## 6. Self-Modifying Code Invalidation

Add lightweight tracking at the 64KB segment level:

1. Each `CompiledBlock` records which segment key it spans
2. Maintain `segmentBlocks: Map<number, Set<number>>` (segment → block addresses)
3. In `Memory.writeU8/16/32`, add: `if (this._hasJitCode && this._jitSegments.has(addr >>> 16)) jitInvalidate(addr >>> 16);`
4. Cost: one `Map.has()` per write, only when JIT code exists. Stack/heap writes (most common) won't have JIT code.

## 7. Files to Create/Modify

### New files
- `src/lib/emu/x86/jit-cache.ts` — Block cache, hotness tracking, invalidation
- `src/lib/emu/x86/jit-codegen.ts` — Instruction-to-JavaScript translation
- `src/lib/emu/x86/jit-decode.ts` — Static ModRM/SIB decoder for compile time
- `src/lib/emu/x86/jit-compile.ts` — Basic block finder, compiler orchestrator

### Modified files
- `src/lib/emu/emu-exec.ts` — JIT cache probe before `cpu.step()`
- `src/lib/emu/memory.ts` — JIT invalidation hook in write methods

### Unchanged files
- `flags.ts`, `lazy-op.ts`, `decode.ts` — kept for interpreter fallback
- `ops-0f.ts`, `shift.ts`, `string.ts` — kept for interpreter fallback
- `fpu.ts` — FPU = block boundary in Phase 1
- `fast-loops.ts` — complementary optimization (covers cold loops before JIT warms up)

## 8. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Correctness bugs | Silent data corruption | Test suite comparing JIT vs interpreter results |
| Self-modifying code | Stale compiled code | Conservative segment-level invalidation |
| Flag accuracy | Subtle misbehavior | Debug mode: compare flags after each block |
| `new Function()` CSP | JIT blocked by policy | Graceful fallback to interpreter |
| 16-bit mode complexity | Complex segment handling | Phase 1-2 target 32-bit + real mode only |

## 9. Implementation Timeline

| Phase | Scope | Duration |
|-------|-------|----------|
| 1 | Infrastructure + MOV/PUSH/POP/ALU + block cache | 2-3 weeks |
| 2 | Control flow (Jcc/JMP/CALL) + memory operands + block chaining | 2-3 weeks |
| 3 | Advanced instructions + flag optimization + REP strings | 2-4 weeks |
| 4 | DOS-specific: VGA bypass, segment hoisting, loop unrolling | 1-2 weeks |

**Total: 7-12 weeks**

## 10. Reference: v86 JIT Architecture

v86 source at `D:\Perso\SideProjects\v86`:
- `src/rust/jit.rs` — Main JIT compiler (basic block detection, compilation orchestration)
- `src/rust/jit_instructions.rs` — Instruction-to-WASM translation
- `src/rust/wasmgen/` — WebAssembly binary generation
- Key difference: v86 generates WASM modules and installs them in a shared WASM Table for `call_indirect`. We generate JS functions.
- Key similarity: basic block detection, lazy flags, hotness tracking, self-modifying code invalidation at page level.
