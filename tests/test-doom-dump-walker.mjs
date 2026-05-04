// Dump DOS/4GW chain walker memory at various points to understand 0F B8 bytes
import { readFileSync, readdirSync, statSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

const noop = () => {};
const mockCtx = {
  fillRect: noop, clearRect: noop, strokeRect: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 8 }),
  drawImage: noop, putImageData: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  setTransform: noop, resetTransform: noop, transform: noop,
  beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop,
  arc: noop, arcTo: noop, rect: noop, ellipse: noop,
  fill: noop, stroke: noop, clip: noop,
  createLinearGradient: () => ({ addColorStop: noop }),
  createRadialGradient: () => ({ addColorStop: noop }),
  createPattern: () => null,
  font: '', textAlign: 'left', textBaseline: 'top',
  fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  globalAlpha: 1, globalCompositeOperation: 'source-over',
  imageSmoothingEnabled: true, shadowBlur: 0, shadowColor: 'transparent',
  canvas: null,
};
const mockCanvas = {
  width: 640, height: 480,
  getContext: () => mockCtx,
  toDataURL: () => 'data:image/png;base64,',
  addEventListener: noop, removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
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
emu.screenWidth = 320;
emu.screenHeight = 200;
emu.exeName = 'DoomShw/DOOM.EXE';
emu.exePath = 'D:\\DoomShw\\DOOM.EXE';

for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'DOOM.EXE') {
    emu.additionalFiles.set(fname, readToArrayBuffer(fp));
  }
}

await emu.load(doomBuf, peInfo, mockCanvas);

function dumpRegion(label, linearBase, len) {
  console.log(`  ${label}:`);
  for (let i = 0; i < len; i += 16) {
    const bytes = [];
    for (let j = 0; j < 16 && i + j < len; j++) {
      bytes.push(emu.memory.readU8(linearBase + i + j).toString(16).padStart(2, '0'));
    }
    console.log(`    +${(i).toString(16).padStart(3, '0')}: ${bytes.join(' ')}`);
  }
}

emu.run();

const MAX_TICKS = 300;
let dumpedEarly = false;
let dumpedMid = false;
let snapshotEarly = null;
let snapshotMid = null;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted) {
    console.log(`\n[HALT AT] eip=0x${(emu.cpu.eip >>> 0).toString(16)} cs=0x${emu.cpu.cs.toString(16)} step=${emu.cpuSteps}`);
    dumpRegion('FINAL cs=1569:0xBA0..0xC00', 0x15690 + 0xBA0, 0x60);
    if (snapshotEarly) {
      const finalBytes = [];
      for (let i = 0; i < 0x60; i++) finalBytes.push(emu.memory.readU8(0x15690 + 0xBA0 + i));
      let diffs = 0;
      for (let i = 0; i < 0x60; i++) {
        if (snapshotEarly[i] !== finalBytes[i]) {
          diffs++;
          if (diffs <= 10) console.log(`    DIFF +${i.toString(16).padStart(3,'0')}: early=${snapshotEarly[i].toString(16).padStart(2,'0')} final=${finalBytes[i].toString(16).padStart(2,'0')}`);
        }
      }
      console.log(`  Total diffs: ${diffs}`);
    }
    break;
  }
  emu.tick();
  if (!dumpedEarly && emu.cpuSteps > 500_000) {
    dumpedEarly = true;
    console.log(`\n[EARLY DUMP] step=${emu.cpuSteps}`);
    dumpRegion('cs=1569:0xBA0..0xC00', 0x15690 + 0xBA0, 0x60);
    snapshotEarly = [];
    for (let i = 0; i < 0x60; i++) snapshotEarly.push(emu.memory.readU8(0x15690 + 0xBA0 + i));
  }
  if (!dumpedMid && emu.cpuSteps > 15_000_000) {
    dumpedMid = true;
    console.log(`\n[MID DUMP] step=${emu.cpuSteps}`);
    dumpRegion('cs=1569:0xBA0..0xC00', 0x15690 + 0xBA0, 0x60);
    snapshotMid = [];
    for (let i = 0; i < 0x60; i++) snapshotMid.push(emu.memory.readU8(0x15690 + 0xBA0 + i));
  }
}
