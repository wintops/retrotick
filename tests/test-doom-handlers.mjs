// Dump DPMI PM interrupt handlers (AX=0205) after DOOM init.
import { readFileSync, readdirSync, statSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = { fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop, resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop, createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent', canvas: null };
const mockCanvas = { width: 640, height: 480, getContext: () => mockCtx, toDataURL: () => 'data:image/png;base64,', addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

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

// Run until first [0xa42] write at 0x5bf (= init enter) then dump handlers
const mem = emu.memory;
let dumped = false;
const origW32 = mem.writeU32.bind(mem);
mem.writeU32 = function(addr, val) {
  if (addr === 0x27C22 && !dumped) {
    const eipAfter = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) >>> 0;
    if (emu.cpu.cs === 0x1569 && eipAfter === 0x5bf) {
      dumped = true;
      console.log(`\n=== First 0x5bf write, step=${emu.cpuSteps} ===`);
      const dpmi = emu._dpmiState;
      if (dpmi) {
        console.log('\nPM Exception handlers (AX=0203, key=vec):');
        for (const [key, h] of dpmi.pmExcHandlers) {
          if (key < 256) console.log(`  vec 0x${key.toString(16).padStart(2,'0')}: sel=0x${h.sel.toString(16)} off=0x${h.off.toString(16)}`);
        }
        console.log('\nPM Interrupt handlers (AX=0205, key=vec+256):');
        for (const [key, h] of dpmi.pmExcHandlers) {
          if (key >= 256) {
            const vec = key - 256;
            console.log(`  vec 0x${vec.toString(16).padStart(2,'0')}: sel=0x${h.sel.toString(16)} off=0x${h.off.toString(16)}`);
          }
        }
      }
    }
  }
  return origW32(addr, val);
};

for (let tick = 0; tick < 60; tick++) {
  if (emu.halted || dumped) break;
  emu.tick();
}
console.log(`\n[DONE] dumped=${dumped} halted=${emu.halted} steps=${emu.cpuSteps}`);
