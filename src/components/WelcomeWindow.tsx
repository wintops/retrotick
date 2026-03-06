import { useState, useRef } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX } from './win2k/Window';
import { Button } from './win2k/Button';
import { addFile } from '../lib/file-store';
import { t } from '../lib/regional-settings';

const FONT = '11px "Tahoma", sans-serif';
const FONT_SMALL = '10px "Tahoma", sans-serif';

interface ExampleGroup {
  labelKey: 'games' | 'programs' | 'screenSavers';
  items: { name: string; description: string }[];
}

const GROUPS: ExampleGroup[] = [
  { labelKey: 'games', items: [
    { name: 'cards.dll', description: 'Cards (DLL)' },
    { name: 'freecell.exe', description: 'FreeCell' },
    { name: 'ski32.exe', description: 'SkiFree' },
    { name: 'sol.exe', description: 'Solitaire' },
    { name: 'winmine.exe', description: 'Minesweeper' },
  ]},
  { labelKey: 'programs', items: [
    { name: 'calc.exe', description: 'Calculator' },
    { name: 'clock.exe', description: 'Clock' },
    { name: 'cmd.exe', description: 'Command Prompt' },
    { name: 'glxgears.exe', description: 'GLX Gears' },
    { name: 'qbasic.exe', description: 'MS-DOS QBasic' },
    { name: 'sndrec32.exe', description: 'Sound Recorder' },
    { name: 'SUPER_PI.EXE', description: 'Super PI' },
    { name: 'taskmgr.exe', description: 'Task Manager' },
    { name: 'welcome95.exe', description: 'Welcome to Windows 95' },
  ]},
  { labelKey: 'screenSavers', items: [
    { name: 'ssmaze.scr', description: '3D Maze' },
    { name: 'sspipes.scr', description: '3D Pipes' },
    { name: 'ssbezier.scr', description: 'Bezier' },
    { name: 'ssflwbox.scr', description: 'Flower Box' },
    { name: 'ssmarque.scr', description: 'Marquee' },
    { name: 'ssmyst.scr', description: 'Mystify' },
    { name: 'ssstars.scr', description: 'Starfield Simulation' },
  ]},
];

const ALL_EXAMPLES = GROUPS.flatMap(g => g.items);

interface WelcomeWindowProps {
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

export function WelcomeWindow({ onClose, onFocus, onMinimize, zIndex, focused, minimized }: WelcomeWindowProps) {
  const [status, setStatus] = useState<Map<string, 'loading' | 'done' | 'error'>>(new Map());
  const [downloading, setDownloading] = useState(false);

  const download = async (name: string) => {
    if (status.get(name) === 'loading' || status.get(name) === 'done') return;
    setStatus(prev => new Map(prev).set(name, 'loading'));
    try {
      const resp = await fetch(`https://static.retrotick.com/examples/${name}`);
      if (!resp.ok) throw new Error(resp.statusText);
      const data = await resp.arrayBuffer();
      await addFile(name, data);
      window.dispatchEvent(new CustomEvent('desktop-files-changed'));
      setStatus(prev => new Map(prev).set(name, 'done'));
    } catch {
      setStatus(prev => new Map(prev).set(name, 'error'));
    }
  };

  const downloadAll = async () => {
    const toDownload = ALL_EXAMPLES.filter(e => status.get(e.name) !== 'done' && status.get(e.name) !== 'loading');
    if (toDownload.length === 0) return;
    setDownloading(true);
    for (const ex of toDownload) {
      await download(ex.name);
    }
    setDownloading(false);
  };

  const remaining = ALL_EXAMPLES.filter(e => status.get(e.name) !== 'done').length;
  const allDone = remaining === 0;
  const initialPos = useRef({ x: Math.max(0, (window.innerWidth - 440) / 2), y: Math.max(0, (window.innerHeight - 340) / 2) });

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex, display: minimized ? 'none' : undefined, pointerEvents: 'none' }} onPointerDown={onFocus}>
      <div style={{ pointerEvents: 'auto', display: 'inline-block' }}>
        <Window
          title={t().welcomeTitle}
          style={WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX}
          clientW={420}
          focused={focused}
          minimized={minimized}
          onClose={onClose}
          onMinimize={onMinimize}
          draggable
          initialPos={initialPos.current}
        >
        <div style={{ background: '#D4D0C8', padding: '10px 12px' }}>
          <div style={{ fontSize: '16px', fontFamily: 'Tahoma, sans-serif', fontWeight: 'bold', marginBottom: '4px', lineHeight: '1.4', color: '#000', textShadow: '1px 1px 0 #FFF, -1px -1px 0 #808080' }}>
            {t().welcomeHeading}
          </div>
          <div style={{ font: FONT, marginBottom: '4px', lineHeight: '1.4' }}>
            {t().welcomeIntro}
          </div>
          <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '6px 0 5px' }} />
          <div style={{ display: 'flex', gap: '12px' }}>
            {GROUPS.map(group => (
              <div key={group.labelKey} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: FONT, fontWeight: 'bold', marginBottom: '2px' }}>{t()[group.labelKey]}</div>
                {group.items.map(ex => {
                  const st = status.get(ex.name);
                  return (
                    <div key={ex.name} style={{ font: FONT, height: '17px', display: 'flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <span>{ex.description}</span>
                      {st === 'loading' && <span style={{ color: '#808080', marginLeft: '3px' }}>...</span>}
                      {st === 'done' && <span style={{ color: '#008000', marginLeft: '3px' }}>{'\u2713'}</span>}
                      {st === 'error' && <span style={{ color: '#C00000', marginLeft: '3px' }}>{t().failed}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '6px 0 5px' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ font: FONT_SMALL, color: '#808080', lineHeight: '1.3', flex: 1, marginRight: '12px' }}>
              {t().welcomeDisclaimer}
            </div>
            <div style={{ width: '100px', height: '23px', flexShrink: 0 }} onClick={downloading || allDone ? undefined : downloadAll}>
              <Button fontCSS={FONT} isDefault disabled={downloading || allDone}>
                {downloading ? t().adding : allDone ? t().allAdded : t().addAll}
              </Button>
            </div>
          </div>
        </div>
        </Window>
      </div>
    </div>
  );
}
