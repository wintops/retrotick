import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';

// Mock Canvas/OffscreenCanvas for headless Node.js
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
  addEventListener: noop,
  removeEventListener: noop,
  style: { cursor: 'default' },
  parentElement: { style: { cursor: 'default' } },
};
mockCtx.canvas = mockCanvas;

globalThis.document = { createElement: () => mockCanvas, title: '' };
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { ...mockCtx, canvas: this }; }
};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

// Helper: read file into proper ArrayBuffer
function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

// Load WINFILE.EXE + companion DLLs
const realArrayBuffer = readToArrayBuffer('H:/WINDOWS/WINFILE.EXE');
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
// Load companion DLLs that WINFILE imports
emu.additionalFiles.set('COMMCTRL.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/COMMCTRL.DLL'));
emu.additionalFiles.set('VER.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/VER.DLL'));
emu.additionalFiles.set('SCONFIG.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/SCONFIG.DLL'));
emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

// Tick until message loop reached
const MAX_TICKS = 200;
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
}

if (emu.waitingForMessage) {
  console.log(`[TEST] SUCCESS: Reached message loop after ${ticks} ticks`);

  // Check MDI children
  const mainWnd = emu.handles.get(emu.mainWindow);
  console.log(`[TEST] MainWindow: 0x${emu.mainWindow.toString(16)} class=${mainWnd?.classInfo?.className} children=${mainWnd?.childList?.length}`);

  // Walk children
  if (mainWnd?.childList) {
    for (const ch of mainWnd.childList) {
      const w = emu.handles.get(ch);
      if (!w) continue;
      const cn = w.classInfo?.className || '?';
      console.log(`  child 0x${ch.toString(16)} class="${cn}" vis=${w.visible} pos=(${w.x},${w.y}) size=${w.width}x${w.height} style=0x${(w.style||0).toString(16)} needsPaint=${!!w.needsPaint} children=${w.childList?.length || 0}`);
      if (w.childList) {
        for (const gc of w.childList) {
          const gw = emu.handles.get(gc);
          if (!gw) continue;
          console.log(`    grandchild 0x${gc.toString(16)} class="${gw.classInfo?.className}" vis=${gw.visible} pos=(${gw.x},${gw.y}) size=${gw.width}x${gw.height} needsPaint=${!!gw.needsPaint} children=${gw.childList?.length || 0}`);
          if (gw.childList) {
            for (const ggc of gw.childList) {
              const ggw = emu.handles.get(ggc);
              if (!ggw) continue;
              console.log(`      greatgrandchild 0x${ggc.toString(16)} class="${ggw.classInfo?.className}" vis=${ggw.visible} pos=(${ggw.x},${ggw.y}) size=${ggw.width}x${ggw.height}`);
            }
          }
        }
      }
    }
  }
} else if (emu.halted) {
  console.error(`[TEST] HALTED after ${ticks} ticks`);
} else {
  console.error(`[TEST] TIMEOUT after ${MAX_TICKS} ticks`);
}
