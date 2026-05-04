// Check if DMX_Init at 0x5229ed is ever called, and what calls 0x522994
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

let dmxInitCalled = false;
let dmxInitCallCount = 0;
let callerEntryCount = 0;
let mixerEntryCount = 0;

cpu.step = function() {
  const eip = cpu.eip >>> 0;
  if (cpu.cs === 0x168) {
    if (eip === 0x5229ed && dmxInitCallCount < 3) {
      dmxInitCallCount++;
      dmxInitCalled = true;
      console.log(`\n[DMX_INIT #${dmxInitCallCount}] step=${emu.cpuSteps} EAX=0x${(cpu.reg[0]>>>0).toString(16)} EBX=0x${(cpu.reg[3]>>>0).toString(16)} EDX=0x${(cpu.reg[2]>>>0).toString(16)} ESI=0x${(cpu.reg[6]>>>0).toString(16)}`);
      const esp = cpu.reg[4] >>> 0;
      console.log(`  ret=0x${emu.memory.readU32(esp).toString(16)} ESP=0x${esp.toString(16)}`);
    }
    if (eip === 0x522994 && callerEntryCount < 3) {
      callerEntryCount++;
      console.log(`\n[CALLER-OF-MIXER #${callerEntryCount}] step=${emu.cpuSteps} EAX=0x${(cpu.reg[0]>>>0).toString(16)} EBX=0x${(cpu.reg[3]>>>0).toString(16)}`);
      const esp = cpu.reg[4] >>> 0;
      console.log(`  ret=0x${emu.memory.readU32(esp).toString(16)} ESP=0x${esp.toString(16)}`);
    }
  }
  origStep();
};

emu.run();

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 15_500_000) break;
}
console.log(`\n[SUMMARY] DMX_Init called=${dmxInitCalled} count=${dmxInitCallCount}, caller=${callerEntryCount}, mixer=${mixerEntryCount}, step=${emu.cpuSteps}`);
