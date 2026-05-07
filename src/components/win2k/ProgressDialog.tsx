import { Progress } from './Progress';

interface ProgressDialogProps {
  caption: string;
  message: string;
  /** 0-100 for a determinate bar; null for indeterminate (animated marquee). */
  percent: number | null;
}

/** Modal progress window in Win2k style. Used for export/import where there is
 *  no Cancel — the user is expected to wait. */
export function ProgressDialog({ caption, message, percent }: ProgressDialogProps) {
  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 99999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0, 0, 0, 0.15)',
    }}>
      <div style={{
        width: '360px',
        background: '#D4D0C8',
        border: '1px solid',
        borderColor: '#FFF #404040 #404040 #FFF',
        boxShadow: 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080, 2px 2px 4px rgba(0,0,0,0.3)',
        font: '11px "Tahoma", "MS Sans Serif", sans-serif',
        userSelect: 'none',
      }}>
        {/* Title bar */}
        <div style={{
          height: '18px', padding: '2px 4px',
          background: 'linear-gradient(to right, #0A246A 0%, #A6CAF0 100%)',
          color: '#FFF', fontWeight: 'bold',
          display: 'flex', alignItems: 'center',
        }}>
          {caption}
        </div>
        {/* Body */}
        <div style={{ padding: '14px 16px' }}>
          <div style={{ marginBottom: '10px', minHeight: '14px' }}>{message}</div>
          <div style={{ height: '18px' }}>
            <Progress percent={percent} />
          </div>
        </div>
      </div>
    </div>
  );
}
