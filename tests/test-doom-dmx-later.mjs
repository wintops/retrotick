// With the SB fix applied, DOOM runs further. Check if DMX_Init at 0x5229ed
// is called at any point now (e.g., when sound is initialized fully).
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
let dmxCalls = 0;
let writes56f214 = 0;
const mem = emu.memory;
const origW32 = mem.writeU32.bind(mem);
mem.writeU32 = (a, v) => {
  if (a === 0x56f214 && writes56f214 < 5) {
    writes56f214++;
    console.log(`[W 0x56f214=${(v>>>0).toString(16)}] cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} step=${emu.cpuSteps}`);
  }
  origW32(a, v);
};

cpu.step = function() {
  if (cpu.cs === 0x168 && (cpu.eip >>> 0) === 0x5229ed && dmxCalls < 5) {
    dmxCalls++;
    console.log(`[DMX_Init CALLED #${dmxCalls}] step=${emu.cpuSteps} EAX=0x${(cpu.reg[0]>>>0).toString(16)} EBX=0x${(cpu.reg[3]>>>0).toString(16)}`);
  }
  origStep();
};

emu.run();
for (let tick = 0; tick < 3000; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (tick % 500 === 0) console.log(`[TICK ${tick}] step=${emu.cpuSteps}`);
}
console.log(`[DONE] step=${emu.cpuSteps} halted=${emu.halted} dmxCalls=${dmxCalls} writes56f214=${writes56f214}`);
console.log(`[0x56f214] final = 0x${mem.readU32(0x56f214).toString(16)}`);
