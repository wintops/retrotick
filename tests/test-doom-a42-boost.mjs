// Diagnostic: artificially replenish [0xa42] when it gets low.
// If DOOM progresses further, exit 2002 is caused by [0xa42] frame starvation.
// If not, there's a separate bug.
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

const mem = emu.memory;
const A42 = 0x27C22;
const A46 = 0x27C26;

// After init settles (say step 2.5M when SS transitions to user), force [0xa42] high
// whenever it drops below 0x5800. This emulates "always have 11 frames available".
let boosts = 0;
const origR32 = mem.readU32.bind(mem);

// Override writes: if it's at 0x5bf writing a low value, clamp to high value.
const origW32 = mem.writeU32.bind(mem);
mem.writeU32 = function(addr, val) {
  if (addr === A42 && emu.cpuSteps > 2400000) {
    const HI = 0x6810;
    if (val < 0x5000) {
      // Too low — replace with HI so we never hit the 0x4840 guard
      val = HI;
      boosts++;
      if (boosts <= 5) {
        const eipAfter = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) >>> 0;
        console.log(`[BOOST #${boosts}] forced [0xa42]=0x${val.toString(16)} at cs=${emu.cpu.cs.toString(16)}:${eipAfter.toString(16)} steps=${emu.cpuSteps}`);
      }
    }
  }
  return origW32(addr, val);
};

const MAX_TICKS = 500;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}
console.log(`\n[DONE] boosts=${boosts} halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
