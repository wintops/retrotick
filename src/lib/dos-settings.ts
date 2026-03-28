/** DOS emulator settings — persisted in localStorage. */

export interface DosSettings {
  /** Text mode renderer: 'dom' allows text selection, 'canvas' eliminates
   *  sub-pixel rendering artifacts in Chrome but disables text selection. */
  textRenderer: 'dom' | 'canvas';
  /** Enable experimental WASM JIT compiler for DOS programs. */
  jitEnabled: boolean;
}

const STORAGE_KEY = 'retrotick-dos';

const DEFAULTS: DosSettings = {
  textRenderer: 'dom',
  jitEnabled: false,
};

export function loadDosSettings(): DosSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULTS };
}

export function saveDosSettings(settings: DosSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new CustomEvent('retrotick-settings-changed'));
}
