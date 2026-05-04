// Find what triggers the first entry into DOS/4GW's scan loop at cs=1569:0x1016.
// Log the call chain (caller → 0xba4 → 0xbdd → 0x1000 → 0x1016) with register state
// and the saved SI/exception context.
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

// On the FIRST entry into the scan at cs=1569:0x1016, log the state.
// Also log the last 10 entries from a rolling ring of "interesting events":
// - Any 0x5bf or 0x6bd write to [0xa42]
// - Entries to 0x580 (exception handler entry)
// - Entries to 0x1000 (scan start)
const events = [];
let scanHit = false;
let ringIdx = 0;
const RING_SIZE = 40;
const ring = new Array(RING_SIZE).fill(null);

emu._stepHook = (cpu) => {
  if (scanHit) return;
  const eip = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
  if (cpu.cs !== 0x1569) return;
  let interesting = null;
  if (eip === 0x580) interesting = 'EH-ENTRY';
  else if (eip === 0x5ba) interesting = 'ALLOC-FRAME';
  else if (eip === 0x6bd) interesting = 'RESTORE-FRAME';
  else if (eip === 0x1000) interesting = 'SCAN-FUNC-ENTRY';
  else if (eip === 0xbea) interesting = 'CALL-SCAN (AL!=1)';
  else if (eip === 0x1016) interesting = 'SCAN-LOOP';
  else if (eip === 0x550) interesting = 'HW-IRQ-STUB';
  if (interesting) {
    ring[ringIdx % RING_SIZE] = {
      label: interesting, eip, step: emu.cpuSteps,
      ss: cpu.ss, esp: cpu.reg[4] >>> 0,
      eax: cpu.reg[0] >>> 0, ebx: cpu.reg[3] >>> 0,
      esi: cpu.reg[6] >>> 0, edi: cpu.reg[7] >>> 0,
    };
    ringIdx++;
    if (eip === 0x1016 && ringIdx > 20) {
      scanHit = true;
      console.log(`\n=== SCAN FIRST HIT at step ${emu.cpuSteps} ===`);
      for (let i = 0; i < RING_SIZE; i++) {
        const idx = (ringIdx + i) % RING_SIZE;
        const r = ring[idx];
        if (!r) continue;
        console.log(`  step=${r.step} ${r.label.padEnd(22)} eip=${r.eip.toString(16)} ss=${r.ss.toString(16)} esp=${r.esp.toString(16)} eax=${r.eax.toString(16)} ebx=${r.ebx.toString(16)} esi=${r.esi.toString(16)} edi=${r.edi.toString(16)}`);
      }
    }
  }
};

const MAX_TICKS = 800;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted || scanHit) break;
  emu.tick();
}

console.log(`\n[DONE] scanHit=${scanHit} halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
