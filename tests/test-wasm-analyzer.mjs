/**
 * Unit test for wasm-analyzer — verifies basic block discovery.
 */
import { Memory } from '../src/lib/emu/memory.ts';
import { analyzeRegion } from '../src/lib/emu/x86/wasm-analyzer.ts';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; }
  else { console.log(`[PASS] ${msg}`); passed++; }
}

// Helper: write bytes to memory
function writeBytes(mem, addr, bytes) {
  for (let i = 0; i < bytes.length; i++) mem.writeU8(addr + i, bytes[i]);
}

// Test 1: Simple linear block ending with RET
{
  const mem = new Memory();
  // NOP; NOP; NOP; RET
  writeBytes(mem, 0x1000, [0x90, 0x90, 0x90, 0xC3]);
  const blocks = analyzeRegion(mem, 0x1000, true);
  assert(blocks.size === 1, `linear block: 1 block found (got ${blocks.size})`);
  const b = blocks.get(0x1000);
  assert(b && b.instrCount === 4, `linear block: 4 instructions`);
  assert(b && b.exitType === 'ret', `linear block: exit=ret`);
  assert(b && b.successors.length === 0, `linear block: no successors`);
}

// Test 2: Conditional jump (two blocks)
{
  const mem = new Memory();
  // 0x2000: CMP AL, 0x42 (3C 42)
  // 0x2002: JE +2 (74 02) -> jumps to 0x2006
  // 0x2004: NOP; RET
  // 0x2006: NOP; NOP; RET
  writeBytes(mem, 0x2000, [0x3C, 0x42, 0x74, 0x02, 0x90, 0xC3, 0x90, 0x90, 0xC3]);
  const blocks = analyzeRegion(mem, 0x2000, true);
  assert(blocks.size >= 3, `jcc: at least 3 blocks (got ${blocks.size})`);
  const b0 = blocks.get(0x2000);
  assert(b0 && b0.isConditional, `jcc: first block is conditional`);
  assert(b0 && b0.branchTarget === 0x2006, `jcc: target is 0x2006`);
}

// Test 3: Unconditional JMP
{
  const mem = new Memory();
  // 0x3000: JMP +3 (EB 03) -> jumps to 0x3005
  // 0x3002: NOP; NOP; NOP
  // 0x3005: RET
  writeBytes(mem, 0x3000, [0xEB, 0x03, 0x90, 0x90, 0x90, 0xC3]);
  const blocks = analyzeRegion(mem, 0x3000, true);
  const b0 = blocks.get(0x3000);
  assert(b0 && b0.exitType === 'jmp', `jmp: exit type is jmp`);
  assert(b0 && b0.branchTarget === 0x3005, `jmp: target is 0x3005`);
  assert(blocks.has(0x3005), `jmp: target block exists`);
}

// Test 4: Loop pattern (backward jump)
{
  const mem = new Memory();
  // 0x4000: INC EAX (40)
  // 0x4001: DEC ECX (49)
  // 0x4002: JNZ -4 (75 FC) -> jumps back to 0x4000
  writeBytes(mem, 0x4000, [0x40, 0x49, 0x75, 0xFC]);
  const blocks = analyzeRegion(mem, 0x4000, true);
  const b0 = blocks.get(0x4000);
  assert(b0 && b0.isConditional, `loop: conditional branch`);
  assert(b0 && b0.branchTarget === 0x4000, `loop: jumps back to self`);
  assert(b0 && b0.successors.includes(0x4000), `loop: self in successors`);
}

// Test 5: 16-bit mode (use32=false)
{
  const mem = new Memory();
  // 0x5000: MOV AX, 1234h (B8 34 12) — 3 bytes in 16-bit mode
  // 0x5003: RET (C3)
  writeBytes(mem, 0x5000, [0xB8, 0x34, 0x12, 0xC3]);
  const blocks = analyzeRegion(mem, 0x5000, false);
  const b0 = blocks.get(0x5000);
  assert(b0 && b0.instrCount === 2, `16-bit: 2 instructions (MOV AX + RET)`);
  assert(b0 && b0.endAddr === 0x5004, `16-bit: endAddr correct`);
}

// Test 6: ModRM with displacement
{
  const mem = new Memory();
  // 0x6000: MOV [EBX+0x10], EAX  (89 43 10) — ModRM + disp8
  // 0x6003: MOV EAX, [ECX]       (8B 01)    — ModRM, no disp
  // 0x6005: RET
  writeBytes(mem, 0x6000, [0x89, 0x43, 0x10, 0x8B, 0x01, 0xC3]);
  const blocks = analyzeRegion(mem, 0x6000, true);
  const b0 = blocks.get(0x6000);
  assert(b0 && b0.instrCount === 3, `modrm: 3 instructions`);
  assert(b0 && b0.endAddr === 0x6006, `modrm: correct endAddr`);
}

// Test 7: Port I/O is block boundary
{
  const mem = new Memory();
  // 0x7000: IN AL, DX (EC)
  // 0x7001: NOP; RET
  writeBytes(mem, 0x7000, [0xEC, 0x90, 0xC3]);
  const blocks = analyzeRegion(mem, 0x7000, true);
  // IN AL,DX should end the block
  const b0 = blocks.get(0x7000);
  assert(b0 && b0.endAddr === 0x7001, `port io: block ends after IN`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
