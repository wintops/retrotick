// Trace writes to DOOM mixer setup globals at linear 0xf210, 0xf214, 0xf218
// and also to [0x55_23c0] (output buffer global)
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

const mem = emu.memory;
const cpu = emu.cpu;
const origWriteU8 = mem.writeU8.bind(mem);
const origWriteU16 = mem.writeU16.bind(mem);
const origWriteU32 = mem.writeU32.bind(mem);
let writeCount = 0;
const watches = [0x56f210, 0x56f214, 0x56f218, 0x5523c0];
const watchLabels = {0x56f210:'enable_flag', 0x56f214:'edx_arg', 0x56f218:'ecx_arg', 0x5523c0:'buffer_ptr'};

function logWrite(size, addr, val) {
  for (const w of watches) {
    if (addr === w || (size === 16 && addr === w - 1) || (size === 32 && addr >= w - 3 && addr <= w)) {
      if (writeCount < 40) {
        writeCount++;
        console.log(`[W#${writeCount}] U${size} addr=0x${addr.toString(16)} (${watchLabels[w] || '?'}) val=0x${(val>>>0).toString(16)} cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} step=${emu.cpuSteps}`);
      }
    }
  }
}

mem.writeU8 = (a, v) => { logWrite(8, a, v); origWriteU8(a, v); };
mem.writeU16 = (a, v) => { logWrite(16, a, v); origWriteU16(a, v); };
mem.writeU32 = (a, v) => { logWrite(32, a, v); origWriteU32(a, v); };

emu.run();

const MAX_TICKS = 200;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 15_000_000) break;
}
console.log(`[END] halt=${emu.halted} step=${emu.cpuSteps}`);
console.log(`  [0x56f210] = 0x${mem.readU32(0x56f210).toString(16)}`);
console.log(`  [0x56f214] = 0x${mem.readU32(0x56f214).toString(16)}`);
console.log(`  [0x56f218] = 0x${mem.readU32(0x56f218).toString(16)}`);
console.log(`  [0x5523c0] = 0x${mem.readU32(0x5523c0).toString(16)}`);
