// Trace all writes to [0xa42] = linear 0x27C22 (inside DOS/4GW's data seg 0x271e).
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

const cpu = emu.cpu;
const mem = emu.memory;

// [0xa42] in DS=0x271e = linear 0x271E0 + 0xa42 = 0x27C22
const WATCH = 0x27C22;

const origWriteU16 = mem.writeU16.bind(mem);
const origWriteU32 = mem.writeU32.bind(mem);

const hits = [];

mem.writeU16 = function(addr, val) {
  origWriteU16(addr, val);
  if (addr === WATCH || addr === WATCH+2) {
    hits.push({
      addr, val, size: 2,
      cs: cpu.cs, off: ((cpu.eip - cpu.segBase(cpu.cs)) >>> 0),
      ss: cpu.ss, esp: cpu.reg[4]>>>0, ebp: cpu.reg[5]>>>0,
      step: emu.cpuSteps
    });
  }
};
mem.writeU32 = function(addr, val) {
  origWriteU32(addr, val);
  if (addr === WATCH) {
    hits.push({
      addr, val, size: 4,
      cs: cpu.cs, off: ((cpu.eip - cpu.segBase(cpu.cs)) >>> 0),
      ss: cpu.ss, esp: cpu.reg[4]>>>0, ebp: cpu.reg[5]>>>0,
      step: emu.cpuSteps
    });
  }
};

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

console.log(`\n${hits.length} writes to [0xa42] (linear 0x27C22):`);
for (let i = 0; i < hits.length; i++) {
  const h = hits[i];
  // Show first 10 and last 10, plus any unusual values
  if (i < 10 || i > hits.length - 10 || (i % 20 === 0)) {
    console.log(`  #${i+1}: ${h.size}B val=0x${h.val.toString(16)} cs=${h.cs.toString(16)}:${h.off.toString(16)} ss=${h.ss.toString(16)} esp=${h.esp.toString(16)} ebp=${h.ebp.toString(16)} step=${h.step}`);
  }
}

// Summary: value at the write, grouped
const valueHist = new Map();
for (const h of hits) {
  if (h.size !== 4) continue;
  const low16 = h.val & 0xFFFF;
  const bucket = Math.floor(low16 / 0x100) * 0x100;
  valueHist.set(bucket, (valueHist.get(bucket) || 0) + 1);
}
console.log(`\nLow16 value distribution (binned by 0x100):`);
const sorted = [...valueHist.entries()].sort((a,b)=>a[0]-b[0]);
for (const [bucket, count] of sorted) {
  console.log(`  0x${bucket.toString(16).padStart(4,'0')}-0x${(bucket+0xff).toString(16)}: ${count}`);
}

console.log(`\n[DONE] halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
