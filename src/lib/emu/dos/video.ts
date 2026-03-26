import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';
import { VGA_MODES } from './vga';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, EDI = 7;

// Video memory base (B800:0000 in real mode)
const VIDEO_MEM_BASE = 0xB8000;

/** Sync video memory (B800:0000) to emu.consoleBuffer */
export function syncVideoMemory(emu: Emulator): void {
  const cols = emu.screenCols;
  const rows = emu.screenRows;
  const mem = emu.memory;
  for (let i = 0; i < cols * rows; i++) {
    const ch = mem.readU8(VIDEO_MEM_BASE + i * 2);
    const attr = mem.readU8(VIDEO_MEM_BASE + i * 2 + 1);
    emu.consoleBuffer[i] = { char: ch, attr };
  }
  // Sync cursor position from CRTC registers (programs like QBasic write
  // directly to CRTC 0x0E/0x0F via ports 0x3D4/0x3D5 instead of INT 10h)
  const cursorPos = (emu.vga.crtcRegs[0x0E] << 8) | emu.vga.crtcRegs[0x0F];
  emu.consoleCursorX = cursorPos % cols;
  emu.consoleCursorY = Math.min(Math.floor(cursorPos / cols), rows - 1);
  emu.onConsoleOutput?.();
}

function clearVideoMem(cpu: CPU, emu: Emulator, attr: number): void {
  const cols = emu.screenCols;
  const rows = emu.screenRows;
  for (let i = 0; i < cols * rows; i++) {
    cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2, 0x20);
    cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2 + 1, attr);
  }
  syncVideoMemory(emu);
}

export function scrollUp(_cpu: CPU, emu: Emulator, lines: number, attr: number, top: number, left: number, bottom: number, right: number): void {
  const cols = emu.screenCols;
  const mem = emu.memory;
  if (lines >= (bottom - top + 1)) {
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  } else {
    for (let row = top; row <= bottom - lines; row++) {
      for (let col = left; col <= right; col++) {
        const dst = (row * cols + col) * 2;
        const src = ((row + lines) * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + dst, mem.readU8(VIDEO_MEM_BASE + src));
        mem.writeU8(VIDEO_MEM_BASE + dst + 1, mem.readU8(VIDEO_MEM_BASE + src + 1));
      }
    }
    for (let row = bottom - lines + 1; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  }
  syncVideoMemory(emu);
}

function scrollDown(_cpu: CPU, emu: Emulator, lines: number, attr: number, top: number, left: number, bottom: number, right: number): void {
  const cols = emu.screenCols;
  const mem = emu.memory;
  if (lines >= (bottom - top + 1)) {
    for (let row = top; row <= bottom; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  } else {
    for (let row = bottom; row >= top + lines; row--) {
      for (let col = left; col <= right; col++) {
        const dst = (row * cols + col) * 2;
        const src = ((row - lines) * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + dst, mem.readU8(VIDEO_MEM_BASE + src));
        mem.writeU8(VIDEO_MEM_BASE + dst + 1, mem.readU8(VIDEO_MEM_BASE + src + 1));
      }
    }
    for (let row = top; row < top + lines; row++) {
      for (let col = left; col <= right; col++) {
        const off = (row * cols + col) * 2;
        mem.writeU8(VIDEO_MEM_BASE + off, 0x20);
        mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
      }
    }
  }
  syncVideoMemory(emu);
}

export function teletypeOutput(cpu: CPU, emu: Emulator, ch: number): void {
  const cols = emu.screenCols;
  const rows = emu.screenRows;

  if (ch === 0x0D) {
    emu.consoleCursorX = 0;
    return;
  }
  if (ch === 0x0A) {
    emu.consoleCursorY++;
    if (emu.consoleCursorY >= rows) {
      scrollUp(cpu, emu, 1, 0x07, 0, 0, rows - 1, cols - 1);
      emu.consoleCursorY = rows - 1;
    }
    return;
  }
  if (ch === 0x08) {
    if (emu.consoleCursorX > 0) emu.consoleCursorX--;
    return;
  }
  if (ch === 0x07) return; // bell

  if (emu.isGraphicsMode) {
    drawCharGraphics(cpu, emu, ch, emu.consoleAttr, emu.consoleCursorX * 8, emu.consoleCursorY * (emu.charHeight || 8));
    // advance cursor
    emu.consoleCursorX++;
    if (emu.consoleCursorX >= cols) {
      emu.consoleCursorX = 0;
      emu.consoleCursorY++;
      if (emu.consoleCursorY >= rows) {
        // scrollUp not supported in graphics yet
        emu.consoleCursorY = rows - 1;
      }
    }
    return; // skip text-mode write
  }

  const off = (emu.consoleCursorY * cols + emu.consoleCursorX) * 2;
  cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
  cpu.mem.writeU8(VIDEO_MEM_BASE + off + 1, emu.consoleAttr);

  emu.consoleCursorX++;
  if (emu.consoleCursorX >= cols) {
    emu.consoleCursorX = 0;
    emu.consoleCursorY++;
    if (emu.consoleCursorY >= rows) {
      scrollUp(cpu, emu, 1, 0x07, 0, 0, rows - 1, cols - 1);
      emu.consoleCursorY = rows - 1;
    }
  }

  syncVideoMemory(emu);
}

function setVideoMode(cpu: CPU, emu: Emulator, modeNum: number): void {
  const noClear = (modeNum & 0x80) !== 0;
  const mode = modeNum & 0x7F;
  const vgaMode = VGA_MODES[mode];
  if (!vgaMode) {
    // Unknown mode — treat as mode 3
    return;
  }

  emu.videoMode = mode;
  emu.screenCols = vgaMode.cols;
  emu.screenRows = vgaMode.rows;
  emu.charHeight = vgaMode.charHeight;
  emu.isGraphicsMode = !vgaMode.isText;

  // Update BDA
  cpu.mem.writeU8(0x0449, mode);
  cpu.mem.writeU16(0x044A, vgaMode.cols);
  cpu.mem.writeU16(0x044C, vgaMode.cols * vgaMode.rows * 2); // page size in bytes
  cpu.mem.writeU16(0x044E, 0); // current page offset
  cpu.mem.writeU8(0x0450, 0); // cursor col page 0
  cpu.mem.writeU8(0x0451, 0); // cursor row page 0
  cpu.mem.writeU8(0x0460, vgaMode.isText ? (vgaMode.charHeight - 1) : 0); // cursor end scanline
  cpu.mem.writeU8(0x0461, vgaMode.isText ? (vgaMode.charHeight - 2) : 0); // cursor start scanline
  cpu.mem.writeU8(0x0462, 0); // active display page
  cpu.mem.writeU16(0x0463, 0x3D4); // CRTC base port (color)
  cpu.mem.writeU8(0x0484, vgaMode.rows - 1); // rows - 1
  cpu.mem.writeU16(0x0485, vgaMode.charHeight); // character height

  // CRT mode control register (BDA 0x0465)
  // Mode 3: 0x29 (80-col text, color)
  cpu.mem.writeU8(0x0465, vgaMode.isText ? 0x29 : 0x23);
  // Color palette register (BDA 0x0466)
  cpu.mem.writeU8(0x0466, 0x30);

  // EGA/VGA feature bits (BDA 0x0487)
  // Bit 7: no-clear flag from mode set; Bits 6-5 = 11 (256K+ RAM)
  cpu.mem.writeU8(0x0487, (noClear ? 0x80 : 0x00) | 0x60);

  // VGA display data area (BDA 0x0489)
  // Bit 0: VGA active; Bits 6-5: scan lines (01=400 for text, 10=200 for mode 13h)
  {
    let dda = 0x01; // VGA active
    if (vgaMode.isText) {
      // 400 scan lines for text modes
      dda |= (1 << 5); // bits 6-5 = 01
    } else if (vgaMode.height === 200) {
      // 200 scan lines (modes 04/05/06/0D/0E/13)
      dda |= (2 << 5); // bits 6-5 = 10
    } else if (vgaMode.height === 350) {
      // 350 scan lines (modes 0F/10)
      dda |= (0 << 5); // bits 6-5 = 00
    }
    // 480 scan lines (modes 11/12): bits 6-5 = 11
    else if (vgaMode.height === 480) {
      dda |= (3 << 5);
    }
    cpu.mem.writeU8(0x0489, dda);
  }

  emu.vga.currentMode = vgaMode;
  emu.vga.initRegsForMode(mode);

  // Reset DAC palette to defaults on every mode change
  // (real VGA BIOS always resets DAC — no-clear bit only skips video memory clearing)
  emu.vga.resetPalette();

  // Enable/disable planar memory hook for A0000-AFFFF
  cpu.mem.vgaPlanar = vgaMode.planar ? emu.vga : null;

  if (vgaMode.isText) {
    if (!noClear) {
      emu.initConsoleBuffer();
      clearVideoMem(cpu, emu, 0x07);
    }
    emu.consoleCursorX = 0;
    emu.consoleCursorY = 0;
  } else {
    // Graphics mode — init framebuffer for all modes
    emu.vga.initFramebuffer(vgaMode.width, vgaMode.height);

    if (!noClear) {
      if (vgaMode.planar) {
        // Planar modes (0D-12): clear all 4 planes
        emu.vga.clearPlanes();
      } else if (mode === 0x13) {
        // Mode 13h: linear at A0000, 64000 bytes
        for (let i = 0; i < 64000; i++) cpu.mem.writeU8(0xA0000 + i, 0);
      } else {
        // CGA modes (4/5/6): interleaved at B8000, 16KB
        for (let i = 0; i < 16384; i++) cpu.mem.writeU8(0xB8000 + i, 0);
      }
    }
  }
}

// --- Pixel operations for all graphics modes ---

function putPixel(cpu: CPU, emu: Emulator, x: number, y: number, color: number, xorMode: boolean): void {
  const mode = emu.videoMode;
  const vga = emu.vga;

  if (mode === 0x13) {
    // Mode 13h: 320x200x256, linear at A0000
    if (x < 320 && y < 200) {
      if (xorMode) color ^= cpu.mem.readU8(0xA0000 + y * 320 + x);
      cpu.mem.writeU8(0xA0000 + y * 320 + x, color);
    }
  } else if (mode === 0x12 || mode === 0x10 || mode === 0x0E || mode === 0x0D) {
    // Planar 16-color modes
    const modeInfo = vga.currentMode;
    if (x >= modeInfo.width || y >= modeInfo.height) return;
    const bytesPerRow = modeInfo.width >> 3;
    const offset = y * bytesPerRow + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
    for (let p = 0; p < 4; p++) {
      const planeBit = (color >> p) & 1;
      if (xorMode) {
        vga.planes[p][offset] ^= (planeBit ? bitMask : 0);
      } else {
        if (planeBit) {
          vga.planes[p][offset] |= bitMask;
        } else {
          vga.planes[p][offset] &= ~bitMask;
        }
      }
    }
  } else if (mode === 0x11 || mode === 0x0F) {
    // Planar mono modes (1bpp, plane 0 only)
    const modeInfo = vga.currentMode;
    if (x >= modeInfo.width || y >= modeInfo.height) return;
    const bytesPerRow = modeInfo.width >> 3;
    const offset = y * bytesPerRow + (x >> 3);
    const bitMask = 0x80 >> (x & 7);
    if (xorMode) {
      vga.planes[0][offset] ^= (color & 1) ? bitMask : 0;
    } else {
      if (color & 1) vga.planes[0][offset] |= bitMask;
      else vga.planes[0][offset] &= ~bitMask;
    }
  } else if (mode === 0x06) {
    // CGA mode 6: 640x200x2, interleaved at B8000
    if (x >= 640 || y >= 200) return;
    const bank = (y & 1) ? 0x2000 : 0;
    const rowOff = (y >> 1) * 80;
    const byteOff = x >> 3;
    const bitPos = 7 - (x & 7);
    const addr = 0xB8000 + bank + rowOff + byteOff;
    let b = cpu.mem.readU8(addr);
    if (xorMode) {
      b ^= ((color & 1) << bitPos);
    } else {
      b = (b & ~(1 << bitPos)) | ((color & 1) << bitPos);
    }
    cpu.mem.writeU8(addr, b);
  } else if (mode === 0x04 || mode === 0x05) {
    // CGA mode 4/5: 320x200x4, interleaved at B8000
    if (x >= 320 || y >= 200) return;
    const bank = (y & 1) ? 0x2000 : 0;
    const rowOff = (y >> 1) * 80;
    const byteOff = x >> 2;
    const shift = (3 - (x & 3)) * 2;
    const addr = 0xB8000 + bank + rowOff + byteOff;
    let b = cpu.mem.readU8(addr);
    if (xorMode) {
      b ^= ((color & 3) << shift);
    } else {
      b = (b & ~(3 << shift)) | ((color & 3) << shift);
    }
    cpu.mem.writeU8(addr, b);
  }
}

function getPixel(_cpu: CPU, emu: Emulator, x: number, y: number): number {
  const mode = emu.videoMode;
  const vga = emu.vga;

  if (mode === 0x13) {
    if (x < 320 && y < 200) return emu.memory.readU8(0xA0000 + y * 320 + x);
    return 0;
  } else if (mode === 0x12 || mode === 0x10 || mode === 0x0E || mode === 0x0D) {
    const modeInfo = vga.currentMode;
    if (x >= modeInfo.width || y >= modeInfo.height) return 0;
    const bytesPerRow = modeInfo.width >> 3;
    const offset = y * bytesPerRow + (x >> 3);
    const bitPos = 7 - (x & 7);
    let color = 0;
    for (let p = 0; p < 4; p++) {
      color |= ((vga.planes[p][offset] >> bitPos) & 1) << p;
    }
    return color;
  } else if (mode === 0x11 || mode === 0x0F) {
    const modeInfo = vga.currentMode;
    if (x >= modeInfo.width || y >= modeInfo.height) return 0;
    const bytesPerRow = modeInfo.width >> 3;
    const offset = y * bytesPerRow + (x >> 3);
    const bitPos = 7 - (x & 7);
    return (vga.planes[0][offset] >> bitPos) & 1;
  } else if (mode === 0x06) {
    if (x >= 640 || y >= 200) return 0;
    const bank = (y & 1) ? 0x2000 : 0;
    const addr = 0xB8000 + bank + (y >> 1) * 80 + (x >> 3);
    return (emu.memory.readU8(addr) >> (7 - (x & 7))) & 1;
  } else if (mode === 0x04 || mode === 0x05) {
    if (x >= 320 || y >= 200) return 0;
    const bank = (y & 1) ? 0x2000 : 0;
    const addr = 0xB8000 + bank + (y >> 1) * 80 + (x >> 2);
    const shift = (3 - (x & 3)) * 2;
    return (emu.memory.readU8(addr) >> shift) & 3;
  }
  return 0;
}

// CP437 8x8 font for printable ASCII (chars 32-127), 8 bytes per char
// For chars outside this range, use blank
const VGA_FONT_8X8: Record<number, number[]> = {
  0x20: [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00],
  0x21: [0x18,0x3C,0x3C,0x18,0x18,0x00,0x18,0x00],
  0x22: [0x6C,0x6C,0x6C,0x00,0x00,0x00,0x00,0x00],
  0x23: [0x6C,0x6C,0xFE,0x6C,0xFE,0x6C,0x6C,0x00],
  0x24: [0x18,0x7E,0xC0,0x7C,0x06,0xFC,0x18,0x00],
  0x25: [0x00,0xC6,0xCC,0x18,0x30,0x66,0xC6,0x00],
  0x26: [0x38,0x6C,0x38,0x76,0xDC,0xCC,0x76,0x00],
  0x27: [0x18,0x18,0x30,0x00,0x00,0x00,0x00,0x00],
  0x28: [0x0C,0x18,0x30,0x30,0x30,0x18,0x0C,0x00],
  0x29: [0x30,0x18,0x0C,0x0C,0x0C,0x18,0x30,0x00],
  0x2A: [0x00,0x66,0x3C,0xFF,0x3C,0x66,0x00,0x00],
  0x2B: [0x00,0x18,0x18,0x7E,0x18,0x18,0x00,0x00],
  0x2C: [0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x30],
  0x2D: [0x00,0x00,0x00,0x7E,0x00,0x00,0x00,0x00],
  0x2E: [0x00,0x00,0x00,0x00,0x00,0x18,0x18,0x00],
  0x2F: [0x06,0x0C,0x18,0x30,0x60,0xC0,0x80,0x00],
  0x30: [0x7C,0xC6,0xCE,0xDE,0xF6,0xE6,0x7C,0x00],
  0x31: [0x18,0x38,0x78,0x18,0x18,0x18,0x7E,0x00],
  0x32: [0x7C,0xC6,0x06,0x1C,0x30,0x66,0xFE,0x00],
  0x33: [0x7C,0xC6,0x06,0x3C,0x06,0xC6,0x7C,0x00],
  0x34: [0x1C,0x3C,0x6C,0xCC,0xFE,0x0C,0x1E,0x00],
  0x35: [0xFE,0xC0,0xFC,0x06,0x06,0xC6,0x7C,0x00],
  0x36: [0x38,0x60,0xC0,0xFC,0xC6,0xC6,0x7C,0x00],
  0x37: [0xFE,0xC6,0x0C,0x18,0x30,0x30,0x30,0x00],
  0x38: [0x7C,0xC6,0xC6,0x7C,0xC6,0xC6,0x7C,0x00],
  0x39: [0x7C,0xC6,0xC6,0x7E,0x06,0x0C,0x78,0x00],
  0x3A: [0x00,0x18,0x18,0x00,0x00,0x18,0x18,0x00],
  0x3B: [0x00,0x18,0x18,0x00,0x00,0x18,0x18,0x30],
  0x3C: [0x0C,0x18,0x30,0x60,0x30,0x18,0x0C,0x00],
  0x3D: [0x00,0x00,0x7E,0x00,0x7E,0x00,0x00,0x00],
  0x3E: [0x60,0x30,0x18,0x0C,0x18,0x30,0x60,0x00],
  0x3F: [0x7C,0xC6,0x0C,0x18,0x18,0x00,0x18,0x00],
  0x40: [0x7C,0xC6,0xDE,0xDE,0xDE,0xC0,0x78,0x00],
  0x41: [0x38,0x6C,0xC6,0xFE,0xC6,0xC6,0xC6,0x00],
  0x42: [0xFC,0x66,0x66,0x7C,0x66,0x66,0xFC,0x00],
  0x43: [0x3C,0x66,0xC0,0xC0,0xC0,0x66,0x3C,0x00],
  0x44: [0xF8,0x6C,0x66,0x66,0x66,0x6C,0xF8,0x00],
  0x45: [0xFE,0x62,0x68,0x78,0x68,0x62,0xFE,0x00],
  0x46: [0xFE,0x62,0x68,0x78,0x68,0x60,0xF0,0x00],
  0x47: [0x3C,0x66,0xC0,0xC0,0xCE,0x66,0x3E,0x00],
  0x48: [0xC6,0xC6,0xC6,0xFE,0xC6,0xC6,0xC6,0x00],
  0x49: [0x3C,0x18,0x18,0x18,0x18,0x18,0x3C,0x00],
  0x4A: [0x1E,0x0C,0x0C,0x0C,0xCC,0xCC,0x78,0x00],
  0x4B: [0xE6,0x66,0x6C,0x78,0x6C,0x66,0xE6,0x00],
  0x4C: [0xF0,0x60,0x60,0x60,0x62,0x66,0xFE,0x00],
  0x4D: [0xC6,0xEE,0xFE,0xFE,0xD6,0xC6,0xC6,0x00],
  0x4E: [0xC6,0xE6,0xF6,0xDE,0xCE,0xC6,0xC6,0x00],
  0x4F: [0x7C,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00],
  0x50: [0xFC,0x66,0x66,0x7C,0x60,0x60,0xF0,0x00],
  0x51: [0x7C,0xC6,0xC6,0xC6,0xD6,0xDE,0x7C,0x06],
  0x52: [0xFC,0x66,0x66,0x7C,0x6C,0x66,0xE6,0x00],
  0x53: [0x7C,0xC6,0xE0,0x38,0x0E,0xC6,0x7C,0x00],
  0x54: [0x7E,0x7E,0x5A,0x18,0x18,0x18,0x3C,0x00],
  0x55: [0xC6,0xC6,0xC6,0xC6,0xC6,0xC6,0x7C,0x00],
  0x56: [0xC6,0xC6,0xC6,0xC6,0x6C,0x38,0x10,0x00],
  0x57: [0xC6,0xC6,0xC6,0xD6,0xFE,0xEE,0xC6,0x00],
  0x58: [0xC6,0xC6,0x6C,0x38,0x6C,0xC6,0xC6,0x00],
  0x59: [0x66,0x66,0x66,0x3C,0x18,0x18,0x3C,0x00],
  0x5A: [0xFE,0xC6,0x8C,0x18,0x32,0x66,0xFE,0x00],
  0x5B: [0x3C,0x30,0x30,0x30,0x30,0x30,0x3C,0x00],
  0x5C: [0xC0,0x60,0x30,0x18,0x0C,0x06,0x02,0x00],
  0x5D: [0x3C,0x0C,0x0C,0x0C,0x0C,0x0C,0x3C,0x00],
  0x5E: [0x10,0x38,0x6C,0xC6,0x00,0x00,0x00,0x00],
  0x5F: [0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xFF],
  0x60: [0x30,0x30,0x18,0x00,0x00,0x00,0x00,0x00],
  0x61: [0x00,0x00,0x78,0x0C,0x7C,0xCC,0x76,0x00],
  0x62: [0xE0,0x60,0x60,0x7C,0x66,0x66,0xDC,0x00],
  0x63: [0x00,0x00,0x7C,0xC6,0xC0,0xC6,0x7C,0x00],
  0x64: [0x1C,0x0C,0x0C,0x7C,0xCC,0xCC,0x76,0x00],
  0x65: [0x00,0x00,0x7C,0xC6,0xFE,0xC0,0x7C,0x00],
  0x66: [0x38,0x6C,0x60,0xF0,0x60,0x60,0xF0,0x00],
  0x67: [0x00,0x00,0x76,0xCC,0xCC,0x7C,0x0C,0xF8],
  0x68: [0xE0,0x60,0x6C,0x76,0x66,0x66,0xE6,0x00],
  0x69: [0x18,0x00,0x38,0x18,0x18,0x18,0x3C,0x00],
  0x6A: [0x06,0x00,0x06,0x06,0x06,0x66,0x66,0x3C],
  0x6B: [0xE0,0x60,0x66,0x6C,0x78,0x6C,0xE6,0x00],
  0x6C: [0x38,0x18,0x18,0x18,0x18,0x18,0x3C,0x00],
  0x6D: [0x00,0x00,0xEC,0xFE,0xD6,0xD6,0xC6,0x00],
  0x6E: [0x00,0x00,0xDC,0x66,0x66,0x66,0x66,0x00],
  0x6F: [0x00,0x00,0x7C,0xC6,0xC6,0xC6,0x7C,0x00],
  0x70: [0x00,0x00,0xDC,0x66,0x66,0x7C,0x60,0xF0],
  0x71: [0x00,0x00,0x76,0xCC,0xCC,0x7C,0x0C,0x1E],
  0x72: [0x00,0x00,0xDC,0x76,0x66,0x60,0xF0,0x00],
  0x73: [0x00,0x00,0x7C,0xC0,0x7C,0x06,0xFC,0x00],
  0x74: [0x10,0x30,0x7C,0x30,0x30,0x34,0x18,0x00],
  0x75: [0x00,0x00,0xCC,0xCC,0xCC,0xCC,0x76,0x00],
  0x76: [0x00,0x00,0xC6,0xC6,0xC6,0x6C,0x38,0x00],
  0x77: [0x00,0x00,0xC6,0xD6,0xFE,0xFE,0x6C,0x00],
  0x78: [0x00,0x00,0xC6,0x6C,0x38,0x6C,0xC6,0x00],
  0x79: [0x00,0x00,0xC6,0xC6,0xC6,0x7E,0x06,0xFC],
  0x7A: [0x00,0x00,0xFE,0xCC,0x18,0x32,0xFE,0x00],
  0x7B: [0x0E,0x18,0x18,0x70,0x18,0x18,0x0E,0x00],
  0x7C: [0x18,0x18,0x18,0x00,0x18,0x18,0x18,0x00],
  0x7D: [0x70,0x18,0x18,0x0E,0x18,0x18,0x70,0x00],
  0x7E: [0x76,0xDC,0x00,0x00,0x00,0x00,0x00,0x00],
};

function drawCharGraphics(cpu: CPU, emu: Emulator, ch: number, attr: number, x: number, y: number): void {
  const fontData = VGA_FONT_8X8[ch];
  if (!fontData) return; // no glyph → skip
  const fg = attr & 0x0F;
  const bg = (attr >> 4) & 0x0F;
  const charH = emu.charHeight || 8;
  for (let row = 0; row < Math.min(8, charH); row++) {
    const bits = fontData[row];
    for (let col = 0; col < 8; col++) {
      const px = x + col;
      const py = y + row;
      const isSet = (bits >> (7 - col)) & 1;
      putPixel(cpu, emu, px, py, isSet ? fg : bg, false);
    }
  }
}

// --- INT 10h: Video BIOS ---
export function handleInt10(cpu: CPU, emu: Emulator): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  const al = cpu.reg[EAX] & 0xFF;
  const cols = emu.screenCols;
  const rows = emu.screenRows;
  switch (ah) {
    case 0x00: // Set video mode
      setVideoMode(cpu, emu, al);
      break;

    case 0x01: { // Set cursor shape (CH=start scanline, CL=end scanline)
      let cursorStart = (cpu.reg[ECX] >> 8) & 0xFF;
      let cursorEnd = cpu.reg[ECX] & 0xFF;
      cpu.mem.writeU8(0x0461, cursorStart); // BDA cursor start (original values)
      cpu.mem.writeU8(0x0460, cursorEnd);   // BDA cursor end

      // VGA cursor size emulation: scale CGA/EGA cursor (8-line cell) to actual char height.
      // Programs like QBasic set cursor scanlines for 8-line cells (e.g. start=6, end=7).
      // On VGA with 16-line cells, the BIOS scales these to the bottom of the cell.
      // Enabled when BDA 0x0487 bit 0 = 0 (default).
      const cursorEmulationDisabled = (cpu.mem.readU8(0x0487) & 0x01) !== 0;
      if (!cursorEmulationDisabled && emu.charHeight > 8 && cursorStart <= cursorEnd && cursorEnd < 8) {
        const h = emu.charHeight;
        if (cursorStart <= 3) {
          // Block cursor (starts in top half): extend to bottom
          cursorEnd = h - 1;
          if (cursorStart === 3) cursorStart = h - 4;
        } else {
          // Underline cursor (starts in bottom half): shift to bottom of larger cell
          cursorStart = h + cursorStart - 8;
          cursorEnd = h + cursorEnd - 8;
          if (cursorEnd >= h) cursorEnd = h - 1;
        }
      }

      emu.vga.crtcRegs[0x0A] = cursorStart;
      emu.vga.crtcRegs[0x0B] = cursorEnd;
      break;
    }

    case 0x02: { // Set cursor position (BH=page, DH=row, DL=col)
      const page = (cpu.reg[EBX] >> 8) & 0xFF;
      const row = (cpu.reg[EDX] >> 8) & 0xFF;
      const col = cpu.reg[EDX] & 0xFF;
      // Update BDA cursor position for this page
      cpu.mem.writeU8(0x0450 + page * 2, col);
      cpu.mem.writeU8(0x0451 + page * 2, row);
      // Update emulator state for active page
      const activePage = cpu.mem.readU8(0x0462);
      if (page === activePage) {
        emu.consoleCursorY = Math.min(row, rows - 1);
        emu.consoleCursorX = Math.min(col, cols - 1);
        // Keep CRTC cursor registers in sync (programs may read them back)
        const cursorPos = emu.consoleCursorY * cols + emu.consoleCursorX;
        emu.vga.crtcRegs[0x0E] = (cursorPos >> 8) & 0xFF;
        emu.vga.crtcRegs[0x0F] = cursorPos & 0xFF;
      }
      break;
    }

    case 0x03: { // Get cursor position (BH=page) → DH=row, DL=col, CH=cursor start, CL=cursor end
      const page = (cpu.reg[EBX] >> 8) & 0xFF;
      const col = cpu.mem.readU8(0x0450 + page * 2);
      const row = cpu.mem.readU8(0x0451 + page * 2);
      cpu.setReg16(EDX, (row << 8) | col);
      const cursorEnd = cpu.mem.readU8(0x0460);
      const cursorStart = cpu.mem.readU8(0x0461);
      cpu.setReg16(ECX, (cursorStart << 8) | cursorEnd);
      break;
    }

    case 0x06: { // Scroll up
      const lines = al || rows;
      const attr = (cpu.reg[EBX] >> 8) & 0xFF;
      const top = (cpu.reg[ECX] >> 8) & 0xFF;
      const left = cpu.reg[ECX] & 0xFF;
      const bottom = (cpu.reg[EDX] >> 8) & 0xFF;
      const right = cpu.reg[EDX] & 0xFF;
      scrollUp(cpu, emu, lines, attr, top, left, bottom, right);
      break;
    }

    case 0x07: { // Scroll down
      const lines = al || rows;
      const attr = (cpu.reg[EBX] >> 8) & 0xFF;
      const top = (cpu.reg[ECX] >> 8) & 0xFF;
      const left = cpu.reg[ECX] & 0xFF;
      const bottom = (cpu.reg[EDX] >> 8) & 0xFF;
      const right = cpu.reg[EDX] & 0xFF;
      scrollDown(cpu, emu, lines, attr, top, left, bottom, right);
      break;
    }

    case 0x08: { // Read char+attr at cursor
      const off = (emu.consoleCursorY * cols + emu.consoleCursorX) * 2;
      const ch = cpu.mem.readU8(VIDEO_MEM_BASE + off);
      const attr = cpu.mem.readU8(VIDEO_MEM_BASE + off + 1);
      cpu.setReg16(EAX, (attr << 8) | ch);
      break;
    }

    case 0x09: { // Write char+attr at cursor
      const ch = al;
      const attr = cpu.reg[EBX] & 0xFF; // BL=attr in text mode, BL=color in graphics mode
      const count = cpu.getReg16(ECX);
      if (emu.isGraphicsMode) {
        // Graphics mode: draw character bitmaps
        let cx = emu.consoleCursorX;
        let cy = emu.consoleCursorY;
        for (let i = 0; i < count; i++) {
          drawCharGraphics(cpu, emu, ch, attr, cx * 8, cy * (emu.charHeight || 8));
          cx++;
          if (cx >= cols) { cx = 0; cy++; }
          if (cy >= rows) break;
        }
      } else {
        // Text mode
        let cx = emu.consoleCursorX;
        let cy = emu.consoleCursorY;
        for (let i = 0; i < count; i++) {
          const off = (cy * cols + cx) * 2;
          cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
          cpu.mem.writeU8(VIDEO_MEM_BASE + off + 1, attr);
          cx++;
          if (cx >= cols) { cx = 0; cy++; }
          if (cy >= rows) break;
        }
      }
      break;
    }

    case 0x0A: { // Write char at cursor (no attr change)
      const ch = al;
      const count = cpu.getReg16(ECX);
      if (emu.isGraphicsMode) {
        let cx = emu.consoleCursorX;
        let cy = emu.consoleCursorY;
        for (let i = 0; i < count; i++) {
          drawCharGraphics(cpu, emu, ch, 0x0F, cx * 8, cy * (emu.charHeight || 8)); // default white on black
          cx++;
          if (cx >= cols) { cx = 0; cy++; }
          if (cy >= rows) break;
        }
      } else {
        let cx = emu.consoleCursorX;
        let cy = emu.consoleCursorY;
        for (let i = 0; i < count; i++) {
          const off = (cy * cols + cx) * 2;
          cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
          cx++;
          if (cx >= cols) { cx = 0; cy++; }
          if (cy >= rows) break;
        }
      }
      break;
    }

    case 0x0C: { // Put pixel (BH=page, AL=color, CX=x, DX=y)
      const x = cpu.getReg16(ECX);
      const y = cpu.getReg16(EDX);
      const xorMode = !!(al & 0x80);
      let color = al & 0x7F;
      putPixel(cpu, emu, x, y, color, xorMode);
      break;
    }

    case 0x0D: { // Get pixel (BH=page, CX=x, DX=y) → AL=color
      const x = cpu.getReg16(ECX);
      const y = cpu.getReg16(EDX);
      cpu.setReg8(EAX, getPixel(cpu, emu, x, y));
      break;
    }

    case 0x0E: // Teletype output
      teletypeOutput(cpu, emu, al);
      break;

    case 0x0F: { // Get video mode → AH=cols, AL=mode, BH=page
      // Real VGA BIOS returns mode with bit 7 from BDA 0x0487 (no-clear flag)
      const noClearBit = cpu.mem.readU8(0x0487) & 0x80;
      cpu.setReg16(EAX, (cols << 8) | emu.videoMode | noClearBit);
      const activePage = cpu.mem.readU8(0x0462);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF00FF) | (activePage << 8);
      break;
    }

    case 0x10: { // Palette functions
      const vga = emu.vga;
      switch (al) {
        case 0x00: { // Set individual palette register (BL=register, BH=value)
          const regIdx = cpu.reg[EBX] & 0xFF; // BL
          const regVal = (cpu.reg[EBX] >> 8) & 0xFF; // BH
          if (regIdx < 16) {
            emu.vga.atcRegs[regIdx] = regVal;
          } else if (regIdx === 0x11) {
            emu.vga.atcRegs[0x11] = regVal; // Overscan
          }
          break;
        }
        case 0x01: { // Set overscan/border color (BH=color)
          emu.vga.atcRegs[0x11] = (cpu.reg[EBX] >> 8) & 0xFF;
          break;
        }
        case 0x02: { // Set all palette registers (ES:DX -> 17 bytes: 16 palette + overscan)
          const palSeg = cpu.segBase(cpu.es);
          const palOff = cpu.getReg16(EDX);
          for (let i = 0; i < 16; i++) {
            emu.vga.atcRegs[i] = cpu.mem.readU8(palSeg + palOff + i);
          }
          emu.vga.atcRegs[0x11] = cpu.mem.readU8(palSeg + palOff + 16); // Overscan
          break;
        }
        case 0x03: { // Toggle intensity/blinking bit (BL bit 0: 0=intensity, 1=blinking)
          const bl = cpu.reg[EBX] & 0xFF;
          const modeCtrl = emu.vga.atcRegs[0x10];
          if (bl & 1) {
            emu.vga.atcRegs[0x10] = modeCtrl | 0x08; // Enable blink
          } else {
            emu.vga.atcRegs[0x10] = modeCtrl & ~0x08; // Enable intensity
          }
          break;
        }
        case 0x07: { // Read individual palette register (BL=register) → BH=value
          const regIdx07 = cpu.reg[EBX] & 0xFF;
          const val07 = regIdx07 < 21 ? emu.vga.atcRegs[regIdx07] : 0;
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF00FF) | (val07 << 8);
          break;
        }
        case 0x08: { // Read overscan register → BH=value
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF00FF) | (emu.vga.atcRegs[0x11] << 8);
          break;
        }
        case 0x09: { // Read all palette registers (ES:DX -> buffer for 17 bytes)
          const dstSeg09 = cpu.segBase(cpu.es);
          const dstOff09 = cpu.getReg16(EDX);
          for (let i = 0; i < 16; i++) {
            cpu.mem.writeU8(dstSeg09 + dstOff09 + i, emu.vga.atcRegs[i]);
          }
          cpu.mem.writeU8(dstSeg09 + dstOff09 + 16, emu.vga.atcRegs[0x11]);
          break;
        }
        case 0x10: { // Set individual DAC register (BX=register, DH=green, CH=blue, CL=red)
          const reg = cpu.getReg16(EBX);
          vga.palette[reg * 3 + 0] = cpu.getReg8(ECX) & 0x3F; // CL=red
          vga.palette[reg * 3 + 1] = ((cpu.reg[EDX] >> 8) & 0xFF) & 0x3F; // DH=green
          vga.palette[reg * 3 + 2] = ((cpu.reg[ECX] >> 8) & 0xFF) & 0x3F; // CH=blue
          vga.dirty = true;
          break;
        }
        case 0x12: { // Set block of DAC registers (BX=first, CX=count, ES:DX -> RGB triples)
          const first = cpu.getReg16(EBX);
          const count = cpu.getReg16(ECX);
          const srcSeg = cpu.segBase(cpu.es);
          const srcOff = cpu.getReg16(EDX);
          for (let i = 0; i < count; i++) {
            const addr = srcSeg + srcOff + i * 3;
            vga.palette[(first + i) * 3 + 0] = cpu.mem.readU8(addr) & 0x3F;
            vga.palette[(first + i) * 3 + 1] = cpu.mem.readU8(addr + 1) & 0x3F;
            vga.palette[(first + i) * 3 + 2] = cpu.mem.readU8(addr + 2) & 0x3F;
          }
          vga.dirty = true;
          break;
        }
        case 0x15: { // Read individual DAC register (BL=register) → DH=green, CH=blue, CL=red
          const reg = cpu.getReg8(EBX); // BL
          const red = vga.palette[reg * 3 + 0];
          const green = vga.palette[reg * 3 + 1];
          const blue = vga.palette[reg * 3 + 2];
          cpu.setReg16(ECX, (blue << 8) | red); // CH=blue, CL=red
          cpu.setReg16(EDX, (green << 8) | (cpu.reg[EDX] & 0xFF)); // DH=green
          break;
        }
        case 0x17: { // Read block of DAC registers (BX=first, CX=count, ES:DX -> buffer)
          const first = cpu.getReg16(EBX);
          const count = cpu.getReg16(ECX);
          const dstSeg = cpu.segBase(cpu.es);
          const dstOff = cpu.getReg16(EDX);
          for (let i = 0; i < count; i++) {
            const addr = dstSeg + dstOff + i * 3;
            cpu.mem.writeU8(addr, vga.palette[(first + i) * 3 + 0]);
            cpu.mem.writeU8(addr + 1, vga.palette[(first + i) * 3 + 1]);
            cpu.mem.writeU8(addr + 2, vga.palette[(first + i) * 3 + 2]);
          }
          break;
        }
        case 0x13: { // Select color page
          const bl = cpu.reg[EBX] & 0xFF;
          const bh = (cpu.reg[EBX] >> 8) & 0xFF;
          if (bl === 0) {
            // 4 groups of 64: P54S=0, Color Select bits 3-2 = page
            vga.atcRegs[0x10] &= ~0x80;
            vga.atcRegs[0x14] = (vga.atcRegs[0x14] & 0x03) | ((bh & 0x03) << 2);
          } else {
            // 16 groups of 16: P54S=1, Color Select = page
            vga.atcRegs[0x10] |= 0x80;
            vga.atcRegs[0x14] = bh & 0x0F;
          }
          break;
        }
        case 0x1a: { // Read color-page state
          const p54s = !!(vga.atcRegs[0x10] & 0x80);
          let pageMode: number, currentPage: number;
          if (p54s) {
            pageMode = 1;
            currentPage = vga.atcRegs[0x14] & 0x0F;
          } else {
            pageMode = 0;
            currentPage = (vga.atcRegs[0x14] >> 2) & 0x03;
          }
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | (currentPage << 8) | pageMode;
          break;
        }
        case 0x1b: // Gray-scale summing — stub (ignore)
          break;
      }
      break;
    }

    case 0x11: { // Character generator
      if (al === 0x11 || al === 0x14) {
        // AL=11h: Load ROM mono 8x14 font
        // AL=14h: Load ROM 8x16 font
        // Both reset DAC palette to text-mode defaults (real VGA BIOS behavior)
        emu.vga.resetPalette();
      } else if (al === 0x12) {
        // Load 8x8 ROM font to page 0 — switch to 80x50 text mode
        emu.screenRows = 50;
        emu.charHeight = 8;
        emu.initConsoleBuffer();
        // Reinit video memory for 80x50
        for (let i = 0; i < cols * 50; i++) {
          cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2, 0x20);
          cpu.mem.writeU8(VIDEO_MEM_BASE + i * 2 + 1, 0x07);
        }
        // Update BDA
        cpu.mem.writeU8(0x0484, 49); // rows - 1
        cpu.mem.writeU16(0x0485, 8); // char height
        syncVideoMemory(emu);
        emu.vga.resetPalette();
      } else if (al === 0x30) {
        // Get font info: CX=bytes per char, DL=rows-1
        cpu.setReg16(ECX, emu.charHeight);
        const dl = emu.screenRows - 1;
        cpu.setReg16(EDX, (cpu.getReg16(EDX) & 0xFF00) | dl);
      } else if (al === 0x00 || al === 0x10) {
        // Load user 8x8 font — stub: just update char height in BDA
        const charHeight = (cpu.reg[EBX] >> 8) & 0xFF; // BH = bytes per character
        if (charHeight > 0) {
          emu.charHeight = charHeight;
          cpu.mem.writeU16(0x0485, charHeight);
        }
      } else if (al === 0x01 || al === 0x04 || al === 0x22 || al === 0x24) {
        // Load ROM 8x14 or 8x16 font — stub, resetPalette
        emu.vga.resetPalette();
      } else if (al === 0x02 || al === 0x23) {
        // Load ROM 8x8 font — stub
        // Don't change to 80x50 since this is just "load to block", not "recalc"
      } else if (al === 0x03) {
        // Set block specifier — stub
      } else if (al === 0x20 || al === 0x21) {
        // Set user graphics chars — stub
      }
      break;
    }

    case 0x12: { // Video subsystem config
      const bl12 = cpu.reg[EBX] & 0xFF;
      switch (bl12) {
        case 0x10: // Get EGA info
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0003; // BH=0 (color), BL=3 (256K)
          cpu.setReg16(ECX, 0x0009); // CH=0 (feature bits), CL=9 (VGA color switch settings)
          break;
        case 0x30: // Select vertical resolution (scan lines)
          // AL=0: 200, AL=1: 350, AL=2: 400
          cpu.setReg8(EAX, 0x12); // AL=12h means function supported
          break;
        case 0x33: // Gray-scale summing (BL=0: enable, BL=1: disable)
          cpu.setReg8(EAX, 0x12);
          break;
        case 0x34: // Cursor emulation
          cpu.setReg8(EAX, 0x12);
          break;
        case 0x36: // Video refresh control
          cpu.setReg8(EAX, 0x12);
          break;
        default:
          cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0003;
          cpu.setReg16(ECX, 0);
          break;
      }
      break;
    }

    case 0x1A: // Get/set display combination
      if (al === 0x00) {
        cpu.setReg8(EAX, 0x1A);
        cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0008;
      }
      break;

    case 0x05: // Select active display page
      break;

    case 0x1B: { // Functionality/state information
      const esBas = cpu.segBase(cpu.es);
      const di = cpu.getReg16(EDI);
      const addr = esBas + di;
      for (let i = 0; i < 64; i++) cpu.mem.writeU8(addr + i, 0);
      // Far pointer to Static Functionality Table at F000:0700
      cpu.mem.writeU16(addr + 0x00, 0x0700); // offset
      cpu.mem.writeU16(addr + 0x02, 0xF000); // segment
      cpu.mem.writeU8(addr + 0x04, emu.videoMode);
      cpu.mem.writeU16(addr + 0x05, cols);
      cpu.mem.writeU16(addr + 0x07, cols * rows * 2);
      cpu.mem.writeU8(addr + 0x0B, emu.consoleCursorX);
      cpu.mem.writeU8(addr + 0x0C, emu.consoleCursorY);
      cpu.mem.writeU16(addr + 0x23, 0x0607);
      cpu.mem.writeU8(addr + 0x25, 0);
      cpu.mem.writeU8(addr + 0x29, rows - 1);
      cpu.mem.writeU8(addr + 0x2A, emu.charHeight);
      cpu.mem.writeU8(addr + 0x2B, 0x08);
      // Additional state fields
      cpu.mem.writeU8(addr + 0x09, cols * rows * 2); // page length low (approximate)
      cpu.mem.writeU8(addr + 0x22, emu.charHeight); // char height
      cpu.mem.writeU8(addr + 0x27, emu.videoMode <= 0x03 ? 0x70 : 0x00); // default attribute for text
      cpu.mem.writeU8(addr + 0x2C, 0); // palette loading allowed
      cpu.mem.writeU8(addr + 0x31, 3); // 256K video memory
      cpu.mem.writeU8(addr + 0x33, 0x0F); // misc info flags
      cpu.setReg8(EAX, 0x1B);
      break;
    }

    case 0x21: {
      // UCDOS display driver — status query
      // Caller checks: CMP BX, 00C8h; JNE continue → BX=C8 is error
      // BX ≠ C8h means display driver is active/ready
      // AH=0 (returned status), BX = current display rows
      cpu.setReg16(EBX, 0x0019); // BX = 25 (rows), not 0xC8
      cpu.setReg8(EAX + 4, 0x00); // AH=0
      break;
    }

    case 0xFE: // Get video buffer
      break;

    default:
      break;
  }
  return true;
}
