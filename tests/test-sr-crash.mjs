// Quick crash test after LOOP fix
import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
const noop = () => {};
const mockCtx = { fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }), drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }), save: noop, restore: noop, translate: noop, scale: noop, rotate: noop, setTransform: noop, resetTransform: noop, transform: noop, beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, rect: noop, ellipse: noop, fill: noop, stroke: noop, clip: noop, createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createPattern: () => null, font: '', textAlign: 'left', textBaseline: 'top', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter', globalAlpha: 1, globalCompositeOperation: 'source-over', imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent', canvas: null };
const mockCanvas = { width: 320, height: 200, getContext: () => mockCtx, toDataURL: () => 'data:image/png;base64,', addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } };
mockCtx.canvas = mockCanvas;
globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { ...mockCtx, canvas: this }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };
function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }
const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/2nd_real';
const secondBuf = readToArrayBuffer(`${BASE}/SECOND.EXE`);
const realityBuf = readToArrayBuffer(`${BASE}/REALITY.FC`);
const emu = new Emulator();
emu.screenWidth = 320; emu.screenHeight = 200;
emu.exeName = '2nd_real/SECOND.EXE'; emu.exePath = 'D:\\2nd_real\\SECOND.EXE';
emu.additionalFiles.set('REALITY.FC', realityBuf);
emu.load(secondBuf, parsePE(secondBuf), mockCanvas);
emu.run();
for (let t = 0; t < 500; t++) { if (emu.halted) break; emu.tick(); if (emu._dosWaitingForKey) { emu.dosKeyBuffer.push({ ascii: 0x0D, scan: 0x1C }); break; } }

// Track bad SI values at subroutine entry
const origStep = emu.cpu.step.bind(emu.cpu);
let badCount = 0, totalSub = 0;
emu.cpu.step = function() {
  if (this.eip === 0x09C8C && this.cs === 0x43A) {
    totalSub++;
    const si = this.reg[6] & 0xFFFF;
    if (si > 0x1200) badCount++;
  }
  origStep.call(this);
};

const startTime = performance.now();
for (let tick = 0; tick < 15000; tick++) {
  if (emu.halted) {
    console.log(`[HALT] tick=${tick} (${((performance.now()-startTime)/1000).toFixed(1)}s) reason=${emu.cpu.haltReason||emu.haltReason}`);
    break;
  }
  emu.tick();
  if (emu._dosWaitingForKey) emu.dosKeyBuffer.push({ ascii: 0x0D, scan: 0x1C });
}
if (!emu.halted) console.log(`[OK] 15000 ticks (${((performance.now()-startTime)/1000).toFixed(1)}s)`);
console.log(`Sub calls: ${totalSub}, bad SI (>0x1200): ${badCount} (${totalSub?((badCount/totalSub*100).toFixed(1)):'0'}%)`);
