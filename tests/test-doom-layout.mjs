// Find all executable code areas by looking for function prologues
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

// Find "I_StartupSound" string — DOOM prints this. Search for the ASCII pattern.
console.log('[SCAN] Looking for string "I_StartupSound" in memory:');
const target = 'I_StartupSound';
let found = [];
for (let addr = 0x100000; addr < 0x700000; addr++) {
  let match = true;
  for (let i = 0; i < target.length; i++) {
    if (mem.readU8(addr + i) !== target.charCodeAt(i)) { match = false; break; }
  }
  if (match) {
    found.push(addr);
    if (found.length > 5) break;
  }
}
for (const a of found) console.log(`  at 0x${a.toString(16)}`);

// Dump I_StartupSound function body (which contains the puts("I_StartupSound"))
// Ref at 0x525f1e PUSH "I_StartupSound". Find function containing it by looking back for 55 89 e5 prologue.
function findFunctionStart(addr) {
  for (let i = 0; i < 2000; i++) {
    const a = addr - i;
    if (mem.readU8(a) === 0x55 && mem.readU8(a+1) === 0x89 && mem.readU8(a+2) === 0xe5) {
      // check prev byte is a RET or NOP (function boundary)
      const prev = mem.readU8(a-1);
      if (prev === 0xc3 || prev === 0x90 || prev === 0xcc) return a;
    }
  }
  return null;
}

const callerAddr = 0x525f1e;
const funcStart = findFunctionStart(callerAddr);
console.log(`\n[SCAN] I_StartupSound function starts at 0x${funcStart?.toString(16) || '?'}`);
if (funcStart) {
  // Dump function body
  console.log(`  Dump 0x${funcStart.toString(16)}..+0x200:`);
  for (let i = 0; i < 0x200; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16; j++) bytes.push(mem.readU8(funcStart + i + j).toString(16).padStart(2, '0'));
    console.log(`    0x${(funcStart+i).toString(16)}: ${bytes.join(' ')}`);
  }
}

// Find who CALLs I_StartupSound
if (funcStart) {
  console.log(`\n[SCAN] Callers of I_StartupSound (0x${funcStart.toString(16)}):`);
  let callerCount = 0;
  for (let addr = 0x100000; addr < 0x700000; addr++) {
    if (mem.readU8(addr) !== 0xe8) continue;
    const rel32 = mem.readU32(addr + 1) | 0;
    const target = (addr + 5 + rel32) >>> 0;
    if (target === funcStart) {
      callerCount++;
      if (callerCount <= 5) {
        const ctx = [];
        for (let j = -6; j < 10; j++) ctx.push(mem.readU8((addr + j) >>> 0).toString(16).padStart(2, '0'));
        console.log(`  CALL at 0x${addr.toString(16)}: ${ctx.join(' ')}`);
      }
    }
  }
  console.log(`  -> Total: ${callerCount}`);
}
