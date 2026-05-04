// Correlate each INT dispatch with the current [0xa42] nesting level
// to identify which INTs are causing the fatal 4-deep nesting.
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

// Hook writes to [0xa42] to track nesting level
const BASELINE = 0x51D0; // value after init settles
const FRAME_SIZE = 0x2C8;
function depth() {
  const cur = mem.readU32(0x27C22);
  return Math.round((BASELINE - cur) / FRAME_SIZE);
}

// Hook all writes to [0xa42] to track transitions
const intLog = [];
const writeLog = [];
const origW32 = mem.writeU32.bind(mem);
mem.writeU32 = function(addr, val) {
  if (addr === 0x27C22) {
    const d = Math.round((BASELINE - val) / FRAME_SIZE);
    const eipAfter = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    // Log only transitions to a different level
    writeLog.push({ val, depth: d, step: emu.cpuSteps, cs: cpu.cs, eip: eipAfter, ss: cpu.ss });
  }
  return origW32(addr, val);
};

// Hook dispatchException via CPU.cs transitions. Instead, patch dispatch.ts temporarily — simpler:
// Hook cpu.loadCS to detect transitions to handler.sel for INT dispatches.
// Even simpler: check EIP prior to each tick step for CD xx (INT) or IDT hits.
// Actually easiest: print depth right after each write.

const MAX_TICKS = 400;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

// Print only transitions where depth CHANGES from previous
let lastDepth = 0;
console.log(`\nDepth transitions (only showing changes):`);
let deep = 0;
for (const w of writeLog) {
  if (w.depth !== lastDepth) {
    const arrow = w.depth > lastDepth ? '↓' : '↑';
    if (w.depth >= 3 || (w.depth !== lastDepth && deep < 50)) {
      deep++;
      console.log(`  step=${w.step} depth ${lastDepth} ${arrow} ${w.depth}  (val=0x${w.val.toString(16)}) cs=${w.cs.toString(16)}:${w.eip.toString(16)} ss=${w.ss.toString(16)}`);
    }
    lastDepth = w.depth;
  }
}

console.log(`\n[DONE] totalWrites=${writeLog.length} halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
