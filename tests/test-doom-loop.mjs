// Find out what DOS/4GW is scanning in its exception-table loop at cs=1569:0x1016.
// The scan follows a chain: next = byte[table+si*8+1]. We log each SI transition.
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

// Detect when we enter the loop range cs=1569:0x1016..0x1046
let loopDetected = false;
let loopStartStep = 0;
const siSeq = [];
emu._stepHook = (cpu) => {
  if (loopDetected) return;
  const eipOff = (cpu.eip - cpu.segBase(cpu.cs)) >>> 0;
  if (cpu.cs === 0x1569 && eipOff === 0x1016 && emu.cpuSteps > 10000000) {
    const si = cpu.reg[6] >>> 0 & 0xFFFF;
    siSeq.push({ si, step: emu.cpuSteps });
    if (siSeq.length >= 20) {
      loopDetected = true;
      loopStartStep = emu.cpuSteps;
      console.log(`\n=== SI sequence in DOS/4GW loop at cs=1569:0x1016 ===`);
      for (const s of siSeq) console.log(`  step=${s.step} si=0x${s.si.toString(16)}`);
      // Dump the table contents
      const ds = cpu.ds;
      const dsBase = cpu.segBase(ds);
      // Also check [DS:0x3c7c] — the ES source for the FIRST byte read (`al = [ES:BX+2]`)
      const esSel0 = emu.memory.readU16((dsBase + 0x3c7c) >>> 0);
      const bpArg = cpu.reg[5] >>> 0 & 0xFFFF;
      console.log(`[DS:0x3c7c] = selector 0x${esSel0.toString(16)} (base=0x${cpu.segBase(esSel0).toString(16)})`);
      console.log(`Function called with BP=${bpArg.toString(16)}, [BP+6] (=BX at entry) = word at DS:BP+6 = ${emu.memory.readU16((dsBase + bpArg + 6) >>> 0).toString(16)}`);
      const esSel = emu.memory.readU16((dsBase + 0x3c7e) >>> 0);
      const esBase = cpu.segBase(esSel);
      const tableOffLo = emu.memory.readU16((esBase + 0x122) >>> 0);
      const tableOffHi = emu.memory.readU16((esBase + 0x122 + 2) >>> 0);
      // [ES:0x122] is a far pointer: off at 0x122, seg at 0x124
      const tableSeg = tableOffHi;
      const tableLin = (cpu.segBase(tableSeg) + tableOffLo) >>> 0;
      console.log(`\nDS=${ds.toString(16)} → [DS:0x3c7e]=ES=${esSel.toString(16)} base=0x${esBase.toString(16)}`);
      console.log(`[ES:0x122] = ${tableSeg.toString(16)}:${tableOffLo.toString(16)} → linear 0x${tableLin.toString(16)}`);
      console.log(`\nTable entries (8 bytes each, first 40):`);
      for (let i = 0; i < 40; i++) {
        const entry = [];
        for (let b = 0; b < 8; b++) entry.push(emu.memory.readU8((tableLin + i * 8 + b) >>> 0).toString(16).padStart(2, '0'));
        const type = parseInt(entry[0], 16);
        const next = parseInt(entry[1], 16);
        console.log(`  [${i.toString().padStart(3)}] type=${type} next=${next}  raw=[${entry.join(' ')}]`);
      }
    }
  }
};

const MAX_TICKS = 800;
for (let tick = 0; tick < MAX_TICKS; tick++) {
  if (emu.halted || loopDetected) break;
  emu.tick();
}

console.log(`\n[DONE] loopDetected=${loopDetected} halted=${emu.halted} reason=${emu.haltReason} steps=${emu.cpuSteps}`);
