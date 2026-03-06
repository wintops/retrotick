import type { Emulator } from '../emulator';

// Win16 SOUND.DRV — sound driver stubs (no audio)

export function registerWin16Sound(emu: Emulator): void {
  const sound = emu.registerModule16('SOUND');

  // Ordinal 1: OpenSound() — 0 bytes
  sound.register('OpenSound', 0, () => 1, 1);
  // Ordinal 2: CloseSound() — 0 bytes
  sound.register('CloseSound', 0, () => 0, 2);
  // Ordinal 4: SetVoiceNote(word word word word) — 8 bytes
  sound.register('SetVoiceNote', 8, () => 0, 4);
  // Ordinal 5: SetVoiceAccent(word word word word word) — 10 bytes
  sound.register('SetVoiceAccent', 10, () => 0, 5);
  // Ordinal 9: StartSound() — 0 bytes
  sound.register('StartSound', 0, () => 0, 9);
  // Ordinal 10: StopSound() — 0 bytes
  sound.register('StopSound', 0, () => 0, 10);
}
