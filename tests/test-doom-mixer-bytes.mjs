// Dump bytes in the mixer prologue region to understand what each instruction does.
import { readFileSync, readdirSync, statSync } from 'fs';
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

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/DoomShw';
const doomBuf = readToArrayBuffer(`${BASE}/DOOM.EXE`);
const peInfo = parsePE(doomBuf);

const emu = new Emulator();
emu.screenWidth = 320;
emu.screenHeight = 200;
emu.exeName = 'DoomShw/DOOM.EXE';
emu.exePath = 'D:\\DoomShw\\DOOM.EXE';

for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'DOOM.EXE') {
    emu.additionalFiles.set(fname, readToArrayBuffer(fp));
  }
}

await emu.load(doomBuf, peInfo, mockCanvas);
emu.run();

// Run until we're past DPMI init but before the mixer corruption starts
const MAX_TICKS = 200;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 10_000_000) break;
}

// Dump the entire mixer function region
function dumpRegion(label, linearBase, len) {
  console.log(`\n${label}:`);
  for (let i = 0; i < len; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16 && i + j < len; j++) {
      bytes.push(emu.memory.readU8(linearBase + i + j).toString(16).padStart(2, '0'));
    }
    console.log(`  +${(i).toString(16).padStart(3, '0')} (0x${(linearBase+i).toString(16)}): ${bytes.join(' ')}`);
  }
}

// cs=168 base = 0x168 * 16 = 0x1680 in real-mode view... no, DPMI selector.
// Actually DOOM's cs=168 base should be logged somewhere. Let's check:
console.log(`[CPU] cs=${emu.cpu.cs.toString(16)} ds=${emu.cpu.ds.toString(16)} step=${emu.cpuSteps}`);
const csBase = emu.cpu.segBase(0x168);
console.log(`[BASE] cs=168 base=0x${csBase.toString(16)}`);

// Dump bytes 0x168 offset 0x522200..0x5224a0 (around mixer)
dumpRegion('cs=168:0x522200..0x5222f4 (pre-prologue + prologue)', csBase + 0x522200, 0xF4);
dumpRegion('cs=168:0x5222f4..0x5223b0 (outer loop body)', csBase + 0x5222f4, 0xBC);
