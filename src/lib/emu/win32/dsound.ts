import type { Emulator } from '../emulator';

const DSERR_NODRIVER = 0x88780078;

export function registerDsound(emu: Emulator): void {
  const dsound = emu.registerDll('DSOUND.DLL');

  // DirectSoundCreate(lpGuid, ppDS, pUnkOuter) → HRESULT
  dsound.register('DirectSoundCreate', 3, () => DSERR_NODRIVER);
}
