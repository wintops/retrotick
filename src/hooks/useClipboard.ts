import { useState, useCallback } from 'preact/hooks';
import { renameEntry, copyEntry, displayName, isFolder, dispatchDesktopFilesChanged } from '../lib/file-store';

export interface ClipboardState {
  mode: 'cut' | 'copy';
  items: string[];
  sourcePrefix: string;
}

export function useClipboard() {
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);

  const cut = useCallback((items: string[], sourcePrefix: string) => {
    setClipboard({ mode: 'cut', items, sourcePrefix });
  }, []);

  const copy = useCallback((items: string[], sourcePrefix: string) => {
    setClipboard({ mode: 'copy', items, sourcePrefix });
  }, []);

  const clear = useCallback(() => setClipboard(null), []);

  const paste = useCallback(async (targetPrefix: string) => {
    if (!clipboard || clipboard.items.length === 0) return;
    const added: string[] = [];
    const deleted: string[] = [];
    for (const item of clipboard.items) {
      const dName = displayName(item);
      const isDir = isFolder(item);
      const destName = targetPrefix + dName + (isDir ? '/' : '');
      // Prevent pasting a folder into itself
      if (isDir && targetPrefix.startsWith(item)) continue;
      if (clipboard.mode === 'cut') {
        if (item === destName) continue;
        await renameEntry(item, destName);
        deleted.push(item);
        added.push(destName);
      } else {
        await copyEntry(item, destName);
        added.push(destName);
      }
    }
    if (clipboard.mode === 'cut') setClipboard(null);
    dispatchDesktopFilesChanged({ source: 'ui', added, deleted });
  }, [clipboard]);

  return { clipboard, cut, copy, paste, clear };
}
