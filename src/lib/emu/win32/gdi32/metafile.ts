import type { Emulator } from '../../emulator';

export function registerMetafile(emu: Emulator): void {
  const gdi32 = emu.registerDll('GDI32.DLL');

  gdi32.register('SetEnhMetaFileBits', 2, () => 0);
  gdi32.register('SetWinMetaFileBits', 4, () => 0);
  gdi32.register('GetEnhMetaFileBits', 3, () => 0);
  gdi32.register('GetEnhMetaFileHeader', 3, () => 0);
  gdi32.register('GetEnhMetaFilePaletteEntries', 3, () => 0);
  gdi32.register('GetWinMetaFileBits', 5, () => 0);
  gdi32.register('PlayEnhMetaFile', 3, () => 0);
  gdi32.register('DeleteEnhMetaFile', 1, () => 1);
  gdi32.register('CopyEnhMetaFileA', 2, () => 0);
  gdi32.register('CopyMetaFileW', 2, () => 0);
  gdi32.register('PlayMetaFile', 2, () => 1);
  gdi32.register('EnumMetaFile', 5, () => 1);
  gdi32.register('PlayMetaFileRecord', 4, () => 1);
  gdi32.register('CopyEnhMetaFileW', 2, () => 0);
  gdi32.register('GetEnhMetaFileDescriptionW', 3, () => 0);
}
