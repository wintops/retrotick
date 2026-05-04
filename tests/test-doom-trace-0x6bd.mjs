// Trace every execution of cs=0x1569:0x6bd (the normal EXCEPTION EXIT path)
// to understand why init has 8 enters at 0x5bf without matching exits.
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

// Instrument the CPU's step function (we wrap at a higher level)
// Hook the dispatch entry — check cs=0x1569, eip in {0x5ba, 0x5bf, 0x6bd, 0x6c1, 0x77d, 0x540}
const WATCH_EIPS = new Set([0x5ba, 0x5bf, 0x6bd, 0x6c1, 0x77d, 0x540, 0x4e1, 0x54c]);

const hits = [];
// Wrap tick to sample EIP each step
const origTick = emu.tick.bind(emu);
let lastHitStep = 0;

// Use a simpler approach: poll every N steps for EIP
// Actually, override cpu.fetch or similar to record EIP transitions.
// For simplicity, wrap the main step loop by hooking cpu.singleStep or dispatch.
// Since we don't have easy access, let's instrument via writeU32 for now
// AND log every dispatch event through a mem._pmCpu tracking.

const mem = emu.memory;
const origWriteU32 = mem.writeU32.bind(mem);
const origWriteU16 = mem.writeU16.bind(mem);

let lastEip = 0, lastCS = 0;

// Override dispatch: patch by hooking cpu step via tick
// emu.tick() calls cpu.step() internally. Let's find another way.
// Use a simple proxy: log on every memory access at 0xa42.
// Also probe: sample each tick for EIP
mem.writeU32 = function(addr, val) {
  const cs = cpu.cs;
  // Get EIP *before* instruction completes. Rough: use cpu.eip AFTER.
  const eipAfter = cpu.eip - cpu.segBase(cs);
  if (cs === 0x1569 && (addr & ~3) === 0x27C20 && addr + 4 > 0x27C22 && addr <= 0x27C22) {
    // this is a write to [0xa42]
    hits.push({
      type: 'WRITE', addr, val, size: 4,
      cs, eipAfter: eipAfter >>> 0,
      ss: cpu.ss, esp: cpu.reg[4] >>> 0,
      step: emu.cpuSteps,
      ds: cpu.ds, es: cpu.es,
    });
  }
  return origWriteU32(addr, val);
};
mem.writeU16 = function(addr, val) {
  if (addr === 0x27C22 || addr === 0x27C24) {
    hits.push({
      type: 'WRITE', addr, val, size: 2,
      cs: cpu.cs, eipAfter: (cpu.eip - cpu.segBase(cpu.cs)) >>> 0,
      ss: cpu.ss, esp: cpu.reg[4] >>> 0,
      step: emu.cpuSteps,
    });
  }
  return origWriteU16(addr, val);
};

// Sample EIP each tick
emu.tick = function() {
  origTick();
  if (emu.cpuSteps - lastHitStep >= 1) {
    const eipOff = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    if (cpu.cs === 0x1569 && WATCH_EIPS.has(eipOff)) {
      hits.push({
        type: 'EIP', eip: eipOff, cs: cpu.cs, ss: cpu.ss,
        esp: cpu.reg[4] >>> 0,
        ds: cpu.ds, step: emu.cpuSteps
      });
      lastHitStep = emu.cpuSteps;
    }
  }
};

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

console.log(`\n${hits.length} events (WRITE to [0xa42] or EIP at key offsets):`);
// Show first 30 and last 30
const toShow = hits.length > 60 ? [...hits.slice(0, 30), { type: 'SEP' }, ...hits.slice(-30)] : hits;
for (const h of toShow) {
  if (h.type === 'SEP') { console.log('  ...'); continue; }
  if (h.type === 'WRITE') {
    console.log(`  W step=${h.step}: addr=0x${h.addr.toString(16)} val=0x${h.val.toString(16)} cs=${h.cs.toString(16)}:${h.eipAfter.toString(16)} ds=${h.ds?.toString(16)} ss=${h.ss.toString(16)} esp=${h.esp.toString(16)}`);
  } else {
    console.log(`  E step=${h.step}: cs=${h.cs.toString(16)}:${h.eip.toString(16)} ds=${h.ds.toString(16)} ss=${h.ss.toString(16)} esp=${h.esp.toString(16)}`);
  }
}

console.log(`\n[DONE] halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
