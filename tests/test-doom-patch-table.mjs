// Experimental: after DOS/4GW init finishes populating the handler table,
// inject type=1 into an unused slot so the exception-scan chain terminates.
// If DOOM progresses past the 600M-step scan loop, the diagnosis is confirmed.
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

// Experiment: block DOS/4GW from overwriting [32].type=1 with type=3.
// If entry keeps type=1, 0xba4 dispatcher takes the direct-call path (0xbf4)
// and skips the scan loop entirely.
const mem = emu.memory;
const TABLE = 0x402a30;
const ENTRY32_TYPE = TABLE + 32 * 8;
let blocked = 0;
const origW8 = mem.writeU8.bind(mem);
mem.writeU8 = function(addr, val) {
  // Any type byte write (2 or 3) → rewrite to 1 to force direct-call dispatch
  if ((val === 2 || val === 3) &&
      addr >= TABLE && addr < TABLE + 0x2000 &&
      ((addr - TABLE) & 7) === 0) {
    blocked++;
    if (blocked <= 20) console.log(`[BLOCK] type=${val} → type=1 at entry=[${((addr - TABLE) >> 3)}] cs=${emu.cpu.cs.toString(16)} step=${emu.cpuSteps}`);
    return origW8(addr, 1);
  }
  return origW8(addr, val);
};

const MAX_TICKS = 600;
let lastReport = 0;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps - lastReport > 50000000) {
    lastReport = emu.cpuSteps;
    const eipOff = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) >>> 0;
    console.log(`[TICK] steps=${emu.cpuSteps} cs=${emu.cpu.cs.toString(16)}:${eipOff.toString(16)} ss=${emu.cpu.ss.toString(16)}`);
  }
}

// Check state at end
const a42 = mem.readU32(0x27c22);
console.log(`\n[DONE] halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps} blocked=${blocked} [0xa42]=0x${a42.toString(16)}`);
