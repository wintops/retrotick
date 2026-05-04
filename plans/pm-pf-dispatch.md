# Plan — PM `#PF` dispatch for VCPI-based DOS extenders (ISAY et al.)

## Context

The previous session landed real 32-bit paging (`src/lib/emu/memory.ts` — `translate()`, TLB, `setPaging()`) plus a workaround in `src/lib/emu/dos/ems.ts` DE0C that keeps the old GDT when the relocated GDT lands in an unmapped page.

ISAY still doesn't start. Root cause: EOS (the DOS extender inside ISAY.EXE) relocates its GDT to VA `0x48F070`, which is unmapped in EOS's own page directory at CR3=0x1A080 (PDE[1]=0). On real hardware the first access to that VA triggers `#PF`, EOS's handler at cs=0x18:0x4a6 (installed after PM entry, type=0x8E 32-bit gate, P=1) populates the missing PDE/PTE, IRETs, and the faulting instruction retries. Our emulator currently returns 0 on unmapped reads and drops unmapped writes silently — so the descriptor load yields a null selector and execution derails.

The goal is to make `#PF` dispatch through the client's IDT so the handler can populate the mapping, then retry the faulting instruction. This unblocks ISAY (and very likely the other EOS demos HMMM/KLPTT and possibly EMUL5/SHAD that share the VCPI-DE0C-then-paged-memory pattern tracked in `memory/dpmi_vcpi_pm_null_pages.md`). DOOM must remain unaffected — DOOM's DOS/4GW client never enables CR0.PG so the new throw path stays dormant.

## Design

Throw `PageFaultError` from `Memory.readU*`/`writeU*` when `translate()` would return -1, catch in the existing `try/catch` around `cpu.step()` in `src/lib/emu/emu-exec.ts`, rewind EIP to the faulting instruction, set CR2, dispatch `INT 0x0E` via the client's IDT, push the 4-byte error code on top of the IRET frame, and let the handler IRET back to retry the access.

Gated by `Memory._pfDispatchEnabled` (set by `setPaging`) so DPMI-without-paging clients see no change.

## Files to modify

### 1. `src/lib/emu/memory.ts`
- Add `export class PageFaultError extends Error` with fields `vaddr: number` and `isWrite: boolean`, next to the existing `AccessViolationError` (around line 170).
- Add field `_pfDispatchEnabled = false` on `Memory` (near `_pagingEnabled`).
- In `setPaging(enabled, pdBase)`: set `this._pfDispatchEnabled = enabled`. When paging is disabled, throwing would surprise non-paging code paths, so keep the silent return-0/drop behavior.
- In `readU8/readU16/readU32`: when `translate()` returns -1 and `_pfDispatchEnabled`, `throw new PageFaultError(addr, false)` instead of `return 0`.
- In `writeU8/writeU16/writeU32`: when `translate()` returns -1 and `_pfDispatchEnabled`, `throw new PageFaultError(addr, true)` instead of silently returning.
- For the page-boundary-split paths (existing `if ((addr & 0xFFF) >= 0xFFF)` etc.), no change — the split recurses into `readU8` which will throw from the faulting byte with the correct `vaddr` for CR2.

### 2. `src/lib/emu/x86/cpu.ts`
- Add field `_lastInstrEip = 0` on the `CPU` class (next to `eip` around line 23). Used by the fault catch to rewind after a mid-instruction throw.

### 3. `src/lib/emu/x86/dispatch.ts`
- In `cpuStep()` at line 423 immediately after `const instrEip = cpu.eip;`, add `cpu._lastInstrEip = instrEip;`. This makes the instruction-start EIP visible to code outside the dispatch function.
- (Optional, cleaner) Change `dispatchException(...)` to return `{ dispatched: boolean; is32: boolean }` instead of `boolean`, so the caller knows which push width to use for the error code. All existing callers just need their `if (dispatchException(...))` checks updated to `if (dispatchException(...).dispatched)`. If this refactor feels too invasive, fall back to deriving `is32` in the catch: read the IDT gate for vector 0x0E and check gate type (0x0E/0x0F → 32-bit, 0x06/0x07 → 16-bit). Start with the return-value refactor — it's narrow and localizes the width logic.

### 4. `src/lib/emu/emulator.ts`
- Add field `_cr2 = 0;` next to `_cr0` and `_cr3` (around line 380-381). Stores the last faulting VA for the `#PF` handler to read via `MOV EAX, CR2`.

### 5. `src/lib/emu/x86/ops-0f.ts`
- `MOV CRn, r32` (case 0x22): add the `crn === 2` branch to write `cpu.emu._cr2 = d.val >>> 0`.
- `MOV r32, CRn` (case 0x20): add the `crn === 2` branch to return `cpu.emu._cr2 ?? 0`. Critical: EOS's handler will do `MOV EAX, CR2` to learn which VA faulted and which PDE/PTE to fill in.

### 6. `src/lib/emu/emu-exec.ts` (lines 1172-1177)
Extend the existing `try/catch` around `emu.cpu.step()`:
```ts
try {
  emu.cpu.step();
} catch (e) {
  if (e instanceof AccessViolationError) { raiseAccessViolation(emu, e.addr); continue; }
  if (e instanceof PageFaultError) {
    const cpu = emu.cpu;
    cpu.eip = cpu._lastInstrEip;                    // rewind to faulting insn
    emu._cr2 = e.vaddr;                             // CR2 = faulting VA
    cpu.mem.invalidatePage(e.vaddr);                // drop negative TLB entry so retry re-walks
    const errCode = (e.isWrite ? 2 : 0) /* | 0 : P=0 (unmapped) */;
    const result = dispatchException(cpu, 0x0E, 'exception');
    if (!result.dispatched) {
      cpu.halted = true;
      cpu.haltReason = `unhandled #PF vaddr=0x${e.vaddr.toString(16)} write=${e.isWrite}`;
      continue;
    }
    if (result.is32) cpu.push32(errCode); else cpu.push16(errCode);
    continue;
  }
  throw e;
}
```
Import `PageFaultError` from `./memory`.

## Opcode restart-safety — scope for this PR

`PageFaultError` is thrown BEFORE any state change in `Memory` itself (translate check is first), so the Memory-level invariants are safe. But opcodes that mutate CPU state before reaching the memory access (REP string ops advancing SI/DI/CX, PUSH decrementing ESP, FPU memory ops updating TOP) will leave registers one iteration/word past the faulting position.

For ISAY specifically, the faulting instruction is a plain `MOV` from `[EAX+offset]` (GDT descriptor load), no REP, no stack push, no FPU. MVP ships without per-opcode restart fixes. Follow-ups (tracked in `memory/x86_pm_paging.md`):
- Pre-translate source/dest pages at the start of `doMovs`/`doStos` in `src/lib/emu/x86/string.ts`, so REP loops only enter when both pages are mapped.
- OR: rewind SI/DI/CX in the catch based on the direction flag when the current instruction is a REP-prefixed string op.

## Error code format

4-byte value:
- bit 0 — P: 0 when page not present (our only case — translate returned -1)
- bit 1 — W/R: 1 on write, 0 on read
- bit 2 — U/S: 0 (we don't emulate privilege level)
- bit 3 — RSVD: 0
- bit 4 — I/D: 0 (we don't distinguish instruction-fetch vs data access)

Simple expression: `errCode = e.isWrite ? 2 : 0`.

## Failure modes + mitigations

- **No IDT entry for `#PF` (P=0 or selector=0)**: `dispatchException` returns `dispatched:false`. Halt with `haltReason = 'unhandled #PF ...'`. Do NOT fall back to silent 0 — that masks the bug we're trying to expose.
- **Stale TLB after handler maps the page**: real x86 doesn't cache not-present translations, but ours does (we set the TLB entry to -1). The `invalidatePage(e.vaddr)` call in the catch clears that proactively so the retry re-walks the PD/PT.
- **Nested `#PF` inside handler (e.g. handler's stack is unmapped)**: recursive throw → catch → dispatch again. Real x86 double-faults; we accept the recursion for MVP. Add a TODO comment.
- **Error-code push itself faults**: the handler's stack near a page boundary could straddle an unmapped page. Accept this edge case for MVP.
- **Walker faults (CR3 points to unallocated memory)**: `_readU32Physical` bypasses paging; unallocated sparse memory auto-creates zeroed segments so PDE reads as 0 and the walker treats it as "not present" — same path as unmapped user VA. Acceptable.

## Verification

**Regression**:
- `timeout 25 npx tsx tests/test-doom.mjs` — must still exceed ~50M RM steps. Paging is off for DOOM so `_pfDispatchEnabled=false` and the new throw path never fires.
- `npm run build` — must succeed without type errors.

**Functional — ISAY**:
- `timeout 30 npx tsx tests/test-isay-vcpi.mjs` — before this change, halts after 6-12 VCPI-DE0C transitions. After, expect ISAY to progress further into demo initialization (look for reduced halt frequency / new code paths in the transition log). Target: observe at least one successful `MOV EAX, CR2` read inside the handler (log-gated trace), and the faulting instruction retrying with a now-mapped VA.

**Unit-level sanity (quick mjs harness)**:
- Enable paging with a page directory where PDE[1]=0, install an IDT entry for vector 0x0E pointing at a small stub (pops error code, IRETs). Execute a `MOV EAX, [0x400000]` instruction. Expect: (a) throw caught, (b) CR2 = 0x400000, (c) handler runs, (d) IRET returns to the faulting instruction, (e) retry reads 0 again (because we didn't map it), (f) infinite-loop bail via a step-count cap. That confirms the dispatch-and-retry cycle works.

**Halt-on-missing-IDT**:
- Same as above but leave IDT entry 0x0E as P=0. Expect emulator to halt with `haltReason` starting with `unhandled #PF`.

## Key file paths

- `src/lib/emu/memory.ts` — throw site + gate flag
- `src/lib/emu/x86/cpu.ts` — `_lastInstrEip` field
- `src/lib/emu/x86/dispatch.ts` — `cpuStep` save `_lastInstrEip`; `dispatchException` return type
- `src/lib/emu/emulator.ts` — `_cr2` field
- `src/lib/emu/x86/ops-0f.ts` — `MOV reg, CR2` and `MOV CR2, reg`
- `src/lib/emu/emu-exec.ts` — catch block around `cpu.step()`

## Reuse / existing utilities

- `cpu.mem.invalidatePage(vaddr)` (memory.ts:220) already exists — use it in the catch.
- `dispatchException(cpu, num, 'exception')` (dispatch.ts:42) already handles DPMI routing + raw IDT dispatch.
- `raiseDivideError` (dispatch.ts:269) is the existing pattern for "rewind EIP + dispatchException" — the catch mirrors it structurally.
- `cpu.push32` / `cpu.push16` (cpu.ts:425, 455) for the error-code push.
- `AccessViolationError` catch pattern in emu-exec.ts:1175 is the template for the new `PageFaultError` catch.
