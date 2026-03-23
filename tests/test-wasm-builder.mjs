/**
 * Unit test for WasmBuilder — verifies that it produces valid WASM modules.
 */

import { WasmBuilder } from '../src/lib/emu/x86/wasm-builder.ts';

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; }
  else { console.log(`[PASS] ${msg}`); passed++; }
}

// Test 1: Trivial module — function that returns a constant
{
  const b = new WasmBuilder();
  b.setParams(0);
  b.setResults([0x7F]); // i32
  b.constI32(42);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  const result = mod.instance.exports.run();
  assert(result === 42, `return constant: got ${result}, expected 42`);
}

// Test 2: Add two params
{
  const b = new WasmBuilder();
  b.setParams(2);
  b.setResults([0x7F]);
  b.getLocal(0);
  b.getLocal(1);
  b.addI32();
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  const result = mod.instance.exports.run(17, 25);
  assert(result === 42, `add params: got ${result}, expected 42`);
}

// Test 3: Use locals
{
  const b = new WasmBuilder();
  b.setParams(1);
  b.setResults([0x7F]);
  const tmp = b.allocLocal();
  b.getLocal(0);       // param 0
  b.constI32(10);
  b.addI32();
  b.setLocal(tmp);
  b.getLocal(tmp);     // return param+10
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  const result = mod.instance.exports.run(32);
  assert(result === 42, `locals: got ${result}, expected 42`);
}

// Test 4: Control flow — if/else
{
  const b = new WasmBuilder();
  b.setParams(1);
  b.setResults([0x7F]);
  const result = b.allocLocal();
  b.getLocal(0);
  b.eqzI32(); // param == 0?
  b.ifVoid();
    b.constI32(100);
    b.setLocal(result);
  b.elseBlock();
    b.constI32(200);
    b.setLocal(result);
  b.end();
  b.getLocal(result);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  assert(mod.instance.exports.run(0) === 100, `if/else true branch`);
  assert(mod.instance.exports.run(1) === 200, `if/else false branch`);
}

// Test 5: Loop with br_if
{
  const b = new WasmBuilder();
  b.setParams(1); // param 0 = count
  b.setResults([0x7F]);
  const sum = b.allocLocal();
  const i = b.allocLocal();
  b.constI32(0); b.setLocal(sum);
  b.constI32(0); b.setLocal(i);

  const loop = b.loopVoid();
    // sum += i
    b.getLocal(sum); b.getLocal(i); b.addI32(); b.setLocal(sum);
    // i++
    b.getLocal(i); b.constI32(1); b.addI32(); b.setLocal(i);
    // if (i < param0) br loop
    b.getLocal(i); b.getLocal(0); b.ltUI32(); b.brIf(loop);
  b.end();

  b.getLocal(sum);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  // sum of 0..9 = 45
  const result = mod.instance.exports.run(10);
  assert(result === 45, `loop sum 0..9: got ${result}, expected 45`);
}

// Test 6: Import a function
{
  const b = new WasmBuilder();
  const addFn = b.addFuncImport('e', 'add', [0x7F, 0x7F], [0x7F]);
  b.setParams(0);
  b.setResults([0x7F]);
  b.constI32(20);
  b.constI32(22);
  b.call(addFn);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes, { e: { add: (a, b) => a + b } });
  const result = mod.instance.exports.run();
  assert(result === 42, `import function: got ${result}, expected 42`);
}

// Test 7: Import memory and read/write
{
  const b = new WasmBuilder();
  b.addMemoryImport('e', 'mem', 1);
  b.setParams(0);
  b.setResults([0x7F]);
  // Write 0xDEAD to offset 0
  b.constI32(0);       // address
  b.constI32(0xDEAD);  // value
  b.storeI32(0);
  // Read back
  b.constI32(0);
  b.loadI32(0);
  const bytes = b.finish();
  const mem = new WebAssembly.Memory({ initial: 1 });
  const mod = await WebAssembly.instantiate(bytes, { e: { mem } });
  const result = mod.instance.exports.run();
  assert(result === 0xDEAD, `memory read/write: got 0x${result.toString(16)}, expected 0xDEAD`);
  // Also verify from JS side
  const dv = new DataView(mem.buffer);
  assert(dv.getInt32(0, true) === 0xDEAD, `memory visible from JS`);
}

// Test 8: br_table dispatch
{
  const b = new WasmBuilder();
  b.setParams(1); // state
  b.setResults([0x7F]);
  const result = b.allocLocal();

  const exitBlock = b.blockVoid();
  const bb2 = b.blockVoid();
  const bb1 = b.blockVoid();
  const bb0 = b.blockVoid();
    b.getLocal(0);
    b.brTable([bb0, bb1, bb2], exitBlock); // switch on param
  b.end(); // bb0
    b.constI32(10); b.setLocal(result); b.br(exitBlock);
  b.end(); // bb1
    b.constI32(20); b.setLocal(result); b.br(exitBlock);
  b.end(); // bb2
    b.constI32(30); b.setLocal(result); b.br(exitBlock);
  b.end(); // exit

  b.getLocal(result);
  const bytes = b.finish();
  const mod = await WebAssembly.instantiate(bytes);
  assert(mod.instance.exports.run(0) === 10, `br_table case 0`);
  assert(mod.instance.exports.run(1) === 20, `br_table case 1`);
  assert(mod.instance.exports.run(2) === 30, `br_table case 2`);
  assert(mod.instance.exports.run(99) === 0, `br_table default`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
