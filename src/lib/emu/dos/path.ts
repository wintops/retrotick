import type { Emulator } from '../emulator';

/** Valid DOS drive letters in the emulator (C, D, E). */
const VALID_DOS_DRIVES = new Set(['C', 'D', 'E']);

/** Check if a drive letter (uppercase) is valid in the emulator.
 *  drive can be 0-based index (0=A) or a letter ('C'). */
export function isDosValidDrive(drive: number | string): boolean {
  const letter = typeof drive === 'number'
    ? String.fromCharCode(0x41 + drive)
    : drive.toUpperCase();
  return VALID_DOS_DRIVES.has(letter);
}

/** Number of logical drives (LASTDRIVE = E → 5). */
export const DOS_LASTDRIVE = 5;

/** Normalize a DOS path: resolve "." and ".." segments. */
function normalizeDosPath(path: string): string {
  const drive = path.substring(0, 2); // "C:"
  const rest = path.substring(2);
  const parts = rest.split('\\').filter(Boolean);
  const result: string[] = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') { if (result.length > 0) result.pop(); }
    else result.push(part);
  }
  return drive + '\\' + result.join('\\');
}

/** Resolve a DOS path using per-process current drive/directory. */
export function dosResolvePath(emu: Emulator, input: string): string {
  let p = input.replace(/\//g, '\\');
  p = p.replace(/(?!^)\\\\+/g, '\\');
  let resolved: string;
  if (/^[A-Za-z]:\\/.test(p)) {
    resolved = p;
  } else if (/^[A-Za-z]:$/.test(p)) {
    const drive = p[0].toUpperCase();
    resolved = emu.currentDirs.get(drive) || (drive + ':\\');
  } else if (/^[A-Za-z]:/.test(p) && p[2] !== '\\') {
    const drive = p[0].toUpperCase();
    const rel = p.substring(2);
    const base = emu.currentDirs.get(drive) || (drive + ':\\');
    resolved = base.endsWith('\\') ? base + rel : base + '\\' + rel;
  } else if (p.startsWith('\\')) {
    resolved = emu.currentDrive + ':' + p;
  } else {
    const base = emu.currentDirs.get(emu.currentDrive) || (emu.currentDrive + ':\\');
    resolved = base.endsWith('\\') ? base + p : base + '\\' + p;
  }
  resolved = resolved.toUpperCase();
  // Normalize ".." and "." segments — only in the DIRECTORY portion of the path.
  // The filename/pattern part (after last \) is preserved as-is so that wildcards
  // like "*.BAS" are not treated as directory components during normalization.
  if (resolved.includes('\\..') || resolved.includes('\\.\\')) {
    const lastSlash = resolved.lastIndexOf('\\');
    if (lastSlash > 2) {
      const dirPart = resolved.substring(0, lastSlash);
      const filePart = resolved.substring(lastSlash + 1);
      const normalizedDir = normalizeDosPath(dirPart);
      resolved = normalizedDir + (normalizedDir.endsWith('\\') ? '' : '\\') + filePart;
    } else {
      resolved = normalizeDosPath(resolved);
    }
  }
  return resolved;
}
