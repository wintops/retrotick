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

  if (vgaMode.isText) {
    if (!noClear) {
      emu.initConsoleBuffer();
      clearVideoMem(cpu, emu, 0x07);
    }
    emu.consoleCursorX = 0;
    emu.consoleCursorY = 0;
  } else {
    // Graphics mode
    if (mode === 0x13) {
      // Mode 13h: 320x200, 256 colors, linear at A0000
      if (!noClear) {
        for (let i = 0; i < 64000; i++) {
          cpu.mem.writeU8(0xA0000 + i, 0);
        }
      }
      emu.vga.currentMode = vgaMode;
      emu.vga.initFramebuffer(320, 200);
    }
    // Other graphics modes: stub — just record the mode
    emu.vga.currentMode = vgaMode;
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

    case 0x01: // Set cursor shape
      break;

    case 0x02: { // Set cursor position
      const row = (cpu.reg[EDX] >> 8) & 0xFF;
      const col = cpu.reg[EDX] & 0xFF;
      emu.consoleCursorY = Math.min(row, rows - 1);
      emu.consoleCursorX = Math.min(col, cols - 1);
      break;
    }

    case 0x03: { // Get cursor position
      const row = emu.consoleCursorY;
      const col = emu.consoleCursorX;
      cpu.setReg16(EDX, (row << 8) | col);
      cpu.setReg16(ECX, 0x0607);
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
      const attr = cpu.reg[EBX] & 0xFF;
      const count = cpu.getReg16(ECX);
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
      break;
    }

    case 0x0A: { // Write char at cursor (no attr change)
      const ch = al;
      const count = cpu.getReg16(ECX);
      let cx = emu.consoleCursorX;
      let cy = emu.consoleCursorY;
      for (let i = 0; i < count; i++) {
        const off = (cy * cols + cx) * 2;
        cpu.mem.writeU8(VIDEO_MEM_BASE + off, ch);
        cx++;
        if (cx >= cols) { cx = 0; cy++; }
        if (cy >= rows) break;
      }
      break;
    }

    case 0x0C: { // Put pixel (BH=page, AL=color, CX=x, DX=y)
      if (emu.videoMode === 0x13) {
        const x = cpu.getReg16(ECX);
        const y = cpu.getReg16(EDX);
        if (x < 320 && y < 200) {
          let color = al;
          if (color & 0x80) {
            // XOR mode
            color = (cpu.mem.readU8(0xA0000 + y * 320 + x) ^ color) & 0x7F;
          }
          cpu.mem.writeU8(0xA0000 + y * 320 + x, color);
        }
      }
      break;
    }

    case 0x0D: { // Get pixel (BH=page, CX=x, DX=y) → AL=color
      if (emu.videoMode === 0x13) {
        const x = cpu.getReg16(ECX);
        const y = cpu.getReg16(EDX);
        if (x < 320 && y < 200) {
          cpu.setReg8(EAX, cpu.mem.readU8(0xA0000 + y * 320 + x));
        } else {
          cpu.setReg8(EAX, 0);
        }
      }
      break;
    }

    case 0x0E: // Teletype output
      teletypeOutput(cpu, emu, al);
      break;

    case 0x0F: // Get video mode → AH=cols, AL=mode, BH=page
      cpu.setReg16(EAX, (cols << 8) | emu.videoMode);
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF00FF); // BH=0
      break;

    case 0x10: { // Palette functions
      const vga = emu.vga;
      switch (al) {
        case 0x00: // Set individual palette register (BL=register, BH=value)
          // For DAC, map the 16 EGA palette entries
          break;
        case 0x02: // Set all palette registers (ES:DX -> 17 bytes)
          break;
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
        case 0x15: { // Read block of DAC registers (BX=first, CX=count, ES:DX -> buffer)
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
        case 0x17: { // Read individual DAC register (BL=register) → DH=green, CH=blue, CL=red
          const reg = cpu.getReg8(EBX); // BL
          cpu.setReg8(ECX, vga.palette[reg * 3 + 0]); // CL=red
          cpu.setReg16(ECX, (vga.palette[reg * 3 + 2] << 8) | vga.palette[reg * 3 + 0]); // CH=blue, CL=red
          cpu.setReg16(EDX, (vga.palette[reg * 3 + 1] << 8) | (cpu.reg[EDX] & 0xFF)); // DH=green
          break;
        }
      }
      break;
    }

    case 0x11: { // Character generator
      if (al === 0x12) {
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
      } else if (al === 0x30) {
        // Get font info: CX=bytes per char, DL=rows-1
        cpu.setReg16(ECX, emu.charHeight);
        const dl = emu.screenRows - 1;
        cpu.setReg16(EDX, (cpu.getReg16(EDX) & 0xFF00) | dl);
      }
      break;
    }

    case 0x12: // Video subsystem config
      cpu.reg[EBX] = (cpu.reg[EBX] & 0xFFFF0000) | 0x0003;
      cpu.setReg16(ECX, 0);
      break;

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
      cpu.mem.writeU32(addr + 0x00, 0);
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
      cpu.setReg8(EAX, 0x1B);
      break;
    }

    case 0xFE: // Get video buffer
      break;

    default:
      break;
  }
  return true;
}
