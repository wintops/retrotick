// Test: GIRLPOWA.EXE (daprophecy BBS intro — DOS MZ with 386 real-mode code)
// Reproduce top-half pixel corruption seen in browser.
import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

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
  width: 640, height: 480,
  getContext: () => mockCtx,
  toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop, removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
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

const buf = readToArrayBuffer('C:/Users/Olivier/Documents/0_Perso/dosbox_d/daprophecy/GIRLPOWA.EXE');
const peInfo = parsePE(buf);

const emu = new Emulator();
emu.screenWidth = 320;
emu.screenHeight = 200;
emu.exeName = 'GIRLPOWA.EXE';
emu.exePath = 'C:\\GIRLPOWA.EXE';

await emu.load(buf, peInfo, mockCanvas);
emu._pitCycleOnly = true;
emu.run();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TICKS = 3000;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${i} ticks: ${emu.cpu.haltReason}`);
    break;
  }
  if (emu._dosHalted) { await sleep(5); continue; }
  emu.tick();
  if (i % 200 === 0) {
    console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${(emu.cpu.eip>>>0).toString(16)} CS=0x${emu.cpu.cs.toString(16)} videoMode=0x${emu.videoMode.toString(16)}`);
  }
  if (emu.cpuSteps > 80_000_000) break;
}

console.log(`[DONE] cpuSteps=${emu.cpuSteps} halted=${emu.halted} videoMode=0x${emu.videoMode.toString(16)}`);

// After some frames, sample the video buffer (0xA0000) and analyse pixel distribution
if (emu.videoMode === 0x13) {
  const mem = emu.memory;
  const vidBase = 0xA0000;
  let zeros = 0, nonzeros = 0;
  const colorCounts = new Map();
  // Top half (y=0..99)
  let topNonZero = 0;
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 320; x++) {
      const b = mem.readU8(vidBase + y * 320 + x);
      if (b === 0) zeros++; else { nonzeros++; topNonZero++; }
      colorCounts.set(b, (colorCounts.get(b) || 0) + 1);
    }
  }
  // Bottom half (y=100..199)
  let botNonZero = 0;
  for (let y = 100; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      const b = mem.readU8(vidBase + y * 320 + x);
      if (b !== 0) botNonZero++;
    }
  }
  console.log(`[VIDEO] top half non-zero pixels: ${topNonZero}/32000`);
  console.log(`[VIDEO] bot half non-zero pixels: ${botNonZero}/32000`);
  const topHistogram = [...colorCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10);
  console.log(`[VIDEO] top-10 color counts (color:count): ${topHistogram.map(([c,n])=>`${c}:${n}`).join(' ')}`);

  // Dump first 20 bytes of screen row 20 and row 120
  const row20 = [];
  for (let x = 0; x < 40; x++) row20.push(mem.readU8(vidBase + 20 * 320 + x).toString(16).padStart(2, '0'));
  const row120 = [];
  for (let x = 0; x < 40; x++) row120.push(mem.readU8(vidBase + 120 * 320 + x).toString(16).padStart(2, '0'));
  console.log(`[ROW  20] ${row20.join(' ')}`);
  console.log(`[ROW 120] ${row120.join(' ')}`);
}
