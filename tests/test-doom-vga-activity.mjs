// Check if DOOM is writing to VGA memory (rendering)
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

const mem = emu.memory;
const cpu = emu.cpu;

// Count writes per 1MB bucket
let vgaWrites = 0;
let bucketWrites = new Map();
const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
function bucketize(a) {
  if (a >= 0xA0000 && a < 0xB0000) { vgaWrites++; return; }
  const b = Math.floor(a / 0x100000);
  bucketWrites.set(b, (bucketWrites.get(b) || 0) + 1);
}
mem.writeU8 = (a, v) => { bucketize(a); origW8(a, v); };
mem.writeU16 = (a, v) => { bucketize(a); origW16(a, v); };
mem.writeU32 = (a, v) => { bucketize(a); origW32(a, v); };

// Also check VGA mode and port 0x3D4/0x3D5
let videoMode = 0;
const origOut = emu.portOut.bind(emu);
emu.portOut = function(port, val) {
  if (port === 0x3D4 || port === 0x3D5 || port === 0x3C4 || port === 0x3C5) {
    // VGA writes — don't spam
  }
  return origOut(port, val);
};

for (let tick = 0; tick < 2000; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (tick % 500 === 0) {
    console.log(`[TICK ${tick}] step=${emu.cpuSteps} vgaWrites=${vgaWrites} videoMode=0x${emu.videoMode.toString(16)} graphicsMode=${emu.isGraphicsMode}`);
  }
}
console.log(`\n[FINAL] VGA writes: ${vgaWrites}`);
console.log(`[FINAL] videoMode: 0x${emu.videoMode.toString(16)} graphicsMode: ${emu.isGraphicsMode}`);
console.log(`[FINAL] Bucket writes (1MB each, >100k):`);
const sorted = [...bucketWrites.entries()].sort((a,b)=>b[1]-a[1]);
for (const [b, c] of sorted.slice(0, 10)) {
  if (c > 100000) console.log(`  bucket ${b} (0x${(b*0x100000).toString(16)}-0x${((b+1)*0x100000).toString(16)}): ${c} writes`);
}
