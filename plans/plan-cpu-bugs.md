# Plan: Fix CPU Emulation Bugs

## Context

STMIK audio mixing produces DC offset and Second Reality (+ other DOS games) crash after running for a while. A thorough audit of the x86 CPU emulation, cross-referenced with dosemu/QEMU source code and Intel manuals, has revealed **6 confirmed bugs**.

**Note on Bug 1:** Under PMODEW flat model, all segment bases (CS/DS/ES/SS) are 0, so segment overrides between them are effectively no-ops. However, if a program allocates DOS memory via DPMI (INT 31h, fn 0100h) and uses a separate PM selector with non-zero base, the override IS needed. This bug is real but may not be the primary cause of STMIK/SR issues unless those programs use separate segment selectors.

## Confirmed Bugs (all verified with concrete test cases)

### Bug 1: Segment overrides silently ignored in 32-bit protected mode (HIGH)
**File:** `src/lib/emu/x86/dispatch.ts:121-122`
**Verified:** Line 122 has `if (!cpu.use32) cpu._segOverride = opcode;` — overrides 0x26/0x2E/0x36/0x3E/0x65 are consumed but _segOverride stays 0 in 32-bit mode. Only FS (0x64) works.
**Fix:** Remove the `if (!cpu.use32)` guard: `cpu._segOverride = opcode;`
**Note:** For flat model (all bases=0), this is a no-op change. For programs using selectors with non-zero bases, this is critical.

### Bug 2: GS missing from getSegOverrideSel (HIGH)
**File:** `src/lib/emu/x86/decode.ts:103-111`
**Verified:** No `case 0x65` in the switch. `default: return cpu.ds` makes GS silently use DS selector.
**Fix:** Add `case 0x65: return cpu.gs;` before the default.

### Bug 3: MOV r/m16, Sreg (0x8C) broken in 32-bit mode (HIGH)
**File:** `src/lib/emu/x86/dispatch.ts:705-719`
**Verified:** `if (!cpu.use32)` skips segment value read in 32-bit mode → sregVal=0. FS (4) and GS (5) missing.
**Fix:** Remove guard, add FS/GS cases. Keep `decodeModRM(16)` for memory dest (always 16-bit write per Intel spec). For register dest in 32-bit mode, the full register gets the zero-extended 16-bit value, but `writeModRM(d, sregVal, 16)` already handles this correctly via `setReg16`.

### Bug 4: ADC/SBB AF flag computation incorrect (MEDIUM)
**Files:** `src/lib/emu/x86/cpu.ts:347,354`
**Verified with case:** ADC a=0x0F, b=0x0F, CF=1 → result=0x1F, lazyB=0x10. AF = (0x0F ^ 0x10 ^ 0x1F) & 0x10 = 0 **WRONG** (should be 1: 0xF+0xF+1=0x1F carries from bit 3).
**Fix (Option A — lazyCF field):** Add `lazyCF: number = 0` to CPU. In ADC/SBB: store original b in lazyB, cf in lazyCF. In materializeFlags ADD/SUB cases, use `lazyCF` for CF computation and original b for AF.
**Fix (Option B — simplest):** In ADC, compute result as `(a + b + cf)` and store lazy as `setLazy(addOp, result, a, b)` (original b, NOT b+cf). Then for CF, compute eagerly: `const hasCF = ((a >>> 0) + (b >>> 0) + cf) > mask;` and store in flagsCache before calling setLazy.
**Impact:** DAA/DAS/AAA/AAS after ADC/SBB give wrong results. Low impact for audio mixing.

### Bug 5: 16-bit IN/OUT split into two 8-bit operations (LOW — DEBATABLE)
**File:** `src/lib/emu/x86/dispatch.ts:1353-1364` (and 0xE5/0xE7)
**Verified:** `OUT DX, AX` sends two separate portOut calls: `portOut(port, lo)` then `portOut(port+1, hi)`.
**Actually correct for 8-bit ISA devices:** The VGA `OUT DX, AX` trick (DX=0x3CE, AL=index, AH=data) depends on this split behavior. The ISA bus decomposes 16-bit writes to 8-bit devices into two 8-bit transfers.
**Wrong for 16-bit devices:** SB16 in 16-bit audio mode expects a single 16-bit write.
**Decision:** Keep current behavior (correct for VGA and most DOS games). Add a `portOut16` path later only if SB16 16-bit mode is needed.

### Bug 6: INC/DEC lose IOPL and NT flags (LOW)
**File:** `src/lib/emu/x86/dispatch.ts` — 10 occurrences
**Verified:** Mask `(DF | 0x0300)` = 0x0700 excludes IOPL (0x3000) and NT (0x4000). After INC/DEC, these bits are zeroed in flagsCache. `materializeFlags` reads IOPL/NT from flagsCache → lost.
**Fix:** Change to `(DF | 0x7300)` (10 occurrences). This matches the preserve mask in `materializeFlags` line 27.
**Impact:** Low — emulator doesn't enforce IOPL, and DOS programs rarely check it after INC/DEC.

## Implementation Order

1. **Bug 1** — Segment overrides in 32-bit mode (remove `if (!cpu.use32)` guard, 1 line)
2. **Bug 2** — GS in getSegOverrideSel (add 1 case)
3. **Bug 3** — MOV Sreg 0x8C (remove guard, add FS/GS cases, ~10 lines)
4. **Bug 6** — INC/DEC flag mask (replace `0x0300` → `0x7300`, 10 occurrences)
5. **Bug 4** — ADC/SBB AF (cpu.ts + flags.ts, choose Option A or B)
6. ~~Bug 5~~ — 16-bit IN/OUT: keep current behavior (correct for VGA)

## Files Modified

- `src/lib/emu/x86/dispatch.ts` — Bugs 1, 3, 6
- `src/lib/emu/x86/decode.ts` — Bug 2
- `src/lib/emu/x86/cpu.ts` — Bug 4
- `src/lib/emu/x86/flags.ts` — Bug 4

## Verification

1. `npm run build` — type check passes
2. Run existing test suite: all `timeout 2 npx tsx tests/test-*.mjs`
3. Manual test: Second Reality in browser — should run longer without crashing
4. Manual test: STMIK-based programs — audio mixing should no longer produce DC offset
