// Run SR and capture GUS DMA upload events + voice register writes.
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
const peInfo = parsePE(secondBuf);

const emu = new Emulator();
emu.screenWidth = 320; emu.screenHeight = 200;
emu.exeName = '2nd_real/SECOND.EXE'; emu.exePath = 'D:\\2nd_real\\SECOND.EXE';
emu.additionalFiles.set('REALITY.FC', realityBuf);
await emu.load(secondBuf, peInfo, mockCanvas);
emu._pitCycleOnly = true; // advance PIT on emulated cycles instead of wall-clock

// Instrument GUS port I/O via wrappers (count + selective trace of the first N events)
const gus = emu.dosAudio.gus;
const origPortWrite = gus.portWrite.bind(gus);
const origPortWrite16 = gus.portWrite16.bind(gus);
let regWriteCount = 0, dmaUploadCount = 0, voiceTriggerCount = 0;
const firstEvents = [];
const voiceTriggers = [];

function logEvent(obj) {
  if (firstEvents.length < 60) firstEvents.push(obj);
}

gus.portWrite = (port, value) => {
  origPortWrite(port, value);
  const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
  if (off === 0x105) {
    regWriteCount++;
    const reg = gus.selectedRegister;
    const data = gus.registerData;
    if (reg === 0x00 && (data >> 8) === 0x00) {
      voiceTriggerCount++;
      const vi = gus.voiceIndex;
      const v = gus.voices[vi];
      voiceTriggers.push({ vi, start: v.wave.start, end: v.wave.end, pos: v.wave.pos, inc: v.wave.inc, pan: v.pan, volPos: v.vol.pos, volInc: v.vol.inc, step: emu.cpuSteps });
    }
    if (reg === 0x41) {
      const hi = data >> 8;
      if (hi & 0x01) {
        dmaUploadCount++;
        logEvent({ kind: 'DMA', step: emu.cpuSteps, dmaAddr: gus.dmaAddr, ctrl: hi.toString(16) });
      }
    }
  }
};
gus.portWrite16 = (port, value) => {
  origPortWrite16(port, value);
  const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
  if (off === 0x104) {
    regWriteCount++;
    const reg = gus.selectedRegister;
    if (reg === 0x00 && (value >> 8) === 0x00) {
      voiceTriggerCount++;
      const vi = gus.voiceIndex;
      const v = gus.voices[vi];
      voiceTriggers.push({ vi, start: v.wave.start, end: v.wave.end, pos: v.wave.pos, inc: v.wave.inc, pan: v.pan, volPos: v.vol.pos, volInc: v.vol.inc, step: emu.cpuSteps });
    }
    if (reg === 0x41) {
      const hi = value >> 8;
      if (hi & 0x01) {
        dmaUploadCount++;
        logEvent({ kind: 'DMA', step: emu.cpuSteps, dmaAddr: gus.dmaAddr, ctrl: hi.toString(16) });
      }
    }
  }
};

emu.run();

const BATCH = 100000;
const MAX_BATCHES = 600;
let totalSteps = 0;
let enterSent = false;
for (let batch = 0; batch < MAX_BATCHES; batch++) {
  if (emu.halted) break;
  for (let i = 0; i < BATCH; i++) {
    emu.tick();
    totalSteps++;
    if (emu.halted) break;
  }
  if (batch % 20 === 0) {
    const linEip = (emu.cpu.cs * 16 + (emu.cpu.eip >>> 0)) & 0xFFFFF;
    const b = [];
    for (let k = 0; k < 8; k++) b.push(emu.memory.readU8((linEip + k) & 0xFFFFF).toString(16).padStart(2, '0'));
    console.log(`[PROG] batch=${batch} totalSteps=${totalSteps} cpuSteps=${emu.cpuSteps} CS:IP=${emu.cpu.cs.toString(16)}:${(emu.cpu.eip >>> 0).toString(16)} (lin=${linEip.toString(16)} bytes=${b.join(' ')}) halted=${emu._dosHalted?'DOS':''}${emu.halted?'HLT':''} pendingInts=${emu._pendingHwInts.length} regWrites=${regWriteCount} dmaUp=${dmaUploadCount} trig=${voiceTriggerCount}`);
  }
  // After ~10M instructions SR should have reached the menu — press Enter.
  if (!enterSent && totalSteps > 10_000_000) {
    console.log(`[INPUT] Pressing Enter at step ${totalSteps}`);
    emu.injectHwKey(0x1C); // Enter make
    emu.injectHwKey(0x9C); // Enter break
    enterSent = true;
  }
}

console.log(`[STATS] total register writes=${regWriteCount}, DMA uploads=${dmaUploadCount}, voice triggers (reg 0x00 state=0)=${voiceTriggerCount}`);
console.log(`[STATS] totalSteps=${totalSteps}, cpuSteps=${emu.cpuSteps}, halted=${emu.halted}`);
console.log(`\n[DMA events, first ${Math.min(firstEvents.length, 20)}]:`);
for (let i = 0; i < Math.min(firstEvents.length, 20); i++) {
  const e = firstEvents[i];
  console.log(`  step=${e.step} dmaAddr=0x${e.dmaAddr.toString(16).padStart(4, '0')} ctrl=0x${e.ctrl}`);
}

console.log(`\n[Voice triggers, first ${Math.min(voiceTriggers.length, 15)}]:`);
for (let i = 0; i < Math.min(voiceTriggers.length, 15); i++) {
  const v = voiceTriggers[i];
  const startByte = (v.start >> 9).toString(16);
  const endByte = (v.end >> 9).toString(16);
  console.log(`  step=${v.step} voice=${v.vi} start=0x${startByte} end=0x${endByte} pos=0x${(v.pos>>9).toString(16)} inc=0x${v.inc.toString(16)} pan=${v.pan} vol.pos=0x${v.volPos.toString(16)} vol.inc=${v.volInc}`);
}

console.log(`\n[GUS RAM samples at trigger offsets]:`);
const samplePoints = new Set();
for (const v of voiceTriggers.slice(0, 20)) {
  samplePoints.add(v.start >> 9);
}
for (const addr of [...samplePoints].sort((a,b)=>a-b)) {
  const bytes = [];
  for (let i = 0; i < 16; i++) bytes.push(gus.ram[(addr + i) & 0xFFFFF].toString(16).padStart(2, '0'));
  console.log(`  0x${addr.toString(16).padStart(5, '0')}: ${bytes.join(' ')}`);
}
