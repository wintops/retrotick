// Test getVisibleWidth() returns different widths for different CRTC configs.
// Standard Mode X 320 uses CRTC[0x01]=0x4F (80 chars) + Seq[1] bit 3 (dot clock /2) = 320 px.
// Tweak to 360 uses CRTC[0x01]=0x59 (90 chars) + 28 MHz clock → 360 px.

import { VGAState } from '../src/lib/emu/dos/vga.ts';

{
  const vga = new VGAState();
  vga.initRegsForMode(0x13);
  // Mode 13h: CRTC[0x01] = 0x4F (80 chars), seq[1]=0x01 (8-dot), ATC[0x10] bit 6
  // set (256-color mode) → 80 × 8 / 2 = 320.
  const w1 = vga.getVisibleWidth();
  if (w1 !== 320) {
    console.error(`FAIL mode 13h: expected 320 got ${w1}`);
    process.exit(1);
  }
  console.log(`OK width 320: ${w1}`);
}

{
  const vga = new VGAState();
  vga.initRegsForMode(0x13);
  // Mode X tweak: CRTC[0x01] = 0x59 (90 chars) → 90 × 8 / 2 = 360
  vga.crtcRegs[0x01] = 0x59;
  const w2 = vga.getVisibleWidth();
  if (w2 !== 360) {
    console.error(`FAIL mode X 360: expected 360 got ${w2}`);
    process.exit(1);
  }
  console.log(`OK width 360: ${w2}`);
}

{
  const vga = new VGAState();
  vga.initRegsForMode(0x12);
  // Mode 12h: 640x480, seq[1]=0x01 (8-dot), no /2, CRTC[0x01]=0x4F → 80 × 8 = 640
  vga.crtcRegs[0x01] = 0x4F;
  vga.seqRegs[1] = 0x01;
  const w3 = vga.getVisibleWidth();
  if (w3 !== 640) {
    console.error(`FAIL mode 12h: expected 640 got ${w3}`);
    process.exit(1);
  }
  console.log(`OK width 640 (mode 12h): ${w3}`);
}

console.log('[TEST] VGA Mode X width: ALL PASS');
