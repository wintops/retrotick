// Trace walker calls + which HW interrupt triggered each one.
// Walker entry: cs=1569:0x0ba4. Dispatch site (RETFD): cs=1569:0x0c38.
// Re-entry point: cs=1569:0x0bb8 (from 0x0c4d JMP).
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
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
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

function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/DoomShw';
const doomBuf = readToArrayBuffer(`${BASE}/DOOM.EXE`);
const peInfo = parsePE(doomBuf);
const emu = new Emulator();
emu.screenWidth = 320; emu.screenHeight = 200;
emu.exeName = 'DoomShw/DOOM.EXE'; emu.exePath = 'D:\\DoomShw\\DOOM.EXE';
for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'DOOM.EXE') emu.additionalFiles.set(fname, readToArrayBuffer(fp));
}
await emu.load(doomBuf, peInfo, mockCanvas);
emu._pitCycleOnly = true; // headless: make PIT fire on cycles
const cs1569_base = 0x15690;
const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);

const WALKER_ENTRY = cs1569_base + 0x0ba4;
const WALKER_REENTRY = cs1569_base + 0x0bb8;
const WALKER_DISPATCH_RETFD = cs1569_base + 0x0c38;
const WALKER_AFTER_RET = cs1569_base + 0x0c3a;  // handler returned here
const WALKER_TEST_EAX = cs1569_base + 0x0c45;   // TEST EAX, EAX
const WALKER_SUCCESS = cs1569_base + 0x0c50;
const HANDLER_F68 = cs1569_base + 0x0f68;
const HANDLER_8A0 = cs1569_base + 0x08a0;
const HANDLER_DCD = cs1569_base + 0x0dcd;
const HANDLER_E6A = cs1569_base + 0x0e6a;

let walkerCount = 0;
let reentryCount = 0;
let handlerHits = { '0xf68': 0, '0x8a0': 0, '0xdcd': 0, '0xe6a': 0 };
let logBudget = 40;
let lastEntryStep = 0;
let lastEdi = -1;

cpu.step = function() {
  const eip = cpu.eip >>> 0;
  if (cpu.cs === 0x1569 && !cpu.realMode) {
    if (eip === WALKER_ENTRY && logBudget > 0) {
      walkerCount++;
      const bp = cpu.reg[5] >>> 0;
      const ssBase = cpu.segBase(cpu.ss);
      const bp_lin = (ssBase + (bp & 0xFFFF)) >>> 0;
      const arg_edi = emu.memory.readU16(bp_lin + 6); // would-be arg at [BP+6]
      const arg_esi = emu.memory.readU16(bp_lin + 8); // [BP+8]
      const esp = cpu.reg[4] >>> 0;
      const retAddr_lin = (ssBase + ((esp) & 0xFFFF)) >>> 0;
      const retIp = emu.memory.readU16(retAddr_lin);
      const retCs = emu.memory.readU16(retAddr_lin + 2);
      logBudget--;
      console.log(`[W #${walkerCount}] step=${emu.cpuSteps} arg[BP+6]=0x${arg_edi.toString(16)} [BP+8]=0x${arg_esi.toString(16)} ret=${retCs.toString(16)}:${retIp.toString(16)}`);
      lastEntryStep = emu.cpuSteps;
    } else if (eip === WALKER_REENTRY && logBudget > 0) {
      reentryCount++;
      if (reentryCount <= 20) {
        const edi = cpu.reg[7] >>> 0;
        console.log(`  [re-entry #${reentryCount}] step=${emu.cpuSteps} EDI=0x${edi.toString(16)} (prev EDI=0x${lastEdi.toString(16)})`);
        lastEdi = edi;
      }
    } else if (eip === WALKER_TEST_EAX) {
      // Handler just returned; EAX has its return value.
      const eax = cpu.reg[0] >>> 0;
      const edi = cpu.reg[7] >>> 0;
      if (!globalThis.__testEaxCount) globalThis.__testEaxCount = 0;
      globalThis.__testEaxCount++;
      if (globalThis.__testEaxCount <= 10) {
        console.log(`  [TEST EAX=0x${eax.toString(16)}] step=${emu.cpuSteps} EDI=0x${edi.toString(16)} (${eax===0 ? 'SUCCESS EXIT' : 'RE-ENTER'})`);
      }
    } else if (eip === HANDLER_F68) {
      handlerHits['0xf68']++;
      if (handlerHits['0xf68'] <= 3) console.log(`[HANDLER 0xf68 = 1001-error-thunk] step=${emu.cpuSteps}`);
    } else if (eip === HANDLER_8A0) {
      handlerHits['0x8a0']++;
      if (handlerHits['0x8a0'] <= 3) console.log(`[HANDLER 0x8a0] step=${emu.cpuSteps} arg[BP+8]=0x${emu.memory.readU16(((cpu.segBase(cpu.ss)) + ((cpu.reg[5] + 8) & 0xFFFF)) >>> 0).toString(16)}`);
    } else if (eip === HANDLER_DCD) {
      handlerHits['0xdcd']++;
    } else if (eip === HANDLER_E6A) {
      handlerHits['0xe6a']++;
    }
  }
  origStep();
};

emu.run();
for (let tick = 0; tick < 200; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 50_000_000) break;
}
console.log(`\n[SUMMARY] walker entries=${walkerCount} re-entries=${reentryCount}`);
console.log('[Handler hits]:');
for (const [k, v] of Object.entries(handlerHits)) console.log(`  ${k}: ${v}`);
console.log(`[END] step=${emu.cpuSteps} halted=${emu.halted}`);
