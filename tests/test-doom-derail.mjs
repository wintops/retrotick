// Find the instruction where DOOM's EIP first derails to an invalid range.
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

// Ring buffer of last 32 instructions
const ring = new Array(32).fill(null);
let ringIdx = 0;
let derailed = false;
const DERAIL_EIP_THRESHOLD = 0x1000000; // 16MB

emu._stepHook = (cpu) => {
  if (derailed || emu.cpuSteps < 2500000) return;
  const eip = cpu.eip >>> 0;
  ring[ringIdx % 32] = {
    eip, cs: cpu.cs, ss: cpu.ss, esp: cpu.reg[4] >>> 0,
    eax: cpu.reg[0] >>> 0, ebp: cpu.reg[5] >>> 0,
  };
  ringIdx++;
  if (cpu.cs === 0x168 && eip > DERAIL_EIP_THRESHOLD) {
    derailed = true;
    console.log(`\n=== DERAIL at step ${emu.cpuSteps} ===`);
    console.log(`Last 32 instructions (oldest first):`);
    for (let i = 0; i < 32; i++) {
      const idx = (ringIdx + i) % 32;
      const r = ring[idx];
      if (!r) continue;
      // Also dump the opcode bytes at each EIP (flat cs=168, so linear = eip)
      const bytes = [];
      for (let b = 0; b < 6; b++) bytes.push(emu.memory.readU8((r.eip + b) >>> 0).toString(16).padStart(2, '0'));
      console.log(`  ${i.toString().padStart(2)}: cs=${r.cs.toString(16)}:${r.eip.toString(16)} ss=${r.ss.toString(16)} esp=${r.esp.toString(16)} eax=${r.eax.toString(16)} ebp=${r.ebp.toString(16)} bytes=[${bytes.join(' ')}]`);
    }
    // Dump stack 16 bytes below ESP — using segBase(ss) + esp
    const r = ring[(ringIdx - 2 + 32) % 32]; // second-to-last entry (pre-derail)
    if (r) {
      const ssBase = cpu.segBase(r.ss);
      const lin = (ssBase + r.esp) >>> 0;
      console.log(`\nSS=${r.ss.toString(16)} base=0x${ssBase.toString(16)} ESP=0x${r.esp.toString(16)} → linear 0x${lin.toString(16)}`);
      // Raw bytes [lin-16 .. lin+24]
      let raw = '';
      for (let i = -16; i < 28; i++) {
        raw += emu.memory.readU8((lin + i) >>> 0).toString(16).padStart(2, '0') + ' ';
        if ((i & 3) === 3) raw += ' ';
      }
      console.log(`    raw: ${raw}`);
      console.log(`    cpu.use32=${cpu.use32} cpu._ssB32=${cpu._ssB32} cpu.realMode=${cpu.realMode}`);
      // Dump GDT entry for SS=0x170
      const gdtBase = emu._gdtBase;
      if (gdtBase) {
        const idx = r.ss >>> 3;
        const descAddr = gdtBase + idx * 8;
        const lo = emu.memory.readU32(descAddr);
        const hi = emu.memory.readU32(descAddr + 4);
        const bBit = (hi >>> 22) & 1;
        const gBit = (hi >>> 23) & 1;
        const limit = ((hi & 0x000F0000) | (lo & 0xFFFF));
        const base = ((hi & 0xFF000000) | ((hi & 0xFF) << 16) | ((lo >>> 16) & 0xFFFF)) >>> 0;
        console.log(`    GDT[${idx.toString(16)}] (for SS=${r.ss.toString(16)}): desc=0x${hi.toString(16)}_${lo.toString(16)} B=${bBit} G=${gBit} base=0x${base.toString(16)} limit=0x${limit.toString(16)}`);
        // Call loadGdtDescriptorIs32 to see what it returns NOW
        const nowIs32 = cpu.loadGdtDescriptorIs32(r.ss);
        console.log(`    loadGdtDescriptorIs32(${r.ss.toString(16)}) NOW returns: ${nowIs32}`);
        // Force recompute _ssB32 by re-setting ss
        cpu.ss = r.ss;
        console.log(`    After re-setting cpu.ss=${r.ss.toString(16)}: _ssB32=${cpu._ssB32}`);
      }
    }
  }
};

const MAX_TICKS = 600;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted || derailed) break;
  emu.tick();
}

console.log(`\n[DONE] derailed=${derailed} halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
