// Scan DOOM's code for all writes to DMX channel count global [0x56f214]
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

// Scan DOOM's code range.
const mem = emu.memory;

// First: scan for DMX_Init alternatives — look for all functions that set
// [0x56f210] or [0x56f214]. Maybe 0x5229ed is dead but there's another init.

console.log('[SCAN] Searching WIDE range 0x100000..0x700000 for disp32=0x56f214:');
let wideFound = 0;
for (let addr = 0x100000; addr < 0x700000; addr++) {
  if (mem.readU8(addr) === 0x14 && mem.readU8(addr+1) === 0xf2 && mem.readU8(addr+2) === 0x56 && mem.readU8(addr+3) === 0x00) {
    wideFound++;
    if (wideFound <= 30) {
      const ctx = [];
      for (let j = -6; j < 6; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
      console.log(`  at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
    }
  }
}
console.log(`  -> Total wide: ${wideFound}`);

// Patterns to search:
// 1. MOV [0x56f214], EBX:  89 1d 14 f2 56 00
// 2. MOV [0x56f214], EAX:  a3 14 f2 56 00
// 3. MOV [0x56f214], imm32: c7 05 14 f2 56 00 xx xx xx xx
const patterns = [
  { name: 'MOV [0x56f214], EBX', bytes: [0x89, 0x1d, 0x14, 0xf2, 0x56, 0x00] },
  { name: 'MOV [0x56f214], EAX', bytes: [0xa3, 0x14, 0xf2, 0x56, 0x00] },
  { name: 'MOV [0x56f214], imm32', bytes: [0xc7, 0x05, 0x14, 0xf2, 0x56, 0x00] },
  { name: 'MOV [0x56f210], EAX', bytes: [0xa3, 0x10, 0xf2, 0x56, 0x00] },
  { name: 'MOV [0x56f210], EBX', bytes: [0x89, 0x1d, 0x10, 0xf2, 0x56, 0x00] },
];

function matchAt(addr, p) {
  for (let i = 0; i < p.length; i++) {
    if (mem.readU8(addr + i) !== p[i]) return false;
  }
  return true;
}

console.log('[SCAN] Looking for DMX global writes in cs=168 (linear 0x500000..0x56a000)...');
const rangeStart = 0x500000;
const rangeEnd = 0x56a000;
for (const {name, bytes} of patterns) {
  let found = 0;
  for (let addr = rangeStart; addr < rangeEnd; addr++) {
    if (matchAt(addr, bytes)) {
      found++;
      if (found <= 8) {
        const ctx = [];
        for (let j = -3; j < bytes.length + 5; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
        console.log(`  ${name} at 0x${addr.toString(16)} context: ${ctx.join(' ')}`);
      }
    }
  }
  console.log(`  -> Total matches: ${found}`);
}

// Now search for callers of DMX_Init at 0x5229ed via e8 rel32 - WIDE range
console.log('\n[SCAN] Callers of DMX_Init (cs=168:0x5229ed) via `e8 rel32` (wide):');
let callerCount = 0;
for (let addr = 0x400000; addr < 0x700000; addr++) {
  if (mem.readU8(addr) !== 0xe8) continue;
  const rel32 = mem.readU32(addr + 1) | 0;
  const target = (addr + 5 + rel32) >>> 0;
  if (target === 0x5229ed) {
    callerCount++;
    if (callerCount <= 20) {
      const ctx = [];
      for (let j = -8; j < 10; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
      console.log(`  CALL 0x5229ed at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
    }
  }
}
console.log(`  -> Total direct callers: ${callerCount}`);

// Also look for "CALL near [disp32]" that might reference a function table containing 0x5229ed
// And "MOV reg, 0x5229ed" constants
console.log('\n[SCAN] MOV reg, imm32=0x5229ed (function pointer load):');
let movCount = 0;
// b8..bf is MOV r32, imm32
for (let addr = 0x400000; addr < 0x700000; addr++) {
  const b = mem.readU8(addr);
  if (b >= 0xb8 && b <= 0xbf) {
    if (mem.readU32(addr + 1) === 0x005229ed) {
      movCount++;
      if (movCount <= 10) console.log(`  MOV r, 0x5229ed at 0x${addr.toString(16)}`);
    }
  }
}
console.log(`  -> Total: ${movCount}`);

// Also scan for indirect pointer references to 0x5229ed in ALL memory
console.log('\n[SCAN] Indirect refs (DD 0x5229ed pointer) anywhere:');
let refCount = 0;
for (let addr = 0; addr < 0x1000000; addr += 4) {
  if (mem.readU32(addr) === 0x005229ed) {
    refCount++;
    if (refCount <= 10) console.log(`  at 0x${addr.toString(16)}`);
  }
}
console.log(`  -> Total pointer refs: ${refCount}`);

// Scan for all functions that write to DMX_Init's target range [0x56f214]
// using ANY instruction encoding. Look for `14 f2 56 00` as disp32 in an instruction.
console.log('\n[SCAN] Any instr with disp32=0x56f214:');
let any = 0;
for (let addr = rangeStart; addr < rangeEnd; addr++) {
  if (mem.readU8(addr) === 0x14 && mem.readU8(addr+1) === 0xf2 && mem.readU8(addr+2) === 0x56 && mem.readU8(addr+3) === 0x00) {
    any++;
    if (any <= 20) {
      const ctx = [];
      for (let j = -6; j < 6; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
      console.log(`  at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
    }
  }
}
console.log(`  -> Total matches: ${any}`);
