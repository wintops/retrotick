// Test: manually set [0x56f214]=8 to see if DOOM progresses past mixer corruption
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

const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);
let patched = false;
const mem = emu.memory;

cpu.step = function() {
  // As soon as cs=168 starts executing (DOOM PM code) and we've set up state, patch
  if (!patched && cpu.cs === 0x168 && emu.cpuSteps > 100_000) {
    patched = true;
    // Patch DMX mixer globals as if DMX_Init was called.
    // Use 1 channel, small sample count. Output buffer = end of our heap so writes
    // don't corrupt DOOM data.
    mem.writeU32(0x56f214, 1);          // channel count = 1 (minimal)
    mem.writeU32(0x56f218, 4);          // sample count = 4 (minimal, makes the inner loop exit fast)
    mem.writeU32(0x5523c0, 0x600000);   // output buffer = far from DOOM data
    console.log(`[PATCH] at step ${emu.cpuSteps}: set DMX globals (1 ch, 4 samples, buf=0x600000)`);
  }
  origStep();
};

emu.run();
const MAX_TICKS = 2000;
// Capture stdout writes
const origWriteU8 = mem.writeU8.bind(mem);
let stdoutBuf = '';
const fakeWrite = (a, v) => { origWriteU8(a, v); };
// (we'll just grep the [41h]-like output from traces — less noisy)
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (tick % 200 === 0) console.log(`[TICK ${tick}] steps=${emu.cpuSteps} cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} tic_counter=${mem.readU32(0x56d1b0).toString(16)} [0x56f210]=${mem.readU32(0x56f210).toString(16)} [0x56f214]=${mem.readU32(0x56f214).toString(16)}`);
}
console.log(`[DONE] halt=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
