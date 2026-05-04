# DPMI Support for DOS/4GW Executables

## Context

emul5.exe uses DOS/4GW, a DPMI-based DOS extender. Currently the emulator returns "DPMI not present" at `src/lib/emu/dos/misc.ts:222`, so DOS/4GW can't switch to protected mode and the program silently stalls after loading the dos4gw.exe overlay.

The fix: implement a DPMI 0.9 host so DOS/4GW (and other DPMI-based programs) can cleanly enter protected mode via the standard INT 31h API.

## Files to Create/Modify

### New: `src/lib/emu/dos/dpmi.ts` (~450 lines)

Main DPMI implementation file, following the XMS pattern (`xms.ts`).

**Constants:**
- `DPMI_ENTRY_SEG = 0xF000`, `DPMI_ENTRY_OFF = 0x0A00` (BIOS ROM stub, after XMS at 0x0800 and UCDOS at 0x0900)
- `DPMI_INT = 0xFD` (trap INT for entry stub, XMS uses 0xFE)
- `DPMI_GDT_LINEAR = 0x3F0000` (GDT at ~4MB, above EMS at 0x200000)
- `DPMI_GDT_ENTRIES = 8192` (64KB GDT)
- `DPMI_MEM_START = 0x400000` (memory blocks start at 4MB)
- `DPMI_FIRST_SEL = 0x80` (first allocatable selector, index 16)

**Functions:**

1. `setupDpmiStub(mem)` — Write `CD FD CB` (INT 0xFD; RETF) at F000:0A00

2. `handleDpmiEntry(cpu, emu)` — Called on INT 0xFD:
   - Build GDT at `DPMI_GDT_LINEAR` with initial selectors:
     - idx 0 (0x00): null
     - idx 1 (0x08): flat code — base=0, limit=4GB, 32-bit, execute/read
     - idx 2 (0x10): flat data — base=0, limit=4GB, 32-bit, read/write
     - idx 3 (0x18): stack — base=0, limit=4GB, 32-bit, read/write
     - idx 4 (0x20): PSP — base=PSP*16, limit=0xFF, 16-bit
   - Set `_gdtBase`, `_gdtLimit`, `_cr0 |= 1`
   - Switch to PM: `realMode=false`, load CS/DS/SS/ES, populate segBases/segLimits
   - Initialize `_dpmiState` tracking structure
   - Clear carry (success)

3. `handleInt31(cpu, emu)` — INT 31h dispatch by AX:

   **Descriptor mgmt (0000-000C):**
   - 0000: Allocate LDT descriptors (CX count → AX base sel)
   - 0001: Free descriptor (BX sel)
   - 0003: Get selector increment → AX=8
   - 0006: Get base (BX sel → CX:DX)
   - 0007: Set base (BX sel, CX:DX)
   - 0008: Set limit (BX sel, CX:DX)
   - 0009: Set access rights (BX sel, CX rights)
   - 000A: Create alias (BX sel → AX new sel, data copy)
   - 000B: Get descriptor → 8 bytes at ES:EDI
   - 000C: Set descriptor ← 8 bytes at ES:EDI

   **DOS memory (0100-0101):**
   - 0100: Alloc DOS mem (BX paras → AX RM seg, DX sel)
   - 0101: Free DOS mem (DX sel)

   **Interrupt vectors (0200-0205):**
   - 0200: Get RM int vector (BL → CX:DX from IVT)
   - 0201: Set RM int vector (BL, CX:DX → IVT)
   - 0204: Get PM exception handler
   - 0205: Set PM exception handler

   **Translation (0300):**
   - 0300: Simulate RM INT — save PM regs, load from 50-byte struct at ES:EDI, call handleDosInt in RM mode, write results back

   **Info (0400):**
   - 0400: Get DPMI version (0.9, 386, etc.)

   **Memory mgmt (0500-0503, 0600-0601, 0800):**
   - 0500: Free memory info → 48 bytes at ES:EDI
   - 0501: Alloc memory block (BX:CX size → BX:CX linear, SI:DI handle)
   - 0502: Free memory block (SI:DI handle)
   - 0503: Resize memory block
   - 0600/0601: Lock/unlock → NOP success
   - 0800: Physical addr mapping → identity map

**Helpers:**
- `writeGdtEntry(mem, gdtBase, index, base, limit, access, flags)` — write 8-byte descriptor
- `readGdtEntryBase/Limit(mem, gdtBase, index)` — read back

### Modify: `src/lib/emu/dos/misc.ts` (lines 220-228)

Change INT 2Fh AX=1687h from "not present" to:
```
AX=0, BX=1 (32-bit), CL=3 (386), DX=0x005A (v0.9), SI=0, ES:DI=F000:0A00
```

Also remove the `ax === 0x0500` DPMI not-present check (line 226-228) — that's a separate multiplex function, not DPMI.

### Modify: `src/lib/emu/dos/index.ts` (2 lines)

- Import `handleDpmiEntry`, `handleInt31`, `DPMI_INT` from `./dpmi`
- Add in switch: `case DPMI_INT: return handleDpmiEntry(cpu, emu);`
- Add in switch: `case 0x31: return handleInt31(cpu, emu);`

### Modify: `src/lib/emu/emu-load.ts` (2 lines)

- Import `setupDpmiStub` from `./dos/dpmi`
- Call `setupDpmiStub(emu.memory)` after `setupXmsStub()` at line 1141

### Modify: `src/lib/emu/emulator.ts` (5 lines)

Add DPMI state field near line 406:
```typescript
_dpmiState?: {
  nextSelector: number;
  freeSelectors: number[];
  nextMemHandle: number;
  memBlocks: Map<number, { base: number; size: number }>;
  nextMemAddr: number;
  dosMemBlocks: Map<number, { rmSeg: number; sel: number; paras: number }>;
  pmExcHandlers: Map<number, { sel: number; off: number }>;
};
```

## Implementation Order

1. **Phase 1 — Stub + entry point**: Create dpmi.ts with setupDpmiStub + handleDpmiEntry. Wire up in index.ts, emu-load.ts, misc.ts. Test: DOS/4GW should detect DPMI and enter PM.

2. **Phase 2 — Core INT 31h**: Descriptor mgmt (0000-000C) + memory mgmt (0500-0503). These are the first things DOS/4GW calls after entering PM.

3. **Phase 3 — DOS I/O**: Simulate RM INT (0300h) + RM interrupt vectors (0200-0201) + DOS memory (0100-0101). Needed for DOS/4GW to load the LE portion and do file I/O.

4. **Phase 4 — Remaining**: Version info (0400), lock/unlock (0600-0601), physical mapping (0800), exception handlers (0204-0205).

## Key Design Decisions

- **Flat model**: Initial CS/DS/SS all have base=0, limit=4GB. This is what DOS/4GW expects — it creates a flat 32-bit address space where linear addresses equal physical addresses.
- **GDT-based**: Real 8-byte descriptors written to memory GDT, which existing `loadGdtDescriptorBase/Is32` functions read. Also cached in `segBases`/`segLimits`.
- **Simulate RM INT**: Temporarily switch CPU to RM, call `handleDosInt()`, switch back. Works because all standard DOS/BIOS ints (10h, 21h, etc.) are handled in JS.
- **No paging**: DPMI 0.9 doesn't require paging. DOS/4GW in DPMI mode doesn't need it.

## Verification

1. `npm run build` — must compile without errors
2. Create `tests/test-emul5.mjs` and run `timeout 2 npx tsx tests/test-emul5.mjs`
3. Check console for: DPMI entry success, no WILD EIP, no unknown opcodes
4. Iterate: fix missing INT 31h subfunctions as DOS/4GW calls them
