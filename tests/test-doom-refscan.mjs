// Quick scan for references to specific DOOM sound functions
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
for (let tick = 0; tick < 150; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 8_000_000) break;
}
console.log(`[LOADED] at step ${emu.cpuSteps}, halted=${emu.halted}`);

const mem = emu.memory;

// Build a single-pass scanner that checks all targets at once
const TARGETS = { 0x5229ed: 'DMX_Init', 0x522994: 'caller-of-mixer', 0x522299: 'mixer-A', 0x522154: 'mixer-B', 0x520004: 'tick-body', 0x5200c0: 'pit-dispatcher' };
const counts = {};
for (const t in TARGETS) counts[t] = { e8: 0, e9: 0, dd: 0 };

const lo = 0x400000;
const hi = 0x600000;
for (let addr = lo; addr < hi; addr++) {
  const b = mem.readU8(addr);
  if (b === 0xe8 || b === 0xe9) {
    const rel = mem.readU32(addr + 1) | 0;
    const target = ((addr + 5 + rel) >>> 0);
    if (target in TARGETS) {
      counts[target][b === 0xe8 ? 'e8' : 'e9']++;
    }
  }
  if ((addr & 3) === 0) {
    const v = mem.readU32(addr);
    if (v in TARGETS) {
      counts[v].dd++;
    }
  }
}

for (const [t, name] of Object.entries(TARGETS)) {
  const c = counts[t];
  console.log(`  0x${Number(t).toString(16)} (${name}): e8-CALL=${c.e8}, e9-JMP=${c.e9}, DD-ptr=${c.dd}`);
}

// Find exact CALL sites of 0x522994 (caller-of-mixer)
console.log('\n[CALLERS of 0x522994]:');
for (let addr = lo; addr < hi; addr++) {
  if (mem.readU8(addr) !== 0xe8) continue;
  const rel = mem.readU32(addr + 1) | 0;
  if (((addr + 5 + rel) >>> 0) === 0x522994) {
    const ctx = [];
    for (let j = -12; j < 12; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
    console.log(`  CALL at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
  }
}
