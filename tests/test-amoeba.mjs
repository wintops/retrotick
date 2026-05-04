import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE } from '../src/lib/pe/index.ts';
import { RegistryStore } from '../src/lib/registry-store.ts';
import { ProfileStore } from '../src/lib/profile-store.ts';

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
  width: 800, height: 600,
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

const EXE_PATH = 'C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo-win32.exe';
const realArrayBuffer = readToArrayBuffer(EXE_PATH);
const peInfo = parsePE(realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
emu.registryStore = new RegistryStore();
emu.profileStore = new ProfileStore();

const notFound = new Set();
let sawOggError = false;
let firstMsgBoxText = null, firstMsgBoxCaption = null;
const origWarn = console.warn.bind(console);
const origLog = console.log.bind(console);
console.log = (...args) => {
  const s = args.join(' ');
  const m = s.match(/\[GetProcAddress\] Not found: "([^"]+)"/);
  if (m) notFound.add(m[1]);
  if (s.includes('Ogg bitstream')) sawOggError = true;
  origLog(...args);
};
console.error = (...args) => {
  const s = args.join(' ');
  if (s.includes('Ogg bitstream')) sawOggError = true;
  origWarn(...args);
};

const demoDatBytes = readFileSync('C:/Users/Olivier/Downloads/e_amoeba-final/e_amoeba-final/demo.dat');
emu.additionalFiles.set('demo.dat', demoDatBytes.buffer.slice(demoDatBytes.byteOffset, demoDatBytes.byteOffset + demoDatBytes.byteLength));

await emu.load(realArrayBuffer, peInfo, mockCanvas);

// Headless-only overrides: Sleep and PeekMessage normally suspend via async rAF
// callbacks that a synchronous test loop cannot service, so bypass them. MessageBoxA
// is auto-dismissed and its text captured so the test can assert no demo error fired.
emu.apiDefs.set('KERNEL32.DLL:Sleep', { handler: () => 0, stackBytes: 4 });
const realPeek = emu.apiDefs.get('USER32.DLL:PeekMessageA')?.handler;
emu.apiDefs.set('USER32.DLL:PeekMessageA', {
  handler: () => {
    const wasWaiting = emu.waitingForMessage;
    const r = realPeek(emu);
    if (r === undefined) { emu.waitingForMessage = wasWaiting; return 0; }
    return r;
  },
  stackBytes: 20,
});
emu.apiDefs.set('USER32.DLL:MessageBoxA', {
  handler: () => {
    if (firstMsgBoxText === null) {
      const textPtr = emu.readArg(1);
      const captionPtr = emu.readArg(2);
      firstMsgBoxText = textPtr ? emu.memory.readCString(textPtr, 256) : '<null>';
      firstMsgBoxCaption = captionPtr ? emu.memory.readCString(captionPtr, 64) : '<null>';
    }
    return 1;
  },
  stackBytes: 16,
});

emu.run();

const IDC_OK = 1001;
let dismissedDialogs = 0;
const MAX_TICKS = 5_000_000;
let ticks = 0;
let stuckCount = 0;
let lastEip = 0;
let reachedMsgLoop = false;
while (!emu.halted && ticks < MAX_TICKS && !sawOggError) {
  if (emu.dialogState && !emu.dialogState.ended) {
    dismissedDialogs++;
    console.log(`[TEST] dismiss dialog #${dismissedDialogs}`);
    emu.dismissDialog(IDC_OK, new Map());
    await Promise.resolve();
    continue;
  }
  if (emu.waitingForMessage) { reachedMsgLoop = true; emu.waitingForMessage = false; }
  emu.tick();
  ticks++;
  if (emu.cpu.eip === lastEip) stuckCount++; else { stuckCount = 0; lastEip = emu.cpu.eip; }
  if (stuckCount > 5000) break;
  if (dismissedDialogs > 5) break;
  if (reachedMsgLoop && ticks > 50_000) break;
}

console.log(`\n[TEST] ticks=${ticks} reachedMsgLoop=${reachedMsgLoop} halted=${emu.halted} reason=${emu.cpu.haltReason || 'none'}`);
console.log(`[TEST] Missing APIs: ${notFound.size}`);
for (const name of notFound) console.log(`  - ${name}`);
if (firstMsgBoxText !== null) {
  console.log(`[TEST] MessageBoxA fired: caption="${firstMsgBoxCaption}" text="${firstMsgBoxText}"`);
}

if (!reachedMsgLoop) {
  console.log('[TEST] FAIL: did not reach message loop');
  process.exit(1);
}
if (firstMsgBoxText !== null) {
  console.log('[TEST] FAIL: demo reported an error');
  process.exit(1);
}
console.log('[TEST] SUCCESS: reached message loop, no demo error');
process.exit(0);
