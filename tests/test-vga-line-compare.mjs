// Test VGA line compare split-screen.
// Layout: plane[0] filled with bottom-pattern (0x20) everywhere; then a small
// "top" window at 0x1000-0x1FFF filled with 0x80. displayStart is set to
// 0x1000 so rows above the split see the 0x80 pattern, rows at or past the
// split see the 0x20 pattern (address counter reset to 0 after line compare).

import { VGAState, syncModeX, syncMode13h } from '../src/lib/emu/dos/vga.ts';

globalThis.ImageData = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
};

// ---- Mode X line compare test ----
{
  const vga = new VGAState();
  vga.initRegsForMode(0x13);
  vga.unchained = true;

  for (let p = 0; p < 4; p++) {
    vga.planes[p].fill(0x20);
    vga.planes[p].fill(0x80, 0x1000, 0x2000);
  }

  // Mode X uses byte-addressed displayStart directly (no word-mode shift).
  // Want displayStart = 0x1000 → CRTC reg = 0x1000.
  vga.crtcRegs[0x0C] = 0x10;
  vga.crtcRegs[0x0D] = 0x00;

  // Line Compare is 10-bit: CRTC[0x18] = bits 7:0, CRTC[0x07] bit 4 = bit 8,
  // CRTC[0x09] bit 6 = bit 9. Default mode 13h CRTC[0x07]=0x1F has bit 4 set
  // and CRTC[0x09]=0x41 has bit 6 set, so clear them for line compare < 256.
  vga.crtcRegs[0x07] &= ~0x10;
  vga.crtcRegs[0x09] &= ~0x40;
  vga.crtcRegs[0x18] = 20; // raw scanline 20 → display row 10 (double-scan)

  const emu = { vga, onVideoFrame: () => {} };
  syncModeX(emu);

  const width = vga.framebuffer.width;
  const buf32 = new Uint32Array(
    vga.framebuffer.data.buffer,
    vga.framebuffer.data.byteOffset,
    vga.framebuffer.data.byteLength >> 2,
  );

  // Row 2 (above split): rowBase = 0x1000, offset = 0x1000 + 2*80 = 0x10A0 → plane[0]=0x80
  // Row 15 (below split): rowBase = 0, offset = 15*80 = 0x4B0 → plane[0]=0x20
  const topPixel = buf32[2 * width + 10];
  const bottomPixel = buf32[15 * width + 10];

  if (topPixel === bottomPixel) {
    console.error(`FAIL (Mode X line compare): top=0x${topPixel.toString(16)} === bottom=0x${bottomPixel.toString(16)}`);
    process.exit(1);
  }
  console.log(`OK Mode X line compare: top(y=2)=0x${topPixel.toString(16)} bottom(y=15)=0x${bottomPixel.toString(16)}`);
}

// ---- Mode 13h line compare test (linear VRAM) ----
{
  const vga = new VGAState();
  vga.initRegsForMode(0x13);
  vga.initFramebuffer(320, 200);

  const vram = new Uint8Array(0x10000);
  vram.fill(0x20);
  vram.fill(0x80, 0x1000, 0x2000);
  const mem = { readU8: (addr) => vram[(addr - 0xA0000) & 0xFFFF] };

  // displayStart 0x1000 (word mode → CRTC reg 0x0800)
  vga.crtcRegs[0x0C] = 0x08;
  vga.crtcRegs[0x0D] = 0x00;
  vga.crtcRegs[0x07] &= ~0x10;
  vga.crtcRegs[0x09] &= ~0x40;
  vga.crtcRegs[0x18] = 20; // split at raw line 20 → row 10

  const emu = { vga, memory: mem, onVideoFrame: () => {} };
  syncMode13h(emu);

  const buf32 = new Uint32Array(
    vga.framebuffer.data.buffer,
    vga.framebuffer.data.byteOffset,
    vga.framebuffer.data.byteLength >> 2,
  );
  // Row 2 above split: rowStart = 0x1000 + 2*320 = 0x1280 → 0x80
  // Row 15 below split: rowStart = 0 + 15*320 = 0x12C0 → but 0x12C0 < 0x2000, so it'd be 0x80 not 0x20!
  // Mode 13h linear pitch = 320 bytes/row. 15*320 = 4800 = 0x12C0. Overlaps top range.
  // Adjust: use smaller top window at 0x1000-0x13FF only; row 15 at offset 0x12C0 is still in top.
  // Better: use a large shift. Move displayStart to something far away, and place
  // the top pattern there.

  // Re-setup: top pattern at 0x8000+0x400, displayStart=0x8000
  vram.fill(0x20);
  vram.fill(0x80, 0x8000, 0x8400);
  vga.crtcRegs[0x0C] = 0x40; // 0x4000 * 2 = 0x8000 in word mode
  vga.crtcRegs[0x0D] = 0x00;

  syncMode13h(emu);
  const buf32b = new Uint32Array(
    vga.framebuffer.data.buffer,
    vga.framebuffer.data.byteOffset,
    vga.framebuffer.data.byteLength >> 2,
  );
  // Row 1 above split: rowStart = 0x8000 + 320 = 0x8140 → 0x80 ✓
  // Row 15 below split: rowStart = 0 + 15*320 = 0x12C0 → 0x20 ✓
  const topPixel = buf32b[1 * 320 + 10];
  const bottomPixel = buf32b[15 * 320 + 10];
  if (topPixel === bottomPixel) {
    console.error(`FAIL (13h line compare): top=0x${topPixel.toString(16)} === bottom=0x${bottomPixel.toString(16)}`);
    process.exit(1);
  }
  console.log(`OK Mode 13h line compare: top(y=1)=0x${topPixel.toString(16)} bottom(y=15)=0x${bottomPixel.toString(16)}`);
}

console.log('[TEST] VGA line compare: ALL PASS');
