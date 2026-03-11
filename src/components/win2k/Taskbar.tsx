import { useState, useEffect, useCallback } from 'preact/hooks';
import type { MenuItem } from '../../lib/pe/types';
import { MenuDropdown } from './MenuBar';
import { t } from '../../lib/regional-settings';

interface TaskbarApp {
  id: number;
  title: string;
  iconUrl?: string | null;
  minimized?: boolean;
  lang?: string;
}

interface TaskbarProps {
  runningApps: TaskbarApp[];
  focusedAppId: number | null;
  onActivateApp: (id: number) => void;
  onMinimizeApp: (id: number) => void;
  onCloseApp: (id: number) => void;
  onMinimizeAll?: () => void;
  onShowWelcome?: () => void;
  onShowRegionalSettings?: () => void;
  onResetToDefault?: () => void;
  onShutDown?: () => void;
}

function Clock() {
  const [time, setTime] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      setTime(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{time}</span>;
}

interface ContextMenu {
  appId: number;
  x: number;
  y: number;
}

export function Taskbar({ runningApps, focusedAppId, onActivateApp, onMinimizeApp, onCloseApp, onMinimizeAll, onShowWelcome, onShowRegionalSettings, onResetToDefault, onShutDown }: TaskbarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [bgContextMenu, setBgContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [startPos, setStartPos] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: MouseEvent, appId: number) => {
    e.preventDefault();
    // Position menu above the taskbar
    setContextMenu({ appId, x: e.clientX, y: e.clientY });
  }, []);

  const dismissMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!contextMenu && !bgContextMenu && !startOpen) return;
    const onDown = () => { setContextMenu(null); setBgContextMenu(null); setStartOpen(false); };
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown), 0);
    return () => { clearTimeout(timer); document.removeEventListener('pointerdown', onDown); };
  }, [contextMenu, bgContextMenu, startOpen]);

  const contextApp = contextMenu ? runningApps.find(a => a.id === contextMenu.appId) : null;

  return (
    <div style={{
      position: 'relative', height: '30px', flexShrink: 0,
      background: '#D4D0C8', zIndex: 9999,
      borderTop: '1px solid #FFF',
      display: 'flex', alignItems: 'center',
      font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif',
      userSelect: 'none', touchAction: 'none', overflow: 'hidden',
    }} onContextMenu={(e: Event) => {
      // Only show background menu if not right-clicking a task button
      const me = e as MouseEvent;
      if (!(me.target as HTMLElement).closest('[data-task-button]')) {
        me.preventDefault();
        setContextMenu(null);
        setBgContextMenu({ x: me.clientX, y: me.clientY });
      }
    }}>
      {/* Start Button */}
      <div style={{ position: 'relative', flexShrink: 0, padding: '0 2px' }}>
        <div
          onPointerDown={(e: Event) => {
            e.stopPropagation();
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            setStartPos({ x: rect.left, y: rect.top });
            setStartOpen(prev => !prev);
            setContextMenu(null); setBgContextMenu(null);
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: '3px',
            height: '22px', padding: '0 6px',
            cursor: 'var(--win2k-cursor)',
            background: '#D4D0C8',
            border: '1px solid',
            borderColor: startOpen ? '#404040 #FFF #FFF #404040' : '#FFF #404040 #404040 #FFF',
            boxShadow: startOpen
              ? 'inset 1px 1px 0 #808080, inset -1px -1px 0 #D4D0C8'
              : 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
            fontWeight: 'bold',
          }}
        >
          <span style={{ lineHeight: '16px' }}>{t().start}</span>
        </div>
        {startOpen && startPos && (
          <div onPointerDown={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={[
                { id: 1, text: t().welcome, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null },
                { id: 5, text: t().regionalSettings, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null },
               // { id: 4, text: t().githubProject, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null },
                { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null },
                { id: 3, text: t().resetToDefault, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null },
                { id: 2, text: t().shutDown, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null },
              ]}
              x={startPos.x}
              y={startPos.y}
              onCommand={(id) => {
                setStartOpen(false);
                if (id === 1) onShowWelcome?.();
                else if (id === 5) onShowRegionalSettings?.();
                else if (id === 4) window.open('https://github.com/lqs/retrotick', '_blank');
                else if (id === 2) onShutDown?.();
                else if (id === 3) onResetToDefault?.();
              }}
              onClose={() => setStartOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Task Buttons */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden', gap: '2px', padding: '0 2px', minWidth: 0 }}>
        {runningApps.map((app) => {
          const isActive = app.id === focusedAppId;
          const isPressed = contextMenu ? (contextMenu.appId === app.id) : isActive;
          return (
            <div
              key={app.id}
              data-task-button
              onClick={() => isActive ? onMinimizeApp(app.id) : onActivateApp(app.id)}
              onContextMenu={(e) => handleContextMenu(e as MouseEvent, app.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: '3px',
                height: '22px', padding: '0 4px',
                flex: '0 1 160px', minWidth: '24px',
                cursor: 'var(--win2k-cursor)', overflow: 'hidden',
                background: '#D4D0C8',
                border: '1px solid',
                borderColor: isPressed ? '#404040 #FFF #FFF #404040' : '#FFF #404040 #404040 #FFF',
                boxShadow: isPressed
                  ? 'inset 1px 1px 0 #808080, inset -1px -1px 0 #D4D0C8'
                  : 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
                fontWeight: 'normal',
              }}
            >
              {app.iconUrl && (
                <img src={app.iconUrl} style={{ width: '16px', height: '16px', flexShrink: 0, imageRendering: 'pixelated' }} />
              )}
              <span lang={app.lang} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, lineHeight: '16px' }}>
                {app.title || t().untitled}
              </span>
            </div>
          );
        })}
      </div>

      {/* Notification Area / Clock */}
      <div style={{
        display: 'flex', alignItems: 'center', height: '22px', padding: '0 8px',
        margin: '0 2px', flexShrink: 0,
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        fontSize: '11px',
      }}>
        <Clock />
      </div>

      {/* Taskbar background context menu */}
      {bgContextMenu && (() => {
        const CMD_MINIMIZE_ALL = 1;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const items: MenuItem[] = [
          mi(CMD_MINIMIZE_ALL, t().minimizeAllWindows, { isGrayed: runningApps.length === 0 }),
        ];
        return (
          <div onPointerDown={(e: Event) => e.stopPropagation()}>
            <MenuDropdown
              items={items}
              x={bgContextMenu.x} y={bgContextMenu.y}
              onCommand={(id) => {
                setBgContextMenu(null);
                if (id === CMD_MINIMIZE_ALL) onMinimizeAll?.();
              }}
              onClose={() => setBgContextMenu(null)}
            />
          </div>
        );
      })()}

      {/* Task button context menu */}
      {contextMenu && contextApp && (() => {
        const CMD_RESTORE = 1, CMD_MINIMIZE = 2, CMD_CLOSE = 3;
        const mi = (id: number, text: string, opts?: Partial<MenuItem>): MenuItem => ({
          id, text, isSeparator: false, isChecked: false, isGrayed: false, isDefault: false, children: null, ...opts,
        });
        const items: MenuItem[] = [
          mi(CMD_RESTORE, t().restore, { isGrayed: !contextApp.minimized }),
          mi(CMD_MINIMIZE, t().minimize, { isGrayed: !!contextApp.minimized }),
          { id: 0, text: '', isSeparator: true, isChecked: false, isGrayed: false, isDefault: false, children: null },
          mi(CMD_CLOSE, t().close, { isDefault: true }),
        ];
        return (
          <div onPointerDown={(e: Event) => e.stopPropagation()}>
          <MenuDropdown
            items={items}
            x={contextMenu.x} y={contextMenu.y}
            onCommand={(id) => {
              dismissMenu();
              if (id === CMD_RESTORE) onActivateApp(contextMenu.appId);
              else if (id === CMD_MINIMIZE) onMinimizeApp(contextMenu.appId);
              else if (id === CMD_CLOSE) onCloseApp(contextMenu.appId);
            }}
            onClose={dismissMenu}
          />
          </div>
        );
      })()}
    </div>
  );
}
