import { useState, useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useLayoutEffect } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU } from './Window';
import { Button } from './Button';
import { MessageBox, MB_YESNO, MB_ICONWARNING, IDYES } from './MessageBox';
import type { FileManager, DirEntry } from '../../lib/emu/file-manager';
import { t } from '../../lib/regional-settings';
import { fileIcon16 } from './file-icons';

// --- Types ---

export interface FileDialogProps {
  mode: 'open' | 'save';
  filter?: string;       // Win32 format: "Text Files|*.txt|All Files|*.*"
  initialDir?: string;
  initialFileName?: string;
  title?: string;
  fileManager: FileManager;
  additionalFiles: Map<string, ArrayBuffer>;
  onResult: (result: FileDialogResult | null) => void;
  focused?: boolean;
  flashTrigger?: number;
  parentRef?: { current: HTMLDivElement | null };
}

export interface FileDialogResult {
  /** Full path in virtual FS (e.g., "D:\\README.TXT" or "Z:\\imported.txt") */
  path: string;
  /** File data — only set for imported files (from PC) */
  data?: ArrayBuffer;
}

// --- Constants ---

const FONT = '11px/1 "Tahoma", "MS Sans Serif", sans-serif';
const DIALOG_W = 420;
const DIALOG_H = 320;
const DRIVES = ['C', 'D', 'Z'];

// --- Helpers ---

function parseFilters(filter: string | undefined): { label: string; pattern: string }[] {
  if (!filter) return [{ label: 'All Files (*.*)', pattern: '*.*' }];
  const parts = filter.split('|');
  const result: { label: string; pattern: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    result.push({ label: `${parts[i]} (${parts[i + 1]})`, pattern: parts[i + 1] });
  }
  if (result.length === 0) result.push({ label: 'All Files (*.*)', pattern: '*.*' });
  return result;
}

function matchesFilter(name: string, pattern: string): boolean {
  const pats = pattern.split(';').map(p => p.trim());
  const uName = name.toUpperCase();
  for (const pat of pats) {
    const uPat = pat.toUpperCase();
    if (uPat === '*.*' || uPat === '*') return true;
    const regexStr = uPat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    if (new RegExp(`^${regexStr}$`).test(uName)) return true;
  }
  return false;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Icons ---

function DriveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <rect x="2" y="4" width="12" height="8" rx="1" fill="#C0C0C0" stroke="#808080" stroke-width="0.5" />
      <rect x="4" y="6" width="3" height="4" fill="#4040A0" />
      <circle cx="12" cy="8" r="1" fill="#00FF00" />
    </svg>
  );
}

// --- Up button icon ---
function UpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M3 10h3v3h4v-3h3L8 4z" fill="#808080" />
      <rect x="2" y="13" width="12" height="1" fill="#FFD700" stroke="#996600" stroke-width="0.3" />
    </svg>
  );
}

// --- New Folder icon ---
function NewFolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M1 3h5l1-1h5v1H7L6 4H1v8h12V5H7z" fill="#FFD700" stroke="#996600" stroke-width="0.3" />
      <rect x="1" y="4" width="12" height="8" fill="#FFD700" stroke="#996600" stroke-width="0.3" />
      <path d="M10 2v5M7.5 4.5h5" stroke="#FF0000" stroke-width="1.5" />
    </svg>
  );
}

// --- Toolbar button ---
function ToolbarButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: any;
}) {
  const [pressed, setPressed] = useState(false);
  return (
    <div
      onPointerDown={() => !disabled && setPressed(true)}
      onPointerUp={() => { setPressed(false); if (!disabled) onClick(); }}
      onPointerLeave={() => setPressed(false)}
      style={{
        width: '24px', height: '22px', display: 'flex', alignItems: 'center',
        justifyContent: 'center', cursor: disabled ? 'default' : 'var(--win2k-cursor)',
        background: '#D4D0C8', opacity: disabled ? 0.5 : 1,
        border: pressed ? '1px solid #808080' : '1px solid transparent',
        boxSizing: 'border-box',
      }}
    >
      {children}
    </div>
  );
}

// --- Main FileDialog component ---

export function FileDialog({
  mode, filter, initialDir, initialFileName, title, fileManager, additionalFiles,
  onResult, focused = true, flashTrigger, parentRef,
}: FileDialogProps) {
  const s = t();
  const defaultTitle = mode === 'open' ? s.open : s.saveAs;
  const dialogTitle = title || defaultTitle;
  const filters = useMemo(() => parseFilters(filter), [filter]);

  // State
  const [currentDir, setCurrentDir] = useState(() => {
    if (initialDir) {
      let d = initialDir.replace(/\//g, '\\').toUpperCase();
      if (!d.endsWith('\\')) d += '\\';
      return d;
    }
    return (fileManager.currentDirs.get(fileManager.currentDrive) || 'D:\\').toUpperCase();
  });
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [fileName, setFileName] = useState(initialFileName || '');
  const [filterIdx, setFilterIdx] = useState(0);
  const [driveOpen, setDriveOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [initialPos, setInitialPos] = useState<{ x: number; y: number } | undefined>();
  const [visible, setVisible] = useState(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState<string | null>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Center dialog on mount
  useLayoutEffect(() => {
    if (!measureRef.current) return;
    const dlgRect = measureRef.current.getBoundingClientRect();
    const parentRect = parentRef?.current?.getBoundingClientRect();
    const cx = parentRect ? parentRect.left + parentRect.width / 2 : window.innerWidth / 2;
    const cy = parentRect ? parentRect.top + parentRect.height / 2 : window.innerHeight / 2;
    const x = Math.max(0, Math.min(cx - dlgRect.width / 2, window.innerWidth - dlgRect.width));
    const y = Math.max(0, Math.min(cy - dlgRect.height / 2, window.innerHeight - dlgRect.height));
    setInitialPos({ x, y });
  }, []);

  useEffect(() => { if (initialPos) setVisible(true); }, [initialPos]);

  // Refresh file list
  const refreshEntries = useCallback(() => {
    const pattern = currentDir + '*.*';
    const raw = fileManager.getVirtualDirListing(pattern, additionalFiles);
    const activePattern = filters[filterIdx]?.pattern || '*.*';
    const filtered = raw.filter(e => {
      if (e.name === '.' || e.name === '..') return false;
      if (e.isDir) return true;
      return matchesFilter(e.name, activePattern);
    });
    filtered.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    setEntries(filtered);
  }, [currentDir, filterIdx, fileManager, additionalFiles, filters]);

  // Clear selection when directory or filter changes
  useEffect(() => { setSelectedName(null); }, [currentDir, filterIdx]);

  useEffect(() => {
    refreshEntries();
    // Re-query after a short delay in case virtualFiles is still loading from IndexedDB
    const timer = setTimeout(refreshEntries, 500);
    return () => clearTimeout(timer);
  }, [refreshEntries]);

  // Navigate into a directory
  const navigateTo = useCallback((dir: string) => {
    let d = dir.toUpperCase();
    if (!d.endsWith('\\')) d += '\\';
    setCurrentDir(d);
    setFileName('');
  }, []);

  // Go up one level
  const goUp = useCallback(() => {
    if (currentDir.length <= 3) return; // already at root
    const trimmed = currentDir.endsWith('\\') ? currentDir.slice(0, -1) : currentDir;
    const lastSlash = trimmed.lastIndexOf('\\');
    if (lastSlash >= 2) navigateTo(trimmed.substring(0, lastSlash + 1));
  }, [currentDir, navigateTo]);

  // Pre-fetch virtual file data (IndexedDB) into cache before returning result
  const confirmOpen = useCallback((path: string) => {
    if (mode === 'save') {
      // Check if file already exists — prompt for overwrite confirmation
      const existing = fileManager.findFile(path, additionalFiles);
      if (existing) {
        setOverwriteConfirm(path);
        return;
      }
      onResult({ path });
      return;
    }
    const fileInfo = fileManager.findFile(path, additionalFiles);
    if (fileInfo && fileInfo.source === 'virtual') {
      fileManager.fetchFileData(fileInfo, additionalFiles, path).then(() => {
        onResult({ path });
      });
    } else {
      onResult({ path });
    }
  }, [mode, fileManager, additionalFiles, onResult]);

  // Double-click entry
  const onDoubleClick = useCallback((entry: DirEntry) => {
    if (entry.isDir) {
      navigateTo(currentDir + entry.name);
    } else {
      confirmOpen(currentDir + entry.name);
    }
  }, [currentDir, navigateTo, confirmOpen]);

  // Single-click entry
  const onClickEntry = useCallback((entry: DirEntry) => {
    setSelectedName(entry.name);
    if (!entry.isDir) setFileName(entry.name);
  }, []);

  // Confirm selection (Open/Save button)
  const onConfirm = useCallback(() => {
    const name = fileName.trim();
    if (!name) return;

    // If the user typed a full path, use it directly
    if (/^[A-Za-z]:\\/.test(name)) {
      confirmOpen(name.toUpperCase());
      return;
    }

    // Check if it's a directory
    const sel = entries.find(e => e.name.toUpperCase() === name.toUpperCase());
    if (sel?.isDir) {
      navigateTo(currentDir + sel.name);
      return;
    }

    confirmOpen(currentDir + name.toUpperCase());
  }, [fileName, currentDir, entries, navigateTo, confirmOpen]);

  // Import from PC
  const onImportFromPC = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    // Apply filter
    const activePattern = filters[filterIdx]?.pattern || '*.*';
    if (activePattern !== '*.*' && activePattern !== '*') {
      const exts: string[] = [];
      activePattern.split(';').forEach(p => {
        const m = p.trim().match(/\*(\.\w+)/);
        if (m) exts.push(m[1]);
      });
      if (exts.length > 0) input.accept = exts.join(',');
    }
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      file.arrayBuffer().then(data => {
        const zPath = 'Z:\\' + file.name.toUpperCase();
        onResult({ path: zPath, data });
      });
    };
    input.addEventListener('cancel', () => { /* do nothing, dialog stays open */ });
    input.click();
  }, [filterIdx, filters, onResult]);

  // Create new folder
  const onNewFolder = useCallback(() => {
    const name = prompt(s.newFolderPrompt);
    if (!name) return;
    const path = currentDir + name.toUpperCase();
    fileManager.createDirectory(path);
    // Refresh
    setCurrentDir(prev => prev); // force re-render
    // Actually need to change to trigger useEffect
    setFilterIdx(prev => { setFilterIdx(prev); return prev; });
    navigateTo(currentDir); // triggers refresh
  }, [currentDir, fileManager, navigateTo]);

  // Handle Enter key on filename input
  const onFileNameKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
  }, [onConfirm]);

  // Current drive letter
  const currentDriveLetter = currentDir.length >= 2 ? currentDir[0] : 'D';
  const canGoUp = currentDir.length > 3;

  // Drive display name
  const driveLabel = (d: string) => {
    if (d === 'C') return '(C:) System';
    if (d === 'D') return '(D:) Desktop';
    if (d === 'Z') return '(Z:) Imported';
    return `(${d}:)`;
  };

  return (
    <div ref={measureRef} style={{
      visibility: visible ? 'visible' : 'hidden', position: 'absolute',
      font: FONT, width: `${DIALOG_W}px`, zIndex: 300,
    }}>
      <Window title={dialogTitle} style={WS_CAPTION | WS_SYSMENU}
        focused={focused} draggable initialPos={initialPos} flashTrigger={flashTrigger}
        onClose={() => onResult(null)}>
        <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '4px',
          width: `${DIALOG_W - 8}px`, height: `${DIALOG_H}px`, boxSizing: 'border-box' }}>

          {/* --- Top toolbar: Look in + navigation --- */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ whiteSpace: 'nowrap', font: FONT }}>{mode === 'open' ? s.lookIn : s.saveIn}</span>
            {/* Drive/path combo */}
            <div style={{ flex: 1, position: 'relative' }}>
              <div onClick={() => setDriveOpen(!driveOpen)} style={{
                display: 'flex', height: '22px', cursor: 'var(--win2k-cursor)',
              }}>
                <div style={{
                  flex: 1, background: '#FFF', boxSizing: 'border-box',
                  border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                  boxShadow: 'inset 1px 1px 0 #404040',
                  padding: '2px 4px', font: FONT, overflow: 'hidden', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: '4px',
                }}>
                  <DriveIcon />{' '}{currentDir.slice(0, -1) || currentDriveLetter + ':'}
                </div>
                <div style={{
                  width: '16px', background: '#D4D0C8', flexShrink: 0,
                  border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
                  boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  font: '8px/1 sans-serif', color: '#000',
                }}>{'\u25BC'}</div>
              </div>
              {/* Drive dropdown */}
              {driveOpen && (
                <div style={{
                  position: 'absolute', top: '22px', left: 0, right: 0, zIndex: 10,
                  background: '#FFF', border: '1px solid #808080',
                  boxShadow: '2px 2px 4px rgba(0,0,0,0.3)',
                }}>
                  {DRIVES.map(d => (
                    <div key={d} onClick={() => { navigateTo(d + ':\\'); setDriveOpen(false); }}
                      style={{
                        padding: '2px 4px', cursor: 'var(--win2k-cursor)', font: FONT,
                        display: 'flex', alignItems: 'center', gap: '4px',
                        background: d === currentDriveLetter ? '#0A246A' : '#FFF',
                        color: d === currentDriveLetter ? '#FFF' : '#000',
                      }}
                      onPointerEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '#0A246A';
                        (e.currentTarget as HTMLElement).style.color = '#FFF';
                      }}
                      onPointerLeave={(e) => {
                        if (d !== currentDriveLetter) {
                          (e.currentTarget as HTMLElement).style.background = '#FFF';
                          (e.currentTarget as HTMLElement).style.color = '#000';
                        }
                      }}
                    >
                      <DriveIcon /> {driveLabel(d)}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Toolbar buttons */}
            <ToolbarButton onClick={goUp} disabled={!canGoUp}><UpIcon /></ToolbarButton>
            <ToolbarButton onClick={onNewFolder}><NewFolderIcon /></ToolbarButton>
          </div>

          {/* --- File list area --- */}
          <div style={{
            flex: 1, background: '#FFF', boxSizing: 'border-box',
            border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
            boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
            overflowY: 'auto', overflowX: 'hidden',
          }}
            onClick={() => { setDriveOpen(false); setFilterOpen(false); }}
          >
            {entries.length === 0 && (
              <div style={{ padding: '8px', color: '#808080', font: FONT }}>
                {s.empty}
              </div>
            )}
            {entries.map(entry => {
              const isSelected = selectedName === entry.name;
              return (
                <div key={entry.name}
                  onClick={(e) => { e.stopPropagation(); onClickEntry(entry); }}
                  onDblClick={() => onDoubleClick(entry)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '4px',
                    padding: '1px 4px', cursor: 'var(--win2k-cursor)',
                    background: isSelected ? '#0A246A' : 'transparent',
                    color: isSelected ? '#FFF' : '#000',
                    font: FONT, whiteSpace: 'nowrap',
                  }}
                >
                  {fileIcon16(entry.name, { isFolder: entry.isDir })}
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.name}
                  </span>
                  {!entry.isDir && (
                    <span style={{ color: isSelected ? '#CCC' : '#808080', fontSize: '10px', marginLeft: '8px' }}>
                      {formatSize(entry.size)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* --- File name row --- */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ whiteSpace: 'nowrap', font: FONT, width: '76px' }}>{s.fileName}</span>
            <input
              type="text"
              value={fileName}
              onInput={(e) => setFileName((e.target as HTMLInputElement).value)}
              onKeyDown={onFileNameKeyDown}
              onClick={() => { setDriveOpen(false); setFilterOpen(false); }}
              style={{
                flex: 1, height: '22px', boxSizing: 'border-box',
                background: '#FFF',
                border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                boxShadow: 'inset 1px 1px 0 #404040',
                font: FONT, padding: '2px 4px', outline: 'none',
              }}
            />
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }}
              onClick={onConfirm}>
              <Button fontCSS={FONT} isDefault>{mode === 'open' ? s.open : s.save}</Button>
            </div>
          </div>

          {/* --- Filter row --- */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <span style={{ whiteSpace: 'nowrap', font: FONT, width: '76px' }}>{s.filesOfType}</span>
            {/* Filter combo */}
            <div style={{ flex: 1, position: 'relative' }}>
              <div onClick={() => { setFilterOpen(!filterOpen); setDriveOpen(false); }}
                style={{ display: 'flex', height: '22px', cursor: 'var(--win2k-cursor)' }}>
                <div style={{
                  flex: 1, background: '#FFF', boxSizing: 'border-box',
                  border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
                  boxShadow: 'inset 1px 1px 0 #404040',
                  padding: '2px 4px', font: FONT, overflow: 'hidden', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center',
                }}>
                  {filters[filterIdx]?.label || 'All Files (*.*)'}
                </div>
                <div style={{
                  width: '16px', background: '#D4D0C8', flexShrink: 0,
                  border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
                  boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  font: '8px/1 sans-serif', color: '#000',
                }}>{'\u25BC'}</div>
              </div>
              {filterOpen && (
                <div style={{
                  position: 'absolute', bottom: '22px', left: 0, right: 0, zIndex: 10,
                  background: '#FFF', border: '1px solid #808080',
                  boxShadow: '2px 2px 4px rgba(0,0,0,0.3)',
                }}>
                  {filters.map((f, i) => (
                    <div key={i}
                      onClick={() => { setFilterIdx(i); setFilterOpen(false); }}
                      style={{
                        padding: '2px 4px', cursor: 'var(--win2k-cursor)', font: FONT,
                        background: i === filterIdx ? '#0A246A' : '#FFF',
                        color: i === filterIdx ? '#FFF' : '#000',
                      }}
                      onPointerEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.background = '#0A246A';
                        (e.currentTarget as HTMLElement).style.color = '#FFF';
                      }}
                      onPointerLeave={(e) => {
                        if (i !== filterIdx) {
                          (e.currentTarget as HTMLElement).style.background = '#FFF';
                          (e.currentTarget as HTMLElement).style.color = '#000';
                        }
                      }}
                    >
                      {f.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }}
              onClick={() => onResult(null)}>
              <Button fontCSS={FONT}>{s.cancel}</Button>
            </div>
          </div>

          {/* --- Import from PC button --- */}
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '2px' }}>
            <div style={{ height: '23px', cursor: 'var(--win2k-cursor)', paddingLeft: '76px' }}
              onClick={onImportFromPC}>
              <div style={{ width: 'auto', height: '100%', display: 'inline-block' }}>
                <button
                  style={{
                    height: '100%', background: '#D4D0C8', cursor: 'var(--win2k-cursor)',
                    border: '1px solid', borderColor: '#FFF #404040 #404040 #FFF',
                    boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
                    font: FONT, padding: '0 8px', whiteSpace: 'nowrap',
                  }}
                >
                  {s.importFromPC}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Window>
      {overwriteConfirm && (
        <MessageBox
          caption={dialogTitle}
          text={s.confirmOverwrite.replace('{0}', overwriteConfirm.substring(overwriteConfirm.lastIndexOf('\\') + 1))}
          type={MB_YESNO | MB_ICONWARNING}
          focused
          onDismiss={(id) => {
            if (id === IDYES) onResult({ path: overwriteConfirm });
            setOverwriteConfirm(null);
          }}
        />
      )}
    </div>
  );
}
