import { useState, useRef } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX } from './win2k/Window';
import { Button } from './win2k/Button';
import { loadDosSettings, saveDosSettings, type DosSettings } from '../lib/dos-settings';
import { t } from '../lib/regional-settings';

const FONT = '11px "Tahoma", sans-serif';

const radioStyle: Record<string, string | number> = {
  font: FONT, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px',
  marginBottom: '4px',
};

interface DosSettingsWindowProps {
  onClose: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

export function DosSettingsWindow({ onClose, onFocus, onMinimize, zIndex, focused, minimized }: DosSettingsWindowProps) {
  const [settings, setSettings] = useState<DosSettings>(loadDosSettings);
  const initialPos = useRef({ x: Math.max(0, (window.innerWidth - 300) / 2), y: Math.max(0, (window.innerHeight - 200) / 2) });

  const handleOK = () => {
    saveDosSettings(settings);
    onClose();
  };

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex, display: minimized ? 'none' : undefined, pointerEvents: 'none' }} onPointerDown={onFocus}>
      <div style={{ pointerEvents: 'auto', display: 'inline-block' }}>
        <Window
          title={t().dosSettings}
          style={WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX}
          clientW={280}
          focused={focused}
          minimized={minimized}
          onClose={onClose}
          onMinimize={onMinimize}
          draggable
          initialPos={initialPos.current}
        >
          <div style={{ background: '#D4D0C8', padding: '12px 14px' }}>
            {/* Text renderer */}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ font: FONT, marginBottom: '6px', fontWeight: 'bold' }}>{t().labelTextRenderer}</div>
              <label style={radioStyle}>
                <input
                  type="radio" name="textRenderer"
                  checked={settings.textRenderer === 'dom'}
                  onChange={() => setSettings(s => ({ ...s, textRenderer: 'dom' }))}
                />
                {t().textRendererDom}
              </label>
              <label style={radioStyle}>
                <input
                  type="radio" name="textRenderer"
                  checked={settings.textRenderer === 'canvas'}
                  onChange={() => setSettings(s => ({ ...s, textRenderer: 'canvas' }))}
                />
                {t().textRendererCanvas}
              </label>
            </div>

            {/* JIT compiler */}
            <div style={{ marginBottom: '10px' }}>
              <div style={{ font: FONT, marginBottom: '6px', fontWeight: 'bold' }}>{t().labelJit}</div>
              <label style={{ ...radioStyle, marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={settings.jitEnabled}
                  onChange={() => setSettings(s => ({ ...s, jitEnabled: !s.jitEnabled }))}
                />
                {t().jitExperimental}
              </label>
            </div>

            <div style={{ borderTop: '1px solid #808080', borderBottom: '1px solid #FFF', margin: '0 0 8px' }} />

            {/* Buttons */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px' }}>
              <div style={{ width: '75px', height: '23px' }} onClick={handleOK}>
                <Button fontCSS={FONT} isDefault>OK</Button>
              </div>
              <div style={{ width: '75px', height: '23px' }} onClick={onClose}>
                <Button fontCSS={FONT}>{t().cancel}</Button>
              </div>
            </div>
          </div>
        </Window>
      </div>
    </div>
  );
}
