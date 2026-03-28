# Debug Second Reality — Ships Scene Crash

## Status: UNRESOLVED (crash persists in browser, partially fixed in headless)

## What We Know

### The Crash
- Second Reality runs fine until the 3D ships scene (4th sub-EXE, ~1 minute in)
- Display becomes garbled, a looping audio sample plays, PMODEW error "1C89:00000" visible
- In headless tests, manifests as WILD EIP or Unimplemented opcode (executing corrupted code)

### Root Cause: Memory Corruption
- The rendering code at CS:0x3C63 (CS=0x43A) writes to DS:SI+offset where DS=CS
- SI values like 0x2720, 0x2D20, 0x34A0, 0x38C0 write into the CODE area (starts at ~CS:0x2D23)
- The structure buffer's normal range is CS:0xDA0-0x11C0 (12 structures, stride 0x60)
- Bad SI values are 2-3x above the valid range — out-of-bounds buffer access
- Code bytes are progressively overwritten with data, eventually causing invalid instruction execution

### Why SI Is Wrong
- 54-66% of subroutine calls (at CS:0x58EC) have SI > 0x1200 (above buffer)
- The subroutine does fixed-point math: `SHL EAX,16; MOVZX EDX,[SI+0x42]; SUB EAX,EDX; DIV ECX`
- SI comes from the rendering pipeline (3D projection → clipping → scan conversion)
- Some upstream computation produces wrong intermediate values → wrong buffer indices

### Headless vs Browser Discrepancy
- Headless tests with 15K ticks sometimes pass (timing-dependent)
- Browser ALWAYS crashes at the ships scene
- The crash depends on WHEN timer interrupts fire relative to rendering code
- Timer interrupts during CLI sections cause side-effects (see below)

## What We Fixed (Committed)

### 1. XCHG AX,r16 (commit 1b6dc5d) — REAL BUG
- Short-form XCHG (0x91-0x97) did full 32-bit swap instead of 16-bit in 16-bit mode
- Corrupted upper 16 bits of registers used in fixed-point math
- Fix: check opSize, use getReg16/setReg16 for 16-bit

### 2. LOOP/JCXZ IP wrapping (commit e458cb5) — REAL BUG
- LOOP/LOOPNE/LOOPE/JCXZ didn't wrap IP to 16 bits in 16-bit mode
- Could jump to wrong addresses near segment boundaries
- Fix: `csBase + ((offset + disp) & 0xFFFF)` in 16-bit mode

### 3. FLAGS push without forced IF=1 (commit 4572ad8) — CORRECTNESS FIX
- Previously pushed `getFlags() | 0x0200` which forced IF=1 in saved FLAGS
- After IRET, code running with CLI unexpectedly had IF=1, changing behavior
- Now pushes actual FLAGS — IRET restores original IF state
- Headless: eliminates WILD EIP crash (demo exits with code 255 instead)
- Browser: no visible improvement (crash persists)

### 4. Other improvements (commit 0b4e80e)
- PIC 8259A ISR/IRR/OCW3 tracking (port 0x20 returns real ISR/IRR)
- PIC ICW2 vector base tracking (_picMasterBase/_picSlaveBase)
- MOV CR0 PM→RM: sets use32=false, _addrSize16=true
- loadCS in RM: forces use32=false
- _inhibitIRQ for MOV SS/POP SS (1-instruction IRQ inhibit)
- Sub-EXE exit cleanup (GDT/IDT/PIC reset)
- INT 2Fh AX=1687h DPMI detection
- [CR0] Enter PM diagnostic log
- EIP history ring buffer for WILD EIP diagnostics

## What We Ruled Out

### Not the cause:
- **tryFastLoop**: disabled it, crash unchanged
- **IDT dispatch**: Second Reality never enters PM (MOV CR0 never fires), all RM
- **PIC ISR values**: fixed to return proper ISR/IRR, no effect
- **IF flag checking in dispatch**: blocks timer → demo freezes (busy-wait handshake needs timer)
- **VGA retrace cache**: uncaching had no effect (retrace wait IS slow but eventually resolves)
- **Other instruction width bugs**: comprehensive review found XCHG as the ONLY one

### All instruction handlers verified correct:
- SHL/SHR/SAR (shift.ts)
- DIV/IDIV (F7 /6, /7) — uses BigInt for 64/32, correct
- MUL/IMUL — correct for all operand sizes
- MOVZX/MOVSX — correct
- INC/DEC short form — correct (checks opSize)
- PUSH/POP short form — correct
- CBW/CWDE, CWD/CDQ — correct
- LEA — correct
- All ALU ops — correct

## Remaining Pistes

### 1. Timer dispatch during CLI corrupts state (MOST LIKELY)
- Our emulator fires timer interrupts even during CLI (IF=0)
- Real x86 NEVER delivers maskable IRQs when IF=0
- During CLI sections, registers may be in intermediate states (half-updated pointers)
- The timer handler runs, preserves/restores its own registers, IRETs
- But the interrupted code's state was captured at a "wrong" moment
- After IRET, the code continues from the interrupted point with potentially stale/wrong cached values
- **Key evidence**: the crash is timing-dependent (different timer timing → different crash behavior)

### 2. Wrong computation in 3D pipeline
- The fixed-point math chain: vertex transform → project → clip → scan convert
- Somewhere a slightly wrong result propagates through the chain
- Could be a flags computation affecting a conditional branch (clipping test)
- Could be an edge case in DIV/IDIV truncation
- Requires register-by-register comparison with DOSBox to find

### 3. Memory layout difference
- DS=CS=0x43A is intentional (code does `MOV AX,CS; MOV DS,AX`)
- Structure buffer and code share the same segment
- Normal structures at 0xDA0-0x11C0, code at 0x2D23+
- Gap between buffer and code (~7KB) should be safe
- But bad SI values jump INTO the code area
- On real hardware same layout exists but SI values stay within bounds

### 4. Browser vs headless timing discrepancy
- Headless: timer based on performance.now() with tight CPU loops
- Browser: timer based on performance.now() with requestAnimationFrame pauses
- Different instruction counts between timer checks → different interrupt points
- The crash may be sensitive to EXACT instruction where timer fires

## Key Addresses (4th sub-EXE, CS=0x43A)

| Address | Description |
|---------|-------------|
| CS:0x08D9 | Global divisor variable (value 0x96BB) |
| CS:0x0DA0-0x11C0 | Structure buffer (normal range, stride 0x60) |
| CS:0x2D23 | Unrolled rendering loop start |
| CS:0x58CC-0x591C | Fixed-point subroutine (DIV ECX, clamp, store) |
| CS:0x3C63 | Corrupting write instruction (MOV [SI+xx], AL) |
| IVT[08h] = 0x110:0x11EC | Timer handler (STMIK + VGA retrace wait) |

## Test Files
- `tests/test-sr-crash.mjs` — configurable crash investigation test
- `tests/test-secondreality.mjs` — full demo test (needs Enter key injection)

## Source Code
- Second Reality source: `D:\Perso\SideProjects\SecondReality`
- Ships scene = GLENZ directory (3D glass polygon effect)
- Assembly rendering: VIDPOLY.ASM, ASM.ASM, VEC.ASM, MATH.ASM
