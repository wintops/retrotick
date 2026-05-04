/** DOS emulator settings — persisted in localStorage. */

export interface DosSettings {
  /** Text mode renderer: 'dom' allows text selection, 'canvas' eliminates
   *  sub-pixel rendering artifacts in Chrome but disables text selection. */
  textRenderer: 'dom' | 'canvas';
  /** Enable experimental WASM JIT compiler for DOS programs. */
  jitEnabled: boolean;
  /** DPMI 0.9 host (for programs using DPMI directly or via CWSDPMI). */
  dpmi: boolean;
  /** V86 mode for DOS programs (EMM386-like — DOS/4GW takes its VCPI path). */
  v86: boolean;
  /** XMS driver (extended memory above 1MB). */
  xms: boolean;
  /** EMS/VCPI driver (expanded memory + V86 PM interface). */
  ems: boolean;
  /** Sound Blaster emulation. */
  soundBlaster: boolean;
  /** AdLib FM synthesis. */
  adlib: boolean;
  /** Gravis UltraSound emulation. */
  gus: boolean;
  /** CPU speed factor: 1 = full speed, 0.5 = half speed, etc. */
  speed: number;
  /** VGA refresh rate in Hz (standard CRT = 70). */
  refreshRate: number;
  /** Log all DOS INT calls to the browser console. */
  traceApi: boolean;
}

const STORAGE_KEY = 'retrotick-dos';

const DEFAULTS: DosSettings = {
  textRenderer: 'dom',
  jitEnabled: false,
  dpmi: false,
  v86: false,
  xms: true,
  ems: true,
  soundBlaster: true,
  adlib: true,
  gus: true,
  speed: 1,
  refreshRate: 70,
  traceApi: false,
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
