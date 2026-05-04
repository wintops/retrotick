// Dump the full chain table at linear 0x2eef0 — the walker accesses entry 46 (0x170 byte offset)
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
emu._pitCycleOnly = true;
emu.run();
for (let tick = 0; tick < 100; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 3_000_000) break;
}

const mem = emu.memory;
// Dump the full chain table — 64 entries (512 bytes) at linear 0x2eef0
console.log(`\n[Chain table at linear 0x2eef0, 64 entries] at step=${emu.cpuSteps}:`);
for (let i = 0; i < 64; i++) {
  const a = 0x2eef0 + i * 8;
  const type = mem.readU8(a);
  const next = mem.readU8(a + 1);
  const off = mem.readU32(a + 2);
  const sel = mem.readU16(a + 6);
  const label = (type !== 0 || next !== 0 || off !== 0 || sel !== 0) ? '' : '(empty)';
  console.log(`  entry[${i.toString().padStart(2,'0')}] @0x${a.toString(16)} (byte-off 0x${(i*8).toString(16).padStart(3,'0')}): type=${type} next=${next} off=0x${off.toString(16).padStart(4,'0')} sel=0x${sel.toString(16).padStart(4,'0')} ${label}`);
}

// Also look at what [DS:0x0124] holds for DOS/4GW's DS (0x271e, base 0x271e0)
const ds271e_base = 0x271e0;
const chainSelector = mem.readU16(ds271e_base + 0x0124);
console.log(`\n[0x271e:0x0124] (walker's ES source) = 0x${chainSelector.toString(16)}`);

// Check what entry 46 should be (byte offset 0x170)
const e46 = 0x2eef0 + 0x170;
console.log(`\nEntry at byte offset 0x170 (= entry 46) at linear 0x${e46.toString(16)}:`);
console.log(`  type=${mem.readU8(e46)} next=${mem.readU8(e46+1)} off=0x${mem.readU32(e46+2).toString(16)} sel=0x${mem.readU16(e46+6).toString(16)}`);
