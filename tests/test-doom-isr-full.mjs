// Dump EVERY instruction at cs=1569 during the 1st IRQ0 handling window to see
// where control goes after 0x913 IRETD during init.
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

const cpu = emu.cpu;
const mem = emu.memory;
const CS_BASE = 0x1569 * 0x10;

// Hook readU8 on the ENTIRE cs=1569 range to detect each instruction fetch start.
// We detect only the FIRST byte of each instruction by tracking EIP transitions.
const entries = [];
let lastEip = -1;
let logging = false;
const origRU8 = mem.readU8.bind(mem);
let lastCS = -1, lastEipOff = -1;
mem.readU8 = function(addr) {
  const v = origRU8(addr);
  if (logging) {
    const eipOff = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
    const curCS = cpu.cs;
    // Log only when we transition to a NEW instruction (addr == current EIP AND different from last)
    if (addr === cpu.eip && (curCS !== lastCS || eipOff !== lastEipOff)) {
      // Also skip if we're on a sequential (prev + small delta) instruction
      const isJump = (curCS !== lastCS) || (lastEipOff < 0) || Math.abs(eipOff - lastEipOff) > 8;
      if (isJump && entries.length < 200) {
        entries.push({ off: eipOff, cs: curCS, ss: cpu.ss, esp: cpu.reg[4] >>> 0, step: emu.cpuSteps });
      }
      lastCS = curCS;
      lastEipOff = eipOff;
    }
  }
  return v;
};

// Enable logging right when writing to [0xa42] at 0x5ba AT INIT (ss=0xC0)
// Capture the NEXT 2000 instructions at cs=1569 after the first init write
let loggingStartStep = -1;
const origW32 = mem.writeU32.bind(mem);
mem.writeU32 = function(addr, val) {
  const r = origW32(addr, val);
  if (addr === 0x27C22 && !logging && cpu.ss === 0xC0) {
    logging = true;
    loggingStartStep = emu.cpuSteps;
    console.log(`\n=== Logging started at step ${emu.cpuSteps} after write val=0x${val.toString(16)} ss=${cpu.ss.toString(16)} ===`);
  }
  return r;
};

const MAX_TICKS = 80;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

console.log(`\nEIP jumps during first init IRQ0 handler:`);
for (const e of entries) {
  console.log(`  step=${e.step} cs=${e.cs.toString(16)}:${e.off.toString(16).padStart(4, '0')} ss=${e.ss.toString(16)} esp=${e.esp.toString(16)}`);
}
console.log(`\n[DONE] total=${entries.length}`);
