import type { Emulator } from './emulator';

/** Try to find a .hlp file by name and hand it to the host's help viewer
 *  callback (`emu.onOpenHelp`). Fire-and-forget: if the file lives only
 *  in IndexedDB we kick off an async fetch and open the viewer when it
 *  resolves — the WinHelp thunk itself returns immediately, mirroring
 *  Windows where WinHelp launches WINHLP32.EXE asynchronously. */
export function launchHelpFile(emu: Emulator, fileName: string): boolean {
  if (!emu.onOpenHelp || !fileName) return false;
  const resolved = emu.resolvePath(fileName);
  const fileInfo = emu.fs.findFile(resolved, emu.additionalFiles);
  if (!fileInfo) {
    console.warn(`[WinHelp] file not found: ${fileName} (resolved=${resolved})`);
    return false;
  }
  const baseName = fileInfo.name.replace(/^.*[\\/]/, '');

  if (fileInfo.source === 'additional') {
    const ab = emu.additionalFiles.get(fileInfo.name);
    if (ab) { emu.onOpenHelp(ab, baseName); return true; }
    return false;
  }

  if (fileInfo.source === 'external') {
    const ext = emu.fs.externalFiles.get(resolved.toUpperCase());
    if (ext) {
      const ab = ext.data.buffer.slice(
        ext.data.byteOffset,
        ext.data.byteOffset + ext.data.byteLength,
      ) as ArrayBuffer;
      emu.onOpenHelp(ab, baseName);
      return true;
    }
    return false;
  }

  // virtual (IndexedDB-backed): hit cache first, otherwise async fetch
  const fs = emu.fs as unknown as { virtualFileCache?: Map<string, ArrayBuffer> };
  const cacheKey = fileInfo.name.toUpperCase();
  const cached = fs.virtualFileCache?.get(cacheKey);
  if (cached) { emu.onOpenHelp(cached, baseName); return true; }

  emu.fs.fetchFileData(fileInfo, emu.additionalFiles, resolved).then(buf => {
    if (buf && emu.onOpenHelp) emu.onOpenHelp(buf, baseName);
    else if (!buf) console.warn(`[WinHelp] failed to load: ${fileName}`);
  });
  return true;
}
