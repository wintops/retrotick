// Find who calls the DMX mixer function at cs=168:0x5222f4
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

// Find the outer function start by tracing any entry into 168:0x5222f4..0x5222ff
// and dumping the return address from the top of stack.
let hitCount = 0;

cpu.step = function() {
  const eip = cpu.eip >>> 0;
  if (cpu.cs === 0x168 && eip === 0x5222f4 && hitCount < 5) {
    hitCount++;
    const esp = cpu.reg[4] >>> 0;
    const retAddr = emu.memory.readU32(esp);
    const esp4 = emu.memory.readU32(esp + 4);
    const esp8 = emu.memory.readU32(esp + 8);
    console.log(`[HIT #${hitCount}] step=${emu.cpuSteps}`);
    console.log(`  esp=0x${esp.toString(16)} EBP=0x${(cpu.reg[5]>>>0).toString(16)} EAX=0x${(cpu.reg[0]>>>0).toString(16)} ECX=0x${(cpu.reg[1]>>>0).toString(16)} EDX=0x${(cpu.reg[2]>>>0).toString(16)}`);
    console.log(`  ret=0x${retAddr.toString(16)} [esp+4]=0x${esp4.toString(16)} [esp+8]=0x${esp8.toString(16)}`);
    console.log(`  [0x55_239c]=${emu.memory.readU32(0x55239c).toString(16)} [0x55_23a4]=${emu.memory.readU32(0x5523a4).toString(16)} [0x55_23a8]=${emu.memory.readU32(0x5523a8).toString(16)} [0x55_23b0]=${emu.memory.readU32(0x5523b0).toString(16)}`);
    // Also dump the caller instruction
    const callerSite = retAddr - 5;
    const bytes = [];
    for (let i = 0; i < 10; i++) bytes.push(emu.memory.readU8((callerSite + i) >>> 0).toString(16).padStart(2,'0'));
    console.log(`  caller@(retAddr-5): ${bytes.join(' ')}`);
  }
  origStep();
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
