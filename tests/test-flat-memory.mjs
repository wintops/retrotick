/**
 * Unit test for FlatMemory — verifies sync between sparse Memory and flat buffer.
 */
import { Memory } from '../src/lib/emu/memory.ts';
import { CPU } from '../src/lib/emu/x86/cpu.ts';
import { FlatMemory, OFF_REGS, OFF_FLAGS } from '../src/lib/emu/x86/flat-memory.ts';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; }
  else { console.log(`[PASS] ${msg}`); passed++; }
}

// Test 1: Memory roundtrip
{
  const mem = new Memory();
  mem.writeU8(0x1000, 0xAA);
  mem.writeU8(0x1001, 0xBB);
  mem.writeU32(0x2000, 0xDEADBEEF);

  const flat = new FlatMemory();
  flat.syncToFlat(mem);

  assert(flat.u8[0x1000] === 0xAA, `syncToFlat byte 0x1000`);
  assert(flat.u8[0x1001] === 0xBB, `syncToFlat byte 0x1001`);
  assert(flat.dv.getUint32(0x2000, true) === 0xDEADBEEF, `syncToFlat dword 0x2000`);

  // Modify flat buffer
  flat.u8[0x1000] = 0xCC;
  flat.dv.setUint32(0x2000, 0x12345678, true);

  // Sync back
  flat.syncFromFlat(mem);
  assert(mem.readU8(0x1000) === 0xCC, `syncFromFlat byte 0x1000`);
  assert(mem.readU32(0x2000) === 0x12345678, `syncFromFlat dword 0x2000`);
}

// Test 2: Register roundtrip
{
  const mem = new Memory();
  const cpu = new CPU(mem);
  cpu.reg[0] = 0x11111111; // EAX
  cpu.reg[1] = 0x22222222; // ECX
  cpu.reg[7] = 0x77777777; // EDI

  const flat = new FlatMemory();
  flat.writeRegs(cpu);

  assert(flat.dv.getInt32(OFF_REGS, true) === 0x11111111, `writeRegs EAX`);
  assert(flat.dv.getInt32(OFF_REGS + 4, true) === 0x22222222, `writeRegs ECX`);
  assert(flat.dv.getInt32(OFF_REGS + 28, true) === 0x77777777, `writeRegs EDI`);

  // Modify in flat buffer
  flat.dv.setInt32(OFF_REGS, 0xAAAAAAAA | 0, true);
  flat.readRegs(cpu);
  assert(cpu.reg[0] === (0xAAAAAAAA | 0), `readRegs EAX`);
}

// Test 3: Flags roundtrip
{
  const mem = new Memory();
  const cpu = new CPU(mem);
  cpu.lazyOp = 5;
  cpu.lazyResult = 42;
  cpu.lazyA = 100;
  cpu.lazyB = 58;
  cpu.flagsCache = 0x0246;
  cpu.flagsValid = false;

  const flat = new FlatMemory();
  flat.writeFlags(cpu);
  assert(flat.dv.getInt32(OFF_FLAGS, true) === 5, `writeFlags lazyOp`);
  assert(flat.dv.getInt32(OFF_FLAGS + 4, true) === 42, `writeFlags lazyResult`);
  assert(flat.dv.getInt32(OFF_FLAGS + 20, true) === 0, `writeFlags flagsValid=false`);

  // Modify and read back
  flat.dv.setInt32(OFF_FLAGS, 3, true);
  flat.dv.setInt32(OFF_FLAGS + 4, 99, true);
  flat.dv.setInt32(OFF_FLAGS + 20, 1, true);
  flat.readFlags(cpu);
  assert(cpu.lazyOp === 3, `readFlags lazyOp`);
  assert(cpu.lazyResult === 99, `readFlags lazyResult`);
  assert(cpu.flagsValid === true, `readFlags flagsValid=true`);
}

// Test 4: WASM can access flat memory
{
  const flat = new FlatMemory();
  flat.u8[0x500] = 0x42;

  // Build a tiny WASM module that reads from offset 0x500
  const { WasmBuilder } = await import('../src/lib/emu/x86/wasm-builder.ts');
  const b = new WasmBuilder();
  b.addMemoryImport('e', 'mem', 1);
  b.setParams(0);
  b.setResults([0x7F]);
  b.constI32(0x500);
  b.loadU8(0);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes, { e: { mem: flat.wasmMemory } });
  const result = mod.instance.exports.run();
  assert(result === 0x42, `WASM reads flat memory: got 0x${result.toString(16)}, expected 0x42`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
