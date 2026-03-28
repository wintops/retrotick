import type { CPU } from '../x86/cpu';
import type { Emulator } from '../emulator';

const EAX = 0;
const ZF = 0x040;
const CF = 0x001;
const BDA = 0x400;

// --- INT 09h: Keyboard Hardware (BIOS default handler) ---
// Scancode-to-ASCII table for unshifted keys (index = scancode 0x00-0x3F)
const SCAN_TO_ASCII: (number | undefined)[] = [
  /*00*/ undefined, 0x1B, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,  // ESC, 1-6
  /*08*/ 0x37, 0x38, 0x39, 0x30, 0x2D, 0x3D, 0x08, 0x09,       // 7-0, -, =, BS, TAB
  /*10*/ 0x71, 0x77, 0x65, 0x72, 0x74, 0x79, 0x75, 0x69,       // q w e r t y u i
  /*18*/ 0x6F, 0x70, 0x5B, 0x5D, 0x0D, undefined, 0x61, 0x73,  // o p [ ] Enter, Ctrl, a s
  /*20*/ 0x64, 0x66, 0x67, 0x68, 0x6A, 0x6B, 0x6C, 0x3B,       // d f g h j k l ;
  /*28*/ 0x27, 0x60, undefined, 0x5C, 0x7A, 0x78, 0x63, 0x76,  // ' `, LShift, \ z x c v
  /*30*/ 0x62, 0x6E, 0x6D, 0x2C, 0x2E, 0x2F, undefined, 0x2A,  // b n m , . /, RShift, *
  /*38*/ undefined, 0x20, undefined,                              // Alt, Space, CapsLock
  // F1-F10 (0x3B-0x44): extended keys, ascii=0
  undefined, undefined, undefined, undefined, undefined,
];

// Extended key scancodes (arrows, F-keys, Home, End, etc.) — always ascii=0
const EXTENDED_SCANCODES = new Set([
  0x3B, 0x3C, 0x3D, 0x3E, 0x3F, 0x40, 0x41, 0x42, 0x43, 0x44, // F1-F10
  0x47, 0x48, 0x49, // Home, Up, PgUp
  0x4B, 0x4D,       // Left, Right
  0x4F, 0x50, 0x51, // End, Down, PgDn
  0x52, 0x53,       // Ins, Del
  0x57, 0x58,       // F11, F12
]);

function runInt15KeyboardIntercept(cpu: CPU, emu: Emulator, scancode: number): { scancode: number; discard: boolean } {
  const intNum = 0x15;
  const biosDefault = emu._dosBiosDefaultVectors.get(intNum) ?? ((0xF000 << 16) | (intNum * 5));
  // Check both _dosIntVectors and IVT memory (programs may write vectors directly)
  const ivtOff = cpu.mem.readU16(intNum * 4);
  const ivtSeg = cpu.mem.readU16(intNum * 4 + 2);
  const ivtVec = (ivtSeg << 16) | ivtOff;
  const vec = (ivtVec !== biosDefault && ivtSeg !== 0xF000)
    ? ivtVec
    : (emu._dosIntVectors.get(intNum) ?? biosDefault);
  if (vec === biosDefault) return { scancode, discard: false };

  const returnCS = cpu.cs;
  const returnIP = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;

  cpu.setReg8(EAX + 4, 0x4F); // AH
  cpu.setReg8(EAX, scancode & 0xFF); // AL
  cpu.push16(cpu.getFlags() & 0xFFFF);
  cpu.push16(returnCS);
  cpu.push16(returnIP);
  cpu.setFlags(cpu.getFlags() & ~0x0300); // clear IF+TF on interrupt entry
  cpu.cs = (vec >>> 16) & 0xFFFF;
  cpu.eip = cpu.segBase(cpu.cs) + (vec & 0xFFFF);

  let returned = false;
  for (let i = 0; i < 100000; i++) {
    cpu.step();
    if (cpu.halted) break;
    const ip16 = (cpu.eip - cpu.segBase(cpu.cs)) & 0xFFFF;
    if (cpu.cs === returnCS && ip16 === returnIP) {
      returned = true;
      break;
    }
  }
  if (!returned) {
    return { scancode, discard: false };
  }
  const discard = (cpu.getFlags() & CF) !== 0;
  return { scancode: cpu.getReg8(EAX), discard };
}

export function handleInt09(cpu: CPU, emu: Emulator, scancodeOverride?: number): boolean {
  // Save all CPU registers — real BIOS INT 09h preserves them.
  // This is critical because runInt15KeyboardIntercept runs a step loop
  // that may modify any register (game's INT 15h handler could trash DS/ES/etc).
  const savedRegs = [cpu.reg[0], cpu.reg[1], cpu.reg[2], cpu.reg[3],
                     cpu.reg[4], cpu.reg[5], cpu.reg[6], cpu.reg[7]];
  const savedDS = cpu.ds;
  const savedES = cpu.es;
  const savedFlags = cpu.getFlags();

  let scancode = scancodeOverride ?? emu.portIn(0x60);
  // Acknowledge keyboard controller and PIC like real BIOS INT 09h.
  const p61 = emu.portIn(0x61);
  emu.portOut(0x61, p61 | 0x80);
  emu.portOut(0x61, p61);
  emu.portOut(0x20, 0x20);
  // AT BIOS path: offer scancode to INT 15h/AH=4F hook before normal processing.
  // Hook may translate AL or discard event via CF=1.
  const int15Result = runInt15KeyboardIntercept(cpu, emu, scancode);
  scancode = int15Result.scancode & 0xFF;
  if (int15Result.discard) {
    // Restore registers before returning
    for (let i = 0; i < 8; i++) cpu.reg[i] = savedRegs[i];
    cpu.ds = savedDS;
    cpu.es = savedES;
    cpu.setFlags(savedFlags);
    return true;
  }

  const shiftFlags = emu.memory.readU8(BDA + 0x17);

  // 0xE0 is the extended key prefix — acknowledge it without storing a key
  if (scancode === 0xE0) {
    emu._kbdE0Prefix = true;
    return true;
  }

  if (scancode & 0x80) {
    emu._kbdE0Prefix = false;
    // Break code — update shift state for modifier releases
    const baseScan = scancode & 0x7F;
    if (baseScan === 0x2A || baseScan === 0x36) // LShift/RShift release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x03);
    else if (baseScan === 0x1D) // Ctrl release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x04);
    else if (baseScan === 0x38) // Alt release
      emu.memory.writeU8(BDA + 0x17, shiftFlags & ~0x08);
    return true;
  }

  // Make code — update shift state for modifier presses
  if (scancode === 0x2A || scancode === 0x36) { // LShift/RShift
    emu.memory.writeU8(BDA + 0x17, shiftFlags | (scancode === 0x2A ? 0x02 : 0x01));
    return true;
  }
  if (scancode === 0x1D) { // Ctrl
    emu.memory.writeU8(BDA + 0x17, shiftFlags | 0x04);
    return true;
  }
  if (scancode === 0x38) { // Alt
    emu.memory.writeU8(BDA + 0x17, shiftFlags | 0x08);
    return true;
  }

  // Determine ASCII based on scancode and modifiers
  let ascii: number;
  const hasE0Prefix = emu._kbdE0Prefix;
  emu._kbdE0Prefix = false;
  const isAlt = !!(shiftFlags & 0x08);
  const isCtrl = !!(shiftFlags & 0x04);

  if (hasE0Prefix) {
    // Enhanced keyboard E0-prefixed make code.
    // Most E0 keys produce ascii=0xE0 (navigation: Home, Up, etc.).
    // NumpadEnter (E0 1C) and NumpadDivide (E0 35) are exceptions —
    // they produce the same ASCII as their main-keyboard equivalents.
    if (scancode === 0x1C) {
      ascii = 0x0D; // NumpadEnter → carriage return
    } else if (emu._currentHwKeyChar !== undefined) {
      ascii = emu._currentHwKeyChar; // NumpadDivide → '/'
    } else {
      ascii = 0xE0;
    }
  } else if (isAlt) {
    ascii = 0; // Alt+key always produces ascii=0
  } else if (isCtrl && scancode >= 0x1E && scancode <= 0x32) {
    // Ctrl+letter: ASCII 1-26
    const ctrlBase = SCAN_TO_ASCII[scancode];
    ascii = ctrlBase ? (ctrlBase - 0x60) & 0x1F : 0;
  } else if (emu._currentHwKeyChar !== undefined) {
    // Use browser-provided ASCII (layout-aware). This must be checked BEFORE
    // EXTENDED_SCANCODES because numpad digits share scancodes with navigation
    // keys (e.g. Numpad7 = 0x47 = Home). When NumLock is on, the browser
    // provides the digit as browserChar and we must use it.
    ascii = emu._currentHwKeyChar;
  } else if (EXTENDED_SCANCODES.has(scancode)) {
    ascii = 0; // Extended key without browserChar (NumLock off → navigation)
  } else {
    ascii = (scancode < SCAN_TO_ASCII.length ? SCAN_TO_ASCII[scancode] : undefined) ?? 0;
  }

  // Cap software key buffer to prevent overflow from key repeat
  if (emu.dosKeyBuffer.length < 32) {
    emu.dosKeyBuffer.push({ ascii, scan: scancode });
  }
  emu.writeBdaKey(ascii, scancode);

  // Restore all registers — BIOS INT 09h is transparent to caller
  for (let i = 0; i < 8; i++) cpu.reg[i] = savedRegs[i];
  cpu.ds = savedDS;
  cpu.es = savedES;
  cpu.setFlags(savedFlags);
  return true;
}

function bdaLayout(emu: Emulator): { start: number; end: number; head: number; tail: number } {
  const start = emu.memory.readU16(BDA + 0x80) || 0x1E;
  const end = emu.memory.readU16(BDA + 0x82) || 0x3E;
  const head = emu.memory.readU16(BDA + 0x1A);
  const tail = emu.memory.readU16(BDA + 0x1C);
  return { start, end, head, tail };
}

function bdaPeekKey(emu: Emulator): { ascii: number; scan: number } | null {
  const { head, tail } = bdaLayout(emu);
  if (head === tail) return null;
  const word = emu.memory.readU16(BDA + head);
  return { ascii: word & 0xFF, scan: (word >>> 8) & 0xFF };
}

function bdaPopKey(emu: Emulator): { ascii: number; scan: number } | null {
  const { start, end, head, tail } = bdaLayout(emu);
  if (head === tail) return null;
  const word = emu.memory.readU16(BDA + head);
  let newHead = head + 2;
  if (newHead >= end) newHead = start;
  emu.memory.writeU16(BDA + 0x1A, newHead);
  return { ascii: word & 0xFF, scan: (word >>> 8) & 0xFF };
}

// --- INT 16h: Keyboard BIOS ---
export function handleInt16(cpu: CPU, emu: Emulator, fromBiosStub = false): boolean {
  const ah = (cpu.reg[EAX] >> 8) & 0xFF;
  switch (ah) {
    case 0x00: case 0x10: {
      // Read keystroke (blocking on real hardware).
      const key = bdaPopKey(emu);
      if (key) {
        if (emu.dosKeyBuffer.length > 0) emu.dosKeyBuffer.shift();
        const ascii = (ah === 0x00 && key.ascii === 0xE0) ? 0 : key.ascii;
        cpu.setReg16(EAX, (key.scan << 8) | ascii);
      } else if (emu.isDOS) {
        // No key available: rewind to INT 16h instruction and halt.
        // _dosHalted allows timer interrupts to keep firing (music, animation)
        // while waiting for keyboard input, unlike waitingForMessage which
        // stops everything.
        cpu.eip -= 2;
        emu._dosHalted = true;
        return true; // handled, but will re-execute
      } else {
        // Win16/Win32: block until key available
        emu._dosWaitingForKey = 'read';
        emu.waitingForMessage = true;
      }
      break;
    }
    case 0x01: case 0x11: {
      // Check keystroke (non-blocking peek)
      const key = bdaPeekKey(emu);
      if (key) {
        const ascii = (ah === 0x01 && key.ascii === 0xE0) ? 0 : key.ascii;
        cpu.setReg16(EAX, (key.scan << 8) | ascii);
        cpu.setFlag(ZF, false); // key available
      } else {
        cpu.setFlag(ZF, true); // no key
      }
      break;
    }
    case 0x02: case 0x12: {
      // Get shift flags from BDA (40:17 basic, 40:18 extended).
      const basic = emu.memory.readU8(BDA + 0x17);
      const ext = emu.memory.readU8(BDA + 0x18);
      if (ah === 0x02) {
        cpu.setReg8(EAX, basic);
      } else {
        cpu.setReg16(EAX, (ext << 8) | basic);
      }
      break;
    }
    case 0x27: {
      // UCDOS keyboard control
      const al = cpu.reg[EAX] & 0xFF;
      switch (al) {
        case 0x00: // Disable input method
          break;
        case 0x01: // Enable input method
          break;
        case 0x02: // Get input method status → AL=0 (inactive)
          cpu.setReg8(EAX, 0x00);
          break;
        case 0x03: // Switch input method
          break;
        default:
          break;
      }
      break;
    }
    case 0x28: {
      // UCDOS keyboard installation check / get status
      // Return signature: BX=CEF7h, CX=C9BDh
      // AL preserved from input, AH modified to status info
      const EBX = 3, ECX = 1;
      cpu.setReg16(EBX, 0xCEF7);
      cpu.setReg16(ECX, 0xC9BD);
      // Log what the program is comparing
      if (emu._dosUcdosStubSeg) {
        const ds = cpu.ds;
        const val323C = cpu.mem.readU16(ds * 16 + 0x323C);
        console.log(`[INT 16h AH=28h] ds=${ds.toString(16)} AX=${cpu.getReg16(EAX).toString(16)} [DS:323C]=${val323C.toString(16)}`);
      }
      break;
    }
    default:
      break;
  }


  return true;
}
