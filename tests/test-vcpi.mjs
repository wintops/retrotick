/**
 * Unit tests for VCPI (Virtual Control Program Interface) — INT 67h AH=DE
 * Implementation lives in src/lib/emu/dos/ems.ts (handleInt67 + handleVcpiPM).
 *
 * Each test sets up a minimal Emulator + CPU, calls the handler directly,
 * and verifies register/memory state. No PE loading required.
 */
import { Memory } from '../src/lib/emu/memory.ts';
import { CPU } from '../src/lib/emu/x86/cpu.ts';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { handleInt67, handleVcpiPM, VCPI_PM_INT } from '../src/lib/emu/dos/ems.ts';

// Register indices (matches ems.ts)
const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESP = 4, EBP = 5, ESI = 6, EDI = 7;

let passed = 0, failed = 0;
const failures = [];
function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; failures.push(msg); }
  else { console.log(`[PASS] ${msg}`); passed++; }
}
function assertEq(actual, expected, msg) {
  const a = typeof actual === 'number' ? `0x${(actual >>> 0).toString(16)}` : actual;
  const e = typeof expected === 'number' ? `0x${(expected >>> 0).toString(16)}` : expected;
  assert(actual === expected, `${msg} — got ${a}, expected ${e}`);
}

/** Build a fresh Emulator wired to a CPU in real mode with EMS enabled. */
function makeEmu() {
  const emu = new Emulator();
  emu.dosEnableEms = true;
  emu.cpu.realMode = true;
  // Conventional DS=0x1000 ES=0x2000 for buffer reads/writes
  emu.cpu.ds = 0x1000;
  emu.cpu.es = 0x2000;
  emu.cpu.ss = 0x3000;
  emu.cpu.reg[ESP] = 0xFFFC;
  return emu;
}

// ────────────────────────────────────────────────────────────────────────────
// Test 1: DE00 — VCPI Installation Check
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 1: DE00 Installation Check ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE00;

  // Pre-populate IVT with recognizable values so we can check the save
  for (let i = 0; i < 256; i++) {
    emu.memory.writeU16(i * 4, 0x1000 + i);  // offset
    emu.memory.writeU16(i * 4 + 2, 0xC000 + i); // segment
  }

  const ret = handleInt67(emu.cpu, emu);
  assert(ret === true, 'DE00 returns true');
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE00 AH=0 success');
  assertEq(emu.cpu.reg[EBX] & 0xFFFF, 0x0100, 'DE00 BX=0x0100 (version 1.0)');
  assert(emu._vcpiPrivateArea !== undefined, 'DE00 sets up _vcpiPrivateArea');
  assertEq(emu._gdtBase, emu._vcpiPrivateArea, 'DE00 _gdtBase = private area');
  assertEq(emu._gdtLimit, 0xFF, 'DE00 _gdtLimit = 0xFF (32 entries)');
  assert(emu._vcpiSavedIVT instanceof Uint16Array, 'DE00 saves IVT');
  assertEq(emu._vcpiSavedIVT[0], 0xC000, 'DE00 saved IVT[0] segment');
  assertEq(emu._vcpiSavedIVT[10], 0xC00A, 'DE00 saved IVT[10] segment');

  // Verify GDT NULL descriptor
  const P = emu._vcpiPrivateArea;
  assertEq(emu.memory.readU32(P + 0), 0, 'GDT[0] = null low');
  assertEq(emu.memory.readU32(P + 4), 0, 'GDT[0] = null high');

  // GDT[1] LDT descriptor — type byte at offset 0x0D should have 0x82 (LDT)
  const ldtTypeByte = (emu.memory.readU32(P + 0x0C) >>> 8) & 0xFF;
  assertEq(ldtTypeByte, 0x82, 'GDT[1] LDT type byte');

  // GDT[2] TSS descriptor — type byte should be 0x89
  const tssTypeByte = (emu.memory.readU32(P + 0x14) >>> 8) & 0xFF;
  assertEq(tssTypeByte, 0x89, 'GDT[2] TSS type byte');

  // IDT entries should look like 32-bit interrupt gates (0xEE high byte)
  const idtEntry0 = emu.memory.readU32(P + 0x2000 + 4);
  assertEq((idtEntry0 >>> 8) & 0xFF, 0xEE, 'IDT[0] gate type/attr = 0xEE');

  // Stub at P+0x2800 should be IRET (0xCF)
  assertEq(emu.memory.readU8(P + 0x2800), 0xCF, 'IDT stub[0] is IRET');

  // Calling DE00 a second time should be idempotent (no re-init)
  emu._vcpiSavedIVT[0] = 0xDEAD;
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);
  assertEq(emu._vcpiSavedIVT[0], 0xDEAD, 'DE00 second call does not re-init IVT save');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 2: DE01 — Get Protected Mode Interface
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 2: DE01 Get PM Interface ===');
  const emu = makeEmu();
  // Bootstrap DE00 first
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);

  // ES:DI -> 4KB-aligned page table buffer at ES=0x2000, DI=0x0000
  // DS:SI -> GDT descriptor buffer at DS=0x1000, SI=0x0500
  const esBase = emu.cpu.ds * 16; // ES=0x2000 → 0x20000
  emu.cpu.es = 0x2000;
  emu.cpu.reg[EDI] = 0x0000;
  emu.cpu.ds = 0x1000;
  emu.cpu.reg[ESI] = 0x0500;

  // Mark EBX upper to detect the EBX clobber bug
  emu.cpu.reg[EBX] = 0xCAFE0000;
  emu.cpu.reg[EAX] = 0xDE01;
  handleInt67(emu.cpu, emu);

  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE01 AH=0 success');

  // BX should = VCPI_PM_OFF = 0x0B00
  assertEq(emu.cpu.reg[EBX] & 0xFFFF, 0x0B00, 'DE01 BX = PM entry offset (0x0B00)');
  // After fix: upper 16 bits preserved
  assertEq((emu.cpu.reg[EBX] >>> 16) & 0xFFFF, 0xCAFE, 'DE01 preserves EBX upper bits');

  // EDI should advance by 0x400 (one page table)
  assertEq(emu.cpu.reg[EDI] & 0xFFFF, 0x0400, 'DE01 EDI advanced by 0x400');

  // Page table at ES:DI start: identity-mapped first 1MB
  // PTE 0 (page 0): physical page 0, flags 0x67 → full DWORD = 0x67
  const pte0 = emu.memory.readU32(0x20000 + 0);
  assertEq(pte0, 0x67, 'PTE[0] = identity, page 0, flags=0x67');

  // PTE 1 should map page 1 → phys page 1: dword = (1 << 12) | 0x67 = 0x1067
  const pte1 = emu.memory.readU32(0x20000 + 4);
  assertEq(pte1, 0x1067, 'PTE[1] = identity, page 1');

  // PTE 0xFE → phys page 0xFE
  const pteFE = emu.memory.readU32(0x20000 + 0xFE * 4);
  assertEq(pteFE, 0xFE067, 'PTE[0xFE] = identity, page 0xFE');

  // PTE 0xFF → quirked DOSBox-style mapping at phys page 0x110
  const pteFF = emu.memory.readU32(0x20000 + 0xFF * 4);
  assertEq(pteFF, 0x110067, 'PTE[0xFF] = quirk mapping → phys 0x110');

  // GDT descriptors at DS:SI (3 × 8 bytes)
  const dsBase = 0x10000;
  // Desc 1 — code segment, base = 0xF0000, limit = 0xFFFF, type = 0x9A (code, ER, P)
  const d1lo = emu.memory.readU32(dsBase + 0x500 + 0);
  const d1hi = emu.memory.readU32(dsBase + 0x500 + 4);
  assertEq(d1lo & 0xFFFF, 0xFFFF, 'Desc1 limit low = 0xFFFF');
  assertEq((d1lo >>> 16) & 0xFFFF, 0x0000, 'Desc1 base[15:0] low part');
  assertEq((d1hi >>> 8) & 0xFF, 0x9A, 'Desc1 access byte = 0x9A (code)');
  assertEq(d1hi & 0xFF, 0x0F, 'Desc1 base[23:16] = 0x0F (vcpiCodeBase=0xF0000)');

  // Desc 2 — data segment, base = 0, limit = 0xFFFF, type = 0x92
  const d2lo = emu.memory.readU32(dsBase + 0x500 + 8);
  const d2hi = emu.memory.readU32(dsBase + 0x500 + 12);
  assertEq(d2lo & 0xFFFF, 0xFFFF, 'Desc2 limit = 0xFFFF');
  assertEq((d2hi >>> 8) & 0xFF, 0x92, 'Desc2 access byte = 0x92 (data RW)');

  // Desc 3 — same as Desc 2
  const d3hi = emu.memory.readU32(dsBase + 0x500 + 20);
  assertEq((d3hi >>> 8) & 0xFF, 0x92, 'Desc3 access byte = 0x92');

  // The PM entry stub should be at F000:0B00 = linear 0xF0B00
  // Bytes: CD FA CB (INT FAh, RETF)
  assertEq(emu.memory.readU8(0xF0B00), 0xCD, 'PM stub[0] = 0xCD (INT)');
  assertEq(emu.memory.readU8(0xF0B01), VCPI_PM_INT, 'PM stub[1] = 0xFA');
  assertEq(emu.memory.readU8(0xF0B02), 0xCB, 'PM stub[2] = 0xCB (RETF)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 3: DE02 — Maximum Physical Address
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 3: DE02 Maximum Physical Address ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE02;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE02 AH=0 success');
  // Spec: EDX = highest physical byte address (16MB-1 = 0x00FFFFFF)
  assertEq(emu.cpu.reg[EDX] >>> 0, 0x00FFFFFF, 'DE02 EDX = 16MB-1');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 4: DE03 — Get Number of Free Pages (decreases as pages are allocated)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 4: DE03 Free Pages ===');
  const emu = makeEmu();
  // Initial pool = 0xFFF + 1 - 0x110 = 0xEF0 pages (~15MB)
  emu.cpu.reg[EAX] = 0xDE03;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE03 AH=0 success');
  assertEq(emu.cpu.reg[EDX] >>> 0, 0xEF0, 'DE03 initial = 0xEF0 free pages');

  // Allocate 3 pages, free count should drop by 3
  for (let i = 0; i < 3; i++) {
    emu.cpu.reg[EAX] = 0xDE04;
    handleInt67(emu.cpu, emu);
  }
  emu.cpu.reg[EAX] = 0xDE03;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EDX] >>> 0, 0xEF0 - 3, 'DE03 decreases after DE04');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 5: DE04 — Allocate One 4K Page + exhaustion
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 5: DE04 Allocate Page ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE04;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE04 AH=0 success');
  // First allocated page should be 0x110 (1.0625 MB)
  assertEq(emu.cpu.reg[EDX] >>> 0, 0x110 << 12, 'DE04 first page = 0x110000');
  // Second call should return next page
  emu.cpu.reg[EAX] = 0xDE04;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EDX] >>> 0, 0x111 << 12, 'DE04 second page = 0x111000');

  // Exhaust the pool: jump to last page, allocate one more, then expect failure
  emu._vcpiNextPage = 0xFFF;
  emu.cpu.reg[EAX] = 0xDE04;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE04 last page success');
  assertEq(emu.cpu.reg[EDX] >>> 0, 0xFFF << 12, 'DE04 last page = 0xFFF000');
  emu.cpu.reg[EAX] = 0xDE04;
  handleInt67(emu.cpu, emu);
  assertEq((emu.cpu.reg[EAX] >>> 8) & 0xFF, 0x88, 'DE04 exhausted → AH=88 (no free pages)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 6: DE05 — Free Page (stub)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 6: DE05 Free Page ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE05;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE05 AH=0 success (stub)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 7: DE06 — Get Physical Address of Page in 1st MB (V86 identity)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 7: DE06 Get Physical Address ===');
  const emu = makeEmu();
  // Page 0x80 → identity → 0x80000
  emu.cpu.reg[EAX] = 0xDE06;
  emu.cpu.reg[ECX] = 0x80;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE06 AH=0 success');
  assertEq(emu.cpu.reg[EDX] >>> 0, 0x80000, 'DE06 page 0x80 → 0x80000');
  emu.cpu.reg[EAX] = 0xDE06;
  emu.cpu.reg[ECX] = 0xFF;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EDX] >>> 0, 0xFF000, 'DE06 page 0xFF → 0xFF000 (V86 identity)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 7b: DE07 — Read CR0
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 7b: DE07 Read CR0 ===');
  const emu = makeEmu();
  emu._cr0 = 0x80000011; // PE + PG + ET
  emu.cpu.reg[EBX] = 0xDEADBEEF;
  emu.cpu.reg[EAX] = 0xDE07;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE07 AH=0 success');
  assertEq(emu.cpu.reg[EBX] >>> 0, 0x80000011, 'DE07 EBX = current CR0');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 7c: DE08 — Read Debug Registers
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 7c: DE08 Read Debug Registers ===');
  const emu = makeEmu();
  emu._vcpiDebugRegs = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88];
  emu.cpu.es = 0x2000;
  emu.cpu.reg[EDI] = 0x100;
  emu.cpu.reg[EAX] = 0xDE08;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE08 AH=0 success');
  for (let i = 0; i < 8; i++) {
    assertEq(emu.memory.readU32(0x20100 + i * 4), [0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88][i], `DE08 DR[${i}]`);
  }
  // Default (no prior set) should write zeros without crashing
  const emu2 = makeEmu();
  emu2.cpu.es = 0x2000;
  emu2.cpu.reg[EDI] = 0x200;
  emu2.cpu.reg[EAX] = 0xDE08;
  handleInt67(emu2.cpu, emu2);
  assertEq(emu2.memory.readU32(0x20200), 0, 'DE08 default DR0 = 0');
  assertEq(emu2.memory.readU32(0x20200 + 28), 0, 'DE08 default DR7 = 0');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 7d: DE09 — Set Debug Registers (round-trip with DE08)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 7d: DE09 Set Debug Registers ===');
  const emu = makeEmu();
  emu.cpu.es = 0x2000;
  emu.cpu.reg[EDI] = 0x300;
  // Pre-fill source buffer
  const src = [0xCAFEBABE, 0xDEADBEEF, 0x12345678, 0x87654321, 0, 0x00000400, 0, 0];
  for (let i = 0; i < 8; i++) emu.memory.writeU32(0x20300 + i * 4, src[i]);
  emu.cpu.reg[EAX] = 0xDE09;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE09 AH=0 success');
  for (let i = 0; i < 8; i++) {
    assertEq(emu._vcpiDebugRegs[i], src[i], `DE09 stored DR[${i}]`);
  }
  // Read them back via DE08
  emu.cpu.reg[EDI] = 0x400;
  emu.cpu.reg[EAX] = 0xDE08;
  handleInt67(emu.cpu, emu);
  for (let i = 0; i < 8; i++) {
    assertEq(emu.memory.readU32(0x20400 + i * 4), src[i], `DE08 round-trip DR[${i}]`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Test 8: DE0A / DE0B — PIC Vector Mappings
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 8: DE0A/DE0B PIC Vectors ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE0A;
  emu.cpu.reg[EBX] = 0xFFFF0000; // marker for upper bits
  emu.cpu.reg[ECX] = 0xFFFF0000;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE0A AH=0 success');
  assertEq(emu.cpu.reg[EBX] & 0xFFFF, 0x08, 'DE0A BX = master PIC base = 0x08');
  assertEq(emu.cpu.reg[ECX] & 0xFFFF, 0x70, 'DE0A CX = slave PIC base = 0x70');
  assertEq((emu.cpu.reg[EBX] >>> 16) & 0xFFFF, 0xFFFF, 'DE0A preserves EBX upper bits');

  emu.cpu.reg[EAX] = 0xDE0B;
  handleInt67(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'DE0B AH=0 success (stub)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 9: DE0C — Switch from V86 to Protected Mode
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 9: DE0C V86→PM switch ===');
  const emu = makeEmu();

  // Bootstrap DE00 first
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);

  // Build a minimal client GDT at linear 0x80000 with two entries:
  //   [0] = null
  //   [1] = code seg base=0, limit=0xFFFFF (4G), type=0x9A, flags G=1 D=1 → 0x00CF9A00
  const clientGdt = 0x80000;
  emu.memory.writeU32(clientGdt + 0, 0);
  emu.memory.writeU32(clientGdt + 4, 0);
  emu.memory.writeU32(clientGdt + 8, 0x0000FFFF);
  emu.memory.writeU32(clientGdt + 12, 0x00CF9A00);
  // Client IDT at 0x90000 (empty)
  const clientIdt = 0x90000;

  // GDTR pseudo-descriptor at 0x70000: WORD limit, DWORD base
  emu.memory.writeU16(0x70000, 15); // 2 entries × 8 - 1
  emu.memory.writeU32(0x70002, clientGdt);
  // IDTR pseudo-descriptor at 0x70010
  emu.memory.writeU16(0x70010, 0x7FF);
  emu.memory.writeU32(0x70012, clientIdt);

  // VCPI data structure at linear 0x60000
  const struct = 0x60000;
  emu.memory.writeU32(struct + 0x00, 0);            // CR3
  emu.memory.writeU32(struct + 0x04, 0x70000);      // GDTR addr
  emu.memory.writeU32(struct + 0x08, 0x70010);      // IDTR addr
  emu.memory.writeU16(struct + 0x0C, 0);            // LDTR (null)
  emu.memory.writeU16(struct + 0x0E, 0);            // TR (null)
  emu.memory.writeU32(struct + 0x10, 0x12345678);   // EIP
  emu.memory.writeU16(struct + 0x14, 0x0008);       // CS = sel 8

  // Per RBIL: ESI = linear address of data structure
  emu.cpu.reg[ESI] = struct;
  emu.cpu.reg[EAX] = 0xDE0C;
  handleInt67(emu.cpu, emu);

  // Should have enabled A20
  assertEq(emu.memory.a20Mask, 0xFFFFFFFF, 'DE0C enables A20');
  // Should have left real mode
  assertEq(emu.cpu.realMode, false, 'DE0C clears realMode');
  // CR0.PE should be set
  assertEq(emu._cr0 & 1, 1, 'DE0C sets CR0.PE');
  // CS should be loaded with 0x08
  assertEq(emu.cpu.cs, 0x08, 'DE0C loads CS');
  // GDT base should be the client GDT (no relocation — DOS4GW modifies its
  // GDT directly via DS:[offset] in V86 mode, so we must read live entries).
  assertEq(emu._gdtBase, clientGdt, 'DE0C GDT base = client GDT');
  assertEq(emu._gdtLimit, 15, 'DE0C GDT limit preserved');
  // IDT base should match client IDT
  assertEq(emu._idtBase, clientIdt, 'DE0C IDT base = client IDT');
  // _vcpiPmGdtBase should be cached
  assertEq(emu._vcpiPmGdtBase, clientGdt, 'DE0C caches PM GDT base');
  // Flags: IF=0, VM=0, IOPL=3
  const f = emu.cpu.getFlags();
  assertEq(f & 0x200, 0, 'DE0C IF=0');
  assertEq(f & 0x20000, 0, 'DE0C VM=0');
  assertEq(f & 0x3000, 0x3000, 'DE0C IOPL=3');

  // Note: DE0C zeros SS/DS/ES/FS/GS to match DOSBox behavior. The VCPI spec
  // requires the caller (DOS4GW etc.) to set up valid PM segment registers
  // immediately after the switch, so this is OK in practice.
  assertEq(emu.cpu.ss, 0, 'DE0C SS zeroed (DOSBox-compatible)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 10: DE0C — Second switch re-reads client GDTR each time
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 10: DE0C Second switch re-reads client GDTR ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);

  // Build client GDT/IDT for first switch
  const clientGdt = 0x80000;
  emu.memory.writeU32(clientGdt + 0, 0);
  emu.memory.writeU32(clientGdt + 4, 0);
  emu.memory.writeU32(clientGdt + 8, 0x0000FFFF);
  emu.memory.writeU32(clientGdt + 12, 0x00CF9A00);
  emu.memory.writeU16(0x70000, 15);
  emu.memory.writeU32(0x70002, clientGdt);
  emu.memory.writeU16(0x70010, 0x7FF);
  emu.memory.writeU32(0x70012, 0x90000);

  const struct = 0x60000;
  emu.memory.writeU32(struct + 0x00, 0);
  emu.memory.writeU32(struct + 0x04, 0x70000);
  emu.memory.writeU32(struct + 0x08, 0x70010);
  emu.memory.writeU16(struct + 0x0C, 0);
  emu.memory.writeU16(struct + 0x0E, 0);
  emu.memory.writeU32(struct + 0x10, 0x1000);
  emu.memory.writeU16(struct + 0x14, 0x08);
  emu.cpu.reg[ESI] = struct;
  emu.cpu.reg[EAX] = 0xDE0C;
  handleInt67(emu.cpu, emu);

  // Simulate V86 code updating its GDTR pseudo-descriptor (e.g. after relocation)
  const newGdt = 0xABCDE000;
  // The new GDT entry must be readable for loadCS to work — write a code seg
  emu.memory.writeU32(newGdt + 0, 0);
  emu.memory.writeU32(newGdt + 4, 0);
  emu.memory.writeU32(newGdt + 8, 0x0000FFFF);
  emu.memory.writeU32(newGdt + 12, 0x00CF9A00);
  emu.memory.writeU16(0x70000, 0x123);
  emu.memory.writeU32(0x70002, newGdt);

  // Reset for second switch — switch back to V86 first via direct flag
  emu.cpu.realMode = true;

  // The second switch should re-read the client GDTR (not use a cached copy)
  emu.cpu.reg[ESI] = struct;
  emu.cpu.reg[EAX] = 0xDE0C;
  handleInt67(emu.cpu, emu);
  assertEq(emu._gdtBase, newGdt, 'DE0C 2nd switch re-reads client GDTR base');
  assertEq(emu._gdtLimit, 0x123, 'DE0C 2nd switch re-reads client GDTR limit');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 11: DE0C — Unknown sub-function returns AH=84
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 11: DE Unknown subfunction ===');
  const emu = makeEmu();
  emu.cpu.reg[EAX] = 0xDEFF;
  handleInt67(emu.cpu, emu);
  assertEq((emu.cpu.reg[EAX] >>> 8) & 0xFF, 0x84, 'DEFF returns AH=84 (not supported)');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 12: handleVcpiPM — Function 0x04 (Allocate Page in PM)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 12: VCPI-PM 0x04 Allocate ===');
  const emu = makeEmu();

  // Build a fake stack: push 16-bit ret = CS:IP (CS=0x0008, IP=0x4000)
  emu.cpu.realMode = false;
  emu.cpu.ss = 0x0010;
  emu.cpu.segBases.set(0x0010, 0xA0000);
  emu.cpu.reg[ESP] = 0x100;
  // 16-bit return frame: WORD IP, WORD CS at SS:ESP
  emu.memory.writeU16(0xA0000 + 0x100, 0x4000);
  emu.memory.writeU16(0xA0000 + 0x102, 0x0050); // CS that doesn't look like a small selector
  emu.memory.writeU16(0xA0000 + 0x104, 0x0000);
  emu.memory.writeU16(0xA0000 + 0x106, 0x0000);

  emu.cpu.reg[EAX] = 0x0004;
  emu.cpu.segBases.set(0x0050, 0x0); // give the heuristic a chance
  handleVcpiPM(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'PM 0x04 AH=0 success');
  // EDX should hold a page address
  assert((emu.cpu.reg[EDX] >>> 0) >= 0x110000, 'PM 0x04 EDX page allocated');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 13: handleVcpiPM — Function 0x05 (Free Page in PM)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 13: VCPI-PM 0x05 Free ===');
  const emu = makeEmu();
  emu.cpu.realMode = false;
  emu.cpu.ss = 0x0010;
  emu.cpu.segBases.set(0x0010, 0xA0000);
  emu.cpu.reg[ESP] = 0x100;
  emu.memory.writeU16(0xA0000 + 0x100, 0x4000);
  emu.memory.writeU16(0xA0000 + 0x102, 0x0050);
  emu.memory.writeU16(0xA0000 + 0x104, 0x0000);
  emu.memory.writeU16(0xA0000 + 0x106, 0x0000);
  emu.cpu.reg[EAX] = 0x0005;
  emu.cpu.segBases.set(0x0050, 0);
  handleVcpiPM(emu.cpu, emu);
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'PM 0x05 success');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 14: handleVcpiPM — Function 0x0C (PM→V86 switch)
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 14: VCPI-PM 0x0C PM→V86 switch ===');
  const emu = makeEmu();
  // Bootstrap so _vcpiPrivateArea is set
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);

  // Set up PM state
  emu.cpu.realMode = false;
  emu.cpu.ss = 0x0018;
  const ssBase = 0xB0000;
  emu.cpu.segBases.set(0x0018, ssBase);
  emu.cpu.reg[ESP] = 0x200;

  // Build the stack frame:
  //   ESP+0..7: CALL FAR return (caller EIP, caller CS) — discarded
  //   ESP+8..11: V86 EIP
  //   ESP+12..15: V86 CS
  //   ESP+16..19: V86 EFLAGS
  //   ESP+20..23: V86 ESP
  //   ESP+24..27: V86 SS
  //   ESP+28..31: V86 ES
  //   ESP+32..35: V86 DS
  //   ESP+36..39: V86 FS
  //   ESP+40..43: V86 GS
  const sp = ssBase + 0x200;
  emu.memory.writeU32(sp + 0, 0xCAFE);    // caller EIP
  emu.memory.writeU32(sp + 4, 0x00000023); // caller CS
  emu.memory.writeU32(sp + 8, 0x00001234); // V86 EIP
  emu.memory.writeU32(sp + 12, 0x00001000); // V86 CS
  emu.memory.writeU32(sp + 16, 0x00020202); // V86 EFLAGS (VM=1, default flags)
  emu.memory.writeU32(sp + 20, 0x0000FFEE); // V86 ESP
  emu.memory.writeU32(sp + 24, 0x00002000); // V86 SS
  emu.memory.writeU32(sp + 28, 0x00003000); // V86 ES
  emu.memory.writeU32(sp + 32, 0x00004000); // V86 DS
  emu.memory.writeU32(sp + 36, 0x00005000); // V86 FS
  emu.memory.writeU32(sp + 40, 0x00006000); // V86 GS

  emu.cpu.reg[EAX] = 0x000C;
  handleVcpiPM(emu.cpu, emu);

  assertEq(emu.cpu.realMode, true, 'PM 0x0C → realMode=true');
  assertEq(emu.cpu.cs, 0x1000, 'PM 0x0C CS = V86 CS');
  assertEq(emu.cpu.ds, 0x4000, 'PM 0x0C DS = V86 DS');
  assertEq(emu.cpu.es, 0x3000, 'PM 0x0C ES = V86 ES');
  assertEq(emu.cpu.ss, 0x2000, 'PM 0x0C SS = V86 SS');
  assertEq(emu.cpu.fs, 0x5000, 'PM 0x0C FS = V86 FS');
  assertEq(emu.cpu.gs, 0x6000, 'PM 0x0C GS = V86 GS');
  // V86 EIP is stored as linear (segBase + offset). With CS=0x1000, base=0x10000.
  assertEq(emu.cpu.eip, 0x10000 + 0x1234, 'PM 0x0C EIP = V86 segBase + offset');
  assertEq(emu.cpu.reg[ESP] & 0xFFFF, 0xFFEE, 'PM 0x0C ESP = V86 ESP');
  assertEq(emu.cpu.use32, false, 'PM 0x0C use32=false (16-bit V86)');
  assertEq(emu.cpu.reg[EAX] & 0xFF00, 0x0000, 'PM 0x0C AH=0 success');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 15: handleVcpiPM — Unknown function returns AH=8F
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 15: VCPI-PM unknown function ===');
  const emu = makeEmu();
  emu.cpu.realMode = false;
  emu.cpu.ss = 0x10;
  emu.cpu.segBases.set(0x10, 0);
  emu.cpu.reg[EAX] = 0x00FF;
  handleVcpiPM(emu.cpu, emu);
  assertEq((emu.cpu.reg[EAX] >>> 8) & 0xFF, 0x8F, 'PM unknown returns AH=8F');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 16: dosEnableEms = false → DE00 returns failure
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 16: EMS disabled ===');
  const emu = makeEmu();
  emu.dosEnableEms = false;
  emu.cpu.reg[EAX] = 0xDE00;
  handleInt67(emu.cpu, emu);
  assertEq((emu.cpu.reg[EAX] >>> 8) & 0xFF, 0x84, 'EMS disabled → AH=84');
}

// ────────────────────────────────────────────────────────────────────────────
// Test 17: VCPI_PM_INT constant is exported correctly
// ────────────────────────────────────────────────────────────────────────────
{
  console.log('\n=== Test 17: VCPI_PM_INT constant ===');
  assertEq(VCPI_PM_INT, 0xFA, 'VCPI_PM_INT = 0xFA');
}

// ────────────────────────────────────────────────────────────────────────────
// Summary
// ────────────────────────────────────────────────────────────────────────────
console.log('\n========================================');
console.log(`[VCPI TESTS] ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
