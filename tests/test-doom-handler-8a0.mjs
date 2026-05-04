// Dump DOS/4GW's handler at cs=1569:0x08a0 to understand what it actually does
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
for (let tick = 0; tick < 200; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 10_000_000) break;
}

const mem = emu.memory;
const cs1569_base = emu.cpu.segBase(0x1569);

function dump(label, base, len) {
  console.log(`\n${label}:`);
  for (let i = 0; i < len; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16; j++) bytes.push(mem.readU8(base + i + j).toString(16).padStart(2, '0'));
    console.log(`  cs:0x${(base - cs1569_base + i).toString(16)} (lin 0x${(base+i).toString(16)}): ${bytes.join(' ')}`);
  }
}

// Dump all chain walker handlers identified in session 29:
// [0] type=1 next=1 off=0xf68  sel=0x1569
// [1] type=1 next=1 off=0x8a0  sel=0x1569
// [2] type=1 next=1 off=0xdcd  sel=0x1569
// [3] type=1 next=1 off=0xe6a  sel=0x1569
dump('Handler 0x8a0 (session 29: the looping one)', cs1569_base + 0x8a0, 0x40);
dump('Handler 0xf68 (entry 0)', cs1569_base + 0xf68, 0x40);
dump('Handler 0xdcd (entry 2)', cs1569_base + 0xdcd, 0x40);
dump('Handler 0xe6a (entry 3)', cs1569_base + 0xe6a, 0x40);

// Also dump what's at the real chain table at linear 0x2eef0 (session 29)
console.log('\n[Real chain table at linear 0x2eef0, 32 entries]:');
for (let i = 0; i < 8; i++) {
  const a = 0x2eef0 + i * 8;
  const type = mem.readU8(a);
  const next = mem.readU8(a + 1);
  const off = mem.readU32(a + 2);
  const sel = mem.readU16(a + 6);
  console.log(`  entry[${i}] at 0x${a.toString(16)}: type=${type} next=${next} off=0x${off.toString(16)} sel=0x${sel.toString(16)}`);
}

// What about at the anchor table 0x402a30?
console.log('\n[Session 24 anchor table at linear 0x402a30]:');
for (let i = 0; i < 8; i++) {
  const a = 0x402a30 + i * 8;
  const type = mem.readU8(a);
  const next = mem.readU8(a + 1);
  const off = mem.readU32(a + 2);
  const sel = mem.readU16(a + 6);
  console.log(`  entry[${i}] at 0x${a.toString(16)}: type=${type} next=${next} off=0x${off.toString(16)} sel=0x${sel.toString(16)}`);
}
