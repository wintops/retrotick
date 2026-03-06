import type { Emulator } from '../emulator';
import { loadSettings, getKeyboardLayout, getLocalePreset } from '../../regional-settings';

// Win16 KEYBOARD module

export function registerWin16Keyboard(emu: Emulator): void {
  const keyboard = emu.registerModule16('KEYBOARD');

  // Ordinal 5: AnsiToOem(lpAnsiStr:4, lpOemStr:4) — 8 bytes
  keyboard.register('AnsiToOem', 8, () => {
    const [lpAnsi, lpOem] = emu.readPascalArgs16([4, 4]);
    if (lpAnsi && lpOem) {
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpAnsi + i);
        emu.memory.writeU8(lpOem + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 260) break;
      }
    }
    return 1;
  }, 5);

  // Ordinal 6: OemToAnsi(lpOemStr:4, lpAnsiStr:4) — 8 bytes
  keyboard.register('OemToAnsi', 8, () => {
    const [lpOem, lpAnsi] = emu.readPascalArgs16([4, 4]);
    if (lpOem && lpAnsi) {
      let i = 0;
      while (true) {
        const ch = emu.memory.readU8(lpOem + i);
        emu.memory.writeU8(lpAnsi + i, ch);
        if (ch === 0) break;
        i++;
        if (i > 260) break;
      }
    }
    return 1;
  }, 6);

  // Ordinal 129: VkKeyScan(ch) — 2 bytes
  keyboard.register('VkKeyScan', 2, () => {
    const ch = emu.readArg16(0) & 0xFF;
    const layout = getKeyboardLayout(loadSettings().keyboardLayout);
    const charStr = String.fromCharCode(ch);
    const entry = layout.charToVK.get(charStr);
    if (entry) {
      return entry.vk | (entry.shift ? 0x0100 : 0);
    }
    // Fallback: letters
    if (ch >= 0x61 && ch <= 0x7A) return ch - 0x20; // a-z → A-Z vk
    if (ch >= 0x41 && ch <= 0x5A) return ch | 0x0100; // A-Z → shift+vk
    return ch;
  }, 129);

  // Ordinal 132: GetKBCodePage() — 0 bytes
  keyboard.register('GetKBCodePage', 0, () => {
    const preset = getLocalePreset(loadSettings().localeId);
    return preset.oemCodePage;
  }, 132);

  // Ordinal 134: AnsiToOemBuff(lpAnsiStr, lpOemStr, nLength) — 10 bytes (4+4+2)
  keyboard.register('AnsiToOemBuff', 10, () => {
    const [lpAnsi, lpOem, nLength] = emu.readPascalArgs16([4, 4, 2]);
    if (lpAnsi && lpOem) {
      for (let i = 0; i < nLength; i++) {
        emu.memory.writeU8(lpOem + i, emu.memory.readU8(lpAnsi + i));
      }
    }
    return 1;
  }, 134);

  // Ordinal 135: OemToAnsiBuff(lpOemStr, lpAnsiStr, nLength) — 10 bytes (4+4+2)
  keyboard.register('OemToAnsiBuff', 10, () => {
    const [lpOem, lpAnsi, nLength] = emu.readPascalArgs16([4, 4, 2]);
    if (lpOem && lpAnsi) {
      for (let i = 0; i < nLength; i++) {
        emu.memory.writeU8(lpAnsi + i, emu.memory.readU8(lpOem + i));
      }
    }
    return 1;
  }, 135);
}
