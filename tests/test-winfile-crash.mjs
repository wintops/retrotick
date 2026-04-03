import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
  drawImage: noop, putImageData: noop,
  getImageData: (x,y,w,h) => ({ data: new Uint8ClampedArray(Math.max(1,w) * Math.max(1,h) * 4), width: Math.max(1,w), height: Math.max(1,h) }),
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

function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

const realArrayBuffer = readToArrayBuffer('H:/WINDOWS/WINFILE.EXE');
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.additionalFiles.set('COMMCTRL.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/COMMCTRL.DLL'));
emu.additionalFiles.set('VER.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/VER.DLL'));
emu.additionalFiles.set('SCONFIG.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/SCONFIG.DLL'));
await emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < 200) { emu.tick(); ticks++; }
if (!emu.waitingForMessage) { console.error('FAILED: no message loop'); process.exit(1); }
console.log(`Reached message loop after ${ticks} ticks`);

// Run ticks
for (let i = 0; i < 50; i++) {
  if (emu.halted) { console.error(`HALTED at tick ${ticks}`); process.exit(1); }
  emu.tick(); ticks++;
}
console.log(`After 50 ticks: halted=${emu.halted}`);

// Simulate resize
function doResize(w, h) {
  console.log(`Resize to ${w}x${h}...`);
  mockCanvas.width = w; mockCanvas.height = h;
  const mainWnd = emu.handles.get(emu.mainWindow);
  if (mainWnd) {
    mainWnd.width = w; mainWnd.height = h;
    const lp = ((h & 0xFFFF) << 16) | (w & 0xFFFF);
    emu.postMessage(emu.mainWindow, 0x0005, 0, lp);
  }
  for (let i = 0; i < 30; i++) {
    if (emu.halted) { console.error(`HALTED during resize tick`); process.exit(1); }
    emu.tick(); ticks++;
  }
}

doResize(500, 400);
doResize(300, 250);
doResize(700, 500);
doResize(400, 350);

console.log(`SUCCESS: ${ticks} total ticks, no crash`);
