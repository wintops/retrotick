// Trace writes to DOS/4GW's exception-handler table at linear 0x402a30..0x402bd0.
// Each 8-byte entry: we want to know the format and who writes type=1 terminators.
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
emu.run();

const cpu = emu.cpu;
const mem = emu.memory;

const TBL_START = 0x402a30;
const TBL_END = 0x402bd0;

const writes = [];
function logWrite(addr, val, size) {
  if (addr >= TBL_START && addr < TBL_END) {
    const entryIdx = (addr - TBL_START) >>> 3;
    const entryOff = (addr - TBL_START) & 7;
    const eipAfter = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    writes.push({
      addr, val, size, entryIdx, entryOff,
      cs: cpu.cs, eip: eipAfter, step: emu.cpuSteps,
    });
  }
}

const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
mem.writeU8 = function(addr, val) { logWrite(addr, val, 1); return origW8(addr, val); };
mem.writeU16 = function(addr, val) { logWrite(addr, val, 2); return origW16(addr, val); };
mem.writeU32 = function(addr, val) { logWrite(addr, val, 4); return origW32(addr, val); };

// Run until well past init
const MAX_TICKS = 400;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

console.log(`\nTotal writes to 0x${TBL_START.toString(16)}-0x${TBL_END.toString(16)}: ${writes.length}`);
// Show only non-zero writes
const nonZero = writes.filter(w => w.val !== 0);
console.log(`Non-zero writes: ${nonZero.length}`);
for (const w of nonZero) {
  console.log(`  step=${w.step} [${w.entryIdx.toString().padStart(3)}+${w.entryOff}] ${w.size}B val=0x${w.val.toString(16)} cs=${w.cs.toString(16)}:${w.eip.toString(16)}`);
}

// Final table state (first 40 entries)
console.log(`\nFinal table state:`);
for (let i = 0; i < 40; i++) {
  const entry = [];
  for (let b = 0; b < 8; b++) entry.push(mem.readU8((TBL_START + i * 8 + b) >>> 0).toString(16).padStart(2, '0'));
  const type = parseInt(entry[0], 16);
  const next = parseInt(entry[1], 16);
  if (type !== 0 || next !== 0) {
    console.log(`  [${i.toString().padStart(3)}] type=${type} next=${next}  raw=[${entry.join(' ')}]`);
  }
}
