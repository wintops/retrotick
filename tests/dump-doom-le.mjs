// Extract DOOM's LE segments (post-load, post-relocation) as raw binary files.
// Lets IDA/Ghidra disassemble them at the correct runtime base addresses.
//
// Usage: npx tsx tests/dump-doom-le.mjs
// Output: /tmp/doom-cs-1569.bin, /tmp/doom-cs-1b4e.bin, etc.
//
// To load in IDA: File > Load file > Binary file, then set segment base to
// cs*16 (e.g. 0x15690 for cs=0x1569), processor = 80386, 16-bit code.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
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
emu._picMasterMask |= 1; // mask IRQ0 so we don't crash before dumping
emu.run();

// Run ticks until all LE segments are loaded. We know DOS/4GW loads them
// within the first few hundred thousand cpuSteps. Run until cs=0x168 (DOOM's
// flat code) is active or we've run enough steps.
const cpu = emu.cpu;
const mem = emu.memory;
const seenCS = new Set();
const origLoadCS = cpu.loadCS.bind(cpu);
cpu.loadCS = function(sel) {
  seenCS.add(sel);
  return origLoadCS(sel);
};

for (let tick = 0; tick < 200; tick++) {
  if (emu.halted) break;
  emu.tick();
  // Stop once DOOM's flat code runs (means all LE setup is done)
  if (seenCS.has(0x168)) break;
}

console.log(`[INFO] Stopped after ${emu.cpuSteps} cpuSteps, seen selectors: ${[...seenCS].map(s=>s.toString(16)).sort().join(',')}`);

// Dump the LE segments we care about
const segments = [
  { sel: 0x98,   size: 0x57d0 },   // DOS/4GW "boot" code-ish (size from AX=000C set descriptor)
  { sel: 0x1569, size: 0x5e3f },   // first LE segment (read from file offset 0xF384)
  { sel: 0x1b4e, size: 0xb6ef },   // second LE segment (read from file offset 0x151C4)
  { sel: 0x26be, size: 0x0570 },   // third (read from 0x208b4)
  { sel: 0x271e, size: 0x3da0 },   // fourth (read from 0x20e24)
  { sel: 0x2eef, size: 0x0650 },   // fifth (read from 0x24bc4)
];

for (const { sel, size } of segments) {
  const base = sel * 16;
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = mem.readU8((base + i) >>> 0);
  const path = `/tmp/doom-cs-${sel.toString(16)}.bin`;
  writeFileSync(path, buf);
  // Compute simple stats
  let nonzero = 0;
  for (let i = 0; i < size; i++) if (buf[i] !== 0) nonzero++;
  console.log(`[DUMP] cs=0x${sel.toString(16)} base=0x${base.toString(16)} size=0x${size.toString(16)} (${size} bytes, ${nonzero} non-zero) → ${path}`);
}

console.log(`\n[DONE] Dumped segments. To disassemble:`);
console.log(`  ndisasm -b 16 /tmp/doom-cs-1b4e.bin > cs-1b4e.asm`);
console.log(`  ndisasm -b 16 -o 0x3100 /tmp/doom-cs-1b4e.bin | less   # view from offset 0x3100`);
console.log(`Or load in IDA/Ghidra with:`);
console.log(`  processor: 80386`);
console.log(`  segment base: cs*16 (e.g. 0x1B4E0 for cs=0x1b4e)`);
console.log(`  code mode: 16-bit (the LE segments have D=0)`);
