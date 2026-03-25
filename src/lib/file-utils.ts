import { parsePE, parseCOM, extractIcons } from './pe';
import type { PEInfo } from './pe';

export function extractFirstIconUrl(data: ArrayBuffer): string | null {
  try {
    const peInfo = parsePE(data);
    const icons = extractIcons(peInfo, data);
    if (icons.length > 0) return URL.createObjectURL(icons[0].blob);
  } catch {}
  return null;
}

export function isExeFile(data: ArrayBuffer, name?: string): { ok: boolean; peInfo?: PEInfo } {
  if (name?.toLowerCase().endsWith('.com')) {
    return { ok: true, peInfo: parseCOM(data) };
  }
  try {
    const peInfo = parsePE(data);
    if (peInfo.isMZ) return { ok: true, peInfo };
    if (peInfo.isNE) return { ok: true, peInfo };
    const isDll = (peInfo.coffHeader.characteristics & 0x2000) !== 0;
    const isI386 = peInfo.coffHeader.machine === 0x014C;
    if (isDll && name?.toLowerCase().endsWith('.cpl') && isI386) return { ok: true, peInfo };
    return { ok: !isDll && isI386, peInfo };
  } catch {
    return { ok: false };
  }
}

export type RunExeFn = (buf: ArrayBuffer, peInfo: PEInfo, additional: Map<string, ArrayBuffer>, exeName: string, commandLine?: string) => void;

export async function openWithDefaultApp(
  name: string,
  stored: { name: string; data: ArrayBuffer }[],
  onRunExe: RunExeFn,
): Promise<boolean> {
  const ext = name.toLowerCase().split('.').pop();
  const NOTEPAD_EXTS = new Set(['txt', 'ini', 'log', 'nfo', 'diz', '1st']);
  if (!ext || !NOTEPAD_EXTS.has(ext)) return false;
  const notepad = stored.find(s => s.name.toLowerCase().replace(/^.*\//, '') === 'notepad.exe');
  if (!notepad) return false;
  const result = isExeFile(notepad.data, notepad.name);
  if (!result.ok || !result.peInfo) return false;
  const additional = new Map<string, ArrayBuffer>();
  for (const s of stored) {
    if (s.name !== notepad.name) additional.set(s.name, s.data);
  }
  const filePath = 'D:\\' + name.replace(/\//g, '\\');
  onRunExe(notepad.data, result.peInfo, additional, notepad.name, filePath);
  return true;
}
