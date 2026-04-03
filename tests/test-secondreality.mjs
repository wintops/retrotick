import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

// Mock Canvas/OffscreenCanvas for headless Node.js
const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
  drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  setTransform: noop, resetTransform: noop, transform: noop,
  beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
  arc: noop, arcTo: noop, rect: noop, ellipse: noop,
  fill: noop, stroke: noop, clip: noop,
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null,
  font: '', textAlign: 'left', textBaseline: 'top',
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent',
  canvas: null,
};
const mockCanvas = {
  width: 320, height: 200,
  getContext: () => mockCtx,
  toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop,
  removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;

globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { ...mockCtx, canvas: this }; }
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

// Helper: read file into proper ArrayBuffer
function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/2nd_real';

const secondBuf = readToArrayBuffer(`${BASE}/SECOND.EXE`);
const realityBuf = readToArrayBuffer(`${BASE}/REALITY.FC`);
const peInfo = parsePE(secondBuf);
console.log(`[INIT] peInfo: isMZ=${peInfo.isMZ} isCOM=${peInfo.isCOM} isPE=${!!peInfo.pe}`);

const emu = new Emulator();
emu.screenWidth = 320;
emu.screenHeight = 200;
emu.exeName = '2nd_real/SECOND.EXE';
emu.exePath = 'D:\\2nd_real\\SECOND.EXE';
// REALITY.FC must be findable by file_int's fallback to dosOpenFile
emu.additionalFiles.set('REALITY.FC', realityBuf);

await emu.load(secondBuf, peInfo, mockCanvas);
emu.run();

// Helper: dump MCB chain
function dumpMcb(emu) {
  const mem = emu.cpu.mem;
  const first = emu._dosMcbFirstSeg || 0x0060;
  let seg = first;
  const parts = [];
  for (let i = 0; i < 200; i++) {
    const lin = seg * 16;
    const t = String.fromCharCode(mem.readU8(lin));
    const owner = mem.readU16(lin + 1);
    const size = mem.readU16(lin + 3);
    parts.push(`${seg.toString(16)}:${t}(own=${owner.toString(16)},sz=${size.toString(16)})`);
    if (t === 'Z') break;
    seg += size + 1;
  }
  return parts.join(' → ');
}

// Run the emulator for many steps, checking for halts and errors
const BATCH = 100000;
const MAX_BATCHES = 1000; // 100M instructions max
let totalSteps = 0;
let lastPart = -1;

for (let batch = 0; batch < MAX_BATCHES; batch++) {
  if (emu.halted) {
    console.log(`[HALT] CPU halted after ${totalSteps} steps`);
    break;
  }

  for (let i = 0; i < BATCH; i++) {
    emu.tick();
    totalSteps++;
    if (emu.halted) break;
  }

  // Print progress every 10M steps
  if (batch % 100 === 99) {
    console.log(`[STEP] ${totalSteps} steps, cpuSteps=${emu.cpuSteps}, halted=${emu.halted}`);
    console.log(`  MCB: ${dumpMcb(emu)}`);
  }
}

console.log(`[DONE] ${totalSteps} total steps, halted=${emu.halted}`);
console.log(`  Final MCB: ${dumpMcb(emu)}`);
