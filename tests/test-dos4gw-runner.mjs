// Generic runner for DOS executables. Captures VGA text-buffer activity
// (0xB8000-0xBA000) and dumps the final screen contents.
// Usage: npx tsx tests/test-dos4gw-runner.mjs <exe-path> [maxSteps] [maxSeconds]
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
function readToArrayBuffer(path) { const b = readFileSync(path); const ab = new ArrayBuffer(b.byteLength); new Uint8Array(ab).set(b); return ab; }

const exePath = process.argv[2];
if (!exePath) { console.error('Usage: test-dos4gw-runner.mjs <exe-path> [maxSteps] [maxSeconds]'); process.exit(1); }
const maxSteps = parseInt(process.argv[3] || '500000000', 10);
const maxSeconds = parseInt(process.argv[4] || '60', 10);

const BASE = exePath.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
const exeName = exePath.replace(/\\/g, '/').split('/').pop();
console.log(`[INIT] exe=${exePath} base=${BASE} maxSteps=${maxSteps} maxSeconds=${maxSeconds}`);
const exeBuf = readToArrayBuffer(exePath);
const peInfo = parsePE(exeBuf);
const emu = new Emulator();
emu.screenWidth = 320; emu.screenHeight = 200;
emu.exeName = exeName; emu.exePath = `D:\\${exeName}`;
for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  try {
    if (statSync(fp).isFile() && fname.toLowerCase() !== exeName.toLowerCase()) {
      emu.additionalFiles.set(fname, readToArrayBuffer(fp));
    }
  } catch (e) {}
}
await emu.load(exeBuf, peInfo, mockCanvas);

const mem = emu.memory;
const cpu = emu.cpu;
const VGA_LO = 0xB8000;
const VGA_HI = 0xBA000;

let totalWrites = 0;
const writers = new Map();
const lines = new Array(25).fill(null).map(() => new Uint8Array(80));
let firstWriteStep = -1;
let lastWriteStep = -1;
const recentChars = [];
const RECENT = 4000;

const origW8 = mem.writeU8.bind(mem);
const origW16 = mem.writeU16.bind(mem);
const origW32 = mem.writeU32.bind(mem);
function trackChar(addr, ch, cs, eip) {
  const off = addr - VGA_LO;
  const row = Math.floor(off / 160);
  const col = Math.floor((off % 160) / 2);
  if (row >= 0 && row < 25 && col >= 0 && col < 80) lines[row][col] = ch;
  if (firstWriteStep < 0) firstWriteStep = emu.cpuSteps;
  lastWriteStep = emu.cpuSteps;
  totalWrites++;
  const key = `cs=${cs.toString(16)}:0x${eip.toString(16).padStart(6,'0')}`;
  writers.set(key, (writers.get(key) || 0) + 1);
  if (ch >= 32 && ch <= 126) {
    recentChars.push(String.fromCharCode(ch));
    if (recentChars.length > RECENT) recentChars.shift();
  }
}
mem.writeU8 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI && (a & 1) === 0) trackChar(a, v & 0xFF, cpu.cs, cpu.eip >>> 0);
  origW8(a, v);
};
mem.writeU16 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI && (a & 1) === 0) trackChar(a, v & 0xFF, cpu.cs, cpu.eip >>> 0);
  origW16(a, v);
};
mem.writeU32 = function(a, v) {
  if (a >= VGA_LO && a < VGA_HI) {
    if ((a & 1) === 0) trackChar(a, v & 0xFF, cpu.cs, cpu.eip >>> 0);
    if (((a + 2) & 1) === 0) trackChar(a + 2, (v >>> 16) & 0xFF, cpu.cs, cpu.eip >>> 0);
  }
  origW32(a, v);
};

emu._pitCycleOnly = true;
emu.run();
const startTime = Date.now();
for (let tick = 0; tick < 50000; tick++) {
  if (emu.halted) break;
  emu.tick();
  if ((Date.now() - startTime) > maxSeconds * 1000) break;
  if (emu.cpuSteps > maxSteps) break;
}
const elapsed = (Date.now() - startTime) / 1000;
console.log(`\n[END] cpuSteps=${emu.cpuSteps} elapsed=${elapsed.toFixed(1)}s halted=${emu.halted} reason="${emu.haltReason || emu.cpu.haltReason}"`);
console.log(`[VGA] writes=${totalWrites} firstAt=${firstWriteStep} lastAt=${lastWriteStep} writerSites=${writers.size}`);
console.log(`[CPU] cs=${cpu.cs.toString(16)} eip=0x${(cpu.eip>>>0).toString(16)} RM=${cpu.realMode}`);

if (recentChars.length > 0) {
  const recent = recentChars.join('');
  const TRIGGERS = ['1001', 'DOS/4GW', 'fatal err', 'error in', 'interrupt chain', 'Mouse', 'Sound', 'I_StartupSound', 'V_Init', 'Stack overflow', 'Memory'];
  let foundAny = false;
  for (const trig of TRIGGERS) {
    if (recent.includes(trig)) {
      foundAny = true;
      const idx = recent.indexOf(trig);
      const start = Math.max(0, idx - 50);
      const end = Math.min(recent.length, idx + 80);
      console.log(`  [TRIG ${trig}] ...${recent.slice(start, end)}...`);
    }
  }
  if (!foundAny) console.log(`  [no trigger] last 200 printable chars: ...${recent.slice(-200)}`);
}

if (writers.size > 0) {
  console.log(`\n[TOP 5 WRITERS]:`);
  const sorted = [...writers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  for (const [k, v] of sorted) console.log(`  ${k}  count=${v}`);
}

console.log('\n[VGA TEXT BUFFER, current state]:');
for (let row = 0; row < 25; row++) {
  let line = '';
  for (let col = 0; col < 80; col++) {
    const ch = lines[row][col];
    if (ch === 0) line += ' ';
    else if (ch >= 32 && ch <= 126) line += String.fromCharCode(ch);
    else line += '.';
  }
  if (line.trim().length > 0) console.log(`  ${row.toString().padStart(2)}: ${line}`);
}
