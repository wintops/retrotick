/**
 * Integration test for the WASM JIT module — compiles x86 code to WASM and executes it.
 */
import { Memory } from '../src/lib/emu/memory.ts';
import { FlatMemory, OFF_REGS, OFF_FLAGS, OFF_EIP, OFF_EXIT, OFF_ENTRY } from '../src/lib/emu/x86/flat-memory.ts';
import { compileWasmRegion } from '../src/lib/emu/x86/wasm-module.ts';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; }
  else { console.log(`[PASS] ${msg}`); passed++; }
}

function writeBytes(mem, addr, bytes) {
  for (let i = 0; i < bytes.length; i++) mem.writeU8(addr + i, bytes[i]);
}

// Test 1: Compile and run a simple sequence: INC EAX; INC EAX; INC EAX; RET
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // 0x1000: INC EAX (40); INC EAX (40); INC EAX (40); RET (C3)
  writeBytes(mem, 0x1000, [0x40, 0x40, 0x40, 0xC3]);

  // Sync memory to flat buffer
  flat.syncToFlat(mem);
  // Set EAX=10 in flat buffer
  flat.dv.setInt32(OFF_REGS, 10, true);

  const region = await compileWasmRegion(mem, 0x1000, true, flat);
  assert(region !== null, `compile simple sequence`);
  if (region) {
    assert(region.entryMap.has(0x1000), `has entry for 0x1000`);
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x1000), true);
    region.run();
    const eax = flat.dv.getInt32(OFF_REGS, true);
    assert(eax === 13, `INC EAX x3: EAX=${eax}, expected 13`);
  }
}

// Test 2: XOR EAX, EAX (zero register)
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // XOR EAX, EAX (31 C0); RET (C3)
  writeBytes(mem, 0x2000, [0x31, 0xC0, 0xC3]);
  flat.syncToFlat(mem);
  flat.dv.setInt32(OFF_REGS, 0x12345678, true); // EAX = nonzero

  const region = await compileWasmRegion(mem, 0x2000, true, flat);
  assert(region !== null, `compile XOR EAX,EAX`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x2000), true);
    region.run();
    const eax = flat.dv.getInt32(OFF_REGS, true);
    assert(eax === 0, `XOR EAX,EAX: EAX=${eax}, expected 0`);
  }
}

// Test 3: PUSH/POP
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // MOV EAX, 0x42 (B8 42 00 00 00); PUSH EAX (50); POP EBX (5B); RET (C3)
  writeBytes(mem, 0x3000, [0xB8, 0x42, 0x00, 0x00, 0x00, 0x50, 0x5B, 0xC3]);
  flat.syncToFlat(mem);
  flat.dv.setInt32(OFF_REGS + 16, 0x10000, true); // ESP = 0x10000

  const region = await compileWasmRegion(mem, 0x3000, true, flat);
  assert(region !== null, `compile PUSH/POP`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x3000), true);
    region.run();
    const eax = flat.dv.getInt32(OFF_REGS, true);
    const ebx = flat.dv.getInt32(OFF_REGS + 12, true);
    const esp = flat.dv.getInt32(OFF_REGS + 16, true);
    assert(eax === 0x42, `PUSH/POP: EAX=0x${eax.toString(16)}, expected 0x42`);
    assert(ebx === 0x42, `PUSH/POP: EBX=0x${ebx.toString(16)}, expected 0x42`);
    assert(esp === 0x10000, `PUSH/POP: ESP restored to 0x${esp.toString(16)}`);
  }
}

// Test 4: SUB r/m, imm8 (Group 83)
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // MOV EAX, 100 (B8 64 00 00 00); SUB EAX, 42 (83 E8 2A); RET (C3)
  writeBytes(mem, 0x4000, [0xB8, 0x64, 0x00, 0x00, 0x00, 0x83, 0xE8, 0x2A, 0xC3]);
  flat.syncToFlat(mem);

  const region = await compileWasmRegion(mem, 0x4000, true, flat);
  assert(region !== null, `compile SUB imm8`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x4000), true);
    region.run();
    const eax = flat.dv.getInt32(OFF_REGS, true);
    assert(eax === 58, `SUB EAX,42: EAX=${eax}, expected 58`);
  }
}

// Test 5: Multiple blocks — verify compilation doesn't crash with branches
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // 0x5000: INC EAX (40); JMP +2 (EB 02); NOP; NOP; DEC EAX (48); RET (C3)
  writeBytes(mem, 0x5000, [0x40, 0xEB, 0x02, 0x90, 0x90, 0x48, 0xC3]);
  flat.syncToFlat(mem);
  flat.dv.setInt32(OFF_REGS, 0, true);

  const region = await compileWasmRegion(mem, 0x5000, true, flat);
  assert(region !== null, `compile multi-block with JMP`);
  if (region) {
    assert(region.blockCount >= 2, `multi-block: ${region.blockCount} blocks`);
  }
}

// Test 6: MOV reg, [mem] — load from memory
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // 0x6000: MOV EBX, 0x8000 (BB 00 80 00 00); MOV EAX, [EBX] (8B 03); RET (C3)
  writeBytes(mem, 0x6000, [0xBB, 0x00, 0x80, 0x00, 0x00, 0x8B, 0x03, 0xC3]);
  flat.syncToFlat(mem);
  // Write test value AFTER sync so it's not overwritten
  flat.dv.setUint32(0x8000, 0xCAFEBABE, true);

  const region = await compileWasmRegion(mem, 0x6000, true, flat);
  assert(region !== null, `compile MOV reg,[mem]`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x6000), true);
    region.run();
    const eax = flat.dv.getUint32(OFF_REGS, true);
    assert(eax === 0xCAFEBABE, `MOV EAX,[EBX]: got 0x${eax.toString(16)}, expected 0xCAFEBABE`);
  }
}

// Test 7: MOV [mem], reg — store to memory
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // 0x7000: MOV EAX, 0xDEAD (B8 AD DE 00 00); MOV EBX, 0x9000 (BB 00 90 00 00);
  //         MOV [EBX], EAX (89 03); RET (C3)
  writeBytes(mem, 0x7000, [0xB8, 0xAD, 0xDE, 0x00, 0x00, 0xBB, 0x00, 0x90, 0x00, 0x00, 0x89, 0x03, 0xC3]);
  flat.syncToFlat(mem);

  const region = await compileWasmRegion(mem, 0x7000, true, flat);
  assert(region !== null, `compile MOV [mem],reg`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x7000), true);
    region.run();
    const val = flat.dv.getUint32(0x9000, true);
    assert(val === 0xDEAD, `MOV [EBX],EAX: got 0x${val.toString(16)}, expected 0xDEAD`);
  }
}

// Test 8: LEA reg, [reg+disp]
{
  const mem = new Memory();
  const flat = new FlatMemory();
  // 0xA000: MOV EBX, 0x100 (BB 00 01 00 00); LEA EAX, [EBX+0x50] (8D 43 50); RET (C3)
  writeBytes(mem, 0xA000, [0xBB, 0x00, 0x01, 0x00, 0x00, 0x8D, 0x43, 0x50, 0xC3]);
  flat.syncToFlat(mem);

  const region = await compileWasmRegion(mem, 0xA000, true, flat);
  assert(region !== null, `compile LEA`);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0xA000), true);
    region.run();
    const eax = flat.dv.getInt32(OFF_REGS, true);
    assert(eax === 0x150, `LEA EAX,[EBX+0x50]: got 0x${eax.toString(16)}, expected 0x150`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
