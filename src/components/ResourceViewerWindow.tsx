import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { PeInfoDisplay } from './PeInfo';
import { BitmapDisplay } from './BitmapDisplay';
import { IconDisplay } from './IconDisplay';
import { CursorDisplay } from './CursorDisplay';
import { MenuDisplay } from './MenuDisplay';
import { DialogDisplay } from './DialogDisplay';
import { DelphiFormDisplay } from './DelphiFormDisplay';
import { AcceleratorDisplay } from './AcceleratorDisplay';
import { AviPlayer } from './AviPlayer';
import { WavPlayer } from './WavPlayer';
import { StringTable } from './StringTable';
import { ManifestDisplay } from './ManifestDisplay';
import { VersionInfoDisplay } from './VersionInfoDisplay';
import { ImportTableDisplay } from './ImportTableDisplay';
import { ExportTableDisplay } from './ExportTableDisplay';
import { useBlobUrls } from '../hooks/useBlobUrls';
import type { LoadedData } from './App';
import type { PEInfo } from '../lib/pe';
import { t } from '../lib/regional-settings';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
const CLIENT_W = 640;
const CLIENT_H = 480;
const TREE_W = 160;

interface Section {
  key: string;
  label: string;
  count: number;
}

function buildSections(data: LoadedData): Section[] {
  const sections: Section[] = [];
  const add = (key: string, label: string, count: number) => { if (count > 0) sections.push({ key, label, count }); };
  add('imports', 'Imports', data.imports.length);
  add('exports', 'Exports', data.exports?.functions.length ?? 0);
  add('bitmaps', 'Bitmaps', data.bitmaps.length);
  add('icons', 'Icons', data.icons.length);
  add('cursors', 'Cursors', data.cursors.length);
  add('menus', 'Menus', data.menus.length);
  add('delphiForms', 'Delphi Forms', data.delphiForms.length);
  add('dialogs', 'Dialogs', data.dialogs.length);
  add('accelerators', 'Accelerators', data.accelerators.length);
  add('avi', 'AVI', data.aviResources.length);
  add('wav', 'WAV', data.wavResources.length);
  add('versionInfo', 'Version Info', data.versionInfos.length);
  add('manifests', 'Manifests', data.manifests.length);
  add('strings', 'String Table', data.strings.length);
  return sections;
}

interface ResourceViewerWindowProps {
  data: LoadedData;
  exeName: string;
  isExecutable: boolean;
  onStop: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  onRunExe: (arrayBuffer: ArrayBuffer, peInfo: PEInfo) => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

export function ResourceViewerWindow({
  data, exeName, isExecutable, onStop, onFocus, onMinimize, onRunExe, zIndex, focused, minimized,
}: ResourceViewerWindowProps) {
  const [windowPos, setWindowPos] = useState({ x: 60, y: 30 });
  const [clientSize, setClientSize] = useState({ w: CLIENT_W, h: CLIENT_H });
  const [maximized, setMaximized] = useState(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);
  const { createUrl } = useBlobUrls();

  const sections = buildSections(data);
  const [selectedSection, setSelectedSection] = useState<string | null>(sections.length > 0 ? sections[0].key : null);

  const onResizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: clientSize.w, startH: clientSize.h, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [clientSize, windowPos]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const m = moveDrag.current;
      if (m) {
        setWindowPos({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY });
        return;
      }
      const d = resizeDrag.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      let w = d.startW, h = d.startH;
      let px = d.startPosX, py = d.startPosY;
      if (d.edge.includes('e')) w = d.startW + dx;
      if (d.edge.includes('w')) { w = d.startW - dx; px = d.startPosX + dx; }
      if (d.edge.includes('s')) h = d.startH + dy;
      if (d.edge.includes('n')) { h = d.startH - dy; py = d.startPosY + dy; }
      const minW = 200, minH = 100;
      if (w < minW) { if (d.edge.includes('w')) px -= minW - w; w = minW; }
      if (h < minH) { if (d.edge.includes('n')) py -= minH - h; h = minH; }
      setClientSize({ w, h });
      setWindowPos({ x: px, y: py });
    };
    const onPointerUp = () => {
      moveDrag.current = null;
      resizeDrag.current = null;
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    if (maximized) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
  }, [windowPos, maximized]);

  const handleMaximize = useCallback(() => {
    const TASKBAR_HEIGHT = 30;
    const CAPTION_H = 21;
    if (maximized) {
      const saved = preMaxState.current;
      if (saved) {
        setWindowPos({ x: saved.x, y: saved.y });
        setClientSize({ w: saved.w, h: saved.h });
        preMaxState.current = null;
      }
      setMaximized(false);
    } else {
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: clientSize.w, h: clientSize.h };
      setWindowPos({ x: 0, y: 0 });
      setClientSize({ w: window.innerWidth, h: window.innerHeight - TASKBAR_HEIGHT - CAPTION_H - 1 });
      setMaximized(true);
    }
  }, [maximized, windowPos, clientSize]);

  const handleTitleBarDblClick = useCallback(() => {
    handleMaximize();
  }, [handleMaximize]);

  const contentH = clientSize.h - 25; // subtract toolbar height

  function renderContent() {
    switch (selectedSection) {
      case 'imports': return <ImportTableDisplay imports={data.imports} />;
      case 'exports': return data.exports ? <ExportTableDisplay exports={data.exports} /> : null;
      case 'bitmaps': return <BitmapDisplay bitmaps={data.bitmaps} createUrl={createUrl} />;
      case 'icons': return <IconDisplay icons={data.icons} createUrl={createUrl} />;
      case 'cursors': return <CursorDisplay cursors={data.cursors} createUrl={createUrl} />;
      case 'menus': return <MenuDisplay menus={data.menus} />;
      case 'delphiForms': return <DelphiFormDisplay forms={data.delphiForms} resUrls={data.resUrls} createUrl={createUrl} />;
      case 'dialogs': return <DialogDisplay dialogs={data.dialogs} resUrls={data.resUrls} />;
      case 'accelerators': return <AcceleratorDisplay accelerators={data.accelerators} />;
      case 'avi': return <AviPlayer aviResources={data.aviResources} />;
      case 'wav': return <WavPlayer wavResources={data.wavResources} createUrl={createUrl} />;
      case 'versionInfo': return <VersionInfoDisplay versionInfos={data.versionInfos} />;
      case 'manifests': return <ManifestDisplay manifests={data.manifests} />;
      case 'strings': return <StringTable strings={data.strings} />;
      default:
        return <PeInfoDisplay peInfo={data.peInfo} />;
    }
  }

  return (
    <div
      style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, display: minimized ? 'none' : undefined }}
      onPointerDown={onFocus}
    >
      <Window
        title={`${t().resourceViewer} - ${exeName}`}
        style={WINDOW_STYLE}
        clientW={clientSize.w}
        clientH={clientSize.h}
        iconUrl={data.resUrls.appIconUrl}
        focused={focused}
        maximized={maximized}
        minimized={minimized}
        onClose={onStop}
        onMinimize={onMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleTitleBarDblClick}
        onResizeStart={onResizeStart}
      >
        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          height: '24px', padding: '0 6px',
          background: '#D4D0C8',
          borderBottom: '1px solid #808080',
          font: '11px Tahoma, sans-serif', color: '#000',
        }}>
          <PeInfoDisplay peInfo={data.peInfo} />
          {isExecutable && (
            <button
              style={{
                padding: '2px 12px', background: '#D4D0C8', cursor: 'var(--win2k-cursor)',
                border: '1px solid', borderColor: '#fff #404040 #404040 #fff',
                font: '11px Tahoma, sans-serif', marginLeft: 'auto', flexShrink: 0,
              }}
              onClick={() => onRunExe(data.arrayBuffer, data.peInfo)}
            >
              {t().run}
            </button>
          )}
        </div>
        {/* Two-pane body */}
        <div style={{ display: 'flex', height: `${contentH}px`, background: '#D4D0C8', padding: '2px' }}>
          {/* Left: tree panel */}
          <div style={{
            width: `${TREE_W}px`, flexShrink: 0, marginRight: '2px',
            background: '#fff', overflow: 'auto',
            border: '1px solid', borderColor: '#808080 #fff #fff #808080',
          }}>
            <div style={{ padding: '2px 0' }}>
              {sections.map(sec => (
                <div
                  key={sec.key}
                  onClick={() => setSelectedSection(sec.key)}
                  style={{
                    padding: '3px 6px 3px 10px',
                    cursor: 'var(--win2k-cursor)', userSelect: 'none',
                    font: '11px Tahoma, sans-serif',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    background: selectedSection === sec.key ? '#0A246A' : 'transparent',
                    color: selectedSection === sec.key ? '#fff' : '#000',
                  }}
                >
                  {sec.label} ({sec.count})
                </div>
              ))}
            </div>
          </div>
          {/* Right: content panel */}
          <div style={{
            flex: 1, overflow: 'auto', padding: '8px',
            font: '11px Tahoma, sans-serif', color: '#000',
            background: '#fff',
            border: '1px solid', borderColor: '#808080 #fff #fff #808080',
          }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {renderContent()}
            </div>
          </div>
        </div>
      </Window>
    </div>
  );
}
