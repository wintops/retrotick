// Find references to cs=1569:0x0f68 (the 1001 error thunk) across memory
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
emu._pitCycleOnly = true;
emu.run();
for (let tick = 0; tick < 100; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 3_000_000) break;
}

const mem = emu.memory;
// Pattern to search: far pointer 0x1569:0x0f68 as dword = 0x1569_0f68
// Little-endian dword: 68 0f 69 15
const targetPtr16 = 0x0f68;  // 16-bit offset
const targetSel = 0x1569;

let found = 0;
console.log('[SCAN] Looking for far pointer (sel:off) = 0x1569:0x0f68 in cs=1569 (linear 0x15690..0x25690):');
// cs=1569 is a 64KB segment. Search within it.
for (let linear = 0x15690; linear < 0x25690; linear += 2) {
  // Check for (off=0x0f68, sel=0x1569) as word-word: 68 0f 69 15 (4 bytes)
  if (mem.readU16(linear) === targetPtr16 && mem.readU16(linear + 2) === targetSel) {
    const off_in_cs = linear - 0x15690;
    const ctx = [];
    for (let j = -4; j < 8; j++) ctx.push(mem.readU8(linear + j).toString(16).padStart(2, '0'));
    console.log(`  at cs=1569:0x${off_in_cs.toString(16)} (lin 0x${linear.toString(16)}): ${ctx.join(' ')}`);
    if (++found > 10) break;
  }
}

// Also check for near CALL to 0x0f68 from cs=1569 code. Bytes: e8 rel16 where target = 0x0f68
console.log('\n[SCAN] Near CALLs to 0x0f68 from within cs=1569:');
let callCount = 0;
for (let off_in_cs = 0; off_in_cs < 0x10000 - 3; off_in_cs++) {
  const addr = 0x15690 + off_in_cs;
  if (mem.readU8(addr) !== 0xe8) continue;
  const rel16 = (mem.readU16(addr + 1) << 16) >> 16; // sign-extend 16-bit
  const target_off = (off_in_cs + 3 + rel16) & 0xFFFF;
  if (target_off === 0x0f68) {
    callCount++;
    const ctx = [];
    for (let j = -4; j < 8; j++) ctx.push(mem.readU8(addr + j).toString(16).padStart(2, '0'));
    console.log(`  CALL 0x0f68 at cs=1569:0x${off_in_cs.toString(16)}: ${ctx.join(' ')}`);
    if (callCount > 10) break;
  }
}
console.log(`\n[SUMMARY] Far-pointer refs: ${found}, near CALLs: ${callCount}`);
