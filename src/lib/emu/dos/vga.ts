// VGA state management, palette, mode 13h framebuffer sync

import type { Emulator } from '../emulator';

/** Default VGA refresh rate in Hz (standard CRT = 70). */
export const VGA_REFRESH_HZ_DEFAULT = 70;

export interface VGAMode {
  mode: number;
  width: number;
  height: number;
  bpp: number;
  isText: boolean;
  cols: number;
  rows: number;
  charHeight: number;
  memBase: number;
  planar: boolean;
}

export const VGA_MODES: Record<number, VGAMode> = {
  0x00: { mode: 0x00, width: 360, height: 400, bpp: 4, isText: true, cols: 40, rows: 25, charHeight: 16, memBase: 0xB8000, planar: false },
  0x01: { mode: 0x01, width: 360, height: 400, bpp: 4, isText: true, cols: 40, rows: 25, charHeight: 16, memBase: 0xB8000, planar: false },
  0x02: { mode: 0x02, width: 720, height: 400, bpp: 4, isText: true, cols: 80, rows: 25, charHeight: 16, memBase: 0xB8000, planar: false },
  0x03: { mode: 0x03, width: 720, height: 400, bpp: 4, isText: true, cols: 80, rows: 25, charHeight: 16, memBase: 0xB8000, planar: false },
  0x04: { mode: 0x04, width: 320, height: 200, bpp: 2, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xB8000, planar: false },
  0x05: { mode: 0x05, width: 320, height: 200, bpp: 2, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xB8000, planar: false },
  0x06: { mode: 0x06, width: 640, height: 200, bpp: 1, isText: false, cols: 80, rows: 25, charHeight: 8, memBase: 0xB8000, planar: false },
  0x07: { mode: 0x07, width: 720, height: 400, bpp: 4, isText: true, cols: 80, rows: 25, charHeight: 16, memBase: 0xB0000, planar: false },
  0x0D: { mode: 0x0D, width: 320, height: 200, bpp: 4, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xA0000, planar: true },
  0x0E: { mode: 0x0E, width: 640, height: 200, bpp: 4, isText: false, cols: 80, rows: 25, charHeight: 8, memBase: 0xA0000, planar: true },
  0x0F: { mode: 0x0F, width: 640, height: 350, bpp: 1, isText: false, cols: 80, rows: 25, charHeight: 14, memBase: 0xA0000, planar: true },
  0x10: { mode: 0x10, width: 640, height: 350, bpp: 4, isText: false, cols: 80, rows: 25, charHeight: 14, memBase: 0xA0000, planar: true },
  0x11: { mode: 0x11, width: 640, height: 480, bpp: 1, isText: false, cols: 80, rows: 30, charHeight: 16, memBase: 0xA0000, planar: true },
  0x12: { mode: 0x12, width: 640, height: 480, bpp: 4, isText: false, cols: 80, rows: 30, charHeight: 16, memBase: 0xA0000, planar: true },
  0x13: { mode: 0x13, width: 320, height: 200, bpp: 8, isText: false, cols: 40, rows: 25, charHeight: 8, memBase: 0xA0000, planar: false },
};

// Build default VGA 256-color palette (6-bit per component)
function buildDefaultPalette(): Uint8Array {
  const pal = new Uint8Array(256 * 3);

  // Standard 16 EGA colors (6-bit values)
  const ega16 = [
    0,0,0,  0,0,42,  0,42,0,  0,42,42,  42,0,0,  42,0,42,  42,21,0,  42,42,42,
    21,21,21, 21,21,63, 21,63,21, 21,63,63, 63,21,21, 63,21,63, 63,63,21, 63,63,63,
  ];
  for (let i = 0; i < 48; i++) pal[i] = ega16[i];

  // Entries 16-31: 16-step grayscale
  for (let i = 0; i < 16; i++) {
    const v = Math.round(i * 63 / 15);
    pal[(16 + i) * 3 + 0] = v;
    pal[(16 + i) * 3 + 1] = v;
    pal[(16 + i) * 3 + 2] = v;
  }

  // Entries 32-247: 3 intensity blocks × 72 colors each
  // 24 hue templates cycling R→Y→G→C→B→M with 4 steps between primaries
  // Each block has 3 saturation levels × 24 hues = 72 colors
  const maxIntensities = [63, 31, 21];
  let idx = 32;
  for (let block = 0; block < 3; block++) {
    const M = maxIntensities[block];
    // 24 hue base colors [R, G, B] using fractions of M
    const hues: [number, number, number][] = [
      [M, 0, 0], [M, Math.round(M/4), 0], [M, Math.round(M/2), 0], [M, Math.round(3*M/4), 0],
      [M, M, 0], [Math.round(3*M/4), M, 0], [Math.round(M/2), M, 0], [Math.round(M/4), M, 0],
      [0, M, 0], [0, M, Math.round(M/4)], [0, M, Math.round(M/2)], [0, M, Math.round(3*M/4)],
      [0, M, M], [0, Math.round(3*M/4), M], [0, Math.round(M/2), M], [0, Math.round(M/4), M],
      [0, 0, M], [Math.round(M/4), 0, M], [Math.round(M/2), 0, M], [Math.round(3*M/4), 0, M],
      [M, 0, M], [M, 0, Math.round(3*M/4)], [M, 0, Math.round(M/2)], [M, 0, Math.round(M/4)],
    ];
    for (let sat = 0; sat < 3; sat++) {
      for (let h = 0; h < 24; h++) {
        const [hr, hg, hb] = hues[h];
        // sat 0 = full (as-is), sat 1 = blend 1/3 toward max, sat 2 = blend 2/3 toward max
        pal[idx * 3 + 0] = Math.round(hr + (M - hr) * sat / 3);
        pal[idx * 3 + 1] = Math.round(hg + (M - hg) * sat / 3);
        pal[idx * 3 + 2] = Math.round(hb + (M - hb) * sat / 3);
        idx++;
      }
    }
  }

  // Entries 248-255: black (zeros, already from Uint8Array init)

  // VGA text mode ATC mapping: ATC[6]=0x14(20), ATC[8-15]=0x38-0x3F(56-63).
  // These DAC positions must contain the correct EGA colors for text mode display.
  pal[20 * 3 + 0] = 42; pal[20 * 3 + 1] = 21; pal[20 * 3 + 2] = 0; // brown
  const brightEGA = [
    21,21,21, 21,21,63, 21,63,21, 21,63,63, 63,21,21, 63,21,63, 63,63,21, 63,63,63,
  ];
  for (let i = 0; i < 24; i++) pal[56 * 3 + i] = brightEGA[i];

  return pal;
}

export class VGAState {
  currentMode: VGAMode = VGA_MODES[0x03];
  palette = buildDefaultPalette(); // 256 entries × 3 components, 6-bit each
  dacWriteIndex = 0;
  dacReadIndex = 0;
  private dacWriteComponent = 0; // 0=R, 1=G, 2=B (write side)
  private dacReadComponent = 0;  // 0=R, 1=G, 2=B (read side)

  seqIndex = 0;
  gcIndex = 0;
  writeMapMask = 0x0F;
  readMapSelect = 0;

  // Planar memory: 4 bit planes × 64KB each (for modes 0D-12)
  planes: Uint8Array[] = [
    new Uint8Array(131072),
    new Uint8Array(131072),
    new Uint8Array(131072),
    new Uint8Array(131072),
  ];
  latchRegs = new Uint8Array(4); // VGA latch registers (one per plane)

  // Register files for read/write tracking
  crtcIndex = 0;
  crtcRegs = new Uint8Array(25); // CRTC registers 0x00-0x18
  seqRegs = new Uint8Array(5);   // Sequencer registers 0x00-0x04
  gcRegs = new Uint8Array(9);    // Graphics Controller registers 0x00-0x08
  miscOutput = 0x67;             // Miscellaneous Output Register (default for mode 3)
  dacPixelMask = 0xFF;           // DAC Pixel Mask Register (0x3C6)

  // Attribute Controller
  atcIndex = 0;
  atcRegs = new Uint8Array(21);  // ATC registers 0x00-0x14
  private atcFlipFlop = false;   // false = next write to 0x3C0 is index, true = data

  framebuffer: ImageData | null = null;
  dirty = false;

  // VGA retrace timing
  refreshHz = VGA_REFRESH_HZ_DEFAULT; // configurable refresh rate
  private lastVblankSync = false;  // was previous 0x3DA read in VBlank?
  pendingSync = false;             // set when VBlank starts; tick should sync & present
  lastSyncTime = 0;                // performance.now() of last syncGraphics call



  // Cached retrace timing — reduces performance.now() calls in tight 0x3DA poll loops
  private _cachedNowUs = 0;        // performance.now() * 1000, refreshed every N polls
  private _3daPollCount = 0;       // polls since last refresh
  private _cachedVisibleLines = 200;
  private _cachedFrameUs = 449 * 31.778;
  private _retraceConstsDirty = true;
  private _cached3DA = 0;          // cached 0x3DA result (recomputed every 64 polls)

  /** Invalidate retrace cache so next 0x3DA read picks up new refreshHz */
  invalidateRetraceCache(): void { this._retraceConstsDirty = true; }

  /** Refresh retrace constants when CRTC regs change */
  private _updateRetraceConsts(): void {
    // Use raw VDE+1 (actual scanlines on CRT) for retrace timing, NOT getVisibleHeight()
    // which divides by maxScanLine for double-scan. The CRTC line counter counts every
    // scanline including double-scanned ones.
    const vdeLow = this.crtcRegs[0x12];
    const overflow = this.crtcRegs[0x07];
    const visibleScanlines = (vdeLow | ((overflow & 0x02) ? 0x100 : 0) | ((overflow & 0x40) ? 0x200 : 0)) + 1;
    const nativeTotalLines = (visibleScanlines <= 400) ? 449 : 525;
    const totalLines = Math.round((1000000 / this.refreshHz) / 31.778);
    this._cachedVisibleLines = Math.round(totalLines * visibleScanlines / nativeTotalLines);
    this._cachedFrameUs = totalLines * 31.778;
    this._retraceConstsDirty = false;
  }

  constructor() {
    this.initRegsForMode(0x03);
  }

  /** Initialize VGA register values for a given video mode */
  initRegsForMode(mode: number): void {
    // Attribute Controller defaults (16 palette entries + 5 control regs)
    // Standard EGA/VGA ATC palette: maps 4-bit attribute to 6-bit DAC index
    // Colors 0-5,7 = dark, 6 = brown (20h), 8-15 = bright (38h-3Fh)
    const egaAtcPalette = [0x00,0x01,0x02,0x03,0x04,0x05,0x14,0x07,0x38,0x39,0x3A,0x3B,0x3C,0x3D,0x3E,0x3F];
    for (let i = 0; i < 16; i++) this.atcRegs[i] = egaAtcPalette[i];
    this.atcRegs[0x10] = 0x0C; // Mode Control: blink enable, line graphics enable
    this.atcRegs[0x11] = 0x00; // Overscan Color
    this.atcRegs[0x12] = 0x0F; // Color Plane Enable (all planes)
    // Horizontal Pixel Panning: 0 for graphics and 8-dot text; 0x08 (no-pan)
    // for 9-dot text modes. Real BIOS applies this per-mode.
    this.atcRegs[0x13] = 0x00;
    this.atcRegs[0x14] = 0x00; // Color Select

    // Sequencer defaults
    this.seqRegs[0] = 0x03; // Reset
    this.seqRegs[1] = 0x00; // Clocking Mode
    this.seqRegs[2] = 0x03; // Map Mask (planes 0,1 for text)
    this.seqRegs[3] = 0x00; // Character Map Select
    this.seqRegs[4] = 0x02; // Memory Mode

    // Graphics Controller defaults
    this.gcRegs[0] = 0x00; // Set/Reset
    this.gcRegs[1] = 0x00; // Enable Set/Reset
    this.gcRegs[2] = 0x00; // Color Compare
    this.gcRegs[3] = 0x00; // Data Rotate
    this.gcRegs[4] = 0x00; // Read Map Select
    this.gcRegs[5] = 0x10; // Mode (odd/even for text)
    this.gcRegs[6] = 0x0E; // Miscellaneous (B8000 mapping for text)
    this.gcRegs[7] = 0x00; // Color Don't Care
    this.gcRegs[8] = 0xFF; // Bit Mask

    if (mode === 0x13) {
      // Mode 13h (320x200x256) — chain-4 linear
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F,
        0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x0E, 0x8F, 0x28, 0x40, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x0F; this.seqRegs[4] = 0x0E;
      this.gcRegs[5] = 0x40; this.gcRegs[6] = 0x05;
      this.atcRegs[0x10] = 0x41; // 256-color mode + graphics enable
      this.miscOutput = 0x63;
    } else if (mode === 0x12) {
      // Mode 12h (640x480x16) — planar
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0x0B, 0x3E,
        0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xEA, 0x0C, 0xDF, 0x28, 0x00, 0xE7, 0x04, 0xE3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x0F; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0xE3;
    } else if (mode === 0x11) {
      // Mode 11h (640x480x2) — planar mono
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0x0B, 0x3E,
        0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0xEA, 0x0C, 0xDF, 0x28, 0x00, 0xE7, 0x04, 0xE3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x01; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0xE3;
    } else if (mode === 0x10) {
      // Mode 10h (640x350x16) — planar
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F,
        0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x83, 0x85, 0x5D, 0x28, 0x0F, 0x63, 0xBA, 0xE3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x0F; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0xA3;
    } else if (mode === 0x0F) {
      // Mode 0Fh (640x350 mono) — planar
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F,
        0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x83, 0x85, 0x5D, 0x28, 0x0F, 0x63, 0xBA, 0xE3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x01; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0xA3;
    } else if (mode === 0x0E) {
      // Mode 0Eh (640x200x16) — planar
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F,
        0x00, 0x41, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x8E, 0x8F, 0x28, 0x00, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x0F; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0x63;
    } else if (mode === 0x0D) {
      // Mode 0Dh (320x200x16) — planar
      this.crtcRegs.set([
        0x2D, 0x27, 0x28, 0x90, 0x2B, 0x80, 0xBF, 0x1F,
        0x00, 0xC1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x8E, 0x8F, 0x14, 0x00, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[1] = 0x09; this.seqRegs[2] = 0x0F; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x05;
      this.miscOutput = 0x63;
    } else if (mode <= 0x03) {
      // Text modes 0-3
      if (mode <= 0x01) {
        // 40-col text (360x400)
        this.crtcRegs.set([
          0x2D, 0x27, 0x28, 0x90, 0x2B, 0xA0, 0xBF, 0x1F,
          0x00, 0x4F, 0x0D, 0x0E, 0x00, 0x00, 0x00, 0x00,
          0x9C, 0x8E, 0x8F, 0x14, 0x1F, 0x96, 0xB9, 0xA3, 0xFF,
        ]);
        this.seqRegs[1] = 0x08; // Clocking: 9-dot wide
        this.miscOutput = 0x67;
      } else {
        // 80-col text (720x400)
        this.crtcRegs.set([
          0x5F, 0x4F, 0x50, 0x82, 0x55, 0x81, 0xBF, 0x1F,
          0x00, 0x4F, 0x0D, 0x0E, 0x00, 0x00, 0x00, 0x00,
          0x9C, 0x8E, 0x8F, 0x28, 0x1F, 0x96, 0xB9, 0xA3, 0xFF,
        ]);
        this.miscOutput = 0x67;
      }
      this.seqRegs[2] = 0x03; this.seqRegs[4] = 0x02;
      this.gcRegs[5] = 0x10; this.gcRegs[6] = 0x0E;
    } else if (mode === 0x04 || mode === 0x05) {
      // CGA 4-color (320x200)
      this.crtcRegs.set([
        0x2D, 0x27, 0x28, 0x90, 0x2B, 0x80, 0xBF, 0x1F,
        0x00, 0xC1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x8E, 0x8F, 0x14, 0x00, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[1] = 0x09; this.seqRegs[2] = 0x03; this.seqRegs[4] = 0x02;
      this.gcRegs[5] = 0x30; this.gcRegs[6] = 0x0F;
      this.miscOutput = 0x63;
    } else if (mode === 0x06) {
      // CGA 2-color (640x200)
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x54, 0x80, 0xBF, 0x1F,
        0x00, 0xC1, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x8E, 0x8F, 0x28, 0x00, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[1] = 0x01; this.seqRegs[2] = 0x01; this.seqRegs[4] = 0x06;
      this.gcRegs[5] = 0x00; this.gcRegs[6] = 0x0D;
      this.miscOutput = 0x63;
    } else if (mode === 0x07) {
      // MDA text (720x400 mono)
      this.crtcRegs.set([
        0x5F, 0x4F, 0x50, 0x82, 0x55, 0x81, 0xBF, 0x1F,
        0x00, 0x4F, 0x0D, 0x0E, 0x00, 0x00, 0x00, 0x00,
        0x9C, 0x8E, 0x8F, 0x28, 0x0F, 0x96, 0xB9, 0xA3, 0xFF,
      ]);
      this.seqRegs[2] = 0x03; this.seqRegs[4] = 0x02;
      this.gcRegs[5] = 0x10; this.gcRegs[6] = 0x0A; // B0000 mapping for MDA
      this.miscOutput = 0x66;
    }

    this.writeMapMask = this.seqRegs[2] & 0x0F;
    this.readMapSelect = this.gcRegs[4] & 0x03;
    // Reset unchained state (Chain-4 is always enabled after a BIOS mode set)
    this.unchained = false;
  }

  // Mode X state: true when mode 13h has Chain-4 disabled (unchained 256-color planar)
  unchained = false;

  /** CRT scanlines per CRTC display row. CRTC[0x09] has two scanline-doubling
   *  mechanisms that are *alternatives*, not cumulative: bits 0-4 (Maximum
   *  Scan Line, N+1 scanlines per CRTC row advance) and bit 7 (Scan Doubling
   *  at the pipeline output). BIOS mode 0x0D defaults to CRTC[09]=0xC1 with
   *  both set, yet the image is still 200 rows — take whichever halves more
   *  aggressively rather than multiplying them. */
  getRowRepeat(): number {
    const maxScanLine = this.crtcRegs[0x09] & 0x1F;
    const scanDouble = (this.crtcRegs[0x09] & 0x80) ? 2 : 1;
    return Math.max(maxScanLine + 1, scanDouble);
  }

  /** Actual visible pixel height from CRTC registers, accounting for row repeat. */
  getVisibleHeight(): number {
    const vdeLow = this.crtcRegs[0x12];
    const overflow = this.crtcRegs[0x07];
    const vde = vdeLow | ((overflow & 0x02) ? 0x100 : 0) | ((overflow & 0x40) ? 0x200 : 0);
    return Math.floor((vde + 1) / this.getRowRepeat());
  }

  /** Line Compare (10-bit): split-screen boundary scanline.
   *  CRTC[0x18] = bits 7:0, CRTC[0x07] bit 4 = bit 8, CRTC[0x09] bit 6 = bit 9.
   *  When the CRTC's current scanline reaches this value, the address counter
   *  is reset to 0 (as if displayStart=0) for the remainder of the frame. */
  getLineCompare(): number {
    const low = this.crtcRegs[0x18];
    const bit8 = (this.crtcRegs[0x07] & 0x10) ? 0x100 : 0;
    const bit9 = (this.crtcRegs[0x09] & 0x40) ? 0x200 : 0;
    return low | bit8 | bit9;
  }

  /** Horizontal Pixel Panning (ATC[0x13]) — returns effective pixel shift.
   *  In standard modes: bits 0-2 give pan 0-7 directly.
   *  In 256-color modes (mode 13h / Mode X): the register is HALVED to obtain
   *  the real pan (only even values 0,2,4,6 are meaningful → pan 0,1,2,3).
   *  Second Reality's opening scroll writes `(x & 3) * 2` expecting this
   *  halving behavior — without it the scroll oscillates. Detection via GC[5]
   *  bit 6 ("256-color mode enable"), stable at mode init.
   *  Bit 3 (+0x08) is the 9-dot text "no pan" marker — not relevant here. */
  getPixelPan(): number {
    const raw = this.atcRegs[0x13] & 0x0F;
    if (this.gcRegs[5] & 0x40) return (raw >> 1) & 0x03;
    return raw & 0x07;
  }

  /** Visible pixel width derived from CRTC Horizontal Display End (CRTC[0x01]).
   *  dots_per_char = 9 dots if Seq[0x01] bit 0 == 0, else 8 dots.
   *  In 256-color modes each pixel spans 2 dot clocks, so the dot count is
   *  halved. We detect 256-color via GC[5] bit 6 ("256-color mode enable"):
   *  it's programmed at mode init by the BIOS and stays stable. We avoid
   *  ATC[0x10] bit 6 because games transiently rewrite ATC[0x10] for blink
   *  toggles and palette page select — that caused framebuffer reinit
   *  oscillation and broke Second Reality. */
  getVisibleWidth(): number {
    const hde = this.crtcRegs[0x01] + 1; // char columns
    const eightDot = !!(this.seqRegs[1] & 0x01);
    const dotsPerChar = eightDot ? 8 : 9;
    let width = hde * dotsPerChar;
    if (this.gcRegs[5] & 0x40) width >>= 1; // 256-color mode
    if (this.seqRegs[1] & 0x08) width >>= 1; // dot clock / 2
    return width;
  }

  /** Check if current register state indicates Mode X (unchained mode 13h) */
  isUnchained(): boolean {
    // Mode X = mode 13h with Chain-4 disabled (seq reg 4 bit 3 = 0)
    return this.currentMode.mode === 0x13 && !(this.seqRegs[4] & 0x08);
  }

  /** Callback set by emulator to update memory hook when unchained state changes */
  onUnchainedChange?: (unchained: boolean) => void;

  portWrite(port: number, value: number): void {
    switch (port) {
      case 0x3C0: // Attribute Controller: alternates index/data via flip-flop
        if (!this.atcFlipFlop) {
          this.atcIndex = value & 0x1F;
        } else {
          if (this.atcIndex < this.atcRegs.length) {
            this.atcRegs[this.atcIndex] = value;
            this.dirty = true;
          }
        }
        this.atcFlipFlop = !this.atcFlipFlop;
        break;
      case 0x3C2: // Miscellaneous Output Register (write)
        this.miscOutput = value;
        break;
      case 0x3C4: // Sequencer index
        this.seqIndex = value & 0x07;
        break;
      case 0x3C5: { // Sequencer data
        if (this.seqIndex < this.seqRegs.length) {
          this.seqRegs[this.seqIndex] = value;
        }
        if (this.seqIndex === 0x02) this.writeMapMask = value & 0x0F;
        // Detect Chain-4 toggle (seq reg 4 bit 3) for Mode X
        if (this.seqIndex === 0x04) {
          const wasUnchained = this.unchained;
          this.unchained = this.isUnchained();
          if (this.unchained !== wasUnchained) {
            this.onUnchainedChange?.(this.unchained);
          }
        }
        break;
      }
      case 0x3CE: // Graphics controller index
        this.gcIndex = value & 0x0F;
        break;
      case 0x3CF: // Graphics controller data
        if (this.gcIndex < this.gcRegs.length) {
          this.gcRegs[this.gcIndex] = value;
        }
        if (this.gcIndex === 0x04) this.readMapSelect = value & 0x03;
        break;
      case 0x3C6: // DAC Pixel Mask
        this.dacPixelMask = value;
        break;
      case 0x3C8: // DAC write index
        if (this.dacWriteComponent !== 0 && !(this as any)._dacDesyncLogged) {
          (this as any)._dacDesyncLogged = true;
          console.warn(`[DAC] Component desync: 0x3C8 write while component=${this.dacWriteComponent}, idx was ${this.dacWriteIndex}, new=${value}`);
        }
        this.dacWriteIndex = value;
        this.dacWriteComponent = 0;
        break;
      case 0x3C7: // DAC read index
        this.dacReadIndex = value;
        this.dacReadComponent = 0;
        break;
      case 0x3C9: // DAC data (write R, G, B sequentially)
        this.palette[this.dacWriteIndex * 3 + this.dacWriteComponent] = value & 0x3F;
        this.dacWriteComponent++;
        if (this.dacWriteComponent >= 3) {
          this.dacWriteComponent = 0;
          this.dacWriteIndex = (this.dacWriteIndex + 1) & 0xFF;
          this.dirty = true;
        }
        break;
      case 0x3D4: // CRTC index
        this.crtcIndex = value & 0x1F;
        break;
      case 0x3D5: // CRTC data
        if (this.crtcIndex < this.crtcRegs.length) {
          this.crtcRegs[this.crtcIndex] = value;
          // Invalidate cached retrace constants when vertical timing regs change
          if (this.crtcIndex === 0x07 || this.crtcIndex === 0x09 || this.crtcIndex === 0x12) {
            this._retraceConstsDirty = true;
          }
        }
        break;
    }
  }

  portRead(port: number): number {
    switch (port) {
      case 0x3C0: // Attribute Controller index (read)
        return this.atcIndex;
      case 0x3C1: // Attribute Controller data (read)
        return this.atcIndex < this.atcRegs.length ? this.atcRegs[this.atcIndex] : 0;
      case 0x3C6: // DAC Pixel Mask
        return this.dacPixelMask;
      case 0x3CC: // Miscellaneous Output Register (read)
        return this.miscOutput;
      case 0x3C4: // Sequencer index
        return this.seqIndex;
      case 0x3C5: // Sequencer data
        return this.seqIndex < this.seqRegs.length ? this.seqRegs[this.seqIndex] : 0;
      case 0x3CE: // Graphics controller index
        return this.gcIndex;
      case 0x3CF: // Graphics controller data
        return this.gcIndex < this.gcRegs.length ? this.gcRegs[this.gcIndex] : 0;
      case 0x3D4: // CRTC index
        return this.crtcIndex;
      case 0x3D5: // CRTC data
        return this.crtcIndex < this.crtcRegs.length ? this.crtcRegs[this.crtcIndex] : 0;
      case 0x3DA: { // Input status register 1 — cached retrace simulation
        this.atcFlipFlop = false; // reading 0x3DA resets ATC flip-flop

        // Recompute retrace state every 64 polls (float math is expensive per-poll)
        if ((this._3daPollCount++ & 63) === 0) {
          this._cachedNowUs = performance.now() * 1000;
          if (this._retraceConstsDirty) this._updateRetraceConsts();
          const tInFrame = this._cachedNowUs % this._cachedFrameUs;
          const currentLine = (tInFrame / 31.778) | 0;
          const inVblank = currentLine >= this._cachedVisibleLines;
          if (inVblank && !this.lastVblankSync) this.pendingSync = true;
          this.lastVblankSync = inVblank;
          const inHblank = !inVblank && (tInFrame - currentLine * 31.778) >= 25.422;
          this._cached3DA = (inVblank ? 0x08 : 0x00) | ((inVblank || inHblank) ? 0x01 : 0x00);
        }
        return this._cached3DA;
      }
      case 0x3C9: { // DAC data read
        const val = this.palette[this.dacReadIndex * 3 + this.dacReadComponent];
        this.dacReadComponent++;
        if (this.dacReadComponent >= 3) {
          this.dacReadComponent = 0;
          this.dacReadIndex = (this.dacReadIndex + 1) & 0xFF;
        }
        return val;
      }
      case 0x3C8:
        return this.dacWriteIndex;
      case 0x3C7:
        return this.dacReadIndex;
      default:
        return 0xFF;
    }
  }

  /** Write a byte to VGA memory at A0000+offset (planar mode) */
  planarWrite(offset: number, val: number): void {
    const writeMode = this.gcRegs[5] & 0x03;
    const mask = this.gcRegs[8]; // Bit Mask register
    const mapMask = this.writeMapMask;

    if (writeMode === 0) {
      // Fast path: Write Mode 0, no rotation/set-reset/logicOp, full mask (most Mode X writes)
      if (this.gcRegs[3] === 0 && this.gcRegs[1] === 0 && mask === 0xFF) {
        if (mapMask & 1) this.planes[0][offset] = val;
        if (mapMask & 2) this.planes[1][offset] = val;
        if (mapMask & 4) this.planes[2][offset] = val;
        if (mapMask & 8) this.planes[3][offset] = val;
        return;
      }
      // Write Mode 0: each plane gets val (optionally rotated/set-reset), masked by Bit Mask
      const enableSR = this.gcRegs[1]; // Enable Set/Reset
      const setReset = this.gcRegs[0]; // Set/Reset value
      const rotate = this.gcRegs[3] & 0x07;
      const logicOp = (this.gcRegs[3] >> 3) & 0x03;
      let data = val;
      if (rotate) data = ((data >> rotate) | (data << (8 - rotate))) & 0xFF;

      for (let p = 0; p < 4; p++) {
        if (!(mapMask & (1 << p))) continue;
        let src = (enableSR & (1 << p)) ? ((setReset & (1 << p)) ? 0xFF : 0x00) : data;
        const latch = this.latchRegs[p];
        if (logicOp === 1) src &= latch;
        else if (logicOp === 2) src |= latch;
        else if (logicOp === 3) src ^= latch;
        this.planes[p][offset] = (src & mask) | (latch & ~mask);
      }
    } else if (writeMode === 1) {
      // Write Mode 1: copy latch registers directly
      for (let p = 0; p < 4; p++) {
        if (mapMask & (1 << p)) this.planes[p][offset] = this.latchRegs[p];
      }
    } else if (writeMode === 2) {
      // Write Mode 2: val bits 0-3 expand to full bytes per plane, masked by Bit Mask
      const logicOp = (this.gcRegs[3] >> 3) & 0x03;
      for (let p = 0; p < 4; p++) {
        if (!(mapMask & (1 << p))) continue;
        let src = (val & (1 << p)) ? 0xFF : 0x00;
        const latch = this.latchRegs[p];
        if (logicOp === 1) src &= latch;
        else if (logicOp === 2) src |= latch;
        else if (logicOp === 3) src ^= latch;
        this.planes[p][offset] = (src & mask) | (latch & ~mask);
      }
    } else if (writeMode === 3) {
      // Write Mode 3: val ANDed with Bit Mask, Set/Reset used as source
      const setReset = this.gcRegs[0];
      const rotate = this.gcRegs[3] & 0x07;
      let data = val;
      if (rotate) data = ((data >> rotate) | (data << (8 - rotate))) & 0xFF;
      const effectiveMask = data & mask;
      for (let p = 0; p < 4; p++) {
        if (!(mapMask & (1 << p))) continue;
        const src = (setReset & (1 << p)) ? 0xFF : 0x00;
        this.planes[p][offset] = (src & effectiveMask) | (this.latchRegs[p] & ~effectiveMask);
      }
    }
  }

  /** Read a byte from VGA memory at A0000+offset (planar mode) — fills latches */
  planarRead(offset: number): number {
    // Load all 4 latches
    for (let p = 0; p < 4; p++) this.latchRegs[p] = this.planes[p][offset];

    const readMode = (this.gcRegs[5] >> 3) & 0x01;
    if (readMode === 0) {
      // Read Mode 0: return plane selected by Read Map Select
      return this.planes[this.readMapSelect][offset];
    } else {
      // Read Mode 1: color compare — return bitmask where all enabled planes match
      const colorCompare = this.gcRegs[2];
      const colorDontCare = this.gcRegs[7];
      let result = 0xFF;
      for (let p = 0; p < 4; p++) {
        if (!(colorDontCare & (1 << p))) continue;
        const planeData = this.planes[p][offset];
        const compareBit = (colorCompare & (1 << p)) ? 0xFF : 0x00;
        result &= ~(planeData ^ compareBit);
      }
      return result;
    }
  }

  clearPlanes(): void {
    for (let p = 0; p < 4; p++) this.planes[p].fill(0);
  }

  /** Reset DAC palette to default VGA colors */
  resetPalette(): void {
    this.palette = buildDefaultPalette();
    this.dirty = true;
  }

  /** Build lookup from 4-bit plane color → 8-bit DAC index, applying ATC palette + Color Select + pixel mask */
  buildAtcDacLookup(): Uint8Array {
    const lut = new Uint8Array(16);
    const colorSelect = this.atcRegs[0x14];
    const p54s = !!(this.atcRegs[0x10] & 0x80);
    for (let i = 0; i < 16; i++) {
      const atcOut = this.atcRegs[i];
      let dacIdx: number;
      if (p54s) {
        dacIdx = (atcOut & 0x0F) | ((colorSelect & 0x0F) << 4);
      } else {
        dacIdx = (atcOut & 0x3F) | ((colorSelect & 0x0C) << 4);
      }
      lut[i] = dacIdx & this.dacPixelMask;
    }
    return lut;
  }

  initFramebuffer(width: number, height: number): void {
    if (typeof ImageData !== 'undefined') {
      this.framebuffer = new ImageData(width, height);
    }
  }
}

const VGA_PORT_START = 0x3C0;
const VGA_PORT_END = 0x3DA;

export function isVGAPort(port: number): boolean {
  return port >= VGA_PORT_START && port <= VGA_PORT_END;
}

/** Convert 6-bit DAC value to 8-bit */
function dac6to8(v: number): number {
  return (v * 255 / 63) | 0;
}

/** Pack RGBA into ABGR uint32 for little-endian ImageData */
function packABGR(r: number, g: number, b: number): number {
  return 0xFF000000 | (b << 16) | (g << 8) | r;
}

/** Build 8-bit RGB lookup from DAC palette (256 entries → ABGR uint32) */
function buildRGBLookup(pal: Uint8Array): Uint32Array {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    lut[i] = packABGR(dac6to8(pal[i * 3]), dac6to8(pal[i * 3 + 1]), dac6to8(pal[i * 3 + 2]));
  }
  return lut;
}

/** Sync mode 13h (320x200x256) framebuffer from linear memory at A0000 */
export function syncMode13h(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mem = emu.memory;
  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);
  const width = vga.framebuffer.width;
  const height = vga.framebuffer.height;

  // CRTC Start Address: display starts at this byte offset in VRAM
  // Used for hardware scrolling and double-buffering
  // In mode 13h chain-4, CRTC word mode: register * 2 gives byte offset
  // (CRTC 0x17 bit 6 = 0 means word addressing)
  const startReg = (vga.crtcRegs[0x0C] << 8) | vga.crtcRegs[0x0D];
  const wordMode = !(vga.crtcRegs[0x17] & 0x40); // bit 6 clear = word mode
  const displayStart = wordMode ? startReg * 2 : startReg;

  // Line Compare: split-screen boundary in display rows, converted from CRT
  // scanlines via the same row-repeat factor getVisibleHeight uses.
  const splitRow = Math.floor(vga.getLineCompare() / vga.getRowRepeat());

  // Horizontal Pixel Panning: shift display left by pan pixels per scanline.
  // Per DOSBox: when ATC[0x10] bit 5 is set, pan resets to 0 below the line
  // compare split (the upper half pans, bottom half stays still). When bit 5
  // is clear, pan is kept for the whole frame.
  const pan = vga.getPixelPan();
  const resetPanBelowSplit = !!(vga.atcRegs[0x10] & 0x20);
  const pixelMask = vga.dacPixelMask;

  for (let y = 0; y < height; y++) {
    const belowSplit = y >= splitRow;
    const rowBase = belowSplit ? 0 : displayStart;
    const effPan = (belowSplit && resetPanBelowSplit) ? 0 : pan;
    const vramRowStart = rowBase + y * width + effPan;
    const pxBase = y * width;
    for (let x = 0; x < width; x++) {
      buf32[pxBase + x] = lut[mem.readU8(0xA0000 + ((vramRowStart + x) & 0xFFFF)) & pixelMask];
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync Mode X (unchained 256-color planar) framebuffer from VGA planes.
 *  Supports page flipping via CRTC display start address (regs 0x0C-0x0D),
 *  line compare split-screen (CRTC 0x18), pixel panning (ATC 0x13), and
 *  dynamic width derived from CRTC horizontal display end. */
export function syncModeX(emu: Emulator): void {
  const vga = emu.vga;

  // Derive resolution from CRTC registers
  // Vertical Display End (CRTC 0x12) = visible scanlines - 1 (low 8 bits)
  // Overflow register (CRTC 0x07) bit 1 = bit 8, bit 6 = bit 9
  const vdeLow = vga.crtcRegs[0x12];
  const overflow = vga.crtcRegs[0x07];
  const vde = vdeLow | ((overflow & 0x02) ? 0x100 : 0) | ((overflow & 0x40) ? 0x200 : 0);
  const totalScanlines = vde + 1;
  // CRTC row repeat (maxScanLine or Scan Doubling bit). See getRowRepeat().
  const rowRepeat = vga.getRowRepeat();
  const height = Math.floor(totalScanlines / rowRepeat);
  // Display width derived from CRTC Horizontal Display End (stable: computed
  // from CRTC[0x01] + Seq[1] + currentMode.bpp, none of which games rewrite
  // mid-gameplay). Supports Mode X tweaks (360x270, 400x300) without the
  // ATC[0x10]-driven oscillation that broke Second Reality positioning.
  let width = vga.getVisibleWidth();
  if (width <= 0) width = 320;
  width = (width + 3) & ~3;

  // Mode-tweak debounce: SR (and similar demos) reprogram CRTC one register
  // at a time, and our vblank-triggered syncGraphics can fall between two
  // writes — capturing e.g. height=200 while pitch is still 176 from the
  // previous scene. Rendering that snapshot freezes a half-torn frame that
  // stays on screen until the next dim change. Require the new (width,height)
  // to stabilise over two consecutive syncs before applying the reshape.
  if (!vga.framebuffer || vga.framebuffer.width !== width || vga.framebuffer.height !== height) {
    const s = vga as any;
    if (s._pendingFbWidth === width && s._pendingFbHeight === height) {
      vga.initFramebuffer(width, height);
      if (!vga.framebuffer) return;
      s._pendingFbWidth = -1;
      s._pendingFbHeight = -1;
    } else {
      s._pendingFbWidth = width;
      s._pendingFbHeight = height;
      // Skip rendering this frame — the framebuffer still reflects the
      // previous stable geometry, so we'd either under-write (leaving stale
      // content visible) or read inconsistent CRTC values. Defer until the
      // dimensions confirm on the next sync.
      return;
    }
  } else {
    (vga as any)._pendingFbWidth = -1;
    (vga as any)._pendingFbHeight = -1;
  }

  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);
  const p0 = vga.planes[0], p1 = vga.planes[1], p2 = vga.planes[2], p3 = vga.planes[3];
  const pixelMask = vga.dacPixelMask;

  // Display start address from CRTC regs 0x0C (high) and 0x0D (low).
  // In unchained Mode X, programs write byte offsets per plane directly — do
  // NOT apply CRTC[0x17] word-mode × 2 (that shift applies to the raw CRTC
  // character counter, but Mode X code addresses planes byte-by-byte).
  const displayStart = (vga.crtcRegs[0x0C] << 8) | vga.crtcRegs[0x0D];

  // CRTC offset register (0x13) = bytes per scanline / 2 in each plane
  const pitch = (vga.crtcRegs[0x13] || 40) * 2;

  // Line Compare: split-screen boundary, converted from CRT scanlines to
  // display rows using the same row-repeat we used to derive height.
  const lineCompareRaw = vga.getLineCompare();
  const splitRow = Math.floor(lineCompareRaw / rowRepeat);

  // Horizontal Pixel Panning: shift pixels left by `pan` at scanline start.
  // Per DOSBox: when ATC[0x10] bit 5 is set, pan resets to 0 below the line
  // compare split (upper half pans, bottom half stays still). When bit 5 is
  // clear, pan applies to the whole frame.
  const pan = vga.getPixelPan();
  const resetPanBelowSplit = !!(vga.atcRegs[0x10] & 0x20);

  if (pan === 0) {
    // Fast path: pan=0 everywhere, 4-pixel unroll
    const bytesPerRow = width >> 2;
    for (let y = 0; y < height; y++) {
      const rowBase = (y < splitRow) ? displayStart : 0;
      const rowStart = rowBase + y * pitch;
      let px = y * width;
      for (let b = 0; b < bytesPerRow; b++) {
        const offset = (rowStart + b) & 0x1FFFF;
        buf32[px]     = lut[p0[offset] & pixelMask];
        buf32[px + 1] = lut[p1[offset] & pixelMask];
        buf32[px + 2] = lut[p2[offset] & pixelMask];
        buf32[px + 3] = lut[p3[offset] & pixelMask];
        px += 4;
      }
    }
  } else {
    // General path: per-row pan + split handling, walk plane-by-plane
    for (let y = 0; y < height; y++) {
      const belowSplit = y >= splitRow;
      const rowBase = belowSplit ? 0 : displayStart;
      const rowStart = rowBase + y * pitch;
      const effPan = (belowSplit && resetPanBelowSplit) ? 0 : pan;
      const pxBase = y * width;
      let srcByte = (rowStart + (effPan >> 2)) & 0x1FFFF;
      let plane = effPan & 3;
      let b0 = p0[srcByte], b1 = p1[srcByte], b2 = p2[srcByte], b3 = p3[srcByte];
      for (let x = 0; x < width; x++) {
        const v = (plane === 0 ? b0 : plane === 1 ? b1 : plane === 2 ? b2 : b3) & pixelMask;
        buf32[pxBase + x] = lut[v];
        plane++;
        if (plane === 4) {
          plane = 0;
          srcByte = (srcByte + 1) & 0x1FFFF;
          b0 = p0[srcByte]; b1 = p1[srcByte]; b2 = p2[srcByte]; b3 = p3[srcByte];
        }
      }
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync CGA mode 4/5 (320x200x4) framebuffer from B8000, interleaved */
export function syncCGA4(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mem = emu.memory;
  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);

  const atcLut = vga.buildAtcDacLookup();

  for (let y = 0; y < 200; y++) {
    // Even scanlines at offset 0, odd at offset 0x2000
    const bank = (y & 1) ? 0x2000 : 0;
    const rowOffset = (y >> 1) * 80;
    for (let x = 0; x < 80; x++) {
      const b = mem.readU8(0xB8000 + bank + rowOffset + x);
      const px = y * 320 + x * 4;
      buf32[px + 0] = lut[atcLut[(b >> 6) & 3]];
      buf32[px + 1] = lut[atcLut[(b >> 4) & 3]];
      buf32[px + 2] = lut[atcLut[(b >> 2) & 3]];
      buf32[px + 3] = lut[atcLut[b & 3]];
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync CGA mode 6 (640x200x2) framebuffer from B8000, interleaved */
export function syncCGA6(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mem = emu.memory;
  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);

  const atcLut = vga.buildAtcDacLookup();

  for (let y = 0; y < 200; y++) {
    const bank = (y & 1) ? 0x2000 : 0;
    const rowOffset = (y >> 1) * 80;
    for (let x = 0; x < 80; x++) {
      const b = mem.readU8(0xB8000 + bank + rowOffset + x);
      const px = y * 640 + x * 8;
      for (let bit = 7; bit >= 0; bit--) {
        buf32[px + (7 - bit)] = lut[atcLut[(b >> bit) & 1]];
      }
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync EGA/VGA planar 16-color mode (0D, 0E, 10, 12) from plane buffers.
 *  Supports CRTC start address, line compare split-screen, and pixel panning.
 *  Respects CRTC-derived visible height: rows beyond VDE are filled with the
 *  overscan color (fixes Moktar bottom-line flicker from page flipping with
 *  a partial 192-row buffer vs the mode's 200-row framebuffer). */
export function syncPlanar16(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mode = vga.currentMode;
  const width = mode.width;
  const fbHeight = mode.height;
  const bytesPerRow = width >> 3; // 8 pixels per byte
  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);
  const p0 = vga.planes[0], p1 = vga.planes[1], p2 = vga.planes[2], p3 = vga.planes[3];
  const atcLut = vga.buildAtcDacLookup();

  // CRTC start address — in EGA/VGA planar 16-color modes, programs typically
  // write byte-offsets per plane directly into CRTC[0x0C:0x0D] (each plane is
  // addressed independently). Applying CRTC[0x17] word-mode × 2 here breaks
  // games that hardware-page-flip (e.g. Moktar writes 0x1E00 byte-offset).
  const displayStart = (vga.crtcRegs[0x0C] << 8) | vga.crtcRegs[0x0D];
  const pitch = (vga.crtcRegs[0x13] || bytesPerRow) * 2;

  // Visible height derived from CRTC Vertical Display End — respects games
  // that program less than mode.height rows (Moktar uses 192 visible rows).
  const vdeLow = vga.crtcRegs[0x12];
  const overflow = vga.crtcRegs[0x07];
  const vde = vdeLow | ((overflow & 0x02) ? 0x100 : 0) | ((overflow & 0x40) ? 0x200 : 0);
  // CRTC row repeat (maxScanLine or Scan Doubling bit). See getRowRepeat().
  const rowRepeat = vga.getRowRepeat();
  const visibleRows = Math.floor((vde + 1) / rowRepeat);
  const height = Math.min(visibleRows, fbHeight);

  // Line Compare: split-screen boundary (row-based after max scan line)
  const splitRow = Math.floor(vga.getLineCompare() / rowRepeat);

  // Pixel Panning (0-7 in EGA planar 16-color modes).
  // Per DOSBox: when ATC[0x10] bit 5 is set, pan resets to 0 below the line
  // compare split; when bit 5 is clear, pan applies to the whole frame.
  const pan = vga.getPixelPan();
  const resetPanBelowSplit = !!(vga.atcRegs[0x10] & 0x20);

  for (let y = 0; y < height; y++) {
    const belowSplit = y >= splitRow;
    const rowBase = belowSplit ? 0 : displayStart;
    const rowOff = rowBase + y * pitch;
    const effPan = (belowSplit && resetPanBelowSplit) ? 0 : pan;
    const pxBase = y * width;
    for (let x = 0; x < width; x++) {
      const srcPx = x + effPan;
      const byteOff = (rowOff + (srcPx >> 3)) & 0x1FFFF;
      const bit = 7 - (srcPx & 7);
      const colorIdx = ((p0[byteOff] >> bit) & 1) | (((p1[byteOff] >> bit) & 1) << 1) |
        (((p2[byteOff] >> bit) & 1) << 2) | (((p3[byteOff] >> bit) & 1) << 3);
      buf32[pxBase + x] = lut[atcLut[colorIdx]];
    }
  }

  // Fill rows beyond the CRTC-visible area with the overscan color so
  // framebuffer rows 192..199 don't show stale plane data between frames.
  if (height < fbHeight) {
    const overscanIdx = vga.atcRegs[0x11] & vga.dacPixelMask;
    const overscan = lut[overscanIdx];
    for (let y = height; y < fbHeight; y++) {
      const pxBase = y * width;
      buf32.fill(overscan, pxBase, pxBase + width);
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync EGA/VGA planar mono mode (0F, 11) from plane 0 */
export function syncPlanarMono(emu: Emulator): void {
  const vga = emu.vga;
  if (!vga.framebuffer) return;

  const mode = vga.currentMode;
  const width = mode.width;
  const height = mode.height;
  const bytesPerRow = width >> 3;
  const lut = buildRGBLookup(vga.palette);
  const buf32 = new Uint32Array(vga.framebuffer.data.buffer, vga.framebuffer.data.byteOffset, vga.framebuffer.data.byteLength >> 2);
  const p0 = vga.planes[0];
  const atcLut = vga.buildAtcDacLookup();

  for (let y = 0; y < height; y++) {
    const rowOff = y * bytesPerRow;
    for (let xByte = 0; xByte < bytesPerRow; xByte++) {
      const b = p0[rowOff + xByte];
      const px = y * width + xByte * 8;
      for (let bit = 7; bit >= 0; bit--) {
        const color = (b >> bit) & 1;
        buf32[px + (7 - bit)] = lut[atcLut[color]];
      }
    }
  }

  vga.dirty = false;
  emu.onVideoFrame?.();
}

/** Sync any graphics mode framebuffer */
export function syncGraphics(emu: Emulator): void {
  const mode = emu.videoMode;
  // Mode X: mode 13h with Chain-4 disabled
  if (mode === 0x13 && emu.vga.unchained) {
    syncModeX(emu);
    return;
  }
  switch (mode) {
    case 0x13: syncMode13h(emu); break;
    case 0x04: case 0x05: syncCGA4(emu); break;
    case 0x06: syncCGA6(emu); break;
    case 0x0D: case 0x0E: case 0x10: case 0x12: syncPlanar16(emu); break;
    case 0x0F: case 0x11: syncPlanarMono(emu); break;
  }
}
