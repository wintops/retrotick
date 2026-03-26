import { useState, useCallback, useRef, useEffect, useMemo } from 'preact/hooks';
import { useLayoutEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { TabControl } from './win2k/TabControl';
import { Button } from './win2k/Button';
import { FileDialog } from './win2k/FileDialog';
import { t } from '../lib/regional-settings';
import { getAllFiles, getFile } from '../lib/file-store';
import { DefaultFileManager } from '../lib/emu/file-manager';

// --- Types ---

export interface BackgroundSettings {
  color: string;
  imageDataUrl: string | null;
  imageName: string | null;
  mode: 'center' | 'tile' | 'stretch';
}

interface Props {
  current: BackgroundSettings;
  onApply: (settings: BackgroundSettings) => void;
  onClose: () => void;
  flashTrigger?: number;
}

// --- Constants ---

const FONT = '11px/1 "Tahoma", "MS Sans Serif", sans-serif';
const DIALOG_W = 380;
const DIALOG_H = 400;
const IMAGE_FILTER = 'Image Files|*.bmp;*.jpg;*.jpeg;*.png;*.gif;*.webp|All Files|*.*';

const COLOR_PALETTE = [
  '#008080', '#000000', '#808080', '#C0C0C0', '#FFFFFF',
  '#800000', '#FF0000', '#808000', '#FFFF00', '#008000',
  '#00FF00', '#000080', '#0000FF', '#800080', '#FF00FF',
  '#3A6EA5', '#A0A0A4', '#D4D0C8', '#F0F0F0', '#C8D0D4',
];

const IMAGE_EXTENSIONS = /\.(bmp|jpg|jpeg|png|gif|webp|ico)$/i;

// --- Helpers ---

function arrayBufferToDataUrl(data: ArrayBuffer, name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || 'png';
  const mimeMap: Record<string, string> = {
    bmp: 'image/bmp', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  };
  const mime = mimeMap[ext] || 'image/png';
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${mime};base64,${btoa(binary)}`;
}

// --- Monitor preview ---

function MonitorPreview({ color, imageUrl, mode }: { color: string; imageUrl: string | null; mode: string }) {
  const screenW = 152, screenH = 112;
  const monW = 180, monH = 150;
  const screenX = (monW - screenW) / 2, screenY = 8;

  let bgStyle: Record<string, string> = { backgroundColor: color };
  if (imageUrl) {
    bgStyle = {
      ...bgStyle,
      backgroundImage: `url(${imageUrl})`,
      backgroundRepeat: mode === 'tile' ? 'repeat' : 'no-repeat',
      backgroundPosition: 'center',
      backgroundSize: mode === 'stretch' ? '100% 100%' : mode === 'tile' ? 'auto' : 'contain',
    };
  }

  return (
    <div style={{ width: `${monW}px`, height: `${monH}px`, position: 'relative', margin: '0 auto' }}>
      <div style={{
        position: 'absolute', left: '0', top: '0', width: `${monW}px`, height: `${monH - 20}px`,
        background: '#C0C0C0', borderRadius: '4px 4px 0 0',
        border: '2px solid #808080', boxSizing: 'border-box',
      }}>
        <div style={{
          position: 'absolute', left: `${screenX - 2}px`, top: `${screenY}px`,
          width: `${screenW}px`, height: `${screenH}px`,
          border: '2px solid #404040', boxSizing: 'border-box',
          overflow: 'hidden', ...bgStyle,
        }} />
      </div>
      <div style={{
        position: 'absolute', bottom: '0', left: '50%', transform: 'translateX(-50%)',
        width: '60px', height: '18px', background: '#C0C0C0',
        border: '2px solid #808080', borderTop: 'none', borderRadius: '0 0 4px 4px',
      }} />
      <div style={{
        position: 'absolute', bottom: '0', left: '50%', transform: 'translateX(-50%)',
        width: '100px', height: '6px', background: '#C0C0C0',
        border: '2px solid #808080', borderRadius: '0 0 2px 2px',
      }} />
    </div>
  );
}

// --- Color picker popup ---

function ColorPicker({ current, onSelect, onClose }: {
  current: string; onSelect: (color: string) => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [onClose]);

  return (
    <div ref={ref} style={{
      position: 'absolute', bottom: '28px', left: '0', zIndex: 10,
      background: '#D4D0C8', border: '2px solid',
      borderColor: '#FFF #404040 #404040 #FFF', padding: '6px',
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 20px)', gap: '2px' }}>
        {COLOR_PALETTE.map(c => (
          <div
            key={c}
            onClick={() => { onSelect(c); onClose(); }}
            style={{
              width: '20px', height: '20px', background: c, cursor: 'var(--win2k-cursor)',
              border: c === current ? '2px solid #000' : '1px solid #808080',
              boxSizing: 'border-box',
            }}
          />
        ))}
      </div>
      <div style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
        <input
          type="color" value={current}
          onInput={(e) => { onSelect((e.target as HTMLInputElement).value); onClose(); }}
          style={{ width: '20px', height: '20px', padding: 0, border: 'none', cursor: 'var(--win2k-cursor)' }}
        />
        <span style={{ font: FONT, fontSize: '10px' }}>Custom...</span>
      </div>
    </div>
  );
}

// --- Main component ---

export function DisplayPropertiesDialog({ current, onApply, onClose, flashTrigger }: Props) {
  const s = t();
  const [color, setColor] = useState(current.color);
  const [imageDataUrl, setImageDataUrl] = useState(current.imageDataUrl);
  const [imageName, setImageName] = useState(current.imageName);
  const [mode, setMode] = useState(current.mode);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [showFileDlg, setShowFileDlg] = useState(false);
  const [imageList, setImageList] = useState<{ name: string; displayName: string }[]>([]);
  const [initialPos, setInitialPos] = useState<{ x: number; y: number } | undefined>();
  const [visible, setVisible] = useState(false);
  const [fileDlgFlash, setFileDlgFlash] = useState(0);
  const measureRef = useRef<HTMLDivElement>(null);

  // Create a standalone FileManager for the FileDialog
  const fileManager = useMemo(() => {
    const fm = new DefaultFileManager();
    fm.currentDrive = 'D';
    fm.currentDirs = new Map([['C', 'C:\\'], ['D', 'D:\\'], ['Z', 'Z:\\']]);
    fm.onFileRequest = (name: string) => getFile(name);
    return fm;
  }, []);
  const additionalFiles = useMemo(() => new Map<string, ArrayBuffer>(), []);

  // Center dialog on mount
  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const dlgRect = measureRef.current.getBoundingClientRect();
    const x = Math.max(0, (window.innerWidth - dlgRect.width) / 2);
    const y = Math.max(0, (window.innerHeight - dlgRect.height) / 2);
    setInitialPos({ x, y });
  }, []);

  useEffect(() => { if (initialPos) setVisible(true); }, [initialPos]);

  // Load image files from virtual FS (for list + FileManager.virtualFiles)
  useEffect(() => {
    getAllFiles().then(files => {
      fileManager.virtualFiles = files.map(f => ({ name: f.name, size: f.data.byteLength }));
      const images = files
        .filter(f => IMAGE_EXTENSIONS.test(f.name))
        .map(f => ({ name: f.name, displayName: f.name.replace(/\.[^.]+$/, '') }));
      setImageList(images);
    });
  }, [fileManager]);

  const handleSelectImage = useCallback(async (name: string) => {
    setImageName(name);
    const data = await getFile(name);
    if (data) setImageDataUrl(arrayBufferToDataUrl(data, name));
  }, []);

  const handleSelectNone = useCallback(() => {
    setImageName(null);
    setImageDataUrl(null);
  }, []);

  // FileDialog result handler
  const handleFileDialogResult = useCallback(async (result: { path: string; data?: ArrayBuffer } | null) => {
    setShowFileDlg(false);
    if (!result) return;
    const fileName = result.path.substring(result.path.lastIndexOf('\\') + 1);
    if (result.data) {
      // Imported from local computer (Z:\)
      setImageDataUrl(arrayBufferToDataUrl(result.data, fileName));
      setImageName(fileName);
    } else {
      // Selected from virtual FS (D:\)
      const data = await getFile(fileName);
      if (!data) {
        // Try fetching via fileManager for subdirectory files
        const fi = fileManager.findFile(result.path, additionalFiles);
        if (fi) {
          const buf = await fileManager.fetchFileData(fi, additionalFiles, result.path);
          if (buf) {
            setImageDataUrl(arrayBufferToDataUrl(buf, fileName));
            setImageName(fileName);
          }
        }
        return;
      }
      setImageDataUrl(arrayBufferToDataUrl(data, fileName));
      setImageName(fileName);
    }
  }, [fileManager, additionalFiles]);

  const buildSettings = useCallback((): BackgroundSettings => ({
    color, imageDataUrl, imageName, mode,
  }), [color, imageDataUrl, imageName, mode]);

  const handleOk = useCallback(() => {
    onApply(buildSettings());
    onClose();
  }, [onApply, onClose, buildSettings]);

  const handleApply = useCallback(() => {
    onApply(buildSettings());
  }, [onApply, buildSettings]);

  return (
    <div ref={measureRef} style={{
      visibility: visible ? 'visible' : 'hidden',
      position: 'absolute', zIndex: 300, font: FONT,
    }}>
      <Window
        title={s.displayProperties}
        style={WS_CAPTION | WS_SYSMENU}
        clientW={DIALOG_W}
        clientH={DIALOG_H}
        focused={!showFileDlg}
        draggable
        initialPos={initialPos}
        flashTrigger={flashTrigger}
        blocked={showFileDlg}
        onBlockedClick={() => setFileDlgFlash(c => c + 1)}
        onClose={onClose}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
          <div style={{ flex: 1, padding: '8px 8px 0 8px' }}>
            <TabControl tabs={[{ text: s.background }]} selectedIndex={0}>
              <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', boxSizing: 'border-box' }}>
                {/* Monitor preview */}
                <div style={{
                  background: '#D4D0C8', padding: '8px',
                  border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                  boxShadow: 'inset 1px 1px 0 #404040',
                }}>
                  <MonitorPreview color={color} imageUrl={imageDataUrl} mode={mode} />
                </div>

                {/* "Background:" label */}
                <span style={{ font: FONT }}>{s.wallpaper}:</span>

                {/* List + right-side controls (XP layout) */}
                <div style={{ flex: 1, display: 'flex', gap: '8px', minHeight: '60px' }}>
                  {/* Wallpaper list */}
                  <div style={{
                    flex: 1, background: '#FFF', overflow: 'auto',
                    border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                    boxShadow: 'inset 1px 1px 0 #404040',
                  }}>
                    <div
                      onClick={handleSelectNone}
                      style={{
                        padding: '1px 4px', cursor: 'var(--win2k-cursor)', font: FONT,
                        background: imageName === null ? '#0A246A' : 'transparent',
                        color: imageName === null ? '#FFF' : '#000',
                      }}
                    >
                      {s.bgNone}
                    </div>
                    {imageList.map(img => (
                      <div
                        key={img.name}
                        onClick={() => handleSelectImage(img.name)}
                        style={{
                          padding: '1px 4px', cursor: 'var(--win2k-cursor)', font: FONT,
                          background: imageName === img.name ? '#0A246A' : 'transparent',
                          color: imageName === img.name ? '#FFF' : '#000',
                        }}
                      >
                        {img.displayName}
                      </div>
                    ))}
                  </div>

                  {/* Right-side controls: Browse, Position, Color */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '95px', flexShrink: 0 }}>
                    {/* Browse button */}
                    <div style={{ height: '23px', cursor: 'var(--win2k-cursor)' }}
                      onClick={() => setShowFileDlg(true)}>
                      <Button fontCSS={FONT}>{s.browse}</Button>
                    </div>

                    {/* Position */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span style={{ font: FONT }}>{s.bgPosition}</span>
                      <select
                        value={mode}
                        onChange={(e) => setMode((e.target as HTMLSelectElement).value as BackgroundSettings['mode'])}
                        style={{
                          font: FONT, height: '22px', width: '100%', background: '#FFF',
                          border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                          boxShadow: 'inset 1px 1px 0 #404040', cursor: 'var(--win2k-cursor)',
                        }}
                      >
                        <option value="center">{s.bgCenter}</option>
                        <option value="tile">{s.bgTile}</option>
                        <option value="stretch">{s.bgStretch}</option>
                      </select>
                    </div>

                    {/* Color */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', position: 'relative' }}>
                      <span style={{ font: FONT }}>{s.bgColor}</span>
                      <div
                        onClick={() => setShowColorPicker(!showColorPicker)}
                        style={{
                          width: '100%', height: '22px', background: color, cursor: 'var(--win2k-cursor)',
                          border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                          boxShadow: 'inset 1px 1px 0 #404040', boxSizing: 'border-box',
                        }}
                      />
                      {showColorPicker && (
                        <ColorPicker current={color} onSelect={setColor} onClose={() => setShowColorPicker(false)} />
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </TabControl>
          </div>

          {/* OK / Cancel / Apply */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', padding: '6px 8px 8px' }}>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={handleOk}>
              <Button fontCSS={FONT} isDefault>{s.ok}</Button>
            </div>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={onClose}>
              <Button fontCSS={FONT}>{s.cancel}</Button>
            </div>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={handleApply}>
              <Button fontCSS={FONT}>{s.apply}</Button>
            </div>
          </div>
        </div>
      </Window>

      {/* FileDialog for browsing images */}
      {showFileDlg && (
        <FileDialog
          mode="open"
          filter={IMAGE_FILTER}
          initialDir="D:\\"
          fileManager={fileManager}
          additionalFiles={additionalFiles}
          onResult={handleFileDialogResult}
          focused
          flashTrigger={fileDlgFlash}
        />
      )}
    </div>
  );
}
