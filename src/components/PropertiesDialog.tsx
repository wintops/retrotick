import { t } from '../lib/regional-settings';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { Button } from './win2k/Button';
import { fileIcon32 } from './win2k/file-icons';

export interface PropertiesInfo {
  displayName: string;
  isFolder: boolean;
  isExe: boolean;
  iconUrl: string | null;
  size: number;
  addedAt: number;
  location: string;
  folderContents?: { files: number; folders: number; totalSize: number } | null;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString()} bytes)`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB (${bytes.toLocaleString()} bytes)`;
}

function getFileTypeName(name: string, isExe: boolean, isFolderEntry: boolean): string {
  if (isFolderEntry) return t().propFileFolder;
  if (isExe) return t().propApplication;
  const ext = name.split('.').pop()?.toUpperCase();
  return ext ? `${ext} File` : 'File';
}

function PropRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
      <div style={{ width: '90px', flexShrink: 0, color: '#000', textAlign: 'right' }}>{label}</div>
      <div style={{ flex: 1, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

export function PropertiesDialog({ info, flashTrigger, onClose }: {
  info: PropertiesInfo;
  flashTrigger: number;
  onClose: () => void;
}) {
  const fc = info.folderContents;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { e.preventDefault(); /* flash handled by parent */ }}
      onContextMenu={(e: Event) => e.preventDefault()}>
      <div onPointerDown={(e) => e.stopPropagation()} style={{ font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif', minWidth: '320px', maxWidth: '420px' }}>
        <Window title={`${info.displayName} ${t().properties}`} style={WS_CAPTION | WS_SYSMENU} focused={true} draggable flashTrigger={flashTrigger} onClose={onClose}>
          {/* Icon + name */}
          <div style={{ padding: '12px 16px 8px', display: 'flex', gap: '10px', alignItems: 'center', borderBottom: '1px solid #808080' }}>
            <div style={{ flexShrink: 0 }}>
              {fileIcon32(info.displayName, { isFolder: info.isFolder, iconUrl: info.iconUrl })}
            </div>
            <div style={{ fontWeight: 'bold', wordBreak: 'break-all' }}>{info.displayName}</div>
          </div>
          {/* Properties rows */}
          <div style={{ padding: '10px 16px 6px' }}>
            <PropRow label={t().propType} value={getFileTypeName(info.displayName, info.isExe, info.isFolder)} />
            <PropRow label={t().propLocation} value={info.location} />
            <PropRow label={t().propSize} value={
              info.isFolder
                ? (fc ? formatFileSize(fc.totalSize) : '...')
                : formatFileSize(info.size)
            } />
            {info.isFolder && fc && (
              <PropRow label={t().propContains} value={
                t().propFilesAndFolders.replace('{0}', String(fc.files)).replace('{1}', String(fc.folders))
              } />
            )}
            {info.addedAt > 0 && (
              <PropRow label={t().propCreated} value={new Date(info.addedAt).toLocaleString()} />
            )}
          </div>
          {/* OK button */}
          <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 16px 10px' }}>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={onClose}>
              <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif' isDefault>{t().ok}</Button>
            </div>
          </div>
        </Window>
      </div>
    </div>
  );
}
