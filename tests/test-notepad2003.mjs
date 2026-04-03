import { readFileSync } from 'fs';
import { Emulator } from '../src/lib/emu/emulator.ts';
import { parsePE, extractMenus } from '../src/lib/pe/index.ts';

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

const realArrayBuffer = readToArrayBuffer('I:/WINDOWS/notepad.exe');
const peInfo = parsePE(realArrayBuffer);
const extractedMenus = extractMenus(peInfo, realArrayBuffer);

const emu = new Emulator();
emu.screenWidth = 800;
emu.screenHeight = 600;
await emu.load(realArrayBuffer, peInfo, mockCanvas);
if (extractedMenus.length > 0) emu.menuItems = extractedMenus[0].menu.items;
emu.run();

// Tick until message loop
let ticks = 0;
while (!emu.waitingForMessage && !emu.halted && ticks < 2000) {
  emu.tick();
  ticks++;
}
if (!emu.waitingForMessage) {
  console.log('FAIL: Did not reach message loop');
  process.exit(1);
}

// Find windows
const mainWnd = emu.handles.get(emu.mainWindow);
let editWnd = null;
for (const [h, data] of emu.handles.findByType('window')) {
  if ((data.classInfo?.className || '').toUpperCase() === 'EDIT') { editWnd = data; break; }
}
editWnd.title = 'Hello World! Test text.';
const wndProc = mainWnd.wndProc;
const hMenu = mainWnd.hMenu;

function sendSync(msg, wParam, lParam) {
  const savedESP = emu.cpu.reg[4];
  const savedEIP = emu.cpu.eip;
  const savedWaiting = emu.waitingForMessage;
  emu.waitingForMessage = false;
  const ret = emu.callWndProc(wndProc, emu.mainWindow, msg, wParam, lParam);
  emu.cpu.reg[4] = savedESP;
  emu.cpu.eip = savedEIP;
  emu.waitingForMessage = savedWaiting;
  return ret;
}

const editMenu = extractedMenus[0].menu.items[1]; // Edit menu
const WM_INITMENU = 0x0116;
const WM_INITMENUPOPUP = 0x0117;

// === TEST 1: WM_INITMENU enables Cut/Copy/Delete when text is selected ===
console.log('=== TEST 1: WM_INITMENU with selection ===');
editWnd.editSelStart = 0;
editWnd.editSelEnd = 5;
console.log('Before: Cut grayed=' + editMenu.children.find(i => i.id === 768)?.isGrayed);
sendSync(WM_INITMENU, hMenu, 0);
const cutAfter = editMenu.children.find(i => i.id === 768)?.isGrayed;
const copyAfter = editMenu.children.find(i => i.id === 769)?.isGrayed;
const deleteAfter = editMenu.children.find(i => i.id === 771)?.isGrayed;
console.log(`After: Cut grayed=${cutAfter}, Copy grayed=${copyAfter}, Delete grayed=${deleteAfter}`);
if (cutAfter === false && copyAfter === false && deleteAfter === false) {
  console.log('SUCCESS: Cut/Copy/Delete enabled when text selected');
} else {
  console.log('FAIL: Cut/Copy/Delete should be enabled');
}

// === TEST 2: WM_INITMENU grays Cut/Copy/Delete when no selection ===
console.log('\n=== TEST 2: WM_INITMENU without selection ===');
editWnd.editSelStart = 5;
editWnd.editSelEnd = 5;
sendSync(WM_INITMENU, hMenu, 0);
const cutNoSel = editMenu.children.find(i => i.id === 768)?.isGrayed;
const copyNoSel = editMenu.children.find(i => i.id === 769)?.isGrayed;
console.log(`Cut grayed=${cutNoSel}, Copy grayed=${copyNoSel}`);
if (cutNoSel === true && copyNoSel === true) {
  console.log('SUCCESS: Cut/Copy grayed when no selection');
} else {
  console.log('FAIL: Cut/Copy should be grayed');
}

// === TEST 3: Select All ===
console.log('\n=== TEST 3: Select All via WM_COMMAND ===');
editWnd.editSelStart = 5;
editWnd.editSelEnd = 5;
sendSync(0x0111, 25, 0); // WM_COMMAND, ID=25 (Select All)
console.log(`editSelStart=${editWnd.editSelStart} editSelEnd=${editWnd.editSelEnd} textLen=${editWnd.title.length}`);
if (editWnd.editSelStart === 0 && editWnd.editSelEnd === editWnd.title.length) {
  console.log('SUCCESS: Select All works');
} else {
  console.log('FAIL: Select All failed');
}

// === TEST 4: hMenu is populated ===
console.log('\n=== TEST 4: Menu handle tree ===');
console.log(`hMenu=0x${hMenu.toString(16)}`);
const menuData = emu.handles.get(hMenu);
if (menuData && menuData.items && menuData.items.length === 5) {
  console.log('SUCCESS: Menu has 5 top-level items');
  for (let i = 0; i < menuData.items.length; i++) {
    console.log(`  [${i}] hSubMenu=0x${(menuData.items[i].hSubMenu || 0).toString(16)} text="${menuData.items[i].text}"`);
  }
} else {
  console.log(`FAIL: Expected 5 items, got ${menuData?.items?.length}`);
}

console.log('\nAll tests done');
