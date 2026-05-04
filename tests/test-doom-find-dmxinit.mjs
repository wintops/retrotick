// Exhaustive search for references to 0x5229ed (DMX_Init) in DOOM's loaded memory
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
emu.run();
for (let tick = 0; tick < 200; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 10_000_000) break;
}

const mem = emu.memory;
const TARGETS = [0x5229ed, 0x522994, 0x522299, 0x522154, 0x520004, 0x5200c0];
for (const TARGET of TARGETS) {
console.log(`\n===== Target: 0x${TARGET.toString(16)} =====`);

console.log(`[SCAN] Exhaustive search for refs to 0x${TARGET.toString(16)}:`);
let e8 = 0, e9 = 0, ea = 0, pushImm = 0, movImm = 0, dwordAbs = 0;
for (let addr = 0x100000; addr < 0x700000; addr++) {
  const b = mem.readU8(addr);
  // e8 rel32 (near CALL)
  if (b === 0xe8) {
    const rel = mem.readU32(addr + 1) | 0;
    if (((addr + 5 + rel) >>> 0) === TARGET) {
      e8++;
      if (e8 <= 10) {
        const ctx = [];
        for (let j = -3; j < 10; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
        console.log(`  e8 CALL at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
      }
    }
  }
  // e9 rel32 (near JMP)
  if (b === 0xe9) {
    const rel = mem.readU32(addr + 1) | 0;
    if (((addr + 5 + rel) >>> 0) === TARGET) {
      e9++;
      if (e9 <= 10) console.log(`  e9 JMP at 0x${addr.toString(16)}`);
    }
  }
  // push imm32: 68 xx xx xx xx
  if (b === 0x68 && mem.readU32(addr + 1) === TARGET) {
    pushImm++;
    if (pushImm <= 10) console.log(`  PUSH 0x${TARGET.toString(16)} at 0x${addr.toString(16)}`);
  }
  // mov r32, imm32: b8..bf xx xx xx xx
  if (b >= 0xb8 && b <= 0xbf && mem.readU32(addr + 1) === TARGET) {
    movImm++;
    if (movImm <= 10) console.log(`  MOV r, 0x${TARGET.toString(16)} at 0x${addr.toString(16)}`);
  }
  // dword pointer stored in data
  if ((addr & 3) === 0 && mem.readU32(addr) === TARGET) {
    dwordAbs++;
    if (dwordAbs <= 10) console.log(`  DD 0x${TARGET.toString(16)} at 0x${addr.toString(16)}`);
  }
}
console.log(`Summary for 0x${TARGET.toString(16)}: e8=${e8}, e9=${e9}, PUSH=${pushImm}, MOV imm=${movImm}, DD=${dwordAbs}`);
}
