// Verify V86 identity-fallback allows ISAY to write to VGA region.
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
  createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
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

function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/MC/Isay';
const exeBuf = readToArrayBuffer(`${BASE}/ISAY.EXE`);
const peInfo = parsePE(exeBuf);
const emu = new Emulator();
emu.screenWidth = 640; emu.screenHeight = 480;
emu.exeName = 'isay.exe'; emu.exePath = 'D:\\test\\ISAY.EXE';
emu.dosEnableDpmi = false; emu.dosEnableV86 = true;

for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname.toLowerCase() !== 'isay.exe') emu.additionalFiles.set(fname, readToArrayBuffer(fp));
}
await emu.load(exeBuf, peInfo, mockCanvas);

const mem = emu.memory;
let vgaWrites = 0;
let vgaReads = 0;
const vgaWriteAddrs = new Set();
const origW8 = mem.writeU8.bind(mem);
const origR8 = mem.readU8.bind(mem);

mem.writeU8 = function(a, v) {
  const u = a >>> 0;
  if (u >= 0xa0000 && u < 0xc0000) { vgaWrites++; vgaWriteAddrs.add(u); }
  origW8(a, v);
};
mem.readU8 = function(a) {
  const u = a >>> 0;
  if (u >= 0xa0000 && u < 0xc0000) vgaReads++;
  return origR8(a);
};

emu.run();
for (let i = 0; i < 400; i++) {
  if (emu.halted) break;
  emu.tick();
}

console.log(`[RESULT] cpuSteps=${emu.cpuSteps}, halted=${emu.halted}, haltReason=${emu.cpu.haltReason || ''}`);
console.log(`[VGA] reads=${vgaReads} writes=${vgaWrites} uniqueAddrs=${vgaWriteAddrs.size}`);
if (vgaWriteAddrs.size > 0) {
  const sorted = [...vgaWriteAddrs].sort((a,b) => a-b);
  console.log(`  First addr: 0x${sorted[0].toString(16)}, last: 0x${sorted[sorted.length-1].toString(16)}`);
}
