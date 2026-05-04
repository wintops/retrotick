// Test: EMUL5.EXE (DOS/4GW DPMI application)
import { readFileSync, readdirSync, statSync } from 'fs';
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

const BASE = 'C:/Users/Olivier/Documents/0_Perso/dosbox_d/emul5';

const emul5Buf = readToArrayBuffer(`${BASE}/EMUL5.EXE`);
const dos4gwBuf = readToArrayBuffer(`${BASE}/DOS4GW.EXE`);
// WORKAROUND TEST: patch MZ e_cblp from 0x7c to 0x80 so (cp-1)*512+cblp = 0x2c80 = e_lfanew
// This tests whether DOS4GW's format scanner succeeds with the LE header correctly placed
const u8 = new Uint8Array(emul5Buf);
console.log(`[PATCH] e_cblp before: 0x${u8[0x02].toString(16)}, e_cp: 0x${u8[0x04].toString(16)}`);
// u8[0x02] = 0x80; // patch to make stub_end match e_lfanew (tried — doesn't help, scanner only checks MF/MZ/BW not LE)
console.log(`[PATCH] e_cblp after:  0x${u8[0x02].toString(16)}`);
const peInfo = parsePE(emul5Buf);

const emu = new Emulator();
emu.screenWidth = 640;
emu.screenHeight = 480;
emu.exeName = 'emul5/EMUL5.EXE';
emu.exePath = 'D:\\emul5\\EMUL5.EXE';
emu.dosEnableDpmi = false; // Force VCPI path (DOS4GW manages its own PM)
emu.additionalFiles.set('DOS4GW.EXE', dos4gwBuf);

// Add all companion files
for (const fname of readdirSync(BASE)) {
  const fp = `${BASE}/${fname}`;
  if (statSync(fp).isFile() && fname !== 'EMUL5.EXE' && fname !== 'DOS4GW.EXE') {
    emu.additionalFiles.set(fname, readToArrayBuffer(fp));
  }
}

await emu.load(emul5Buf, peInfo, mockCanvas);
emu.run();
emu.cpu._debugJmpFar = true;

// EXPERIMENT: After load, find the env program name and replace it with "DOS4GW.EXE"
// Hypothesis: DOS4GW reads env program name to find its own .exe.
// Our env has "D:\emul5\EMUL5.EXE" → DOS4GW thinks EMUL5.EXE is itself.
// Real DOS4GW needs to read its own file (DOS4GW.EXE) to load the overlay.
{
  // Env block starts at segment 0x61, linear 0x610
  // Find double-null + count word + program name
  const envBase = 0x61 * 16;
  let p = envBase;
  while (p < envBase + 0x9e * 16 - 4) {
    if (emu.memory.readU8(p) === 0 && emu.memory.readU8(p + 1) === 0) break;
    p++;
  }
  p += 2; // skip double null
  const cnt = emu.memory.readU16(p);
  console.log(`[ENV] env block double-null at 0x${p.toString(16)}, count=${cnt}`);
  p += 2;
  // Read the current program name
  let curName = '';
  for (let i = 0; i < 64; i++) {
    const c = emu.memory.readU8(p + i);
    if (c === 0) break;
    curName += String.fromCharCode(c);
  }
  console.log(`[ENV] current program name: "${curName}"`);
  // Replace with "DOS4GW.EXE" + null
  const newName = 'D:\\emul5\\DOS4GW.EXE\0';
  for (let i = 0; i < newName.length; i++) {
    emu.memory.writeU8(p + i, newName.charCodeAt(i));
  }
  // Pad with zeros to clear the rest
  for (let i = newName.length; i < curName.length + 1; i++) {
    emu.memory.writeU8(p + i, 0);
  }
  console.log(`[ENV] replaced program name with: "${newName.slice(0, -1)}"`);
}

// Watchpoint: log every write to linear 0x1abc-0x1abd (function pointer)
// + GDT[10] at 0x3E0050-0x3E0057 (sel 0x50 descriptor)
const WATCH_RANGES = [
  [0x1abc, 0x1abe],
  [0x3E0050, 0x3E0058],
  [0x1a10, 0x1a18], // client GDT[10] at 0x19c0+0x50
  // Track who writes the filename to ds:[0x1190] in DOS4GW data segment
  // ds=0x110 (initial) → linear 0x1100+0x1190 = 0x2290
  // ds=0x744 (relocated) → linear 0x7440+0x1190 = 0x85d0
  [0x2290, 0x22a0],
  [0x85d0, 0x85e0],
  // Track 0x2626 (= ds:[0x1526] in DOS4GW data, source of strcpy)
  [0x2626, 0x2640],
  // Track ds:[0xcf8] (the far pointer used by lds si,[0xcf8])
  // ds=0x110 → linear 0x1100+0xcf8 = 0x1df8
  [0x1df8, 0x1dfc],
];
const WATCH_ADDR = 0x1abc;
const WATCH_END = 0x1abe;
const origWU8 = emu.memory.writeU8.bind(emu.memory);
const origWU16 = emu.memory.writeU16.bind(emu.memory);
const origWU32 = emu.memory.writeU32.bind(emu.memory);
let dumped = false;
function dumpCs18() {
  if (dumped) return;
  const cpu = emu.cpu;
  if (cpu.realMode) return;
  dumped = true;
  const gdtBase = cpu.emu?._gdtBase ?? 0;
  if (!gdtBase) return;
  const desc18 = gdtBase + 0x18;
  const lo = cpu.mem.readU32(desc18);
  const hi = cpu.mem.readU32(desc18 + 4);
  const base = ((hi >>> 24) << 24) | ((hi & 0xFF) << 16) | ((lo >>> 16) & 0xFFFF);
  const limit = (lo & 0xFFFF) | (((hi >>> 16) & 0xF) << 16);
  const d32 = (hi & (1 << 22)) !== 0;
  console.log(`[GDT[18]] base=0x${base.toString(16)} limit=0x${limit.toString(16)} D=${d32 ? 32 : 16}`);
}
function inWatch(addr, size) {
  for (const [lo, hi] of WATCH_RANGES) {
    if (addr < hi && addr + size > lo) return true;
  }
  return false;
}
function logWatch(size, addr, val) {
  if (inWatch(addr, size)) {
    const cpu = emu.cpu;
    let bytes = '';
    const eip = (cpu.eip >>> 0);
    for (let i = -4; i < 8; i++) bytes += cpu.mem.readU8((eip + i) >>> 0).toString(16).padStart(2,'0') + ' ';
    console.log(`[WATCH] w${size*8} addr=0x${addr.toString(16)} val=0x${(val >>> 0).toString(16)} cs=${cpu.cs.toString(16)} eip=${eip.toString(16)} es=${cpu.es.toString(16)} ds=${cpu.ds.toString(16)} edi=${(cpu.reg[7]>>>0).toString(16)} esi=${(cpu.reg[6]>>>0).toString(16)} step=${stepNum} bytes(eip-4..+8)=[${bytes}]`);
    dumpCs18();
  }
}
emu.memory.writeU8 = function(addr, val) { logWatch(1, addr >>> 0, val); return origWU8(addr, val); };
emu.memory.writeU16 = function(addr, val) { logWatch(2, addr >>> 0, val); return origWU16(addr, val); };
emu.memory.writeU32 = function(addr, val) { logWatch(4, addr >>> 0, val); return origWU32(addr, val); };

// Track all CS transitions and keep a small ring of recent steps per CS
const transitions = []; // {stepNum, fromCS, fromEIP, toCS, toEIP, fromRM, toRM, prevBytes}
let prevCS = -1;
let prevEIP = 0;
let prevRM = 0;
let stepNum = 0;
const RING_SIZE = 16;
const recentEIP = new Uint32Array(RING_SIZE);
const recentCS = new Uint16Array(RING_SIZE);
let recentIdx = 0;
const trace = []; // full step trace near the crash
const int21Log = []; // every INT 21h call seen
const origStep = emu.cpu.step.bind(emu.cpu);
emu.cpu.step = function() {
  // Capture BEFORE: what instruction is about to execute
  const beforeCS = this.cs;
  const beforeEIP = this.eip >>> 0;
  const beforeRM = this.realMode ? 1 : 0;
  const beforeDS = this.ds;
  const beforeSS = this.ss;
  const beforeESP = this.reg[4] >>> 0;
  // Catch the strcpy loop body (CS=0x2cd:0x45d6) and dump source pointer
  // strcpy code: 36c1 push bp, 36c4 mov bp,sp, 36c7 jmp +d → 36d6
  // 36d6: mov bx, [bp+6] (source ptr); 36d9: inc word [bp+6]; 36dc: mov al, [bx]
  if (beforeEIP === 0x45d6 && !globalThis._strcpySrcDumped) {
    // [bp+6] holds the source pointer. bp is in this.reg[5]?
    // In our cpu, bp is reg[5] (low 16 bits)
    const bp = this.reg[5] & 0xFFFF;
    const ssBase = beforeRM ? beforeSS * 16 : 0;
    const srcPtrAddr = (ssBase + bp + 6) >>> 0;
    const srcOffset = this.mem.readU16(srcPtrAddr);
    const dsBase = beforeRM ? beforeDS * 16 : 0;
    const srcLinear = (dsBase + srcOffset) >>> 0;
    let srcStr = '';
    for (let k = 0; k < 64; k++) {
      const c = this.mem.readU8((srcLinear + k - srcOffset + this.mem.readU16(srcPtrAddr) - srcOffset + srcOffset) >>> 0);
      // simplified: read at srcLinear + k from current source
    }
    // simpler: just read at the current source offset (already incremented)
    const curSrcOff = this.mem.readU16(srcPtrAddr);
    const curLinear = (dsBase + curSrcOff) >>> 0;
    let context = '';
    for (let k = -16; k < 32; k++) {
      const c = this.mem.readU8((curLinear + k) >>> 0);
      if (c >= 0x20 && c < 0x7f) context += String.fromCharCode(c);
      else context += '.';
    }
    console.log(`[STRCPY @ step ${stepNum}] bp=0x${bp.toString(16)} [bp+6]=0x${curSrcOff.toString(16)} ds=0x${beforeDS.toString(16)} → linear 0x${curLinear.toString(16)}`);
    console.log(`   context near source: "${context}"`);
    globalThis._strcpySrcDumped = true;
  }
  // Maintain a 64-entry trace ring just for steps near sub_4E96 entry
  if (!globalThis._sub4e96Entry) {
    if (!globalThis._preEntry) globalThis._preEntry = [];
    globalThis._preEntry.push({stepNum, cs: beforeCS, eip: beforeEIP, b0: this.mem.readU8(beforeEIP), b1: this.mem.readU8(beforeEIP+1), b2: this.mem.readU8(beforeEIP+2), b3: this.mem.readU8(beforeEIP+3), b4: this.mem.readU8(beforeEIP+4)});
    if (globalThis._preEntry.length > 64) globalThis._preEntry.shift();
  }
  // Dump source string for the strcpy at step 3886
  if (stepNum === 3886 && !globalThis._dump9ff9) {
    globalThis._dump9ff9 = true;
    // SI=0x4f at this point (already incremented past 0x4e)
    // The string starts at 0x9ff9:0x4e = linear 0x9ffde
    const linStart = 0x9ffde;
    let hex = '';
    let asc = '';
    for (let k = 0; k < 64; k++) {
      const c = this.mem.readU8((linStart + k) >>> 0);
      hex += c.toString(16).padStart(2,'0') + ' ';
      asc += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
    }
    console.log(`\n[DUMP @ step 3886] linear 0x${linStart.toString(16)} (DS:SI start):`);
    console.log(`  hex: ${hex}`);
    console.log(`  asc: "${asc}"`);
    // Also dump 64 bytes earlier
    const linEarly = 0x9ff90;
    let hex2 = '';
    let asc2 = '';
    for (let k = 0; k < 80; k++) {
      const c = this.mem.readU8((linEarly + k) >>> 0);
      hex2 += c.toString(16).padStart(2,'0') + ' ';
      asc2 += (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.';
    }
    console.log(`[DUMP @ step 3886] linear 0x${linEarly.toString(16)} (segment 0x9ff9 base):`);
    console.log(`  hex: ${hex2}`);
    console.log(`  asc: "${asc2}"\n`);
  }
  // Detect entry into sub_4E96 (linear 0xc2d6) and sub_4C1F (linear 0xc05f)
  if (beforeEIP === 0xc2d6 && !globalThis._sub4e96Entry) {
    globalThis._sub4e96Entry = true;
    // Verify the patch is still in effect at this point
    let cur = '';
    for (let k = 0; k < 32; k++) {
      const c = this.mem.readU8(0x2290 + k);
      if (c === 0) break;
      cur += String.fromCharCode(c);
    }
    const handle = this.mem.readU16(0x1100 + 0x0E70);
    console.log(`\n[CHECK] At sub_4E96 entry: ds:[1190]="${cur}" ds:[0E70]=0x${handle.toString(16)}\n`);
    console.log(`\n>>> 64 STEPS BEFORE sub_4E96 entry:`);
    for (const t of globalThis._preEntry) {
      const bytes = `${t.b0.toString(16).padStart(2,'0')} ${t.b1.toString(16).padStart(2,'0')} ${t.b2.toString(16).padStart(2,'0')} ${t.b3.toString(16).padStart(2,'0')} ${t.b4.toString(16).padStart(2,'0')}`;
      console.log(`  step=${t.stepNum} ${t.cs.toString(16)}:${t.eip.toString(16)} [${bytes}]`);
    }
    const ssBase = beforeRM ? beforeSS * 16 : 0;
    console.log(`\n>>> ENTER sub_4E96 @ step ${stepNum} CS=${beforeCS.toString(16)} SS=${beforeSS.toString(16)} ESP=${beforeESP.toString(16)} ssBase=${ssBase.toString(16)}`);
    // Dump call site (return addr on stack)
    let stk = '';
    for (let i = 0; i < 8; i++) {
      const w = this.mem.readU16((beforeESP + i*2) >>> 0);
      stk += `0x${w.toString(16)} `;
    }
    console.log(`    Stack: ${stk}`);
    // Try interpreting first stack word as caller's return EIP (linear)
    const ret0 = this.mem.readU16(beforeESP >>> 0);
    let cb = '';
    for (let j = 0; j < 12; j++) cb += this.mem.readU8(((ret0 - 3) + j) >>> 0).toString(16).padStart(2,'0') + ' ';
    console.log(`    Caller bytes @ 0x${(ret0-3).toString(16)}: ${cb}`);
    // If that doesn't look like a call, try full 32-bit return
    const ret32 = this.mem.readU32(beforeESP >>> 0);
    let cb2 = '';
    for (let j = 0; j < 12; j++) cb2 += this.mem.readU8(((ret32 - 3) + j) >>> 0).toString(16).padStart(2,'0') + ' ';
    console.log(`    32-bit caller bytes @ 0x${(ret32-3).toString(16)}: ${cb2}`);
  }
  if (beforeEIP === 0xc05f && !globalThis._sub4c1fEntry) {
    globalThis._sub4c1fEntry = true;
    console.log(`\n>>> ENTER sub_4C1F @ step ${stepNum} CS=${beforeCS.toString(16)} SS=${beforeSS.toString(16)} ESP=${beforeESP.toString(16)}`);
    let stk = '';
    for (let i = 0; i < 8; i++) {
      const w = this.mem.readU16((beforeESP + i*2) >>> 0);
      stk += `0x${w.toString(16)} `;
    }
    console.log(`    Stack: ${stk}`);
    const ret0 = this.mem.readU16(beforeESP >>> 0);
    let cb = '';
    for (let j = 0; j < 12; j++) cb += this.mem.readU8(((ret0 - 3) + j) >>> 0).toString(16).padStart(2,'0') + ' ';
    console.log(`    Caller bytes @ 0x${(ret0-3).toString(16)}: ${cb}`);
  }
  // Snapshot bytes of the instruction we're about to run
  const bytes = [];
  for (let b = 0; b < 8; b++) bytes.push(this.mem.readU8((beforeEIP + b) >>> 0).toString(16).padStart(2, '0'));

  // Detect INT 21h about to execute and log AX/BX/CX/DX/ES/SI/DI
  const b0 = parseInt(bytes[0], 16), b1 = parseInt(bytes[1], 16);
  const cpuRef = this;
  // For READS (AH=3f handle 5), capture buffer AFTER the int21 returns.
  // We track a pending read here and dump after origStep().
  let pendingRead = null;
  if (b0 === 0xCD && b1 === 0x21) {
    const ax0 = this.reg[0] & 0xFFFF;
    const ah0 = (ax0 >> 8) & 0xFF;
    if (ah0 === 0x3f && (this.reg[3] & 0xFFFF) > 2) {
      const bxV = this.reg[3] & 0xFFFF;
      const cxV = this.reg[1] & 0xFFFF;
      const dxV = this.reg[2] & 0xFFFF;
      const dsV = beforeDS;
      const dsBase = beforeRM ? dsV * 16 : 0; // V86/RM
      pendingRead = { handle: bxV, count: cxV, addr: dsBase + dxV };
    }
  }
  if (b0 === 0xCD && b1 === 0x21) {
    const ax = this.reg[0] & 0xFFFF;
    const bx = this.reg[3] & 0xFFFF;
    const cx = this.reg[1] & 0xFFFF;
    const dx = this.reg[2] & 0xFFFF;
    const si = this.reg[6] & 0xFFFF;
    const di = this.reg[7] & 0xFFFF;
    const ah = (ax >> 8) & 0xFF;
    let bufStr = '';
    let bufHex = '';
    // For write (AH=40) to STDOUT/STDERR, capture the buffer content
    if (ah === 0x40 && (bx === 1 || bx === 2)) {
      const dsBase = beforeRM ? beforeDS * 16 : (this.emu?._gdtBase ? this.segBase(beforeDS) : beforeDS * 16);
      const len = Math.min(cx, 80);
      const chars = [];
      const hex = [];
      for (let i = 0; i < len; i++) {
        const b = this.mem.readU8((dsBase + dx + i) >>> 0);
        hex.push(b.toString(16).padStart(2, '0'));
        chars.push((b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : (b === 0x0A ? '\\n' : b === 0x0D ? '\\r' : '.'));
      }
      bufStr = chars.join('');
      bufHex = hex.join(' ');
    }
    int21Log.push({
      stepNum, cs: beforeCS, eip: beforeEIP,
      ax, bx, cx, dx, si, di,
      ds: beforeDS, es: this.es,
      bufStr, bufHex,
    });
    // Dump command tail when AH=4B happens
    if (ah === 0x4B && !globalThis._dumpedCmdTail) {
      globalThis._dumpedCmdTail = true;
      // PSP at 0x100, cmdline at 0x80. linear = 0x100*16 + 0x80 = 0x1080
      let cmdLen = this.mem.readU8(0x1080);
      let cmd = '';
      for (let k = 0; k < cmdLen && k < 64; k++) cmd += String.fromCharCode(this.mem.readU8(0x1081 + k));
      console.log(`[CMD-TAIL @ AH=4B] PSP cmdtail length=${cmdLen} content="${cmd}"`);
      // Also dump bytes near 0x1080
      let cb = '';
      for (let k = 0; k < 32; k++) cb += this.mem.readU8(0x1080 + k).toString(16).padStart(2,'0') + ' ';
      console.log(`  bytes: ${cb}`);
    }
    // Dump bytes at EIP and around for the FIRST AH=4B call (LOAD OVERLAY)
    if (ah === 0x4B && !globalThis._dumpedAh4b) {
      globalThis._dumpedAh4b = true;
      console.log(`\n=== AH=4B call dump (step ${stepNum}, CS=0x${beforeCS.toString(16)}:${beforeEIP.toString(16)}) ===`);
      let codeBytes = '';
      for (let k = -32; k < 32; k++) {
        if (k === 0) codeBytes += '| ';
        codeBytes += this.mem.readU8((beforeEIP + k) >>> 0).toString(16).padStart(2, '0') + ' ';
      }
      console.log(`code bytes (-32..+32 around EIP): ${codeBytes}`);
      // Also dump filename at DS:DX (the overlay name)
      const dsBaseLog = beforeRM ? beforeDS * 16 : 0;
      const fnAddr = (dsBaseLog + dx) >>> 0;
      let fname = '';
      for (let k = 0; k < 64; k++) {
        const c = this.mem.readU8((fnAddr + k) >>> 0);
        if (c === 0) break;
        fname += String.fromCharCode(c);
      }
      console.log(`Filename at DS:DX = ${beforeDS.toString(16)}:${dx.toString(16)} = "${fname}"`);
      // ES:BX is the parameter block. Dump 16 bytes at it.
      const esBase = this.es * 16;
      const pbAddr = (esBase + bx) >>> 0;
      let pb = '';
      for (let k = 0; k < 16; k++) pb += this.mem.readU16((pbAddr + k*2) >>> 0).toString(16).padStart(4,'0') + ' ';
      console.log(`Param block at ES:BX = ${this.es.toString(16)}:${bx.toString(16)} (linear 0x${pbAddr.toString(16)}): ${pb}`);
      console.log(`=== END AH=4B dump ===\n`);
    }
    // Dump call site context for AH=42 SEEK calls from CS=0x901
    if (ah === 0x42 && beforeCS === 0x901 && !globalThis._dumpedSeek901) {
      globalThis._dumpedSeek901 = true;
      // In our emulator, eip is already the linear address (segBase is folded in).
      // So read code directly at eip, and compute the file-offset hint via csBase.
      const csBase = beforeCS * 16;
      const linearEIP = beforeEIP >>> 0;
      console.log(`\n=== DUMP at first AH=42 from CS=0x901 (step ${stepNum}) ===`);
      console.log(`CS=0x${beforeCS.toString(16)} EIP(linear)=0x${linearEIP.toString(16)} csBase=0x${csBase.toString(16)} RM=${beforeRM}`);
      console.log(`SS=0x${beforeSS.toString(16)} ESP=0x${beforeESP.toString(16)}`);
      // Code at linear EIP - 16 to + 48
      let codeHex = '';
      for (let i = -16; i < 48; i++) {
        const off = (linearEIP + i) >>> 0;
        codeHex += this.mem.readU8(off).toString(16).padStart(2, '0') + ' ';
        if (i === -1) codeHex += '| ';
      }
      console.log(`Code @ EIP-16..+48:`);
      console.log(`  ${codeHex}`);
      // Stack: ESP appears to be linear here too
      const linearESP = beforeESP >>> 0;
      let stackStr = '';
      for (let i = 0; i < 16; i++) {
        const w = this.mem.readU16((linearESP + i*2) >>> 0);
        stackStr += `0x${w.toString(16).padStart(4,'0')} `;
      }
      console.log(`Stack @ linear ESP=0x${linearESP.toString(16)}:`);
      console.log(`  ${stackStr}`);
      // Walk stack: each near-return is in same CS, so caller linear = csBase + (returnOff - 3)
      // But we don't know which words are return addresses. Try first 8.
      console.log(`Possible return targets (caller bytes at each):`);
      for (let i = 0; i < 8; i++) {
        const off = this.mem.readU16((linearESP + i*2) >>> 0);
        const callerLin = (csBase + off - 3) >>> 0;
        let cb = '';
        for (let j = 0; j < 10; j++) cb += this.mem.readU8((callerLin + j) >>> 0).toString(16).padStart(2, '0') + ' ';
        console.log(`  stack[${i}]=0x${off.toString(16)} caller@0x${callerLin.toString(16)}: ${cb}`);
      }
      console.log(`=== END DUMP ===\n`);
      // Search the entire memory for the LE detection function signature
      // Pattern: c8 50 00 00 ff 76 06 ff 76 0a ff 76 08 2b c0 89 46 b0 50
      const sig = [0xc8, 0x50, 0x00, 0x00, 0xff, 0x76, 0x06, 0xff, 0x76, 0x0a, 0xff, 0x76, 0x08];
      let found = [];
      const memSize = Math.min(this.mem.size || 0x800000, 0x800000);
      for (let i = 0; i < memSize - sig.length; i++) {
        let m = true;
        for (let j = 0; j < sig.length; j++) {
          if (this.mem.readU8((i + j) >>> 0) !== sig[j]) { m = false; break; }
        }
        if (m) {
          found.push(i);
          if (found.length >= 5) break;
        }
      }
      console.log(`LE detector signature scan: ${found.length} hits → ${found.map(h => '0x' + h.toString(16)).join(', ')}`);
      // Scan for ANY 'LE' word in cmp instructions: __ 4c 45 (with various opcodes before)
      // Also look for word constant 0x454C in any context
      let found2 = [];
      for (let i = 0; i < memSize - 2; i++) {
        if (this.mem.readU8(i) === 0x4c && this.mem.readU8(i+1) === 0x45) {
          // Check if preceded by a 'cmp imm16' opcode pattern
          const prev = this.mem.readU8((i-1) >>> 0);
          const prev2 = this.mem.readU8((i-2) >>> 0);
          const prev3 = this.mem.readU8((i-3) >>> 0);
          if (prev3 === 0x81 && (prev2 & 0xC0) === 0x40) {
            // cmp word [reg+disp8], imm16
            found2.push(i-3);
            if (found2.length >= 10) break;
          }
        }
      }
      console.log(`'LE' constant in cmp: ${found2.length} hits → ${found2.map(h => '0x' + h.toString(16)).join(', ')}`);
      // Scan for sub_4E96's prologue: c8 4a 00 00 57 56 (the DOS/16M loader)
      const sig4e96 = [0xc8, 0x4a, 0x00, 0x00, 0x57, 0x56, 0xc7];
      let found3 = [];
      for (let i = 0; i < memSize - sig4e96.length; i++) {
        let m = true;
        for (let j = 0; j < sig4e96.length; j++) {
          if (this.mem.readU8((i + j) >>> 0) !== sig4e96[j]) { m = false; break; }
        }
        if (m) {
          found3.push(i);
          if (found3.length >= 5) break;
        }
      }
      console.log(`sub_4E96 prologue scan: ${found3.length} hits → ${found3.map(h => '0x' + h.toString(16)).join(', ')}`);
      // Scan for sub_4C1F prologue: c8 02 00 00 c7 46 fe 02 00
      const sig4c1f = [0xc8, 0x02, 0x00, 0x00, 0xc7, 0x46, 0xfe, 0x02, 0x00];
      let found4 = [];
      for (let i = 0; i < memSize - sig4c1f.length; i++) {
        let m = true;
        for (let j = 0; j < sig4c1f.length; j++) {
          if (this.mem.readU8((i + j) >>> 0) !== sig4c1f[j]) { m = false; break; }
        }
        if (m) {
          found4.push(i);
          if (found4.length >= 5) break;
        }
      }
      console.log(`sub_4C1F prologue scan: ${found4.length} hits → ${found4.map(h => '0x' + h.toString(16)).join(', ')}`);
      // Find all MZ headers in memory
      let mzs = [];
      for (let i = 0; i < memSize - 64; i += 16) {
        if (this.mem.readU8(i) === 0x4d && this.mem.readU8(i+1) === 0x5a) {
          // Check it's a plausible MZ header
          const e_cp = this.mem.readU16(i + 4);
          const e_cparhdr = this.mem.readU16(i + 8);
          if (e_cp > 0 && e_cp < 0x800 && e_cparhdr > 0 && e_cparhdr < 0x100) {
            mzs.push({linear: i, e_cp, e_cparhdr});
          }
        }
      }
      console.log(`MZ headers in memory: ${mzs.length}`);
      for (const m of mzs.slice(0, 10)) {
        console.log(`  linear=0x${m.linear.toString(16)} e_cp=${m.e_cp} e_cparhdr=${m.e_cparhdr} imageSize=0x${((m.e_cp-1)*512 + this.mem.readU16(m.linear+2)).toString(16)}`);
      }
      // Also look for the sub_4E96 prologue across all linear addresses (in case there are multiple copies)
      let allSub4e96 = [];
      for (let i = 0; i < memSize - 7; i++) {
        if (this.mem.readU8(i) === 0xc8 && this.mem.readU8(i+1) === 0x4a &&
            this.mem.readU8(i+2) === 0x00 && this.mem.readU8(i+3) === 0x00 &&
            this.mem.readU8(i+4) === 0x57 && this.mem.readU8(i+5) === 0x56) {
          allSub4e96.push(i);
          if (allSub4e96.length >= 10) break;
        }
      }
      console.log(`All sub_4E96 prologue scan: ${allSub4e96.length} → ${allSub4e96.map(h=>'0x'+h.toString(16)).join(', ')}`);
      // Same for sub_7B9A: 8b dc 8b 57 02 8b 4f 04 8b 1e 70 0e b8 00 42 cd 21
      let allSub7b9a = [];
      const sub7b9aSig = [0x8b,0xdc,0x8b,0x57,0x02,0x8b,0x4f,0x04,0x8b,0x1e,0x70,0x0e,0xb8,0x00,0x42];
      for (let i = 0; i < memSize - sub7b9aSig.length; i++) {
        let m = true;
        for (let j = 0; j < sub7b9aSig.length; j++) {
          if (this.mem.readU8(i+j) !== sub7b9aSig[j]) { m = false; break; }
        }
        if (m) {
          allSub7b9a.push(i);
          if (allSub7b9a.length >= 10) break;
        }
      }
      console.log(`All sub_7B9A scan: ${allSub7b9a.length} → ${allSub7b9a.map(h=>'0x'+h.toString(16)).join(', ')}`);
    }
  }

  origStep();

  // After read returns: dump first 32 bytes of the buffer
  if (pendingRead && pendingRead.count <= 0x1000) {
    const len = Math.min(pendingRead.count, 32);
    const hex = [];
    const ascii = [];
    for (let i = 0; i < len; i++) {
      const b = this.mem.readU8((pendingRead.addr + i) >>> 0);
      hex.push(b.toString(16).padStart(2, '0'));
      ascii.push((b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.');
    }
    if (int21Log.length > 0) {
      const last = int21Log[int21Log.length - 1];
      last.readBuf = hex.join(' ');
      last.readAscii = ascii.join('');
      last.readBytesActual = this.reg[0] & 0xFFFF; // AX = bytes read
    }
  }

  // Capture AFTER: where we are now
  const afterCS = this.cs;
  const afterEIP = this.eip >>> 0;
  const afterRM = this.realMode ? 1 : 0;

  if (afterCS !== beforeCS) {
    transitions.push({
      stepNum,
      fromCS: beforeCS,
      fromEIP: beforeEIP,
      toCS: afterCS,
      toEIP: afterEIP,
      fromRM: beforeRM,
      toRM: afterRM,
      prevBytes: bytes.join(' '),
      beforeSS, beforeESP, beforeDS,
      afterSS: this.ss,
      afterESP: this.reg[4] >>> 0,
    });
  }
  // Rolling 128-entry trace — freeze when CPU halted
  if (!this.halted) {
    trace.push({
      stepNum,
      cs: beforeCS, eip: beforeEIP, rm: beforeRM,
      ds: beforeDS, ss: beforeSS, esp: beforeESP,
      bytes: bytes.join(' '),
      afterCS, afterEIP, afterSS: this.ss, afterESP: this.reg[4] >>> 0,
    });
    if (trace.length > 128) trace.shift();
  }
  recentEIP[recentIdx] = beforeEIP;
  recentCS[recentIdx] = beforeCS;
  recentIdx = (recentIdx + 1) & (RING_SIZE - 1);
  stepNum++;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const MAX_TICKS = 200;
let totalTicks = 0;

for (let i = 0; i < MAX_TICKS; i++) {
  if (emu.halted) {
    console.log(`[HALT] after ${totalTicks} ticks: cpuHR=${emu.cpu.haltReason || ''} emuHR=${emu.haltReason || ''} EIP=0x${(emu.cpu.eip>>>0).toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
    console.log(`[INT21LOG] ${int21Log.length} INT 21h calls total. Showing ALL:`);
    const i21start = 0;
    for (let k = i21start; k < int21Log.length; k++) {
      const e = int21Log[k];
      const ah = (e.ax >> 8) & 0xFF;
      const al = e.ax & 0xFF;
      console.log(`  [${k}] step=${e.stepNum} ${e.cs.toString(16)}:${e.eip.toString(16)} AH=${ah.toString(16).padStart(2,'0')} AL=${al.toString(16).padStart(2,'0')} BX=${e.bx.toString(16)} CX=${e.cx.toString(16)} DX=${e.dx.toString(16)} SI=${e.si.toString(16)} DI=${e.di.toString(16)} DS=${e.ds.toString(16)} ES=${e.es.toString(16)}`);
      if (e.bufStr) console.log(`         BUF: "${e.bufStr}"  HEX: ${e.bufHex}`);
      if (e.readBuf) console.log(`         READ ${e.readBytesActual} bytes: ${e.readBuf}  "${e.readAscii}"`);
    }
    console.log(`[TRACE] full step trace near crash (${trace.length} entries):`);
    for (const t of trace) {
      const sig = (t.afterCS !== t.cs || t.afterSS !== t.ss) ? ' ***' : '';
      console.log(`  step=${t.stepNum} ${t.cs.toString(16)}:${t.eip.toString(16)}(RM=${t.rm}) DS=${t.ds.toString(16)} SS=${t.ss.toString(16)} ESP=${t.esp.toString(16)} [${t.bytes}]${sig}`);
    }
    console.log(`[TRANSITIONS] ${transitions.length} total CS changes (showing last 30):`);
    const start = Math.max(0, transitions.length - 30);
    for (let j = start; j < transitions.length; j++) {
      const t = transitions[j];
      console.log(`  [${j}] step=${t.stepNum}  ${t.fromCS.toString(16)}:${t.fromEIP.toString(16)}(RM=${t.fromRM}) DS=${t.beforeDS.toString(16)} SS=${t.beforeSS.toString(16)} ESP=${t.beforeESP.toString(16)} [${t.prevBytes}]
      -> ${t.toCS.toString(16)}:${t.toEIP.toString(16)}(RM=${t.toRM}) SS=${t.afterSS.toString(16)} ESP=${t.afterESP.toString(16)}`);
    }
    break;
  }
  if (emu._dosHalted) await sleep(60);
  emu.tick();
  totalTicks++;
  if (i < 5 || i % 10 === 0) {
    const eip = emu.cpu.eip >>> 0;
    console.log(`[TICK ${i}] cpuSteps=${emu.cpuSteps} EIP=0x${eip.toString(16)} CS=0x${emu.cpu.cs.toString(16)} RM=${emu.cpu.realMode}`);
  }
}

console.log(`[DONE] ticks=${totalTicks} cpuSteps=${emu.cpuSteps} halted=${emu.halted}`);
console.log(`  videoMode=0x${emu.videoMode.toString(16)} isGraphics=${emu.isGraphicsMode}`);
if (emu.cpu.haltReason) console.log(`  haltReason: ${emu.cpu.haltReason}`);
