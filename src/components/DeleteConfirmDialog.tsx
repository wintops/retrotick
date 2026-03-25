import { isFolder, displayName } from '../lib/file-store';
import { Window, WS_CAPTION, WS_SYSMENU } from './win2k/Window';
import { Button } from './win2k/Button';
import { t } from '../lib/regional-settings';

export function DeleteConfirmDialog({ name, flashTrigger, onConfirm, onCancel, onFlash }: {
  name: string;
  flashTrigger: number;
  onConfirm: () => void;
  onCancel: () => void;
  onFlash: () => void;
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { e.preventDefault(); onFlash(); }}
      onContextMenu={(e: Event) => e.preventDefault()}>
      <div onPointerDown={(e) => e.stopPropagation()} style={{ font: '11px/1 "Tahoma", "MS Sans Serif", sans-serif', minWidth: '280px', maxWidth: '400px' }}>
        <Window title={isFolder(name) ? t().confirmFolderDelete : t().confirmFileDelete} style={WS_CAPTION | WS_SYSMENU} focused={true} draggable flashTrigger={flashTrigger} onClose={onCancel}>
          <div style={{ padding: '12px 12px 8px', display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
            <svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
              <circle cx="16" cy="16" r="14" fill="#FFFF00" stroke="#000" stroke-width="1"/>
              <rect x="14" y="7" width="4" height="12" fill="#000"/>
              <rect x="14" y="22" width="4" height="4" fill="#000"/>
            </svg>
            <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {isFolder(name)
                ? t().confirmDeleteFolder.replace('{0}', displayName(name))
                : t().confirmDeleteFile.replace('{0}', displayName(name))}
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '6px', padding: '4px 12px 8px' }}>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={onConfirm}>
              <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif' isDefault>{t().yes}</Button>
            </div>
            <div style={{ width: '75px', height: '23px', cursor: 'var(--win2k-cursor)' }} onClick={onCancel}>
              <Button fontCSS='11px/1 "Tahoma", "MS Sans Serif", sans-serif'>{t().no}</Button>
            </div>
          </div>
        </Window>
      </div>
    </div>
  );
}
