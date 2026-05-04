// Trace INT dispatches around the [0xa42] writes to understand what nests.
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

// Hook writes to 0xa42 to record events
const events = [];
const origWriteU32 = mem.writeU32.bind(mem);
mem.writeU32 = function(addr, val) {
  if (addr === 0x27C22) {
    const eipAfter = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    events.push({ type: 'WRITE', val, step: emu.cpuSteps, cs: cpu.cs, eip: eipAfter, ss: cpu.ss });
  }
  return origWriteU32(addr, val);
};

// Hook cpu loadCS (called on INT dispatch) — actually let's hook push32/push16 calls
// No — let's hook dispatchException via module import. But that's complex.
// Instead, use emu.traceApi or add a direct hook on EIP transitions to track INT instructions.
// When CPU executes an INT n (0xCD xx), we can log before dispatch.
// Simpler: hook the cpu step loop indirectly via writeU32 watch extended.

// Track large EIP jumps (sign of INT dispatch to handler)
const origPush32 = cpu.push32.bind(cpu);
cpu.push32 = function(val) {
  // Before push32 of flags, capture state to see if this is an INT dispatch
  return origPush32(val);
};

// Better: trap on the moment before DispatchException clears IF
const origSetFlags = cpu.setFlags.bind(cpu);
// no easy hook — skip for now

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

// Show events around step 2.5M to 3.5M (where nesting increases)
console.log(`\nEvents around step 2.5M-4.5M (writes to [0xa42]):`);
let prevVal = 0;
for (const e of events) {
  if (e.val === prevVal) continue;
  prevVal = e.val;
  const eipStr = e.cs.toString(16) + ':' + e.eip.toString(16);
  console.log(`  step=${e.step}: val=0x${e.val.toString(16)} eip=${eipStr} ss=${e.ss.toString(16)}`);
}
console.log(`\n[DONE] halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
