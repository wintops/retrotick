// Find near JMPs (e9) to cs=1569:0x0f68 within cs=1569 code
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
const target_off = 0x0f68;

console.log('[SCAN] Looking for e9 rel16 (near JMP) to 0x0f68 within cs=1569:');
let count = 0;
for (let off = 0; off < 0x10000; off++) {
  const addr = cs1569 + off;
  // e9 rel16 in 16-bit = 3 bytes
  if (mem.readU8(addr) === 0xe9) {
    const rel16 = (mem.readU16(addr + 1) << 16) >> 16;
    const target = (off + 3 + rel16) & 0xFFFF;
    if (target === target_off) {
      count++;
      const ctx = [];
      for (let j = -4; j < 8; j++) ctx.push(mem.readU8(addr + j).toString(16).padStart(2, '0'));
      console.log(`  JMP 0x0f68 from cs=1569:0x${off.toString(16)} (lin 0x${addr.toString(16)}): ${ctx.join(' ')}`);
      if (count > 10) break;
    }
  }
}
console.log(`  -> Total: ${count}`);

// Also search for eb rel8 (short JMP) — rare for long jumps but possible
console.log('\n[SCAN] Looking for eb rel8 (short JMP) to 0x0f68:');
for (let off = 0; off < 0x10000; off++) {
  const addr = cs1569 + off;
  if (mem.readU8(addr) === 0xeb) {
    const rel8 = (mem.readU8(addr + 1) << 24) >> 24;
    const target = (off + 2 + rel8) & 0xFFFF;
    if (target === target_off) {
      const ctx = [];
      for (let j = -4; j < 8; j++) ctx.push(mem.readU8(addr + j).toString(16).padStart(2, '0'));
      console.log(`  JMP short to 0x0f68 from cs=1569:0x${off.toString(16)}: ${ctx.join(' ')}`);
    }
  }
}

// Also check: does code at 0x0d7a fall through to eventually reach 0xf68? Dump that whole range
console.log('\n[DUMP] cs=1569:0x0d78..0x0f80 (outer dispatcher continuation):');
for (let base = 0x0d78; base < 0x0f80; base += 16) {
  const bytes = [];
  for (let j = 0; j < 16; j++) bytes.push(mem.readU8(cs1569 + base + j).toString(16).padStart(2, '0'));
  console.log(`  cs=1569:0x${base.toString(16)}: ${bytes.join(' ')}`);
}
