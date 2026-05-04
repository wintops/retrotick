import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0, ECX = 1, EDX = 2, EBX = 3, ESI = 6, EDI = 7;

// INT 33h mouse event condition mask bits
const MOUSE_EVENT_MOVE     = 0x01;
const MOUSE_EVENT_LDOWN    = 0x02;
const MOUSE_EVENT_LUP      = 0x04;
const MOUSE_EVENT_RDOWN    = 0x08;
const MOUSE_EVENT_RUP      = 0x10;
const MOUSE_EVENT_MDOWN    = 0x20;
const MOUSE_EVENT_MUP      = 0x40;

// Default graphics cursor: 16x16 arrow (AND mask, then XOR mask)
// Each row is a 16-bit value, MSB = leftmost pixel
const DEFAULT_CURSOR_AND: Uint16Array = new Uint16Array([
  0x3FFF, 0x1FFF, 0x0FFF, 0x07FF, 0x03FF, 0x01FF, 0x00FF, 0x007F,
  0x003F, 0x001F, 0x01FF, 0x10FF, 0x30FF, 0xF87F, 0xF87F, 0xFC3F,
]);
const DEFAULT_CURSOR_XOR: Uint16Array = new Uint16Array([
  0x0000, 0x4000, 0x6000, 0x7000, 0x7800, 0x7C00, 0x7E00, 0x7F00,
  0x7F80, 0x7FC0, 0x7C00, 0x4600, 0x0600, 0x0300, 0x0300, 0x0000,
]);
const DEFAULT_CURSOR_HOTX = 0;
const DEFAULT_CURSOR_HOTY = 0;

/** DOS mouse driver state, stored on Emulator as `dosMouse` */
export interface DosMouseState {
  installed: boolean;
  x: number;           // virtual screen X (0..maxX)
  y: number;           // virtual screen Y (0..maxY)
  buttons: number;     // bit 0=left, bit 1=right, bit 2=middle
  maxX: number;        // horizontal range max (default 639)
  maxY: number;        // vertical range max (default 199 for mode 13h, etc.)
  minX: number;
  minY: number;
  cursorVisible: number; // hide counter: starts at -1 (hidden), show increments, hide decrements
  // Motion counters (mickeys) — reset on read
  mickeysX: number;
  mickeysY: number;
  // User callback
  callbackMask: number;  // event condition mask
  callbackSeg: number;
  callbackOff: number;
  // Pending callback events
  pendingCallbackMask: number;
  // Button press/release counters
  pressCount: [number, number, number];   // left, right, middle
  releaseCount: [number, number, number];
  pressX: [number, number, number];
  pressY: [number, number, number];
  releaseX: [number, number, number];
  releaseY: [number, number, number];
  // Sensitivity
  sensX: number;  // mickeys per 8 pixels (default 8)
  sensY: number;
  doubleThreshold: number;
  // Graphics cursor shape (16x16 AND/XOR masks + hotspot)
  cursorAnd: Uint16Array;
  cursorXor: Uint16Array;
  cursorHotX: number;
  cursorHotY: number;
}

export function createDosMouseState(): DosMouseState {
  return {
    installed: false,
    x: 0, y: 0,
    buttons: 0,
    maxX: 639, maxY: 199,
    minX: 0, minY: 0,
    cursorVisible: -1,
    mickeysX: 0, mickeysY: 0,
    callbackMask: 0, callbackSeg: 0, callbackOff: 0,
    pendingCallbackMask: 0,
    pressCount: [0, 0, 0],
    releaseCount: [0, 0, 0],
    pressX: [0, 0, 0],
    pressY: [0, 0, 0],
    releaseX: [0, 0, 0],
    releaseY: [0, 0, 0],
    sensX: 8, sensY: 16,
    doubleThreshold: 64,
    cursorAnd: Uint16Array.from(DEFAULT_CURSOR_AND),
    cursorXor: Uint16Array.from(DEFAULT_CURSOR_XOR),
    cursorHotX: DEFAULT_CURSOR_HOTX,
    cursorHotY: DEFAULT_CURSOR_HOTY,
  };
}

/**
 * Inject a browser mouse event into the DOS mouse state.
 * Called from ConsoleView when the user interacts with the DOS window.
 * @param emu - Emulator instance
 * @param px - pixel X in display space (0..displayW-1)
 * @param py - pixel Y in display space (0..displayH-1)
 * @param displayW - display width in pixels (e.g. 640)
 * @param displayH - display height in pixels (e.g. 480)
 * @param buttons - browser buttons bitmask (bit0=left, bit1=right, bit2=middle)
 * @param type - 'move' | 'down' | 'up'
 */
export function injectDosMouseEvent(
  emu: Emulator,
  px: number, py: number,
  displayW: number, displayH: number,
  buttons: number, type: 'move' | 'down' | 'up',
): void {
  const m = emu.dosMouse;
  if (!m.installed) return;

  // Map browser pixel coordinates directly to virtual coordinate scale
  const newX = Math.max(m.minX, Math.min(m.maxX, Math.round(px * m.maxX / (displayW - 1))));
  const newY = Math.max(m.minY, Math.min(m.maxY, Math.round(py * m.maxY / (displayH - 1))));

  let eventMask = 0;

  // Update mickeys (relative movement counters) and position
  if (newX !== m.x || newY !== m.y) {
    m.mickeysX += (newX - m.x);
    m.mickeysY += (newY - m.y);
    m.x = newX;
    m.y = newY;
    eventMask |= MOUSE_EVENT_MOVE;
  }

  applyButtonsAndCallback(emu, m, eventMask, buttons);
}


/** Shared: process button changes and queue callback */
function applyButtonsAndCallback(emu: Emulator, m: DosMouseState, eventMask: number, buttons: number): void {
  // Convert browser buttons (bit0=L, bit1=R, bit2=M) to DOS (bit0=L, bit1=R, bit2=M)
  const dosButtons = ((buttons & 1) ? 1 : 0) | ((buttons & 2) ? 2 : 0) | ((buttons & 4) ? 4 : 0);
  const changed = dosButtons ^ m.buttons;

  if (changed & 1) { // left
    if (dosButtons & 1) { eventMask |= MOUSE_EVENT_LDOWN; m.pressCount[0]++; m.pressX[0] = m.x; m.pressY[0] = m.y; }
    else { eventMask |= MOUSE_EVENT_LUP; m.releaseCount[0]++; m.releaseX[0] = m.x; m.releaseY[0] = m.y; }
  }
  if (changed & 2) { // right
    if (dosButtons & 2) { eventMask |= MOUSE_EVENT_RDOWN; m.pressCount[1]++; m.pressX[1] = m.x; m.pressY[1] = m.y; }
    else { eventMask |= MOUSE_EVENT_RUP; m.releaseCount[1]++; m.releaseX[1] = m.x; m.releaseY[1] = m.y; }
  }
  if (changed & 4) { // middle
    if (dosButtons & 4) { eventMask |= MOUSE_EVENT_MDOWN; m.pressCount[2]++; m.pressX[2] = m.x; m.pressY[2] = m.y; }
    else { eventMask |= MOUSE_EVENT_MUP; m.releaseCount[2]++; m.releaseX[2] = m.x; m.releaseY[2] = m.y; }
  }
  m.buttons = dosButtons;

  // Queue callback if mask matches
  if (eventMask && m.callbackMask && (eventMask & m.callbackMask)) {
    m.pendingCallbackMask |= (eventMask & m.callbackMask);
    // Wake CPU if halted/waiting
    if ((emu.waitingForMessage || emu._dosHalted) && emu.running && !emu.halted) {
      requestAnimationFrame(emu.tick);
    }
  }
}

/** Handle INT 33h — DOS Mouse Services */
export function handleInt33(cpu: CPU, emu: Emulator): boolean {
  const m = emu.dosMouse;
  const ax = cpu.getReg16(EAX);

  switch (ax) {
    case 0x0000: { // Reset/detect
      // Reset state
      m.x = 0; m.y = 0; m.buttons = 0;
      m.cursorVisible = -1;
      m.minX = 0; m.minY = 0;
      m.maxX = 639;
      // Default maxY based on video mode
      m.maxY = emu.isGraphicsMode ? (emu.videoMode === 0x13 ? 199 : 479) : 199;
      m.mickeysX = 0; m.mickeysY = 0;
      m.callbackMask = 0; m.callbackSeg = 0; m.callbackOff = 0;
      m.pendingCallbackMask = 0;
      m.pressCount = [0, 0, 0]; m.releaseCount = [0, 0, 0];
      m.pressX = [0, 0, 0]; m.pressY = [0, 0, 0];
      m.releaseX = [0, 0, 0]; m.releaseY = [0, 0, 0];
      m.sensX = 8; m.sensY = 16; m.doubleThreshold = 64;
      m.cursorAnd = Uint16Array.from(DEFAULT_CURSOR_AND);
      m.cursorXor = Uint16Array.from(DEFAULT_CURSOR_XOR);
      m.cursorHotX = DEFAULT_CURSOR_HOTX;
      m.cursorHotY = DEFAULT_CURSOR_HOTY;
      m.installed = true;
      cpu.setReg16(EAX, 0xFFFF); // mouse installed
      cpu.setReg16(EBX, 3);       // 3 buttons
      return true;
    }

    case 0x0001: // Show cursor
      m.cursorVisible++;
      return true;

    case 0x0002: // Hide cursor
      m.cursorVisible--;
      return true;

    case 0x0003: // Get position and button status
      cpu.setReg16(EBX, m.buttons);
      cpu.setReg16(ECX, m.x);
      cpu.setReg16(EDX, m.y);
      return true;

    case 0x0004: // Set position
      m.x = Math.max(m.minX, Math.min(m.maxX, cpu.getReg16(ECX)));
      m.y = Math.max(m.minY, Math.min(m.maxY, cpu.getReg16(EDX)));
      return true;

    case 0x0005: { // Get button press info
      const btn = cpu.getReg16(EBX) & 3;
      cpu.setReg16(EAX, m.buttons);
      cpu.setReg16(EBX, m.pressCount[btn]);
      cpu.setReg16(ECX, m.pressX[btn]);
      cpu.setReg16(EDX, m.pressY[btn]);
      m.pressCount[btn] = 0;
      return true;
    }

    case 0x0006: { // Get button release info
      const btn = cpu.getReg16(EBX) & 3;
      cpu.setReg16(EAX, m.buttons);
      cpu.setReg16(EBX, m.releaseCount[btn]);
      cpu.setReg16(ECX, m.releaseX[btn]);
      cpu.setReg16(EDX, m.releaseY[btn]);
      m.releaseCount[btn] = 0;
      return true;
    }

    case 0x0007: // Set horizontal range
      m.minX = cpu.getReg16(ECX);
      m.maxX = cpu.getReg16(EDX);
      m.x = Math.max(m.minX, Math.min(m.maxX, m.x));
      return true;

    case 0x0008: // Set vertical range
      m.minY = cpu.getReg16(ECX);
      m.maxY = cpu.getReg16(EDX);
      m.y = Math.max(m.minY, Math.min(m.maxY, m.y));
      return true;

    case 0x0009: { // Set graphics cursor shape
      m.cursorHotX = cpu.getReg16(EBX); // BX = hot spot column
      m.cursorHotY = cpu.getReg16(ECX); // CX = hot spot row
      // ES:DX → pointer to 32 words: 16 AND mask rows, then 16 XOR mask rows
      const maskAddr = cpu.segBase(cpu.es) + cpu.getReg16(EDX);
      for (let i = 0; i < 16; i++) {
        m.cursorAnd[i] = emu.memory.readU16(maskAddr + i * 2);
        m.cursorXor[i] = emu.memory.readU16(maskAddr + 32 + i * 2);
      }
      return true;
    }

    case 0x000A: // Set text cursor type (stub)
      return true;

    case 0x000B: // Read motion counters (mickeys)
      cpu.setReg16(ECX, m.mickeysX & 0xFFFF);
      cpu.setReg16(EDX, m.mickeysY & 0xFFFF);
      m.mickeysX = 0;
      m.mickeysY = 0;
      return true;

    case 0x000C: { // Set user callback
      m.callbackMask = cpu.getReg16(ECX);
      m.callbackSeg = cpu.es;
      m.callbackOff = cpu.getReg16(EDX);
      return true;
    }

    case 0x000F: // Set mickey/pixel ratio
      m.sensX = cpu.getReg16(ECX) || 8;
      m.sensY = cpu.getReg16(EDX) || 16;
      return true;

    case 0x0010: // Set exclusive area (stub — ignore)
      return true;

    case 0x0013: // Set double-speed threshold
      m.doubleThreshold = cpu.getReg16(EDX);
      return true;

    case 0x0014: { // Swap user callback (exchange)
      const oldMask = m.callbackMask;
      const oldSeg = m.callbackSeg;
      const oldOff = m.callbackOff;
      m.callbackMask = cpu.getReg16(ECX);
      m.callbackSeg = cpu.es;
      m.callbackOff = cpu.getReg16(EDX);
      cpu.setReg16(ECX, oldMask);
      cpu.es = oldSeg;
      cpu.setReg16(EDX, oldOff);
      return true;
    }

    case 0x0015: // Get driver storage requirements
      cpu.setReg16(EBX, 0); // 0 bytes needed (we keep state in JS)
      return true;

    case 0x001A: // Set sensitivity
      m.sensX = cpu.getReg16(EBX) || 8;
      m.sensY = cpu.getReg16(ECX) || 16;
      m.doubleThreshold = cpu.getReg16(EDX);
      return true;

    case 0x001B: // Get sensitivity
      cpu.setReg16(EBX, m.sensX);
      cpu.setReg16(ECX, m.sensY);
      cpu.setReg16(EDX, m.doubleThreshold);
      return true;

    case 0x001F: // Disable mouse driver
      cpu.setReg16(EAX, 0x001F);
      cpu.es = 0;
      cpu.setReg16(EBX, 0);
      return true;

    case 0x0020: // Enable mouse driver
      return true;

    case 0x0021: // Software reset
      cpu.setReg16(EAX, 0xFFFF);
      cpu.setReg16(EBX, 3);
      return true;

    case 0x0024: // Get driver info
      cpu.setReg16(EBX, 0x0800); // version 8.0
      cpu.setReg8(ECX, 2);       // IRQ type: PS/2
      cpu.setReg8(EDX, 0);       // no IRQ
      return true;

    default:
      // Unknown subfunctions — silently ignore
      return true;
  }
}

/**
 * Update mouse coordinate range when the video mode changes.
 * Real DOS mouse drivers hook INT 10h and auto-adjust.
 */
export function updateMouseRangeForMode(emu: Emulator): void {
  const m = emu.dosMouse;
  if (!m.installed) return;
  const prevMaxY = m.maxY;
  m.maxX = 639;
  m.maxY = emu.isGraphicsMode ? (emu.videoMode === 0x13 ? 199 : 479) : 199;
  // Clamp current position to new range
  m.x = Math.max(m.minX, Math.min(m.maxX, m.x));
  if (prevMaxY !== m.maxY) {
    m.y = Math.max(m.minY, Math.min(m.maxY, m.y));
  }
}

/**
 * Draw the graphics-mode mouse cursor onto a canvas context.
 * Called after the framebuffer is rendered so the cursor overlays the image
 * without modifying the actual VRAM framebuffer data.
 *
 * @param ctx - Canvas 2D context at native resolution (e.g. 320x200)
 * @param emu - Emulator instance
 */
export function drawGfxMouseCursor(ctx: CanvasRenderingContext2D, emu: Emulator): void {
  const m = emu.dosMouse;
  if (!m.installed || m.cursorVisible < 0 || !emu.isGraphicsMode) return;

  const fb = emu.vga.framebuffer;
  if (!fb) return;
  const screenW = fb.width;
  const screenH = fb.height;

  // Convert virtual mouse coordinates to pixel coordinates
  const pixelX = Math.round(m.x * (screenW - 1) / m.maxX) - m.cursorHotX;
  const pixelY = Math.round(m.y * (screenH - 1) / m.maxY) - m.cursorHotY;

  // Clip cursor region to screen bounds
  const x0 = Math.max(0, pixelX);
  const y0 = Math.max(0, pixelY);
  const x1 = Math.min(screenW, pixelX + 16);
  const y1 = Math.min(screenH, pixelY + 16);
  if (x0 >= x1 || y0 >= y1) return;

  // Read existing pixels under cursor area
  const region = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const data = region.data;

  for (let cy = y0; cy < y1; cy++) {
    const row = cy - pixelY;
    const andRow = m.cursorAnd[row];
    const xorRow = m.cursorXor[row];
    for (let cx = x0; cx < x1; cx++) {
      const col = cx - pixelX;
      const bit = 0x8000 >>> col;
      const andBit = andRow & bit;
      const xorBit = xorRow & bit;
      const idx = ((cy - y0) * (x1 - x0) + (cx - x0)) * 4;
      if (!andBit && !xorBit) {
        // Black (cursor outline)
        data[idx] = 0; data[idx + 1] = 0; data[idx + 2] = 0; data[idx + 3] = 255;
      } else if (!andBit && xorBit) {
        // White (cursor fill)
        data[idx] = 255; data[idx + 1] = 255; data[idx + 2] = 255; data[idx + 3] = 255;
      } else if (andBit && xorBit) {
        // XOR: invert existing pixel
        data[idx] = 255 - data[idx];
        data[idx + 1] = 255 - data[idx + 1];
        data[idx + 2] = 255 - data[idx + 2];
      }
      // andBit && !xorBit: transparent — leave unchanged
    }
  }

  ctx.putImageData(region, x0, y0);
}

/**
 * Dispatch pending mouse callback (called from tick loop in emu-exec.ts).
 * Returns true if a callback was dispatched (caller should continue tick loop).
 *
 * The real DOS mouse driver saves all registers before calling the user callback
 * and restores them after RETF. We emulate this by pushing all regs + DS/ES
 * onto the stack, then a small trampoline that pops them after RETF.
 * Since we can't inject code, we save registers in JS and restore on RETF detect.
 */
// Mouse callback return trampoline location (written in emu-load.ts)
const MOUSE_TRAMP_SEG = 0xF000;
const MOUSE_TRAMP_OFF = 0x0500;

export function dispatchMouseCallback(emu: Emulator): boolean {
  const m = emu.dosMouse;
  if (!m.pendingCallbackMask || !m.callbackMask || !m.callbackSeg) return false;
  // The callback seg:off stored via INT 33h AX=0Ch is a real-mode pair.
  // In protected mode the raw `cpu.cs = seg; cpu.eip = segBase(seg)+off`
  // below would load a value that is not a valid GDT selector and derail
  // the DPMI client. DPMI-aware programs should use INT 31h AX=0303 to
  // bridge RM events into PM; we can't reflect a plain INT 33h callback
  // from PM without a full mode-switch trampoline.
  if (!emu.cpu.realMode) return false;
  // Don't dispatch if a hardware interrupt handler or another callback is active
  if (emu._hwIntSavedSP >= 0) return false;
  if (emu._mouseCallbackSavedSP >= 0) return false;

  const mask = m.pendingCallbackMask;
  m.pendingCallbackMask = 0;

  const seg = m.callbackSeg;
  const off = m.callbackOff;
  const returnCS = emu.cpu.cs;
  const returnIP = (emu.cpu.eip - emu.cpu.segBase(emu.cpu.cs)) & 0xFFFF;

  // Save SP to prevent nested dispatches (cleared when SP returns)
  emu._mouseCallbackSavedSP = emu.cpu.reg[4] & 0xFFFF;

  // Build a complete stack frame so the x86 trampoline at F000:0500
  // restores ALL registers and returns to the interrupted code via IRET.
  // Push order must match the trampoline's POP order (IRET first, then regs).

  // 1) Interrupted context for IRET (trampoline pops last)
  emu.cpu.push16(emu.cpu.getFlags() & 0xFFFF);
  emu.cpu.push16(returnCS);
  emu.cpu.push16(returnIP);

  // 2) All GP registers + segment regs (trampoline POPs in this order:
  //    AX, BX, CX, DX, BP, SI, DI, DS, ES — so push in reverse)
  emu.cpu.push16(emu.cpu.getReg16(EAX));
  emu.cpu.push16(emu.cpu.getReg16(EBX));
  emu.cpu.push16(emu.cpu.getReg16(ECX));
  emu.cpu.push16(emu.cpu.getReg16(EDX));
  emu.cpu.push16(emu.cpu.reg[5] & 0xFFFF); // BP
  emu.cpu.push16(emu.cpu.getReg16(ESI));
  emu.cpu.push16(emu.cpu.getReg16(EDI));
  emu.cpu.push16(emu.cpu.ds);
  emu.cpu.push16(emu.cpu.es);

  // 3) Trampoline return address for callback's RETF
  emu.cpu.push16(MOUSE_TRAMP_SEG);
  emu.cpu.push16(MOUSE_TRAMP_OFF);

  // Set callback parameters per INT 33h convention:
  //   AX = event condition mask, BX = button state,
  //   CX = cursor X, DX = cursor Y, SI = mickeysX, DI = mickeysY
  emu.cpu.setReg16(EAX, mask);
  emu.cpu.setReg16(EBX, m.buttons);
  emu.cpu.setReg16(ECX, m.x);
  emu.cpu.setReg16(EDX, m.y);
  emu.cpu.setReg16(ESI, m.mickeysX & 0xFFFF);
  emu.cpu.setReg16(EDI, m.mickeysY & 0xFFFF);

  // Jump to callback
  emu.cpu.cs = seg;
  emu.cpu.eip = emu.cpu.segBase(seg) + off;

  return true;
}
