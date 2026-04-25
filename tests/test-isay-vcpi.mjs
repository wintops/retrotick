// Test harness: ISAY.EXE (EOS demo) VCPI PM transition. Used to regression-check
// DOOM/EOS-family post-VCPI bugs. When the PM code enters zero pages (100% zero-code
// bytes + very scattered EIPs) after DE0C, the test fails. Currently FAILS because
// EOS PM code does an intentional CALL FAR 0:0 at cs=0x18:0x35CE that would need a
// #GP handler or emulation of system memory at 0xF0000xxx for proper dispatch.
import { readFileSync, readdirSync, statSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
  measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop,
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  setTransform: noop, resetTransform: noop, transform: noop,
  beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
  arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop,
  createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top',
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent', canvas: null,
};
const mockCanvas = { width: 640, height: 480, getContext: () => mockCtx, toDataURL: () => 'data:image/png;base64,', addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/MC/Isay';
const exeBuf = readToArrayBuffer(`${BASE}/ISAY.EXE`);
const peInfo = parsePE(exeBuf);
const emu = new Emulator();
emu.screenWidth = 640; emu.screenHeight = 480;
emu.exeName = 'isay.exe'; emu.exePath = 'D:\\test\\ISAY.EXE';
emu.dosEnableDpmi = false; emu.dosEnableV86 = true;

for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname.toLowerCase() !== 'isay.exe') emu.additionalFiles.set(fname, readToArrayBuffer(fp));
}
await emu.load(exeBuf, peInfo, mockCanvas);
emu.run();

// Track: did we execute any non-zero code page after PM entry?
let pmSteps = 0;
let nonZeroCodeSteps = 0;
let zeroCodeSteps = 0;
let stepNum = 0;
let lastCS = 0, lastEIP = 0;
let wasPM = false;
const pmEipSet = new Set();
const pmInitialTrace = []; // first 30 PM steps — most important
const pmTransitions = []; // detected far jumps / cs changes within PM
// Rolling ring buffer of last 60 PM steps
const RING_SIZE = 60;
const pmRing = [];
let pmRingIdx = 0;
let pmRingFull = false;
let badTransitionCaptured = false;
let badTransitionSnapshot = null;
// Track writes to the memory range where cs=0x18 code lives.
// We'll detect this range after first PM entry.
let cs18Base = -1;
const cs18CallFarBytesOverTime = []; // watch bytes at cs=0x18:0x35CE

const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function() {
  const eip = this.eip >>> 0;
  const cs = this.cs;
  // Detect PM mode: realMode=false (our emu state)
  if (!this.realMode) {
    pmSteps++;
    // Snapshot cs=0x18 base + descriptor on first PM step
    if (cs18Base < 0 && cs === 0x18) {
      cs18Base = this.segBase(0x18);
      const gdtBase = this.emu._gdtBase;
      const descAddr = gdtBase + 0x18;
      const lo = this.mem.readU32(descAddr);
      const hi = this.mem.readU32(descAddr + 4);
      const baseLo = (lo >>> 16) & 0xFFFF;
      const baseMid = hi & 0xFF;
      const baseHi = (hi >>> 24) & 0xFF;
      const base = (baseHi << 24) | (baseMid << 16) | baseLo;
      const limLo = lo & 0xFFFF;
      const limHi = (hi >>> 16) & 0x0F;
      let limit = (limHi << 16) | limLo;
      const gBit = (hi >>> 23) & 1;
      if (gBit) limit = ((limit + 1) << 12) - 1;
      const dBit = (hi >>> 22) & 1;
      const type = (hi >>> 8) & 0xFF;
      console.log(`[BASE] cs=0x18 base=0x${cs18Base.toString(16)} limit=0x${limit.toString(16)} D=${dBit} G=${gBit} type=0x${type.toString(16)}`);
      // Also dump bytes at base + 0xC4E (= linear 0x35CE) and at linear 0x35CE directly (should be same)
      console.log(`[BYTES] base+0xC4E (linear 0x${(cs18Base + 0xC4E).toString(16)}): ${[...Array(8)].map((_,i) => this.mem.readU8(cs18Base + 0xC4E + i).toString(16).padStart(2,'0')).join(' ')}`);
      // Also check: does cpu.eip match linear 0x2BEA or offset 0x2BEA?
      console.log(`[EIP] this.eip=0x${eip.toString(16)} -- if linear: offset = 0x${(eip - cs18Base).toString(16)}; if offset: linear = 0x${(eip + cs18Base).toString(16)}`);
    }
    // Track bytes at linear 0x35CE over time (= cs=0x18 offset 0xC4E)
    // This is where the CALL FAR 0:0 instruction is seen.
    if (pmSteps % 5000 === 0 || pmSteps === 1) {
      const bytes = [];
      for (let i = 0; i < 8; i++) bytes.push(this.mem.readU8((0x35CE + i) >>> 0).toString(16).padStart(2, '0'));
      cs18CallFarBytesOverTime.push({ pmStep: pmSteps, linear: 0x35CE, bytes: bytes.join(' ') });
    }
    // Capture first 30 PM steps
    if (pmInitialTrace.length < 30) {
      const bytes = [];
      for (let i = 0; i < 10; i++) bytes.push(this.mem.readU8((eip + i) >>> 0).toString(16).padStart(2, '0'));
      pmInitialTrace.push({
        stepNum, cs, eip,
        use32: this.use32,
        eax: this.reg[0]>>>0, ebx: this.reg[3]>>>0, ecx: this.reg[1]>>>0, edx: this.reg[2]>>>0,
        esi: this.reg[6]>>>0, edi: this.reg[7]>>>0, ebp: this.reg[5]>>>0, esp: this.reg[4]>>>0,
        ds: this.ds, es: this.es, ss: this.ss, fs: this.fs, gs: this.gs,
        bytes: bytes.join(' '),
      });
    }
    // Rolling ring: every PM step
    const ringEntry = { cs, eip, eax: this.reg[0]>>>0, esp: this.reg[4]>>>0 };
    let bs = '';
    for (let i = 0; i < 6; i++) bs += this.mem.readU8((eip + i) >>> 0).toString(16).padStart(2, '0') + ' ';
    ringEntry.bytes = bs.trim();
    pmRing[pmRingIdx] = ringEntry;
    pmRingIdx = (pmRingIdx + 1) % RING_SIZE;
    if (pmRingIdx === 0) pmRingFull = true;

    // Capture ring at bad transition (cs going to 0)
    if (wasPM && cs !== lastCS && cs === 0 && !badTransitionCaptured) {
      badTransitionCaptured = true;
      const out = [];
      const start = pmRingFull ? pmRingIdx : 0;
      const count = pmRingFull ? RING_SIZE : pmRingIdx;
      for (let i = 0; i < count; i++) {
        const idx = (start + i) % RING_SIZE;
        out.push(pmRing[idx]);
      }
      badTransitionSnapshot = out;
    }

    // Track CS changes in PM — capture bytes at the source EIP
    if (wasPM && cs !== lastCS && pmTransitions.length < 1000) {
      const srcBytes = [];
      for (let i = -4; i < 12; i++) {
        srcBytes.push(this.mem.readU8((lastEIP + i) >>> 0).toString(16).padStart(2, '0'));
      }
      const dstBytes = [];
      for (let i = 0; i < 16; i++) {
        dstBytes.push(this.mem.readU8((eip + i) >>> 0).toString(16).padStart(2, '0'));
      }
      pmTransitions.push({
        stepNum, fromCS: lastCS, fromEIP: lastEIP, toCS: cs, toEIP: eip,
        srcBytes: srcBytes.join(' '), dstBytes: dstBytes.join(' '),
        esp: this.reg[4]>>>0, ss: this.ss,
      });
    }
    wasPM = true;
    const b0 = this.mem.readU8(eip);
    const b1 = this.mem.readU8((eip + 1) >>> 0);
    const b2 = this.mem.readU8((eip + 2) >>> 0);
    const b3 = this.mem.readU8((eip + 3) >>> 0);
    if ((b0 | b1 | b2 | b3) === 0) zeroCodeSteps++;
    else nonZeroCodeSteps++;
    pmEipSet.add(`${cs.toString(16)}:${eip.toString(16)}`);
  } else {
    wasPM = false;
  }
  lastCS = cs;
  lastEIP = eip;
  origStep();
  stepNum++;
};

const MAX_TICKS = 400;
let totalTicks = 0;
for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) break;
  emu.tick();
  totalTicks++;
}

const pmZeroRatio = pmSteps > 0 ? (zeroCodeSteps / pmSteps * 100).toFixed(1) : 'N/A';
console.log(`[RESULT] steps=${stepNum}, ticks=${totalTicks}, halted=${emu.halted}`);
console.log(`  PM steps: ${pmSteps}, zero-code: ${zeroCodeSteps} (${pmZeroRatio}%), non-zero: ${nonZeroCodeSteps}`);
console.log(`  Last state: cs=0x${lastCS.toString(16)} eip=0x${lastEIP.toString(16)} RM=${emu.cpu.realMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);

console.log(`\n[FIRST 30 PM STEPS]:`);
for (const s of pmInitialTrace) {
  console.log(`  step=${s.stepNum} cs=${s.cs.toString(16)}:${s.eip.toString(16)}(32=${s.use32}) eax=${s.eax.toString(16)} ebx=${s.ebx.toString(16)} ecx=${s.ecx.toString(16)} edx=${s.edx.toString(16)}`);
  console.log(`    esi=${s.esi.toString(16)} edi=${s.edi.toString(16)} ebp=${s.ebp.toString(16)} esp=${s.esp.toString(16)} ds=${s.ds.toString(16)} es=${s.es.toString(16)} ss=${s.ss.toString(16)}`);
  console.log(`    bytes: [${s.bytes}]`);
}

console.log(`\n[cs=0x18:0x35CE bytes over time]:`);
for (const s of cs18CallFarBytesOverTime.slice(0, 10)) {
  console.log(`  pmStep=${s.pmStep} linear=0x${s.linear.toString(16)}: ${s.bytes}`);
}

if (badTransitionSnapshot) {
  console.log(`\n[LAST ${badTransitionSnapshot.length} PM STEPS BEFORE cs=0 BAD TRANSITION]:`);
  for (const s of badTransitionSnapshot) {
    console.log(`  cs=${s.cs.toString(16)}:${s.eip.toString(16)} eax=${s.eax.toString(16)} esp=${s.esp.toString(16)} [${s.bytes}]`);
  }
}

console.log(`\n[PM CS TRANSITIONS]: ${pmTransitions.length}`);
for (const t of pmTransitions.slice(0, 10)) {
  console.log(`  step=${t.stepNum} cs=${t.fromCS.toString(16)}:${t.fromEIP.toString(16)} → cs=${t.toCS.toString(16)}:${t.toEIP.toString(16)} ss=${t.ss.toString(16)} esp=${t.esp.toString(16)}`);
  console.log(`    src bytes (lastEIP-4..+12): ${t.srcBytes}`);
  console.log(`    dst bytes (eip..+16): ${t.dstBytes}`);
}

// Pass criteria:
//   - PM entered (pmSteps > 0)
//   - Mostly non-zero code in PM (<5% zero pages)
//   - Multiple unique EIPs (not stuck at one spot)
const passed = pmSteps > 10000 && parseFloat(pmZeroRatio) < 5 && pmEipSet.size > 50;
if (passed) {
  console.log('[TEST PASS] ISAY entered PM and runs real code');
} else {
  console.log('[TEST FAIL] ISAY hang pattern detected');
}
process.exit(passed ? 0 : 1);
