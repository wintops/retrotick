// Dump cs=1569:0x580 (ISR builder per session 22) and search for writes
// to [SI+0x38] which is the chain-head slot in the ISR frame.
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
const cs1569 = 0x15690;
function dump(label, base, len) {
  console.log(`\n${label}:`);
  for (let i = 0; i < len; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16; j++) bytes.push(mem.readU8(base + i + j).toString(16).padStart(2, '0'));
    console.log(`  cs=1569:0x${(base-cs1569+i).toString(16)}: ${bytes.join(' ')}`);
  }
}

// Dump the ISR builder at 0x580
dump('cs=1569:0x580..0x680 (ISR builder at 0x580, plus pre-walker code)', cs1569 + 0x580, 0x100);

// Search for "88 44 38" (MOV [SI+0x38], AL) — writes to the chain-head slot at offset 0x38
console.log('\n[SCAN] Writes to [SI+0x38] (pattern 88 44 38 = MOV [SI+0x38], AL):');
for (let off = 0; off < 0x10000 - 3; off++) {
  const a = cs1569 + off;
  if (mem.readU8(a) === 0x88 && mem.readU8(a+1) === 0x44 && mem.readU8(a+2) === 0x38) {
    const ctx = [];
    for (let j = -4; j < 8; j++) ctx.push(mem.readU8(a + j).toString(16).padStart(2, '0'));
    console.log(`  cs=1569:0x${off.toString(16)}: ${ctx.join(' ')}`);
  }
}
// Also 89 44 38 (MOV [SI+0x38], AX) and C6 44 38 imm (MOV [SI+0x38], imm8)
console.log('\n[SCAN] Writes to [SI+0x38] other patterns:');
for (let off = 0; off < 0x10000 - 4; off++) {
  const a = cs1569 + off;
  const b0 = mem.readU8(a), b1 = mem.readU8(a+1), b2 = mem.readU8(a+2);
  if ((b0 === 0x89 && b1 === 0x44 && b2 === 0x38) ||  // MOV [SI+0x38], r16
      (b0 === 0xC6 && b1 === 0x44 && b2 === 0x38)) {  // MOV [SI+0x38], imm8
    const ctx = [];
    for (let j = -4; j < 8; j++) ctx.push(mem.readU8(a + j).toString(16).padStart(2, '0'));
    console.log(`  cs=1569:0x${off.toString(16)}: ${ctx.join(' ')}`);
  }
}
