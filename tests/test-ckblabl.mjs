// Test: CKBLABL.EXE (simple DOS MZ program — regression test)
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

const buf = readToArrayBuffer('C:/Users/Olivier/Documents/0_Perso/dosbox_d/r!plume/CKBLABL.EXE');
const peInfo = parsePE(buf);

const emu = new Emulator();
emu.screenWidth = 640;
emu.screenHeight = 480;
emu.exeName = 'CKBLABL.EXE';
emu.exePath = 'C:\\CKBLABL.EXE';

await emu.load(buf, peInfo, mockCanvas);
emu.run();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TICKS = 50;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${i} ticks: ${emu.cpu.haltReason}`);
    break;
  }
  if (emu._dosHalted) await sleep(60);
  emu.tick();
  if (i < 5 || i % 10 === 0) {
    console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${(emu.cpu.eip>>>0).toString(16)} CS=0x${emu.cpu.cs.toString(16)} videoMode=0x${emu.videoMode.toString(16)}`);
  }
}

console.log(`[DONE] cpuSteps=${emu.cpuSteps} halted=${emu.halted} videoMode=0x${emu.videoMode.toString(16)}`);
