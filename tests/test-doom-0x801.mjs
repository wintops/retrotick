// Trace what INT is being called with target 0:0x801 and what's at that linear address
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
for (let tick = 0; tick < 100; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 8_000_000) break;
}

const mem = emu.memory;
function dump(label, base, len) {
  console.log(`\n${label}:`);
  for (let i = 0; i < len; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16; j++) bytes.push(mem.readU8(base + i + j).toString(16).padStart(2, '0'));
    console.log(`  0x${(base+i).toString(16)}: ${bytes.join(' ')}`);
  }
}

// Memory at linear 0x800..0x900 — where DOOM's RM target 0:801 points
dump('linear 0x7F0..0x850', 0x7F0, 0x60);
dump('linear 0x1b4e0..0x1b500 (DOS/4GW INT 21h stub region)', 0x1b4e0, 0x20);

// Find IVT entries pointing to 0:0x801
console.log('\nSearching IVT for 0:0x801:');
for (let vec = 0; vec < 256; vec++) {
  const ip = mem.readU16(vec * 4);
  const cs = mem.readU16(vec * 4 + 2);
  if (cs === 0 && ip === 0x801) {
    console.log(`  IVT[0x${vec.toString(16)}] = 0:0x801`);
  }
}
console.log('\nAll IVT[0x00] through IVT[0x1F]:');
for (let vec = 0; vec <= 0x1f; vec++) {
  const ip = mem.readU16(vec * 4);
  const cs = mem.readU16(vec * 4 + 2);
  console.log(`  IVT[0x${vec.toString(16)}] = 0x${cs.toString(16)}:0x${ip.toString(16)}`);
}
