import { readFileSync } from 'fs';
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
globalThis.OffscreenCanvas = class {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return { ...mockCtx, canvas: this }; }
};
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

// Load Notepad 2003
const realArrayBuffer = readToArrayBuffer('I:/WINDOWS/notepad.exe');
const peInfo = parsePE(realArrayBuffer);

// Create a test text file (CP-1252 encoded, as Windows would)
const testContent = 'Hello from double-click!\r\nLine two.\r\n';
const testData = new TextEncoder().encode(testContent);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;

// Simulate what openWithDefaultApp does: pass file as command line + additionalFiles
emu.commandLine = 'D:\\TEST.TXT';
emu.additionalFiles.set('TEST.TXT', testData.buffer);

await emu.load(realArrayBuffer, peInfo, mockCanvas);
emu.run();

// Tick until message loop
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < 3000) {
  emu.tick();
  ticks++;
}

if (!emu.waitingForMessage) {
  console.log(`[TEST] FAIL: Did not reach message loop after ${ticks} ticks. halted=${emu.halted} reason=${emu.haltReason}`);
  process.exit(1);
}

console.log(`[TEST] Reached message loop after ${ticks} ticks`);

// Check if the EDIT control contains the file content
let editFound = false;
for (const [h, data] of emu.handles.findByType('window')) {
  const cn = (data.classInfo?.className || '').toUpperCase();
  if (cn === 'EDIT') {
    const text = data.title || '';
    console.log(`[TEST] Edit hwnd=0x${h.toString(16)} text="${text.substring(0, 100)}"`);
    if (text.includes('Hello from double-click!')) {
      console.log('[TEST] SUCCESS: Edit control contains file content from command line');
      editFound = true;
    } else if (text === '') {
      console.log('[TEST] FAIL: Edit control is EMPTY — file not loaded');
    } else {
      console.log(`[TEST] FAIL: Unexpected edit content`);
    }
  }
}

// Also check the window title — should contain "TEST.TXT"
const mainWnd = emu.handles.get(emu.mainWindow);
if (mainWnd) {
  console.log(`[TEST] Main window title: "${mainWnd.title}"`);
  if (mainWnd.title && mainWnd.title.toUpperCase().includes('TEST.TXT')) {
    console.log('[TEST] SUCCESS: Title contains filename');
  } else {
    console.log('[TEST] INFO: Title does not contain filename');
  }
}

if (!editFound) {
  console.log('[TEST] FAIL: File content not found in edit control');
  process.exit(1);
}

console.log('[TEST] Done — command line file open works');
