import { parsePE, parseCOM, extractIcons } from './pe';
import type { PEInfo } from './pe';

export function extractFirstIconUrl(data: ArrayBuffer): string | null {
  try {
    const peInfo = parsePE(data);
    return extractFirstIconUrlFromParsed(peInfo, data);
  } catch {}
  return null;
}

export function extractFirstIconUrlFromParsed(peInfo: PEInfo, data: ArrayBuffer): string | null {
  try {
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
    return classifyExe(peInfo, name);
  } catch {
    return { ok: false };
  }
}

export function classifyExe(peInfo: PEInfo, name?: string): { ok: boolean; peInfo: PEInfo } {
  if (peInfo.isMZ) return { ok: true, peInfo };
  if (peInfo.isNE) return { ok: true, peInfo };
  const isDll = (peInfo.coffHeader.characteristics & 0x2000) !== 0;
  const isI386 = peInfo.coffHeader.machine === 0x014C;
  const isARM = peInfo.coffHeader.machine === 0x01C0;
  if (isDll && name?.toLowerCase().endsWith('.cpl') && isI386) return { ok: true, peInfo };
  return { ok: !isDll && (isI386 || isARM), peInfo };
}

export type RunExeFn = (buf: ArrayBuffer, peInfo: PEInfo, additional: Map<string, ArrayBuffer> | undefined, exeName: string, commandLine?: string) => void;

export async function openWithDefaultApp(
  name: string,
  metas: { name: string }[],
  onRunExe: RunExeFn,
  getFileData: (name: string) => Promise<ArrayBuffer | null>,
): Promise<boolean> {
  const ext = name.toLowerCase().split('.').pop();
  const NOTEPAD_EXTS = new Set(['txt', 'ini', 'log', 'nfo', 'diz', '1st']);
  if (!ext || !NOTEPAD_EXTS.has(ext)) return false;
  const notepadMeta = metas.find(m => m.name.toLowerCase().replace(/^.*\//, '') === 'notepad.exe');
  if (!notepadMeta) return false;
  const notepadData = await getFileData(notepadMeta.name);
  if (!notepadData) return false;
  const result = isExeFile(notepadData, notepadMeta.name);
  if (!result.ok || !result.peInfo) return false;
  const filePath = 'D:\\' + name.replace(/\//g, '\\');
  onRunExe(notepadData, result.peInfo, undefined, notepadMeta.name, filePath);
  return true;
}
