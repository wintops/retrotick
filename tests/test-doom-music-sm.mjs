// Understand what the music state machine at 0x524282 is doing.
// Dispatch via jump table at 0x524264: [0x524324, 0x5243ae, 0x524404, 0x524435, 0x524477, 0x5244ef, 0x5244fc]
// Check which dispatch target is hit most (music event type).
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
emu.run();

const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);
const entryPoints = { 0x524324: 0, 0x5243ae: 0, 0x524404: 0, 0x524435: 0, 0x524477: 0, 0x5244ef: 0, 0x5244fc: 0,
  0x51fc6f: 0, // tic counter wait loop
  0x524284: 0, // music function prologue
  0x51fc3d: 0, // tic counter incrementer
};
let firstEntryStep = 0;
let lastEntryStep = 0;
let funcEntryCount = 0;
cpu.step = function() {
  if (cpu.cs === 0x168) {
    const eip = cpu.eip >>> 0;
    if (eip === 0x524282) funcEntryCount++;
    if (entryPoints[eip] !== undefined) {
      entryPoints[eip]++;
      if (firstEntryStep === 0) firstEntryStep = emu.cpuSteps;
      lastEntryStep = emu.cpuSteps;
    }
  }
  origStep();
};

for (let tick = 0; tick < 500; tick++) {
  if (emu.halted) break;
  emu.tick();
}
console.log(`[DONE] step=${emu.cpuSteps}`);
console.log(`[Music function entries] to 0x524282: ${funcEntryCount}`);
console.log(`[First dispatch entry step]: ${firstEntryStep}`);
console.log(`[Last dispatch entry step]: ${lastEntryStep}`);
console.log('[Dispatch entry counts]:');
for (const [ep, c] of Object.entries(entryPoints)) {
  console.log(`  0x${Number(ep).toString(16)}: ${c} hits`);
}
