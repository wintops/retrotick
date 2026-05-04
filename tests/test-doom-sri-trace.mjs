// Trace DPMI AX=0302 calls with intNum + struct contents to understand 0:801 target
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

const cpu = emu.cpu;
const origStep = cpu.step.bind(cpu);

// Catch entries to dpmiSimulateRmInt target 0:801. Since we can't hook the DPMI
// function directly, catch INT 31h instructions with AX=0300/0301/0302 and
// inspect the struct.
let traced = 0;
const INTNUMS = new Set();

cpu.step = function() {
  // Detect INT 31h just before execution
  const eip = cpu.eip >>> 0;
  const b0 = emu.memory.readU8(eip);
  const b1 = emu.memory.readU8(eip + 1);
  if (b0 === 0xcd && b1 === 0x31 && !cpu.realMode) {
    const ax = cpu.reg[0] & 0xffff;
    if (ax === 0x0302 || ax === 0x0301 || ax === 0x0300) {
      const structLin = (cpu.segBase(cpu.es) + (cpu.use32 ? cpu.reg[7] : (cpu.reg[7] & 0xffff))) >>> 0;
      const sriCS = emu.memory.readU16(structLin + 0x2C);
      const sriIP = emu.memory.readU16(structLin + 0x2A);
      const intNum = cpu.reg[3] & 0xff;
      if (sriCS === 0 && sriIP === 0x801 && traced < 5) {
        traced++;
        const callerCS = cpu.cs;
        const callerEip = eip;
        console.log(`[SRI->0:801 #${traced}] step=${emu.cpuSteps} AX=0x${ax.toString(16)} intNum=0x${intNum.toString(16)} struct@0x${structLin.toString(16)} rmDS=${emu.memory.readU16(structLin+0x24).toString(16)} rmEAX=0x${emu.memory.readU32(structLin+0x1C).toString(16)}`);
        console.log(`  caller cs=${callerCS.toString(16)} eip=0x${callerEip.toString(16)}`);
        INTNUMS.add(intNum);
      }
    }
  }
  origStep();
};

emu.run();
for (let tick = 0; tick < 300; tick++) {
  if (emu.halted) break;
  emu.tick();
  if (emu.cpuSteps > 20_000_000) break;
}
console.log(`[DONE] step=${emu.cpuSteps} traced=${traced} intNums=${[...INTNUMS].map(n=>n.toString(16)).join(',')}`);
