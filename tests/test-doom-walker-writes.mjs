// Watch writes to DOS/4GW walker memory to find what corrupts it.
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

// Monkey-patch writeU16 / writeU8 / writeU32 to catch any write to the walker region.
const WATCH_LO = 0x15690 + 0xBA0;
const WATCH_HI = 0x15690 + 0xC00;
let writeCount = 0;
const mem = emu.memory;
const cpu = emu.cpu;
const origWriteU8 = mem.writeU8.bind(mem);
const origWriteU16 = mem.writeU16.bind(mem);
const origWriteU32 = mem.writeU32.bind(mem);

function logWrite(size, addr, val) {
  if (addr >= WATCH_LO && addr < WATCH_HI && emu.cpuSteps > 200_000 && writeCount < 20) {
    writeCount++;
    console.log(`[WALKER-WRITE#${writeCount}] U${size} addr=0x${addr.toString(16)} val=0x${(val>>>0).toString(16)} cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} step=${emu.cpuSteps}`);
    const ebytes = [];
    for (let i = -4; i < 12; i++) ebytes.push(mem.readU8((cpu.eip + i) >>> 0).toString(16).padStart(2,'0'));
    console.log(`  bytes@eip-4: ${ebytes.join(' ')}  EDI=0x${(cpu.reg[7]>>>0).toString(16)} ECX=0x${(cpu.reg[1]>>>0).toString(16)} EBX=0x${(cpu.reg[3]>>>0).toString(16)} EAX=0x${(cpu.reg[0]>>>0).toString(16)}`);
  }
}

mem.writeU8 = (addr, val) => { logWrite(8, addr, val); origWriteU8(addr, val); };
mem.writeU16 = (addr, val) => { logWrite(16, addr, val); origWriteU16(addr, val); };
mem.writeU32 = (addr, val) => { logWrite(32, addr, val); origWriteU32(addr, val); };

emu.run();

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) {
    console.log(`\n[HALT] reason=${emu.haltReason} step=${emu.cpuSteps}`);
    break;
  }
  emu.tick();
}
