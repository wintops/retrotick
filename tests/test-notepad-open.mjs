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

function readToArrayBuffer(path) {
  const b = readFileSync(path);
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return ab;
}

// Load NOTEPAD.EXE from Win2000
const realArrayBuffer = readToArrayBuffer('K:/WINNT/NOTEPAD.EXE');
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
await emu.load(realArrayBuffer, peInfo, mockCanvas);

// Enable API tracing
emu.traceApi = true;

emu.run();

// Tick until message loop reached
const MAX_TICKS = 500;
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < MAX_TICKS) {
  emu.tick();
  ticks++;
}

if (!emu.waitingForMessage) {
  console.log(`[TEST] FAIL: Did not reach message loop after ${ticks} ticks. halted=${emu.halted} reason=${emu.haltReason}`);
  process.exit(1);
}

console.log(`[TEST] Reached message loop after ${ticks} ticks`);

// Disable tracing for now
emu.traceApi = false;

// Simulate File > Open by sending WM_COMMAND with the Open menu item ID
// Notepad's File>Open command is typically ID 2 (from the accelerator table / menu)
// But first, let's wire up onShowCommonDialog to auto-return a file path
const WM_COMMAND = 0x0111;
// Notepad menu: 9=New, 10=Open, 1=Save, 2=Save As
const NOTEPAD_ID_OPEN = 10;

// Create a fake file to open
const testContent = 'Hello from test!\r\n';
const testData = new TextEncoder().encode(testContent);

// Pre-populate the virtual file cache so CreateFile can find it synchronously
emu.fs.virtualFiles.push({ name: 'TEST.TXT', size: testData.length });
emu.fs.virtualFileCache.set('TEST.TXT', testData.buffer);

// Wire up the common dialog to auto-return our test file
emu.onShowCommonDialog = (req) => {
  console.log(`[TEST] onShowCommonDialog called: type=${req.type}`);
  // Simulate selecting a file
  req.onResult({ path: 'D:\\TEST.TXT', data: testData.buffer });
};

console.log('[TEST] Sending WM_COMMAND File>Open...');
emu.traceApi = true;

// Send WM_COMMAND to main window
if (emu.mainWindow) {
  emu.postMessage(emu.mainWindow, WM_COMMAND, NOTEPAD_ID_OPEN, 0);
} else {
  console.log('[TEST] No main window found, trying hwnd=1');
  emu.postMessage(1, WM_COMMAND, NOTEPAD_ID_OPEN, 0);
}

// Tick to process the command
for (let i = 0; i < 500 && !emu.halted; i++) {
  emu.tick();
  if (emu.waitingForMessage) break;
}

console.log(`[TEST] After File>Open: halted=${emu.halted} waitingForMessage=${emu.waitingForMessage}`);

// Find the EDIT control and check its text
let editFound = false;
for (const [h, data] of emu.handles.findByType('window')) {
  const cn = (data.classInfo?.className || '').toUpperCase();
  if (cn === 'EDIT') {
    console.log(`[TEST] Edit hwnd=0x${h.toString(16)} title="${(data.title || '').substring(0, 80)}" editBufferHandle=0x${(data.editBufferHandle || 0).toString(16)}`);
    if (data.title && data.title.includes('Hello from test!')) {
      console.log('[TEST] SUCCESS: Edit control contains file content');
      editFound = true;
    } else {
      console.log(`[TEST] FAIL: Edit control text does not contain expected content`);
    }
  }
}
if (!editFound) {
  console.log('[TEST] FAIL: Edit control not found or text not set');
  process.exit(1);
}

// ---- Test save + reopen ----
emu.traceApi = false;

// Simulate editing: change wnd.title (as the DOM textarea would)
let editHwnd = 0;
for (const [h, data] of emu.handles.findByType('window')) {
  if ((data.classInfo?.className || '').toUpperCase() === 'EDIT') {
    editHwnd = h;
    data.title = 'New content\nLine 2\nLine 3';
    break;
  }
}

// Trigger File > Save (menu ID 1)
const NOTEPAD_ID_SAVE = 1;
emu.postMessage(emu.mainWindow, WM_COMMAND, NOTEPAD_ID_SAVE, 0);
for (let i = 0; i < 500 && !emu.halted; i++) {
  emu.tick();
  if (emu.waitingForMessage) break;
}

console.log(`[TEST] After Save: halted=${emu.halted} waitingForMessage=${emu.waitingForMessage}`);

// Now reopen the same file
emu.onShowCommonDialog = (req) => {
  req.onResult({ path: 'D:\\TEST.TXT' });
};
emu.postMessage(emu.mainWindow, WM_COMMAND, NOTEPAD_ID_OPEN, 0);
for (let i = 0; i < 500 && !emu.halted; i++) {
  emu.tick();
  if (emu.waitingForMessage) break;
}

// Verify the edit control has the saved content
let saveReopenOk = false;
for (const [h, data] of emu.handles.findByType('window')) {
  if ((data.classInfo?.className || '').toUpperCase() === 'EDIT') {
    const text = (data.title || '').trim();
    console.log(`[TEST] After save+reopen: title="${text.substring(0, 80)}"`);
    if (text.includes('New content') && text.includes('Line 2') && text.includes('Line 3')) {
      console.log('[TEST] SUCCESS: Save+reopen preserved content');
      saveReopenOk = true;
    } else {
      console.log('[TEST] FAIL: Save+reopen did not preserve content');
    }
  }
}
if (!saveReopenOk) {
  console.log('[TEST] FAIL: Save+reopen test failed');
  process.exit(1);
}

console.log('[TEST] Done');
