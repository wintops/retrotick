// Check 0x51fe14's decision inputs: [0x56d226] and port 0x82
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
let loggedEntries = 0;

// Also trace writes to [0x56d226]
const mem = emu.memory;
const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
let wcount = 0;
function logW(size, addr, val) {
  if (addr === 0x56d226 || addr === 0x56d225 || addr === 0x56d224) {
    if (wcount < 20) {
      wcount++;
      console.log(`[W#${wcount}] U${size} [0x${addr.toString(16)}]=0x${(val>>>0).toString(16)} cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} step=${emu.cpuSteps}`);
    }
  }
}
mem.writeU8 = (a, v) => { logW(8, a, v); origW8(a, v); };
mem.writeU16 = (a, v) => { logW(16, a, v); origW16(a, v); };
mem.writeU32 = (a, v) => { logW(32, a, v); origW32(a, v); };

// Trace entries to 0x51fe14 and log state
let waitingForExit = null;
cpu.step = function() {
  if (cpu.cs === 0x168 && (cpu.eip >>> 0) === 0x51fe14 && loggedEntries < 20) {
    loggedEntries++;
    const val226 = emu.memory.readU16(0x56d226);
    const port82 = emu.portIn ? emu.portIn(0x82) : -1;
    const esp = cpu.reg[4] >>> 0;
    const ret = emu.memory.readU32(esp);
    console.log(`[0x51fe14] entry #${loggedEntries} step=${emu.cpuSteps} [0x56d226]=0x${val226.toString(16)} port 0x82=0x${port82.toString(16)} ret=0x${ret.toString(16)}`);
    waitingForExit = { ret, entry: loggedEntries };
  }
  origStep();
  if (waitingForExit && cpu.cs === 0x168 && (cpu.eip >>> 0) === waitingForExit.ret) {
    const eax = cpu.reg[0] >>> 0;
    console.log(`  -> 0x51fe14 entry #${waitingForExit.entry} returned EAX=0x${eax.toString(16)}`);
    waitingForExit = null;
  }
};

emu.run();
for (let tick = 0; tick < 200; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 15_000_000) break;
}
console.log(`[DONE] step=${emu.cpuSteps}`);
