// Trace writes to the VGA text buffer (0xB8000-0xB9F9F) to find the path
// that emits "DOS/4GW Professional fatal error (1001): error in interrupt
// chain" on DOOM. Sessions 27-30 ruled out INT 21h AH=02/06/09/40, INT 10h
// AH=0Eh, INT 29h. Hypothesis: a direct mov [B800:..], byte path or far
// pointer write into the CGA/text buffer.
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

const mem = emu.memory;
const cpu = emu.cpu;
const VGA_LO = 0xB8000;
const VGA_HI = 0xBA000; // 25 rows × 80 cols × 2 bytes = 4000, rounded up

// Track sequential character writes and look for "1001", "DOS/4GW", or "error in"
const writers = new Map(); // cs:eip → count
const lastChars = []; // ring buffer of recent printable chars
const RING = 200;
let firstHitFound = false;
let firstHitAt = -1;
let firstHitCS = 0;
let firstHitEip = 0;
let inrange = 0;

const TRIGGERS = ['1001', 'DOS/4GW', 'error in', 'fatal err', 'interrupt'];

function recordChar(addr, ch, cs, eip) {
  if (ch < 32 || ch > 126) return;
  lastChars.push({ ch, cs, eip, step: emu.cpuSteps, addr });
  if (lastChars.length > RING) lastChars.shift();
  // Build last 40 chars as string and search for triggers
  const tail = lastChars.slice(-40).map(c => String.fromCharCode(c.ch)).join('');
  for (const trig of TRIGGERS) {
    if (tail.includes(trig) && !firstHitFound) {
      firstHitFound = true;
      firstHitAt = emu.cpuSteps;
      firstHitCS = cs;
      firstHitEip = eip;
      console.log(`\n[!! TRIGGER !!] tail="${tail}" matched "${trig}"`);
      console.log(`  cs=0x${cs.toString(16)} eip=0x${eip.toString(16)} step=${emu.cpuSteps} addr=0x${addr.toString(16)}`);
      console.log(`  last 30 chars sequence:`);
      const sequence = lastChars.slice(-30);
      for (const c of sequence) {
        console.log(`    addr=0x${c.addr.toString(16)} ch='${String.fromCharCode(c.ch)}' (0x${c.ch.toString(16)}) cs=0x${c.cs.toString(16)} eip=0x${c.eip.toString(16)} step=${c.step}`);
      }
    }
  }
}

const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
mem.writeU8 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI) {
    inrange++;
    // Even byte = character; odd = attribute
    if ((a & 1) === 0) {
      const cs = cpu.cs, eip = (cpu.eip >>> 0);
      const key = `cs=0x${cs.toString(16)}:0x${eip.toString(16)}`;
      writers.set(key, (writers.get(key) || 0) + 1);
      recordChar(a, v & 0xFF, cs, eip);
    }
  }
  origW8(a, v);
};
mem.writeU16 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI) {
    inrange++;
    // Word write: low byte = character, high byte = attribute (CGA standard)
    if ((a & 1) === 0) {
      const cs = cpu.cs, eip = (cpu.eip >>> 0);
      const key = `cs=0x${cs.toString(16)}:0x${eip.toString(16)}`;
      writers.set(key, (writers.get(key) || 0) + 1);
      recordChar(a, v & 0xFF, cs, eip);
    }
  }
  origW16(a, v);
};
mem.writeU32 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI) {
    inrange++;
    // DWord = 2 chars + 2 attrs (char, attr, char, attr)
    if ((a & 1) === 0) {
      const cs = cpu.cs, eip = (cpu.eip >>> 0);
      const key = `cs=0x${cs.toString(16)}:0x${eip.toString(16)}`;
      writers.set(key, (writers.get(key) || 0) + 1);
      recordChar(a, v & 0xFF, cs, eip);
      recordChar(a + 2, (v >>> 16) & 0xFF, cs, eip);
    }
  }
  origW32(a, v);
};

emu._pitCycleOnly = true;
emu.run();
for (let tick = 0; tick < 6000; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (firstHitFound && emu.cpuSteps > firstHitAt + 10000) break;
  if (emu.cpuSteps > 600_000_000) break;
}

console.log(`\n[END] cpuSteps=${emu.cpuSteps} halted=${emu.halted} reason="${emu.haltReason}"`);
console.log(`[END] in-range writes=${inrange} unique writers=${writers.size}`);

if (writers.size > 0) {
  console.log(`\n[TOP 20 WRITERS]:`);
  const sorted = [...writers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [k, v] of sorted) console.log(`  ${k}  count=${v}`);
}

if (!firstHitFound) {
  // Dump full text buffer to see what got written
  console.log('\n[VGA TEXT BUFFER DUMP] (rows 0-24):');
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const ch = mem.readU8(VGA_LO + (row * 80 + col) * 2);
      if (ch === 0) line += ' ';
      else if (ch >= 32 && ch <= 126) line += String.fromCharCode(ch);
      else line += '.';
    }
    if (line.trim().length > 0) console.log(`  ${row.toString().padStart(2)}: ${line}`);
  }
}
