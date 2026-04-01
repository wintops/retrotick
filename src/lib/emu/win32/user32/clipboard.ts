import type { Emulator } from '../../emulator';

export function registerClipboard(emu: Emulator): void {
  const user32 = emu.registerDll('USER32.DLL');

  // Track clipboard formats that have been set
  const clipboardFormats = new Set<number>();
  // Store the data handle per format
  const clipboardData = new Map<number, number>();

  user32.register('OpenClipboard', 1, () => 1);
  user32.register('CloseClipboard', 0, () => 1);

  user32.register('EmptyClipboard', 0, () => {
    clipboardFormats.clear();
    clipboardData.clear();
    return 1;
  });

  user32.register('SetClipboardData', 2, () => {
    const uFormat = emu.readArg(0);
    const hData = emu.readArg(1);
    clipboardFormats.add(uFormat);
    clipboardData.set(uFormat, hData);
    return hData;
  });

  user32.register('IsClipboardFormatAvailable', 1, () => {
    const uFormat = emu.readArg(0);
    const CF_TEXT = 1, CF_UNICODETEXT = 13;
    if ((uFormat === CF_TEXT || uFormat === CF_UNICODETEXT) && emu._clipboardText) return 1;
    return clipboardFormats.has(uFormat) ? 1 : 0;
  });

  user32.register('GetClipboardData', 1, () => {
    const uFormat = emu.readArg(0);
    const CF_TEXT = 1, CF_UNICODETEXT = 13;
    // Return clipboard text as a memory handle
    if ((uFormat === CF_TEXT || uFormat === CF_UNICODETEXT) && emu._clipboardText && !clipboardData.has(uFormat)) {
      const text = emu._clipboardText;
      if (uFormat === CF_UNICODETEXT) {
        const handle = emu.allocHeap((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++) emu.memory.writeU16(handle + i * 2, text.charCodeAt(i));
        emu.memory.writeU16(handle + text.length * 2, 0);
        return handle;
      } else {
        const handle = emu.allocHeap(text.length + 1);
        for (let i = 0; i < text.length; i++) emu.memory.writeU8(handle + i, text.charCodeAt(i) & 0xFF);
        emu.memory.writeU8(handle + text.length, 0);
        return handle;
      }
    }
    return clipboardData.get(uFormat) || 0;
  });

}
