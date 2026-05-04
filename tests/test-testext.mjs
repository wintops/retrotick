// Test: TESTEXT.EXE — XMS extended memory read/write test
import { readFileSync } from 'fs';
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

const buf = readToArrayBuffer('C:/Users/Olivier/Documents/0_Perso/dosbox_d/TESTEXT3/TESTEXT.EXE');
const emu = new Emulator();
emu.screenWidth = 640; emu.screenHeight = 480;
emu.exeName = 'TESTEXT.EXE'; emu.exePath = 'D:\\TESTEXT3\\TESTEXT.EXE';
emu.traceApi = true;
// Toggle via env var: DOS_V86=0 → disable pseudo-V86
if (process.env.DOS_V86 === '0') emu.dosEnableV86 = false;
// Intercept port I/O to trace A20/8042 interactions
const origPortOut = emu.portOut.bind(emu);
let a20EnabledStep = -1;
emu.portOut = (port, val) => {
  if (port === 0x92 || port === 0x64 || port === 0x60 || port === 0x70 || port === 0x71) {
    console.log(`[PORT ${emu.cpuSteps}] OUT 0x${port.toString(16)}, 0x${val.toString(16)} EIP=${emu.cpu.eip.toString(16)}`);
    if (port === 0x60 && val === 0xDF) a20EnabledStep = emu.cpuSteps;
  }
  origPortOut(port, val);
};
const origPortIn = emu.portIn.bind(emu);
emu.portIn = (port) => {
  const val = origPortIn(port);
  if (port === 0x92 || port === 0x64 || port === 0x60 || port === 0x70 || port === 0x71) console.log(`[PORT ${emu.cpuSteps}] IN 0x${port.toString(16)} → 0x${val.toString(16)} EIP=${emu.cpu.eip.toString(16)}`);
  return val;
};
await emu.load(buf, parsePE(buf), mockCanvas);
emu.run();

// Log XMS state
console.log(`[XMS] baseAddr=0x${emu._xmsBaseAddr.toString(16)} nextAddr=0x${emu._xmsNextAddr.toString(16)} totalKB=${emu._xmsTotalKB}`);
console.log(`[XMS] stub at F000:0800 bytes: ${[0,1,2].map(i => emu.memory.readU8(0xF0800 + i).toString(16).padStart(2,'0')).join(' ')}`);
console.log(`[IVT] INT 2Fh vector: ${emu.memory.readU16(0x2F*4+2).toString(16)}:${emu.memory.readU16(0x2F*4).toString(16)}`);
console.log(`[IVT] INT 67h vector: ${emu.memory.readU16(0x67*4+2).toString(16)}:${emu.memory.readU16(0x67*4).toString(16)}`);

// Read console buffer after test to see printed output


// Track segBase cache for selector 0x30 (extended memory)
const origSegBase = emu.cpu.segBase.bind(emu.cpu);
const ext_bases = new Set();
emu.cpu.segBase = function(sel) {
  const b = origSegBase(sel);
  if (sel === 0x30) ext_bases.add(b);
  return b;
};

// Wall-clock budget: configurable via DEADLINE_S env (default 8s). Snapshot
// the console buffer periodically so we can see Phase/Errors transitions.
const deadlineS = Number(process.env.DEADLINE_S ?? 8);
const snapshotEveryMs = Number(process.env.SNAPSHOT_MS ?? 2000);
const deadline = Date.now() + deadlineS * 1000;
let i = 0;
let nextSnapshotAt = Date.now() + snapshotEveryMs;
const extractStatus = () => {
  // Rows 4 (Word Size / Extended Memory) and 5 (Errors / Phase)
  const row = (r) => {
    let s = '';
    for (let c = 0; c < 80; c++) {
      const e = emu.consoleBuffer?.[r * 80 + c];
      s += e && e.char > 0x20 ? String.fromCharCode(e.char) : ' ';
    }
    return s.trim();
  };
  return { r3: row(3), r4: row(4), r5: row(5) };
};
// Scan memory grid rows (8..22) for any non-zero bank — signals errors in headless.
let lastBadReport = '';
const scanGrid = () => {
  const lines = [];
  for (let r = 8; r <= 22; r++) {
    let s = '';
    for (let c = 0; c < 80; c++) {
      const e = emu.consoleBuffer?.[r * 80 + c];
      s += e && e.char > 0x20 ? String.fromCharCode(e.char) : ' ';
    }
    // "FFFFFFFF" anywhere means a bank failed.
    if (s.includes('FFFFFFFF')) lines.push(s.trimEnd());
  }
  return lines;
};
while (Date.now() < deadline) {
  if (emu.halted) break;
  emu.tick();
  i++;
  if (Date.now() >= nextSnapshotAt) {
    const s = extractStatus();
    console.log(`[T+${((Date.now() - deadline + deadlineS * 1000) / 1000).toFixed(1)}s steps=${emu.cpuSteps}] ${s.r3} | ${s.r4} | ${s.r5}`);
    const bad = scanGrid();
    if (bad.length > 0) {
      const joined = bad.join('\n    ');
      if (joined !== lastBadReport) {
        console.log(`  !! GRID ERRORS:\n    ${joined}`);
        lastBadReport = joined;
      }
    }
    nextSnapshotAt = Date.now() + snapshotEveryMs;
  }
}
console.log(`[ran ${i} ticks in ${((Date.now() - deadline + deadlineS * 1000)/1000).toFixed(1)}s]`);

// Now dump GDT at the end
console.log(`[GDT base=0x${emu._gdtBase.toString(16)} limit=0x${emu._gdtLimit.toString(16)}]`);
for (let i = 0; i <= (emu._gdtLimit >> 3); i++) {
  const lo = emu.memory.readU32(emu._gdtBase + i * 8);
  const hi = emu.memory.readU32(emu._gdtBase + i * 8 + 4);
  const baseLo = (lo >>> 16) & 0xFFFF;
  const baseMid = hi & 0xFF;
  const baseHi = (hi >>> 24) & 0xFF;
  const base = ((baseHi << 24) | (baseMid << 16) | baseLo) >>> 0;
  const limitLo = lo & 0xFFFF;
  const limitHi = (hi >>> 16) & 0x0F;
  const limit = (limitHi << 16) | limitLo;
  const access = (hi >>> 8) & 0xFF;
  console.log(`  [${i}] sel=0x${(i*8).toString(16)} base=0x${base.toString(16)} limit=0x${limit.toString(16)} access=0x${access.toString(16)}`);
}
console.log(`[DISTINCT SELECTOR 0x30 BASES SEEN] count=${ext_bases.size}`);
if (ext_bases.size < 20) for (const b of ext_bases) console.log(`  0x${b.toString(16)}`);
console.log(`[segBases cache size] ${emu.cpu.segBases.size}`);
console.log(`[A20] mask after test: 0x${emu.memory.a20Mask.toString(16)}`);
// Dump console output
if (emu.consoleBuffer && emu.consoleBuffer.length > 0) {
  const lines = [];
  for (let row = 0; row < 25; row++) {
    let line = '';
    for (let col = 0; col < 80; col++) {
      const entry = emu.consoleBuffer[row * 80 + col];
      const ch = entry ? entry.char : 0x20;
      line += ch > 0x20 ? String.fromCharCode(ch) : ' ';
    }
    const trimmed = line.trimEnd();
    if (trimmed) lines.push(`[CON ${row}] ${trimmed}`);
  }
  for (const l of lines) console.log(l);
}

// Dump what's at E000:0000
const e0bytes = [];
for (let i = 0; i < 24; i++) e0bytes.push(emu.memory.readU8(0xE0000 + i).toString(16).padStart(2, '0'));
console.log(`[E000:0000] ${e0bytes.join(' ')}`);
console.log(`Halted: ${emu.halted}, steps: ${emu.cpuSteps}, reason: ${emu.cpu.haltReason || 'still running'}`);
