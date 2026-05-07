interface ProgressProps {
  /** 0-100 for a determinate bar; null/undefined for indeterminate (animated marquee). */
  percent: number | null;
}

const STRIPE_GRADIENT =
  'repeating-linear-gradient(to right, #316AC5 0px, #316AC5 8px, #FFF 8px, #FFF 10px)';

/**
 * Win2k-style progress bar. When `percent` is `null`, renders an indeterminate
 * marquee animation by sliding the stripe pattern continuously to the right.
 */
export function Progress({ percent }: ProgressProps) {
  const indeterminate = percent === null;
  return (
    <>
      <style>{`@keyframes win2k-progress-marquee { from { background-position: 0 0; } to { background-position: 40px 0; } }`}</style>
      <div style={{
        width: '100%', height: '100%',
        border: '1px solid', borderColor: '#808080 #FFF #FFF #808080',
        boxShadow: 'inset 1px 1px 0 #404040, inset -1px -1px 0 #D4D0C8',
        background: '#FFF', overflow: 'hidden', padding: '2px',
        boxSizing: 'border-box',
      }}>
        <div style={indeterminate ? {
          width: '100%', height: '100%',
          background: STRIPE_GRADIENT,
          backgroundSize: '40px 100%',
          animation: 'win2k-progress-marquee 1s linear infinite',
        } : {
          width: `${percent}%`, height: '100%',
          background: STRIPE_GRADIENT,
        }} />
      </div>
    </>
  );
}
