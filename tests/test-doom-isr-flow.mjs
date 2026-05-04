// Check which parts of DOS/4GW's ISR handler run during init.
// We detect execution of specific instructions by hooking instruction-byte reads
// (the CPU fetches opcode bytes via readU8 from the linear address).
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
const CS_BASE = 0x1569 * 0x10; // = 0x15690

// Hook the CPU step: detect when EIP crosses key offsets inside 0x1569
// Offsets of interest:
//   0x580 = entry
//   0x5ba = write to [0xa42] at init (ENTER)
//   0x687 = call 0xba4 (USER HANDLER INVOCATION)
//   0x68a = post-call (USER HANDLER RETURNED)
//   0x6bd = write to [0xa42] at end (RESTORE)
//   0x6d5 = IRETD
//   0xc50 = early exit from 0xba4
//   0xc54 = retf from 0xba4
const KEY_OFFSETS = new Map([
  [0x580, 'ENTER 0x580'],
  [0x5ba, 'WRITE-A42 0x5ba (ENTER)'],
  [0x687, 'CALL 0xba4'],
  [0x68a, 'POST-CALL (returned)'],
  [0x6bd, 'WRITE-A42 0x6bd (RESTORE)'],
  [0x6d5, 'IRETD 0x6d5'],
  [0xba4, '[0xba4 entry]'],
  [0xbb8, '[0xba4 loop top (or main path)]'],
  [0xbc6, '[0xba4 al-and-3 je branch]'],
  [0xbf4, '[0xba4 al==1 path]'],
  [0xc18, '[0xba4 32-bit target path]'],
  [0xc38, '[0xba4 retf to user handler]'],
  [0xc40, '[0xba4 user handler returned via retf]'],
  [0xc4d, '[0xba4 loop back (EAX != 0)]'],
  [0xc50, '0xba4 early-exit path'],
  [0xc54, '0xba4 retf'],
  [0x913, 'ALT IRETD 0x913'],
  [0x918, '0x918 entry (push esi)'],
  [0x8d0, '0x8d0 (restore frame path)'],
  [0x8c8, '0x8c8 32-bit push path'],
  [0x8a0, '0x8a0 handler entry'],
  [0x880, 'post-handler at 0x880?'],
  [0x4e1, 'exit_2002 entry 0x4e1'],
]);

const events = [];
let eventCount = 0;
const MAX_EVENTS = 800;

// Hook readU8 to catch instruction fetches at these exact linear addresses
const origRU8 = mem.readU8.bind(mem);
mem.readU8 = function(addr) {
  const v = origRU8(addr);
  if (cpu.cs === 0x1569) {
    const off = addr - CS_BASE;
    if (KEY_OFFSETS.has(off)) {
      const eipCur = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
      if (eipCur === off && eventCount < MAX_EVENTS) {
        events.push({ label: KEY_OFFSETS.get(off), off, step: emu.cpuSteps, ss: cpu.ss, esp: cpu.reg[4] >>> 0 });
        eventCount++;
      }
    }
  }
  return v;
};

const MAX_TICKS = 80;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) break;
  emu.tick();
}

// Report — group by step to collapse noise
console.log(`\n${events.length} events captured:`);
let lastStep = -1, lastOff = -1;
for (const e of events) {
  if (e.step === lastStep && e.off === lastOff) continue;
  console.log(`  step=${e.step} cs=1569:${e.off.toString(16).padStart(4, '0')} [${e.label}]  ss=${e.ss.toString(16)} esp=${e.esp.toString(16)}`);
  lastStep = e.step; lastOff = e.off;
}

console.log(`\n[DONE] halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
