// Find the initial entry to mixer at 0x5222f4 (NOT via the loop's JNZ back).
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

let prevEip = 0, prevCs = 0;
let ring = [];
const RING = 30;

cpu.step = function() {
  const eip = cpu.eip >>> 0;
  const cs = cpu.cs;
  // Track when we first enter 0x5222f4 from OUTSIDE the loop (not from 0x5223a7 JNZ back).
  if (cs === 0x168 && eip === 0x5222f4 && !(prevCs === 0x168 && prevEip >= 0x5223a7 && prevEip <= 0x5223ac) && emu.cpuSteps > 14_000_000) {
    console.log(`\n[MIXER ENTRY] step=${emu.cpuSteps} from cs=${prevCs.toString(16)} eip=0x${prevEip.toString(16)}`);
    console.log(`  EAX=0x${(cpu.reg[0]>>>0).toString(16)} EBX=0x${(cpu.reg[3]>>>0).toString(16)} ECX=0x${(cpu.reg[1]>>>0).toString(16)} EDX=0x${(cpu.reg[2]>>>0).toString(16)}`);
    console.log(`  ESI=0x${(cpu.reg[6]>>>0).toString(16)} EDI=0x${(cpu.reg[7]>>>0).toString(16)} EBP=0x${(cpu.reg[5]>>>0).toString(16)} ESP=0x${(cpu.reg[4]>>>0).toString(16)}`);
    console.log(`  [0x55_239c]=${emu.memory.readU32(0x55239c).toString(16)} [0x55_23a4]=${emu.memory.readU32(0x5523a4).toString(16)} [0x55_23a8]=${emu.memory.readU32(0x5523a8).toString(16)}`);
    console.log('  Last 30 instructions:');
    for (const r of ring) console.log(`    ${r}`);
    // Stop after first finding
    emu.halted = true;
    emu.haltReason = 'mixer entry captured';
  }
  if (ring.length >= RING) ring.shift();
  const bytes = [];
  for (let i = 0; i < 4; i++) bytes.push(emu.memory.readU8((eip + i) >>> 0).toString(16).padStart(2,'0'));
  ring.push(`cs=${cs.toString(16)} eip=0x${eip.toString(16)} bytes=${bytes.join(' ')} esp=0x${(cpu.reg[4]>>>0).toString(16)}`);
  prevCs = cs; prevEip = eip;
  origStep();
};

emu.run();

const MAX_TICKS = 300;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}
console.log('[END] halt=', emu.halted, 'reason=', emu.haltReason);
