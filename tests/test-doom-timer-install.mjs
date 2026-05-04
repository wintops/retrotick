// Trace where DOOM installs its PIT timer handler and find its entry point.
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

const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);

// Record every CALL that lands somewhere that might be our mixer function entry.
// The mixer outer loop body is at 0x5222f4. The function entry should be before.
// Track: every time EIP is in cs=168:[0x521f00..0x5222f4], log that as a possible entry.
let logged = new Set();

cpu.step = function() {
  const eip = cpu.eip >>> 0;
  const cs = cpu.cs;
  if (cs === 0x168 && eip >= 0x521f00 && eip <= 0x5222f3 && !logged.has(eip) && emu.cpuSteps > 14_000_000 && emu.cpuSteps < 14_600_000) {
    logged.add(eip);
    if (logged.size > 30) return origStep();
    const bytes = [];
    for (let i = 0; i < 8; i++) bytes.push(emu.memory.readU8((eip + i) >>> 0).toString(16).padStart(2,'0'));
    console.log(`[SEEN] step=${emu.cpuSteps} eip=0x${eip.toString(16)} bytes=${bytes.join(' ')} EBP=0x${(cpu.reg[5]>>>0).toString(16)} ESP=0x${(cpu.reg[4]>>>0).toString(16)}`);
  }
  origStep();
};

emu.run();

const MAX_TICKS = 200;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  // Stop early once we've caught enough
  if (logged.size > 30) break;
}
console.log('[END] emulator halted=', emu.halted, 'step=', emu.cpuSteps);
