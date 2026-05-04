// Trace writes to DS:[0..0x40] — the chain head byte table (one byte per vector)
// and DS:[0x122..0x126] — the far pointer + count that indexes into the 0x402a30 table.
import { readFileSync, readdirSync, statSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = { fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop, resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop, createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent', canvas: null };
const mockCanvas = { width: 640, height: 480, getContext: () => mockCtx, toDataURL: () => 'data:image/png;base64,', addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

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

// Right after load, dump memory at linear 0x402a30 (entries [0..5])
console.log(`\n=== Memory at linear 0x402a30 IMMEDIATELY after load (before run) ===`);
for (let i = 0; i < 6; i++) {
  const bytes = [];
  for (let b = 0; b < 8; b++) bytes.push(emu.memory.readU8(0x402a30 + i * 8 + b).toString(16).padStart(2, '0'));
  console.log(`  [${i}] raw=[${bytes.join(' ')}]`);
}

emu.run();

const cpu = emu.cpu;
const mem = emu.memory;

// DS=0x271e base = 0x271e0
const DS_BASE = 0x271e0;
const CHAIN_HEADS_START = DS_BASE + 0x02;  // DS:[vec+2] for vec=0 is at DS:[0x02]
const CHAIN_HEADS_END = DS_BASE + 0x102;   // vec=0xFF → DS:[0x101]
// Also watch DS:[0x122] and DS:[0x126]
const ALLOC_PTR_LIN = DS_BASE + 0x122;
const ALLOC_CNT_LIN = DS_BASE + 0x126;

// Log writes to the chain heads
const writes = [];
function maybeLog(addr, val, size) {
  if (addr >= CHAIN_HEADS_START && addr < CHAIN_HEADS_END) {
    const vec = (addr - DS_BASE - 2);
    const eipAfter = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    writes.push({ vec, addr, val, size, cs: cpu.cs, eip: eipAfter, step: emu.cpuSteps });
  }
  // Also log writes to the ALLOC pointer and count
  if ((addr >= ALLOC_PTR_LIN && addr < ALLOC_PTR_LIN + 4) ||
      (addr >= ALLOC_CNT_LIN && addr < ALLOC_CNT_LIN + 2)) {
    const eipAfter = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    console.log(`[ALLOC-REG] DS:${(addr - DS_BASE).toString(16)} ${size}B val=0x${val.toString(16)} cs=${cpu.cs.toString(16)}:${eipAfter.toString(16)} step=${emu.cpuSteps}`);
  }
}
const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
mem.writeU8 = function(addr, val) { maybeLog(addr, val, 1); return origW8(addr, val); };
mem.writeU16 = function(addr, val) { maybeLog(addr, val, 2); return origW16(addr, val); };
mem.writeU32 = function(addr, val) { maybeLog(addr, val, 4); return origW32(addr, val); };

// Run past init and DOOM registration
const MAX_TICKS = 400;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

// Show all non-zero writes
const nz = writes.filter(w => w.val !== 0);
console.log(`\n${nz.length} non-zero writes to chain heads [DS:0x02..0x102]:`);
for (const w of nz) {
  console.log(`  step=${w.step} vec=0x${w.vec.toString(16)} (DS:${(w.addr - DS_BASE).toString(16)}) ${w.size}B val=0x${w.val.toString(16)} cs=${w.cs.toString(16)}:${w.eip.toString(16)}`);
}

// Dump final state of chain heads (all 0x40 entries)
console.log(`\nFinal chain heads (DS:0x02..0x42 = vec 0x00..0x40):`);
for (let v = 0; v < 0x40; v++) {
  const b = mem.readU8(DS_BASE + 2 + v);
  if (b !== 0) console.log(`  vec 0x${v.toString(16).padStart(2, '0')} → entry[${b}]`);
}
