// Investigate why DOOM is stuck in RM at cs=fffe with bytes=[00...] at EIP.
// Hypothesis: A20 issue — code at cs=fffe expects HMA mapping but our emu
// returns 0 for HMA. Or relocator is genuinely running zero-filled memory.
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
function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

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

const cpu = emu.cpu;
const mem = emu.memory;

let ffeStepEntered = -1;
let firstFFEEntry = null;
const ffeBackTrack = [];

const origStep = cpu.step.bind(cpu);
let lastCS = -1;
let pmEntries = 0;
let stepsSampled = 0;

cpu.step = function() {
  const eip = (this.eip >>> 0);
  const cs = this.cs;
  // Capture transition to cs=fffe
  if (cs === 0xfffe && lastCS !== 0xfffe) {
    if (ffeStepEntered < 0) {
      ffeStepEntered = emu.cpuSteps;
      // Snapshot what we know
      const csBase = cs * 16;
      const linEip = csBase + (eip & 0xFFFF);
      firstFFEEntry = {
        step: emu.cpuSteps,
        cs, eip, linEip,
        a20: emu.memory.a20Mask,
        bytes: [...Array(16)].map((_, i) => emu.memory.readU8((linEip + i) >>> 0).toString(16).padStart(2,'0')).join(' '),
      };
      console.log(`\n[FIRST cs=fffe @step=${emu.cpuSteps}] cs=fffe eip=0x${eip.toString(16)} linEip=0x${linEip.toString(16)} a20Mask=0x${emu.memory.a20Mask.toString(16)}`);
      console.log(`  bytes@linEip: ${firstFFEEntry.bytes}`);
    }
  }
  // Track PM transitions
  if (!this.realMode && lastCS === 0xfffe) {
    pmEntries++;
    console.log(`[PM ENTRY @step=${emu.cpuSteps}] cs=${cs.toString(16)} eip=0x${eip.toString(16)}`);
  }
  // Sample bytes at cs=fffe periodically to confirm code is real
  if (cs === 0xfffe && (emu.cpuSteps & 0xFFFFF) === 0 && stepsSampled < 5) {
    const csBase = cs * 16;
    const linEip = csBase + (eip & 0xFFFF);
    const wrapLinEip = (linEip & emu.memory.a20Mask) >>> 0;
    const bytes = [...Array(16)].map((_, i) => emu.memory.readU8((linEip + i) >>> 0).toString(16).padStart(2,'0')).join(' ');
    const wrappedBytes = [...Array(16)].map((_, i) => emu.memory.readU8((wrapLinEip + i) >>> 0).toString(16).padStart(2,'0')).join(' ');
    console.log(`[SAMPLE @step=${emu.cpuSteps}] cs=fffe:0x${eip.toString(16)} linEip=0x${linEip.toString(16)} a20Mask=0x${emu.memory.a20Mask.toString(16)}`);
    console.log(`  raw:     ${bytes}`);
    console.log(`  wrapped: ${wrappedBytes}`);
    stepsSampled++;
  }
  lastCS = cs;
  origStep();
};

emu._pitCycleOnly = true;
emu.run();
const startTime = Date.now();
for (let tick = 0; tick < 5000; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (Date.now() - startTime > 30000) break;
  if (pmEntries > 0 && emu.cpuSteps > ffeStepEntered + 50_000_000) break;
}

console.log(`\n[END] cpuSteps=${emu.cpuSteps} firstFFE@${ffeStepEntered} pmEntries=${pmEntries}`);
console.log(`[A20] mask=0x${emu.memory.a20Mask.toString(16)}`);

// Sample HMA region
console.log('\n[HMA SAMPLE 0x100000..0x100020]:');
for (let i = 0; i < 32; i += 16) {
  const bytes = [...Array(16)].map((_, j) => emu.memory.readU8(0x100000 + i + j).toString(16).padStart(2,'0')).join(' ');
  console.log(`  0x${(0x100000 + i).toString(16)}: ${bytes}`);
}

// Sample bottom of cs=fffe (linear ~0xFFFE0..0x1000E0)
console.log('\n[cs=fffe linear range 0xFFFE0..0x10003F]:');
for (let i = 0; i < 96; i += 16) {
  const addr = 0xFFFE0 + i;
  const bytes = [...Array(16)].map((_, j) => emu.memory.readU8(addr + j).toString(16).padStart(2,'0')).join(' ');
  console.log(`  0x${addr.toString(16)}: ${bytes}`);
}
