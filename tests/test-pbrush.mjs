import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';

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

// Load PBRUSH.EXE + companion DLLs
const realArrayBuffer = readToArrayBuffer('H:/WINDOWS/PBRUSH.EXE');
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.registryStore = new RegistryStore();
// Load companion DLLs that PBRUSH imports
emu.additionalFiles.set('PBRUSH.DLL', readToArrayBuffer('H:/WINDOWS/PBRUSH.DLL'));
emu.additionalFiles.set('OLESVR.DLL', readToArrayBuffer('H:/WINDOWS/SYSTEM/OLESVR.DLL'));
await emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

// Tick until message loop reached or MessageBox shown
const MAX_TICKS = 500;
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
}

if (emu.waitingForMessage) {
  const mainWnd = emu.handles.get(emu.mainWindow);
  console.log(`[TEST] SUCCESS: Reached message loop after ${ticks} ticks`);
  console.log(`[TEST] MainWindow: 0x${emu.mainWindow.toString(16)} class="${mainWnd?.classInfo?.className}" title="${mainWnd?.title}" size=${mainWnd?.width}x${mainWnd?.height} style=0x${(mainWnd?.style||0).toString(16)}`);

  // Dump thunk map to find what's at key addresses
  const thunkEnd = Math.max(...emu.thunkToApi.keys());
  console.log(`[TEST] Thunk range: 0x${Math.min(...emu.thunkToApi.keys()).toString(16)} - 0x${thunkEnd.toString(16)} (${emu.thunkToApi.size} entries)`);

  // Check what's at 0xF01B1
  const t01b1 = emu.thunkToApi.get(0xF01B1);
  console.log(`[TEST] Thunk@0xF01B1: ${t01b1 ? `${t01b1.dll}:${t01b1.name} (${t01b1.displayName})` : 'NOT FOUND'}`);

  // Check message queue
  console.log(`[TEST] Message queue length: ${emu._messageQueue?.length || 0}`);
  if (emu._messageQueue) {
    for (const msg of emu._messageQueue) {
      console.log(`  queued: hwnd=0x${msg.hwnd.toString(16)} msg=0x${msg.message.toString(16)} wP=${msg.wParam} lP=0x${msg.lParam.toString(16)}`);
    }
  }
  // Process queued messages (WM_SIZE etc.) before dumping children
  emu.traceApi = true;
  emu.waitingForMessage = false;
  let extraTicks = 0;
  while (!emu.waitingForMessage && !emu.halted && extraTicks < 50) {
    emu.tick();
    extraTicks++;
  }
  emu.traceApi = false;
  console.log(`[TEST] Processed ${extraTicks} extra ticks, halted=${emu.halted}`);

  // Dump child windows
  if (mainWnd?.childList) {
    for (const ch of mainWnd.childList) {
      const w = emu.handles.get(ch);
      if (!w) continue;
      console.log(`  child 0x${ch.toString(16)} class="${w.classInfo?.className}" vis=${w.visible} pos=(${w.x},${w.y}) size=${w.width}x${w.height} style=0x${(w.style||0).toString(16)} wndProc=0x${(w.wndProc||0).toString(16)}`);
      if (w.childList) {
        for (const gc of w.childList) {
          const gw = emu.handles.get(gc);
          if (!gw) continue;
          console.log(`    grandchild 0x${gc.toString(16)} class="${gw.classInfo?.className}" vis=${gw.visible} pos=(${gw.x},${gw.y}) size=${gw.width}x${gw.height}`);
        }
      }
    }
  }

  // Simulate menu open (WM_INITMENU + WM_INITMENUPOPUP) like EmulatorView.tsx does
  const WM_INITMENU = 0x0116;
  const WM_INITMENUPOPUP = 0x0117;
  const hMenu = mainWnd.hMenu || 0;
  console.log(`\n[TEST] Simulating menu open (hMenu=0x${hMenu.toString(16)}, wndProc=0x${mainWnd.wndProc.toString(16)})...`);
  emu.traceApi = true;
  emu.waitingForMessage = false;
  emu.callWndProc16(mainWnd.wndProc, emu.mainWindow, WM_INITMENU, hMenu, 0);
  console.log(`[TEST] WM_INITMENU done, halted=${emu.halted}`);
  if (!emu.halted) {
    emu.callWndProc16(mainWnd.wndProc, emu.mainWindow, WM_INITMENUPOPUP, 0, 0);
    console.log(`[TEST] WM_INITMENUPOPUP done, halted=${emu.halted}`);
  }
  if (emu.halted) {
    console.error(`[TEST] HALTED: ${emu.cpu.haltReason}`);
    console.error(emu.diagThunkDump());
  } else {
    console.log(`[TEST] Menu open handled OK`);
  }
} else if (emu.halted) {
  console.error(`[TEST] HALTED after ${ticks} ticks: ${emu.cpu.haltReason}`);
} else {
  console.error(`[TEST] TIMEOUT after ${MAX_TICKS} ticks`);
}
