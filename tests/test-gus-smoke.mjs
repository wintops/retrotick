// Smoke test: GUS at base 0x240 → select ports 0x342/0x343, data 0x344/0x345, DRAM 0x347.
import { Emulator } from '../src/lib/emu/emulator.ts';

const noop = () => {};
globalThis.document = { createElement: () => ({ getContext: () => ({ fillRect: noop, clearRect: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: (w,h)=>({ data: new Uint8ClampedArray(w*h*4), width: w, height: h }), putImageData: noop, drawImage: noop, save: noop, restore: noop, canvas: null }), width: 640, height: 480, toDataURL: () => '', addEventListener: noop, removeEventListener: noop, style: { cursor: 'default' }, parentElement: { style: { cursor: 'default' } } }), title: '' };
globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; } getContext() { return { fillRect: noop, clearRect: noop, getImageData: () => ({ data: new Uint8ClampedArray(4) }), createImageData: (w,h)=>({ data: new Uint8ClampedArray(w*h*4), width: w, height: h }), putImageData: noop, drawImage: noop, save: noop, restore: noop }; } };
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.Image = class { set src(_) {} };
globalThis.URL = { createObjectURL: () => '', revokeObjectURL: noop };
globalThis.Blob = class { constructor() {} };

const emu = new Emulator();
emu.isDOS = true;
// Wire GUS readMemory like emu-load.ts:1335 does
emu.dosAudio.gus.readMemory = (addr) => emu.memory.readU8(addr);
const gus = emu.dosAudio.gus;

// Take GUS out of reset (reset reg = 0x03 → running + DAC enabled)
emu.portOut(0x343, 0x4C);                 // select reg 0x4C
emu.portOutWord(0x344, 0x0300);           // hi byte = 0x03

// ── 1. OUTSW word write to reg 0x00 (wave control, voice 0)
emu.portOut(0x342, 0x00); emu.portOut(0x343, 0x00);
emu.portOutWord(0x344, 0x0000);
console.log('[1] Reg 0x00 word write: voice 0 wave.state =', gus.voices[0].wave.state.toString(16), '(expected: 0)');

// ── 2. Byte-then-byte write to reg 0x01 (wave rate)
emu.portOut(0x343, 0x01);
emu.portOut(0x344, 0x00);
emu.portOut(0x345, 0x04);
console.log('[2] Reg 0x01 byte/byte: voice 0 wave.inc =', gus.voices[0].wave.inc.toString(16), '(expected: 0x200)');

// ── 3. Word write to reg 0x01
emu.portOut(0x343, 0x01);
emu.portOutWord(0x344, 0x0800);
console.log('[3] Reg 0x01 word:      voice 0 wave.inc =', gus.voices[0].wave.inc.toString(16), '(expected: 0x400)');

// ── 4. DRAM byte writes
emu.portOut(0x343, 0x43); emu.portOutWord(0x344, 0x1000);
emu.portOut(0x343, 0x44); emu.portOutWord(0x344, 0x0000);
for (let i = 0; i < 4; i++) {
  emu.portOut(0x343, 0x43); emu.portOutWord(0x344, 0x1000 + i);
  emu.portOut(0x347, 0xAA + i);
}
console.log('[4] DRAM byte writes at 0x1000..0x1003:',
  gus.ram[0x1000].toString(16), gus.ram[0x1001].toString(16),
  gus.ram[0x1002].toString(16), gus.ram[0x1003].toString(16),
  '(expected: aa ab ac ad)');

// ── 5. DMA upload path test (channel 1)
const srcBase = 0x10000;
for (let i = 0; i < 8; i++) emu.memory.writeU8(srcBase + i, 0x10 + i);
emu.portOut(0x0C, 0);              // clear flipflop
emu.portOut(0x0A, 0x05);           // mask ch 1
emu.portOut(0x83, (srcBase >> 16) & 0xFF);
emu.portOut(0x02, srcBase & 0xFF);
emu.portOut(0x02, (srcBase >> 8) & 0xFF);
emu.portOut(0x03, 7); emu.portOut(0x03, 0);
emu.portOut(0x0B, 0x49);           // mode
emu.portOut(0x0A, 0x01);           // unmask
emu.portOut(0x343, 0x42); emu.portOutWord(0x344, 0x2000);
emu.portOut(0x343, 0x41); emu.portOutWord(0x344, 0x0100); // hi=0x01 enable
const uploaded = [];
for (let i = 0; i < 8; i++) uploaded.push(gus.ram[0x20000 + i].toString(16));
console.log('[5] DMA upload to GUS RAM 0x20000..0x20007:', uploaded.join(' '), '(expected: 10 11 12 13 14 15 16 17)');

// ── 6. Same but with OUTSW-style single port call (simulating dispatch.ts OUTSW)
emu.portOut(0x343, 0x01);
emu.portOutWord(0x344, 0x0123);
console.log('[6] Reg 0x01 word 0x0123: voice 0 wave.inc =', gus.voices[0].wave.inc.toString(16), '(expected: ceil(0x123/2) = 0x92)');

// ── 7. DMA upload with MSB inversion (8-bit samples, unsigned → signed)
const src7 = 0x11000;
for (let i = 0; i < 4; i++) emu.memory.writeU8(src7 + i, 0x00 + i); // 00, 01, 02, 03
emu.portOut(0x0C, 0);
emu.portOut(0x0A, 0x05);
emu.portOut(0x83, (src7 >> 16) & 0xFF);
emu.portOut(0x02, src7 & 0xFF); emu.portOut(0x02, (src7 >> 8) & 0xFF);
emu.portOut(0x03, 3); emu.portOut(0x03, 0);
emu.portOut(0x0B, 0x49);
emu.portOut(0x0A, 0x01);
emu.portOut(0x343, 0x42); emu.portOutWord(0x344, 0x3000);
emu.portOut(0x343, 0x41); emu.portOutWord(0x344, 0x8100); // hi=0x81 → enable | invert-MSB (8-bit)
const inv8 = [];
for (let i = 0; i < 4; i++) inv8.push(gus.ram[0x30000 + i].toString(16));
console.log('[7] DMA 8-bit MSB-inv (every byte XOR 0x80):', inv8.join(' '), '(expected: 80 81 82 83)');

// ── 8b. Two sequential DMA uploads to different RAM offsets
// (first upload 4 bytes to 0x50000, then 4 bytes to 0x60000)
const src8b1 = 0x13000, src8b2 = 0x13100;
for (let i = 0; i < 4; i++) emu.memory.writeU8(src8b1 + i, 0xAA + i);
for (let i = 0; i < 4; i++) emu.memory.writeU8(src8b2 + i, 0xCC + i);
// first upload
emu.portOut(0x0C, 0); emu.portOut(0x0A, 0x05);
emu.portOut(0x83, (src8b1 >> 16) & 0xFF);
emu.portOut(0x02, src8b1 & 0xFF); emu.portOut(0x02, (src8b1 >> 8) & 0xFF);
emu.portOut(0x03, 3); emu.portOut(0x03, 0);
emu.portOut(0x0B, 0x49); emu.portOut(0x0A, 0x01);
emu.portOut(0x343, 0x42); emu.portOutWord(0x344, 0x5000);
emu.portOut(0x343, 0x41); emu.portOutWord(0x344, 0x0100);
// second upload
emu.portOut(0x0C, 0); emu.portOut(0x0A, 0x05);
emu.portOut(0x83, (src8b2 >> 16) & 0xFF);
emu.portOut(0x02, src8b2 & 0xFF); emu.portOut(0x02, (src8b2 >> 8) & 0xFF);
emu.portOut(0x03, 3); emu.portOut(0x03, 0);
emu.portOut(0x0B, 0x49); emu.portOut(0x0A, 0x01);
emu.portOut(0x343, 0x42); emu.portOutWord(0x344, 0x6000);
emu.portOut(0x343, 0x41); emu.portOutWord(0x344, 0x0100);
const a = [], b = [];
for (let i = 0; i < 4; i++) a.push(gus.ram[0x50000 + i].toString(16));
for (let i = 0; i < 4; i++) b.push(gus.ram[0x60000 + i].toString(16));
console.log('[8b] 1st DMA upload @0x50000:', a.join(' '), '(expected: aa ab ac ad)');
console.log('[8b] 2nd DMA upload @0x60000:', b.join(' '), '(expected: cc cd ce cf)');

// ── 8. DMA upload with MSB inversion for 16-bit samples (only high byte XOR)
const src8 = 0x12000;
for (let i = 0; i < 8; i++) emu.memory.writeU8(src8 + i, 0x00 + i); // 00 01 02 03 04 05 06 07
emu.portOut(0x0C, 0);
emu.portOut(0x0A, 0x05);
emu.portOut(0x83, (src8 >> 16) & 0xFF);
emu.portOut(0x02, src8 & 0xFF); emu.portOut(0x02, (src8 >> 8) & 0xFF);
emu.portOut(0x03, 7); emu.portOut(0x03, 0);
emu.portOut(0x0B, 0x49);
emu.portOut(0x0A, 0x01);
emu.portOut(0x343, 0x42); emu.portOutWord(0x344, 0x4000);
emu.portOut(0x343, 0x41); emu.portOutWord(0x344, 0xC100); // hi=0xC1 → enable | are_samples_16bit | invert-MSB
const inv16 = [];
for (let i = 0; i < 8; i++) inv16.push(gus.ram[0x40000 + i].toString(16));
console.log('[8] DMA 16-bit MSB-inv (odd bytes XOR 0x80):', inv16.join(' '), '(expected: 0 81 2 83 4 85 6 87)');
