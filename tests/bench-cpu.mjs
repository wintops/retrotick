/**
 * RetroTick CPU Benchmark — synthetic x86 micro-benchmarks.
 * Validates correctness (register/memory state) and measures MIPS.
 * Run: npx tsx tests/bench-cpu.mjs
 */
import { performance } from 'perf_hooks';
import { Memory } from '../src/lib/emu/memory.ts';
import { CPU } from '../src/lib/emu/x86/cpu.ts';
import { tryFastLoop } from '../src/lib/emu/fast-loops.ts';

// Memory layout
const CODE = 0x100000;
const STACK = 0x500000;
const SRC = 0x200000;
const DST = 0x300000;
const MAX = 200_000_000;

/** Little-endian 32-bit value as byte array */
function le32(v) {
  return [v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF];
}

/** Create fresh CPU + Memory with minimal emu mock for HLT */
function fresh() {
  const mem = new Memory();
  const cpu = new CPU(mem);
  cpu.eip = CODE;
  cpu.reg[4] = STACK; // ESP
  const emu = { waitingForMessage: false, isDOS: false, _dosHalted: false };
  cpu.emu = emu;
  return { cpu, mem, emu };
}

/** Write byte array to memory */
function wb(mem, addr, bytes) {
  for (let i = 0; i < bytes.length; i++) mem.writeU8((addr + i) >>> 0, bytes[i]);
}

/** Step-by-step runner (no fast-loop) */
function stepRun(cpu, _mem, emu) {
  let n = 0;
  while (!emu.waitingForMessage && !cpu.halted && n < MAX) {
    cpu.step();
    n++;
  }
  return n;
}

/**
 * Fast-loop runner: steps until loopAddr, then calls tryFastLoop directly,
 * then steps remaining instructions. Bypasses periodic detection (which has
 * alignment issues with synthetic benchmarks) and directly tests the FL engine.
 */
function makeFLRunner(loopAddr) {
  return (cpu, mem, emu) => {
    let n = 0;
    // Step setup instructions until we reach the loop start
    while ((cpu.eip >>> 0) !== loopAddr && !emu.waitingForMessage && !cpu.halted && n < 1000) {
      cpu.step();
      n++;
    }
    // Invoke fast-loop engine directly
    const origLog = console.log;
    console.log = () => {}; // suppress [FAST-LOOP] messages
    const it = tryFastLoop(cpu, mem);
    console.log = origLog;
    if (it > 0) n += it;
    // Step remaining (HLT + any residual if FL didn't catch everything)
    while (!emu.waitingForMessage && !cpu.halted && n < MAX) {
      cpu.step();
      n++;
    }
    return n;
  };
}

/** Benchmark harness: warmup + measured runs, reports PASS/FAIL + MIPS */
function bench(label, setup, check, runFn, runs = 5, warmup = 3) {
  // Warmup
  for (let i = 0; i < warmup; i++) {
    const s = setup();
    runFn(s.cpu, s.mem, s.emu);
    const e = check(s.cpu, s.mem);
    if (e) { console.log(`  ${label.padEnd(38)} FAIL (warmup: ${e})`); return; }
  }
  // Measured runs
  const times = [], steps = [];
  for (let i = 0; i < runs; i++) {
    const s = setup();
    const t0 = performance.now();
    const st = runFn(s.cpu, s.mem, s.emu);
    const elapsed = performance.now() - t0;
    const e = check(s.cpu, s.mem);
    if (e) { console.log(`  ${label.padEnd(38)} FAIL (${e})`); return; }
    times.push(elapsed);
    steps.push(st);
  }
  const avgMs = times.reduce((a, b) => a + b) / runs;
  const avgSt = steps.reduce((a, b) => a + b) / runs;
  const mips = avgSt / (avgMs / 1000) / 1e6;
  const std = Math.sqrt(times.map(t => (t - avgMs) ** 2).reduce((a, b) => a + b) / runs);
  const mStd = avgMs > 0 ? mips * std / avgMs : 0;
  console.log(
    `  ${label.padEnd(38)} PASS` +
    `  ${mips.toFixed(1).padStart(7)} MIPS (±${mStd.toFixed(1).padStart(5)})` +
    `  ${avgMs.toFixed(1).padStart(8)}ms`
  );
}

// ═══════════════════════════════════════════════════════════════════
// Suite A: ALU reg-reg — add/xor/sub/dec/jnz × 100K
// Tests: dispatch, ALU, lazy flags, testCC (OPT-1, OPT-3, OPT-7)
// ═══════════════════════════════════════════════════════════════════
function suiteA() {
  const N = 100000;
  //  mov ecx, N
  //  loop: add eax, ebx | xor edx, esi | sub edi, eax | dec ecx | jnz loop
  //  hlt
  const code = [
    0xB9, ...le32(N),
    0x01, 0xD8,       // add eax, ebx
    0x31, 0xF2,       // xor edx, esi
    0x29, 0xC7,       // sub edi, eax
    0x49,             // dec ecx
    0x75, 0xF7,       // jnz loop (back 9)
    0xF4,
  ];
  // JS reference
  let xA = 1, xD = 0, xDI = 0x10000;
  for (let i = 0; i < N; i++) {
    xA = (xA + 2) | 0;
    xD = (xD ^ 0x12345678) | 0;
    xDI = (xDI - xA) | 0;
  }
  const setup = () => {
    const s = fresh();
    wb(s.mem, CODE, code);
    s.cpu.reg[0] = 1;          // EAX
    s.cpu.reg[3] = 2;          // EBX
    s.cpu.reg[2] = 0;          // EDX
    s.cpu.reg[6] = 0x12345678; // ESI
    s.cpu.reg[7] = 0x10000;    // EDI
    return s;
  };
  const check = (cpu) => {
    if (cpu.halted) return `HALT: ${cpu.haltReason}`;
    if ((cpu.reg[1] | 0) !== 0) return `ECX=${cpu.reg[1]} exp 0`;
    if ((cpu.reg[0] | 0) !== xA) return `EAX=${cpu.reg[0]} exp ${xA}`;
    if ((cpu.reg[2] | 0) !== xD) return `EDX=${cpu.reg[2]} exp ${xD}`;
    if ((cpu.reg[7] | 0) !== xDI) return `EDI=${cpu.reg[7]} exp ${xDI}`;
    return null;
  };
  bench('A: ALU reg-reg (100K)', setup, check, stepRun);
}

// ═══════════════════════════════════════════════════════════════════
// Suite B: Memory load/store — mov eax,[esi]; mov [edi],eax × 10K
// Tests: decodeModRM, memory seg cache (OPT-3, OPT-5)
// ═══════════════════════════════════════════════════════════════════
function suiteB() {
  const N = 10000;
  //  mov ecx, N
  //  loop: mov eax,[esi] | mov [edi],eax | add esi,4 | add edi,4 | dec ecx | jnz loop
  //  hlt
  const code = [
    0xB9, ...le32(N),
    0x8B, 0x06,       // mov eax, [esi]
    0x89, 0x07,       // mov [edi], eax
    0x83, 0xC6, 0x04, // add esi, 4
    0x83, 0xC7, 0x04, // add edi, 4
    0x49,             // dec ecx
    0x75, 0xF3,       // jnz loop (back 13)
    0xF4,
  ];
  const setup = () => {
    const s = fresh();
    wb(s.mem, CODE, code);
    for (let i = 0; i < N; i++) s.mem.writeU32((SRC + i * 4) >>> 0, (i + 1) >>> 0);
    s.cpu.reg[6] = SRC; // ESI
    s.cpu.reg[7] = DST; // EDI
    return s;
  };
  const check = (cpu, mem) => {
    if (cpu.halted) return `HALT: ${cpu.haltReason}`;
    if ((cpu.reg[1] | 0) !== 0) return `ECX=${cpu.reg[1]}`;
    const f = mem.readU32(DST);
    if (f !== 1) return `DST[0]=${f} exp 1`;
    const l = mem.readU32((DST + (N - 1) * 4) >>> 0);
    if (l !== N) return `DST[${N - 1}]=${l} exp ${N}`;
    return null;
  };
  bench('B: Mem load/store (10K)', setup, check, stepRun);
}

// ═══════════════════════════════════════════════════════════════════
// Suite D: Conditional branches — cmp/jge/add/dec/jnz × 50K
// Tests: testCC compound conditions (OPT-1)
// ═══════════════════════════════════════════════════════════════════
function suiteD() {
  const N = 50000;
  const HALF = 25000;
  //  mov ecx, N | xor eax, eax | mov ebx, HALF
  //  loop: cmp eax, ebx | jge skip | add eax, 1 | skip: dec ecx | jnz loop
  //  hlt
  const code = [
    0xB9, ...le32(N),
    0x31, 0xC0,             // xor eax, eax
    0xBB, ...le32(HALF),    // mov ebx, HALF
    // loop at CODE+12:
    0x39, 0xD8,             // cmp eax, ebx
    0x7D, 0x03,             // jge skip (+3)
    0x83, 0xC0, 0x01,       // add eax, 1
    // skip at CODE+19:
    0x49,                   // dec ecx
    0x75, 0xF6,             // jnz loop (back 10)
    0xF4,
  ];
  // Expected: eax increments to HALF then stops
  const setup = () => {
    const s = fresh();
    wb(s.mem, CODE, code);
    return s;
  };
  const check = (cpu) => {
    if (cpu.halted) return `HALT: ${cpu.haltReason}`;
    if ((cpu.reg[1] | 0) !== 0) return `ECX=${cpu.reg[1]}`;
    if ((cpu.reg[0] | 0) !== HALF) return `EAX=${cpu.reg[0]} exp ${HALF}`;
    if ((cpu.reg[3] | 0) !== HALF) return `EBX=${cpu.reg[3]} exp ${HALF}`;
    return null;
  };
  bench('D: Cond branches (50K)', setup, check, stepRun);
}

// ═══════════════════════════════════════════════════════════════════
// Suite E: Fast-loop memset — mov [edi],eax; add edi,4; dec ecx; jnz × 50K
// Tests: fast-loop detection and execution (OPT-4, OPT-8, OPT-9, OPT-10)
// ═══════════════════════════════════════════════════════════════════
function suiteE() {
  const N = 50000;
  const FILL = 0xDEADBEEF;
  //  mov ecx, N | mov eax, FILL
  //  loop (CODE+10): mov [edi],eax | add edi,4 | dec ecx | jnz loop
  //  hlt
  const code = [
    0xB9, ...le32(N),
    0xB8, ...le32(FILL),
    // loop at CODE+10:
    0x89, 0x07,       // mov [edi], eax
    0x83, 0xC7, 0x04, // add edi, 4
    0x49,             // dec ecx
    0x75, 0xF8,       // jnz loop (back 8)
    0xF4,
  ];
  const endEDI = (DST + N * 4) | 0;

  const setup = () => {
    const s = fresh();
    wb(s.mem, CODE, code);
    s.cpu.reg[7] = DST; // EDI
    return s;
  };
  const check = (cpu, mem) => {
    if (cpu.halted) return `HALT: ${cpu.haltReason}`;
    if ((cpu.reg[1] | 0) !== 0) return `ECX=${cpu.reg[1]}`;
    if ((cpu.reg[0] | 0) !== (FILL | 0)) return `EAX=0x${(cpu.reg[0]>>>0).toString(16)} exp 0x${(FILL>>>0).toString(16)}`;
    if ((cpu.reg[7] | 0) !== endEDI) return `EDI=0x${(cpu.reg[7]>>>0).toString(16)} exp 0x${(endEDI>>>0).toString(16)}`;
    const f = mem.readU32(DST);
    if (f !== (FILL >>> 0)) return `DST[0]=0x${f.toString(16)} exp 0x${(FILL>>>0).toString(16)}`;
    const l = mem.readU32((DST + (N - 1) * 4) >>> 0);
    if (l !== (FILL >>> 0)) return `DST[last]=0x${l.toString(16)} exp 0x${(FILL>>>0).toString(16)}`;
    return null;
  };

  bench('E: FL memset step (50K)', setup, check, stepRun);
  bench('E: FL memset FL   (50K)', setup, check, makeFLRunner(CODE + 10));
}

// ═══════════════════════════════════════════════════════════════════
// Suite F: Fast-loop checksum — add eax,[esi]; add esi,4; dec ecx; jnz × 10K
// Tests: memory-source ALU in fast loops (OPT-2)
// Before OPT-2: FL bails, falls back to step. After OPT-2: FL catches it.
// ═══════════════════════════════════════════════════════════════════
function suiteF() {
  const N = 10000;
  //  mov ecx, N | xor eax, eax
  //  loop (CODE+7): add eax,[esi] | add esi,4 | dec ecx | jnz loop
  //  hlt
  const code = [
    0xB9, ...le32(N),
    0x31, 0xC0,       // xor eax, eax
    // loop at CODE+7:
    0x03, 0x06,       // add eax, [esi]
    0x83, 0xC6, 0x04, // add esi, 4
    0x49,             // dec ecx
    0x75, 0xF8,       // jnz loop (back 8)
    0xF4,
  ];
  // Source: dwords 1..N, expected sum = N*(N+1)/2
  const expectedSum = (N * (N + 1) / 2) | 0;

  const setup = () => {
    const s = fresh();
    wb(s.mem, CODE, code);
    for (let i = 0; i < N; i++) s.mem.writeU32((SRC + i * 4) >>> 0, (i + 1) >>> 0);
    s.cpu.reg[6] = SRC; // ESI
    return s;
  };
  const check = (cpu) => {
    if (cpu.halted) return `HALT: ${cpu.haltReason}`;
    if ((cpu.reg[1] | 0) !== 0) return `ECX=${cpu.reg[1]}`;
    if ((cpu.reg[0] | 0) !== expectedSum) return `EAX=${cpu.reg[0]} exp ${expectedSum}`;
    return null;
  };

  bench('F: FL checksum step (10K)', setup, check, stepRun);
  bench('F: FL checksum FL   (10K)', setup, check, makeFLRunner(CODE + 7));
}

// ═══════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════
console.log('=== RetroTick CPU Benchmark ===\n');
suiteA();
suiteB();
suiteD();
suiteE();
suiteF();
console.log('\nDone.');
