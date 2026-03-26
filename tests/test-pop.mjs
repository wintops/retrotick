// Quick test: Prince of Persia with A20 fix
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

const princeBuf = readToArrayBuffer('C:/Users/Olivier/Documents/0_Perso/dosbox_d/POP1DEMO/PRINCE.EXE');
const emu = new Emulator();
emu.screenWidth = 320; emu.screenHeight = 200;
emu.exeName = 'POP1DEMO/PRINCE.EXE'; emu.exePath = 'D:\\POP1DEMO\\PRINCE.EXE';
emu.load(princeBuf, parsePE(princeBuf), mockCanvas);
emu.run();

for (let i = 0; i < 5000; i++) {
  if (emu.halted) break;
  emu.tick();
}
console.log(`Halted: ${emu.halted}, reason: ${emu.cpu.haltReason || 'still running!'}`);
