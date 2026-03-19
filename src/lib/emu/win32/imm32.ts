import type { Emulator } from '../emulator';

export function registerImm32(emu: Emulator): void {
  const imm32 = emu.registerDll('IMM32.DLL');
  imm32.register('ImmGetContext', 1, () => 0); // return NULL (no IME context)
  imm32.register('ImmReleaseContext', 2, () => 1);
  imm32.register('ImmSetCompositionStringW', 6, () => 0);
  imm32.register('ImmSetCompositionWindow', 2, () => 0);
  imm32.register('ImmGetCompositionWindow', 2, () => 0);
  imm32.register('ImmNotifyIME', 3, () => 0);
  imm32.register('ImmSetOpenStatus', 2, () => 0);
  imm32.register('ImmGetOpenStatus', 1, () => 0);
  imm32.register('ImmSetCompositionFontW', 2, () => 0);
  imm32.register('ImmGetCompositionStringW', 4, () => 0);
  imm32.register('ImmAssociateContext', 2, () => 0);
  // A variants
  imm32.register('ImmSetCompositionFontA', 2, () => 0);
  imm32.register('ImmGetCompositionStringA', 4, () => 0);
  // IME status
  imm32.register('ImmGetConversionStatus', 3, () => 0);
  imm32.register('ImmSetConversionStatus', 3, () => 0);
  imm32.register('ImmIsIME', 1, () => 0); // no IME active
}
