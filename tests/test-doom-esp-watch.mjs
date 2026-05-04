// Watch ESP for unexpected jumps that indicate stack corruption.
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

// Catch the moment ESP jumps far (more than 0x10000 bytes in one step)
let prevESP = 0;
let prevCS = 0;
let prevEIP = 0;
let firstJump = true;
const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);
const ESP_REG = 4;
cpu.step = function() {
  const preESP = cpu.reg[ESP_REG] >>> 0;
  const preCS = cpu.cs;
  const preEIP = cpu.eip >>> 0;
  origStep();
  const postESP = cpu.reg[ESP_REG] >>> 0;
  const postCS = cpu.cs;
  const postEIP = cpu.eip >>> 0;
  const delta = Math.abs(postESP - preESP);
  if (firstJump && delta > 0x100000 && emu.cpuSteps > 8_000_000) {
    firstJump = false;
    console.log(`\n[ESP JUMP] at step ${emu.cpuSteps}`);
    console.log(`  pre:  cs=${preCS.toString(16)} eip=0x${preEIP.toString(16)} esp=0x${preESP.toString(16)}`);
    console.log(`  post: cs=${postCS.toString(16)} eip=0x${postEIP.toString(16)} esp=0x${postESP.toString(16)}`);
    console.log(`  delta: 0x${delta.toString(16)}`);
    // Dump bytes at preEIP
    const bytes = [];
    for (let i = -4; i < 12; i++) bytes.push(emu.memory.readU8((preEIP + i) >>> 0).toString(16).padStart(2, '0'));
    console.log(`  bytes@preEIP-4: ${bytes.join(' ')}`);
  }
};

emu.run();

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) {
    console.log(`\n[HALT] reason=${emu.haltReason} step=${emu.cpuSteps}`);
    break;
  }
  emu.tick();
}
