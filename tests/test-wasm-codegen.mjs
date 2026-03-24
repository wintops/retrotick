/**
 * Comprehensive WASM JIT codegen tests — verifies that each supported x86 opcode
 * produces correct results when compiled to WASM and executed.
 */
import { Memory } from '../src/lib/emu/memory.ts';
import { FlatMemory, OFF_REGS, OFF_FLAGS, OFF_EIP, OFF_EXIT, OFF_ENTRY, OFF_COUNTER, OFF_SEGBASES } from '../src/lib/emu/x86/flat-memory.ts';
import { compileWasmRegion } from '../src/lib/emu/x86/wasm-module.ts';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`[FAIL] ${msg}`); failed++; }
  else { console.log(`[PASS] ${msg}`); passed++; }
}

function writeBytes(mem, addr, bytes) {
  for (let i = 0; i < bytes.length; i++) mem.writeU8(addr + i, bytes[i]);
}

/** Helper: compile x86 bytes at 0x1000 (32-bit mode), set regs, run, return flat */
async function run32(bytes, regs = {}) {
  const mem = new Memory();
  const flat = new FlatMemory();
  writeBytes(mem, 0x1000, bytes);
  flat.syncToFlat(mem);
  // Set registers
  const regIdx = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7 };
  for (const [name, val] of Object.entries(regs)) {
    flat.dv.setInt32(OFF_REGS + regIdx[name] * 4, val, true);
  }
  // Set segment bases to 0 (flat model)
  for (let i = 0; i < 4; i++) flat.dv.setUint32(OFF_SEGBASES + i * 4, 0, true);

  const region = await compileWasmRegion(mem, 0x1000, true, flat);
  if (!region) return null;
  flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x1000), true);
  region.run();
  return {
    eax: flat.dv.getInt32(OFF_REGS, true),
    ecx: flat.dv.getInt32(OFF_REGS + 4, true),
    edx: flat.dv.getInt32(OFF_REGS + 8, true),
    ebx: flat.dv.getInt32(OFF_REGS + 12, true),
    esp: flat.dv.getInt32(OFF_REGS + 16, true),
    ebp: flat.dv.getInt32(OFF_REGS + 20, true),
    esi: flat.dv.getInt32(OFF_REGS + 24, true),
    edi: flat.dv.getInt32(OFF_REGS + 28, true),
    eip: flat.dv.getUint32(OFF_EIP, true),
    counter: flat.dv.getInt32(OFF_COUNTER, true),
    lazyOp: flat.dv.getInt32(OFF_FLAGS, true),
    lazyResult: flat.dv.getInt32(OFF_FLAGS + 4, true),
    readMem32: (addr) => flat.dv.getUint32(addr, true),
    readMem16: (addr) => flat.dv.getUint16(addr, true),
    readMem8: (addr) => flat.dv.getUint8(addr),
  };
}

// ========== MOV variants ==========

// MOV r8, imm8 (B0-B7)
{
  // MOV AL, 0x42; MOV CH, 0xAB; RET
  const r = await run32([0xB0, 0x42, 0xB5, 0xAB, 0xC3], { eax: 0xFF00, ecx: 0 });
  assert(r && (r.eax & 0xFF) === 0x42, `MOV AL,0x42: AL=${r ? (r.eax&0xFF).toString(16) : 'null'}`);
  assert(r && ((r.ecx >> 8) & 0xFF) === 0xAB, `MOV CH,0xAB: CH=${r ? ((r.ecx>>8)&0xFF).toString(16) : 'null'}`);
  // Verify high bytes of EAX preserved
  assert(r && (r.eax & 0xFF00) === 0xFF00, `MOV AL preserves AH: ${r ? (r.eax&0xFF00).toString(16) : 'null'}`);
}

// MOV r/m8, reg8 (0x88) reg-reg
{
  // MOV CL, AL; RET
  const r = await run32([0x88, 0xC1, 0xC3], { eax: 0x55, ecx: 0 });
  assert(r && (r.ecx & 0xFF) === 0x55, `MOV CL,AL: CL=${r ? (r.ecx&0xFF).toString(16) : 'null'}`);
}

// MOV reg8, r/m8 (0x8A) reg-reg
{
  // MOV AL, BL; RET
  const r = await run32([0x8A, 0xC3, 0xC3], { eax: 0, ebx: 0xAA });
  assert(r && (r.eax & 0xFF) === 0xAA, `MOV AL,BL: AL=${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// MOV r/m, imm (0xC7) reg
{
  // MOV EBX, 0x12345678; RET  (C7 C3 78 56 34 12; C3)
  const r = await run32([0xC7, 0xC3, 0x78, 0x56, 0x34, 0x12, 0xC3], { ebx: 0 });
  assert(r && (r.ebx >>> 0) === 0x12345678, `MOV EBX,imm32: EBX=0x${r ? (r.ebx>>>0).toString(16) : 'null'}`);
}

// MOV r/m8, imm8 (0xC6) reg
{
  // MOV DL, 0x99; RET  (C6 C2 99; C3)
  const r = await run32([0xC6, 0xC2, 0x99, 0xC3], { edx: 0 });
  assert(r && (r.edx & 0xFF) === 0x99, `MOV DL,0x99: DL=0x${r ? (r.edx&0xFF).toString(16) : 'null'}`);
}

// ========== ALU: ADD/SUB/AND/OR/XOR/CMP ==========

// ADD EAX, imm32 (0x05)
{
  const r = await run32([0x05, 0x00, 0x01, 0x00, 0x00, 0xC3], { eax: 0x100 });
  assert(r && r.eax === 0x200, `ADD EAX,0x100: EAX=${r?.eax}`);
}

// AND EAX, imm32 (0x25)
{
  const r = await run32([0x25, 0x0F, 0x0F, 0x00, 0x00, 0xC3], { eax: 0xABCD });
  assert(r && r.eax === 0x0B0D, `AND EAX,0x0F0F: EAX=0x${r?.eax.toString(16)}`);
}

// TEST EAX, imm32 (0xA9) — doesn't modify EAX
{
  const r = await run32([0xA9, 0xFF, 0x00, 0x00, 0x00, 0xC3], { eax: 0x1234 });
  assert(r && r.eax === 0x1234, `TEST EAX,imm: EAX unchanged=${r?.eax}`);
}

// Group 83: SUB reg, imm8
{
  const r = await run32([0x83, 0xEB, 0x0A, 0xC3], { ebx: 100 });
  assert(r && r.ebx === 90, `SUB EBX,10: EBX=${r?.ebx}`);
}

// Group 83: CMP reg, imm8 — doesn't modify reg
{
  const r = await run32([0x83, 0xFB, 0x05, 0xC3], { ebx: 10 });
  assert(r && r.ebx === 10, `CMP EBX,5: EBX unchanged=${r?.ebx}`);
}

// Group 81: ADD reg, imm32
{
  // ADD ECX, 0x10000; RET  (81 C1 00 00 01 00; C3)
  const r = await run32([0x81, 0xC1, 0x00, 0x00, 0x01, 0x00, 0xC3], { ecx: 0x5000 });
  assert(r && r.ecx === 0x15000, `ADD ECX,0x10000: ECX=0x${r?.ecx.toString(16)}`);
}

// Group 81: SUB reg, imm32
{
  // SUB EDX, 0x100; RET  (81 EA 00 01 00 00; C3)
  const r = await run32([0x81, 0xEA, 0x00, 0x01, 0x00, 0x00, 0xC3], { edx: 0x500 });
  assert(r && r.edx === 0x400, `SUB EDX,0x100: EDX=0x${r?.edx.toString(16)}`);
}

// Group 81: AND reg, imm32
{
  // AND EAX, 0xFF00; RET  (81 E0 00 FF 00 00; C3)
  const r = await run32([0x81, 0xE0, 0x00, 0xFF, 0x00, 0x00, 0xC3], { eax: 0xABCD });
  assert(r && r.eax === 0xAB00, `AND EAX,0xFF00: EAX=0x${r?.eax.toString(16)}`);
}

// Group 81: CMP reg, imm32 — doesn't modify reg
{
  // CMP EAX, 0x1000; RET  (81 F8 00 10 00 00; C3)
  const r = await run32([0x81, 0xF8, 0x00, 0x10, 0x00, 0x00, 0xC3], { eax: 0x2000 });
  assert(r && r.eax === 0x2000, `CMP EAX,0x1000: EAX unchanged=${r?.eax}`);
}

// Group 80: ADD r8, imm8
{
  // ADD AL, 0x10; RET  (80 C0 10; C3)
  const r = await run32([0x80, 0xC0, 0x10, 0xC3], { eax: 0x30 });
  assert(r && (r.eax & 0xFF) === 0x40, `ADD AL,0x10: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// Group 80: CMP r8, imm8 — doesn't modify reg
{
  // CMP BL, 0x05; RET  (80 FB 05; C3)
  const r = await run32([0x80, 0xFB, 0x05, 0xC3], { ebx: 0x42 });
  assert(r && (r.ebx & 0xFF) === 0x42, `CMP BL,5: BL unchanged=0x${r ? (r.ebx&0xFF).toString(16) : 'null'}`);
}

// 8-bit ALU: XOR AL, BL (0x30 = XOR r/m8, reg8)
{
  // XOR CL, DL; RET  (30 D1; C3)
  const r = await run32([0x30, 0xD1, 0xC3], { ecx: 0xFF, edx: 0x0F });
  assert(r && (r.ecx & 0xFF) === 0xF0, `XOR CL,DL: CL=0x${r ? (r.ecx&0xFF).toString(16) : 'null'}`);
}

// ========== Shifts ==========

// SHL EAX, imm8 (C1 /4)
{
  // SHL EAX, 4; RET  (C1 E0 04; C3)
  const r = await run32([0xC1, 0xE0, 0x04, 0xC3], { eax: 0x123 });
  assert(r && r.eax === 0x1230, `SHL EAX,4: EAX=0x${r?.eax.toString(16)}`);
}

// SHR EAX, imm8 (C1 /5)
{
  // SHR EAX, 8; RET  (C1 E8 08; C3)
  const r = await run32([0xC1, 0xE8, 0x08, 0xC3], { eax: 0xABCD });
  assert(r && r.eax === 0xAB, `SHR EAX,8: EAX=0x${r?.eax.toString(16)}`);
}

// SAR EAX, imm8 (C1 /7) — arithmetic shift preserves sign
{
  // SAR EAX, 4; RET  (C1 F8 04; C3)
  const r = await run32([0xC1, 0xF8, 0x04, 0xC3], { eax: -16 }); // 0xFFFFFFF0
  assert(r && r.eax === -1, `SAR EAX,4 (neg): EAX=${r?.eax}`);
}

// SHL reg, 1 (D1 /4)
{
  // SHL EBX, 1; RET  (D1 E3; C3)
  const r = await run32([0xD1, 0xE3, 0xC3], { ebx: 0x80 });
  assert(r && r.ebx === 0x100, `SHL EBX,1: EBX=0x${r?.ebx.toString(16)}`);
}

// ========== PUSH imm ==========

// PUSH imm8 sign-extended (0x6A)
{
  // PUSH -1 (6A FF); POP EAX (58); RET (C3)
  const r = await run32([0x6A, 0xFF, 0x58, 0xC3], { esp: 0x10000 });
  assert(r && r.eax === -1, `PUSH imm8 -1: EAX=${r?.eax}`);
  assert(r && r.esp === 0x10000, `PUSH/POP balanced ESP`);
}

// PUSH imm32 (0x68)
{
  // PUSH 0xDEADBEEF (68 EF BE AD DE); POP EBX (5B); RET (C3)
  const r = await run32([0x68, 0xEF, 0xBE, 0xAD, 0xDE, 0x5B, 0xC3], { esp: 0x10000 });
  assert(r && (r.ebx >>> 0) === 0xDEADBEEF, `PUSH imm32: EBX=0x${r ? (r.ebx>>>0).toString(16) : 'null'}`);
}

// ========== Port I/O ==========

// IN AL, imm8 (0xE4) — portIn import returns 0xFF by default
{
  // IN AL, 0x60; RET  (E4 60; C3)
  const r = await run32([0xE4, 0x60, 0xC3], { eax: 0 });
  // Default portIn returns 0xFF
  assert(r && (r.eax & 0xFF) === 0xFF, `IN AL,0x60: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// IN AL, DX (0xEC)
{
  // IN AL, DX; RET  (EC; C3)
  const r = await run32([0xEC, 0xC3], { eax: 0, edx: 0x3DA });
  assert(r && (r.eax & 0xFF) === 0xFF, `IN AL,DX: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// ========== Group FE: INC/DEC r/m8 ==========

// INC AL (FE C0)
{
  const r = await run32([0xFE, 0xC0, 0xC3], { eax: 0x41 });
  assert(r && (r.eax & 0xFF) === 0x42, `INC AL: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// DEC CL (FE C9)
{
  const r = await run32([0xFE, 0xC9, 0xC3], { ecx: 0x10 });
  assert(r && (r.ecx & 0xFF) === 0x0F, `DEC CL: CL=0x${r ? (r.ecx&0xFF).toString(16) : 'null'}`);
}

// ========== Group FF: INC/DEC/PUSH r/m ==========

// INC ECX (FF C1)
{
  const r = await run32([0xFF, 0xC1, 0xC3], { ecx: 99 });
  assert(r && r.ecx === 100, `INC ECX (FF): ECX=${r?.ecx}`);
}

// DEC EDX (FF CA)
{
  const r = await run32([0xFF, 0xCA, 0xC3], { edx: 100 });
  assert(r && r.edx === 99, `DEC EDX (FF): EDX=${r?.edx}`);
}

// PUSH reg via FF /6
{
  // PUSH EAX (FF F0); POP EBX (5B); RET (C3)
  const r = await run32([0xFF, 0xF0, 0x5B, 0xC3], { eax: 0xBEEF, esp: 0x10000 });
  assert(r && (r.ebx >>> 0) === 0xBEEF, `PUSH EAX (FF /6): EBX=0x${r ? (r.ebx>>>0).toString(16) : 'null'}`);
}

// ========== Group F6/F7: TEST/NOT/NEG ==========

// TEST AL, imm8 (F6 /0) — doesn't modify reg
{
  // TEST AL, 0x01; RET  (F6 C0 01; C3)
  const r = await run32([0xF6, 0xC0, 0x01, 0xC3], { eax: 0x55 });
  assert(r && r.eax === 0x55, `TEST AL,1: EAX unchanged=${r?.eax}`);
}

// NOT AL (F6 /2)
{
  // NOT AL; RET  (F6 D0; C3)
  const r = await run32([0xF6, 0xD0, 0xC3], { eax: 0xF0 });
  assert(r && (r.eax & 0xFF) === 0x0F, `NOT AL: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// NEG AL (F6 /3)
{
  // NEG AL; RET  (F6 D8; C3)
  const r = await run32([0xF6, 0xD8, 0xC3], { eax: 0x05 });
  assert(r && (r.eax & 0xFF) === 0xFB, `NEG AL: AL=0x${r ? (r.eax&0xFF).toString(16) : 'null'}`);
}

// NOT EAX (F7 /2)
{
  // NOT EAX; RET  (F7 D0; C3)
  const r = await run32([0xF7, 0xD0, 0xC3], { eax: 0 });
  assert(r && (r.eax >>> 0) === 0xFFFFFFFF, `NOT EAX: EAX=0x${r ? (r.eax>>>0).toString(16) : 'null'}`);
}

// NEG EAX (F7 /3)
{
  // NEG EAX; RET  (F7 D8; C3)
  const r = await run32([0xF7, 0xD8, 0xC3], { eax: 1 });
  assert(r && r.eax === -1, `NEG EAX: EAX=${r?.eax}`);
}

// TEST EAX, imm32 (F7 /0)
{
  // TEST EAX, 0xFF; RET  (F7 C0 FF 00 00 00; C3)
  const r = await run32([0xF7, 0xC0, 0xFF, 0x00, 0x00, 0x00, 0xC3], { eax: 0x1234 });
  assert(r && r.eax === 0x1234, `TEST EAX,imm32: EAX unchanged=${r?.eax}`);
}

// ========== Memory operations (32-bit addressing) ==========

// MOV [mem], reg (0x89) with [EBX+disp8]
{
  // MOV [EBX+0x10], EAX; RET  (89 43 10; C3)
  const r = await run32([0x89, 0x43, 0x10, 0xC3], { eax: 0xCAFE, ebx: 0x5000 });
  assert(r && r.readMem32(0x5010) === 0xCAFE, `MOV [EBX+0x10],EAX: mem=0x${r?.readMem32(0x5010).toString(16)}`);
}

// MOV reg, [mem] (0x8B) with [ESI]
{
  const mem = new Memory();
  const flat = new FlatMemory();
  writeBytes(mem, 0x1000, [0x8B, 0x06, 0xC3]); // MOV EAX, [ESI]; RET
  flat.syncToFlat(mem);
  flat.dv.setInt32(OFF_REGS + 24, 0x4000, true); // ESI = 0x4000
  flat.dv.setUint32(0x4000, 0xBAADF00D, true); // [ESI] = 0xBAADF00D
  for (let i = 0; i < 4; i++) flat.dv.setUint32(OFF_SEGBASES + i * 4, 0, true);
  const region = await compileWasmRegion(mem, 0x1000, true, flat);
  if (region) {
    flat.dv.setInt32(OFF_ENTRY, region.entryMap.get(0x1000), true);
    region.run();
    const eax = flat.dv.getUint32(OFF_REGS, true);
    assert(eax === 0xBAADF00D, `MOV EAX,[ESI]: got 0x${eax.toString(16)}`);
  } else {
    assert(false, `MOV EAX,[ESI]: compilation failed`);
  }
}

// ========== Counter test ==========
{
  // 5 NOPs + RET → counter should be 5
  const r = await run32([0x90, 0x90, 0x90, 0x90, 0x90, 0xC3]);
  assert(r && r.counter === 5, `counter: 5 NOPs → counter=${r?.counter}`);
}

// ========== Combined: realistic sequence ==========
{
  // MOV ECX, 10; MOV EAX, 0; loop: ADD EAX, ECX; DEC ECX; ... bail (unsupported Jcc)
  // We can't test the loop (Jcc bails), but the linear part should work:
  // MOV ECX, 10 (B9 0A 00 00 00); MOV EAX, 0 (B8 00 00 00 00);
  // ADD EAX, ECX (01 C8); DEC ECX (49); RET (C3)
  const r = await run32([
    0xB9, 0x0A, 0x00, 0x00, 0x00,  // MOV ECX, 10
    0xB8, 0x00, 0x00, 0x00, 0x00,  // MOV EAX, 0
    0x01, 0xC8,                      // ADD EAX, ECX
    0x49,                            // DEC ECX
    0xC3                             // RET
  ]);
  assert(r && r.eax === 10, `ADD+DEC sequence: EAX=${r?.eax}`);
  assert(r && r.ecx === 9, `ADD+DEC sequence: ECX=${r?.ecx}`);
}

// ========== Address masking: high addresses don't OOB ==========
{
  // MOV EBX, 0xFFFFFF00; MOV EAX, [EBX]; RET — should not crash (addr masked to 128MB)
  const r = await run32([
    0xBB, 0x00, 0xFF, 0xFF, 0xFF,  // MOV EBX, 0xFFFFFF00
    0x8B, 0x03,                      // MOV EAX, [EBX]
    0xC3                             // RET
  ]);
  assert(r !== null, `high address load: no crash`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
