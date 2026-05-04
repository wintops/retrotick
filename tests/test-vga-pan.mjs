// Test horizontal pixel panning in Mode X.
// Write a pattern to planes where plane 0 byte 0 = color A, plane 1 byte 0 = color B.
// With pan=0: output[0]=A, output[1]=B, output[2]=C, output[3]=D.
// With pan=1: output[0]=B (was pixel 1), output[1]=C, output[2]=D, output[3]=A-of-next-byte.

import { VGAState, syncModeX } from '../src/lib/emu/dos/vga.ts';

globalThis.ImageData = class {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
};

const vga = new VGAState();
vga.initRegsForMode(0x13);
vga.unchained = true;

// Each byte in each plane corresponds to one pixel column.
// Write unique colors so we can identify which pixel lands in output[0].
// Plane 0 byte 0 = 0x10, plane 1 byte 0 = 0x20, plane 2 byte 0 = 0x30, plane 3 byte 0 = 0x40
// Plane 0 byte 1 = 0x50, plane 1 byte 1 = 0x60, plane 2 byte 1 = 0x70, plane 3 byte 1 = 0x80
vga.planes[0][0] = 0x10; vga.planes[1][0] = 0x20; vga.planes[2][0] = 0x30; vga.planes[3][0] = 0x40;
vga.planes[0][1] = 0x50; vga.planes[1][1] = 0x60; vga.planes[2][1] = 0x70; vga.planes[3][1] = 0x80;

// Build a palette where DAC[i] = R=G=B=i so we can recover the plane value from
// the pixel's red channel.
for (let i = 0; i < 256; i++) {
  vga.palette[i * 3] = i & 0x3F;
  vga.palette[i * 3 + 1] = i & 0x3F;
  vga.palette[i * 3 + 2] = i & 0x3F;
}

const emu = { vga, onVideoFrame: () => {} };

function firstPixelColors(pan) {
  // In 256-color mode, ATC[0x13] is halved to get effective pan → write pan*2
  vga.atcRegs[0x13] = (pan & 0x03) * 2;
  syncModeX(emu);
  const buf = vga.framebuffer.data;
  // Pixel bytes are [R,G,B,A]. Return first 8 pixels' red channel → 6-bit DAC value × (255/63).
  // To recover the DAC index from the 8-bit red, divide by (255/63).
  const out = [];
  for (let i = 0; i < 8; i++) {
    const r = buf[i * 4];
    const dacIdx = Math.round(r / (255 / 63));
    out.push(dacIdx);
  }
  return out;
}

const pan0 = firstPixelColors(0);
const pan1 = firstPixelColors(1);
const pan2 = firstPixelColors(2);

// With pan=0, first 4 pixels are plane0[0], plane1[0], plane2[0], plane3[0] = 0x10, 0x20, 0x30, 0x40
// pixel 4-7 = plane0[1], plane1[1], plane2[1], plane3[1] = 0x50, 0x60, 0x70, 0x80 → but 0x80 > 63 pixelmask won't clip, DAC only has 6-bit values so 0x80 & 0xFF lookup with default palette.
// Note: palette stored RGB at 6-bit, default dacPixelMask=0xFF, so index 0x80 is valid.
// BUT our palette sets DAC[i] R=G=B=i&0x3F, so DAC[0x80] R = 0x80 & 0x3F = 0. That's a collision.

// Easier: check the ordering of the first 3 pixels only (all < 0x40, safe).
console.log('pan=0 first 4:', pan0.slice(0, 4).map(v => '0x' + v.toString(16)));
console.log('pan=1 first 4:', pan1.slice(0, 4).map(v => '0x' + v.toString(16)));
console.log('pan=2 first 4:', pan2.slice(0, 4).map(v => '0x' + v.toString(16)));

// Assertions: for pan=0, output[0] ≈ 0x10
if (pan0[0] !== 0x10) {
  console.error(`FAIL pan=0: expected output[0]=0x10, got 0x${pan0[0].toString(16)}`);
  process.exit(1);
}
// For pan=1, output[0] should be what was at plane 1 of byte 0 = 0x20
if (pan1[0] !== 0x20) {
  console.error(`FAIL pan=1: expected output[0]=0x20, got 0x${pan1[0].toString(16)}`);
  process.exit(1);
}
// For pan=2, output[0] should be plane 2 of byte 0 = 0x30
if (pan2[0] !== 0x30) {
  console.error(`FAIL pan=2: expected output[0]=0x30, got 0x${pan2[0].toString(16)}`);
  process.exit(1);
}

console.log('[TEST] VGA pixel panning: ALL PASS');
