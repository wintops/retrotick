import { useState, useEffect } from 'preact/hooks';

export function CalendarPopup() {
  const [now, setNow] = useState(new Date());
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  // Localized narrow day names starting from Monday
  const dayHeaders = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 1 + i); // 2024-01-01 = Monday
    return d.toLocaleDateString(undefined, { weekday: 'narrow' });
  });

  const monthLabel = new Date(viewYear, viewMonth, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDow = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
  const startOffset = (firstDow + 6) % 7; // Monday-based

  const today = new Date();
  const isToday = (day: number) =>
    viewYear === today.getFullYear() && viewMonth === today.getMonth() && day === today.getDate();

  // Build grid with prev/next month filler days
  const cells: { day: number; current: boolean }[] = [];
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
  for (let i = startOffset - 1; i >= 0; i--) cells.push({ day: prevMonthDays - i, current: false });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, current: true });
  let nextDay = 1;
  while (cells.length % 7 !== 0) cells.push({ day: nextDay++, current: false });

  function prevMonthNav() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonthNav() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  const navBtn: Record<string, string | number> = {
    cursor: 'var(--win2k-cursor)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: '18px', height: '18px',
    background: '#D4D0C8', border: '1px solid',
    borderColor: '#FFF #404040 #404040 #FFF',
    fontSize: '8px',
  };

  return (
    <div
      onPointerDown={(e: Event) => e.stopPropagation()}
      style={{
        position: 'fixed', bottom: '32px', right: '4px',
        background: '#D4D0C8',
        border: '2px solid', borderColor: '#FFF #404040 #404040 #FFF',
        padding: '8px', zIndex: 10001,
        font: '11px "Tahoma", "MS Sans Serif", sans-serif',
        userSelect: 'none',
      }}
    >
      {/* Time with seconds */}
      <div style={{
        textAlign: 'center', fontSize: '18px',
        fontFamily: '"Courier New", monospace',
        padding: '2px 0 6px', fontWeight: 'bold',
        borderBottom: '1px solid #808080', marginBottom: '6px',
      }}>
        {timeStr}
      </div>

      {/* Month navigation */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
        <span onClick={prevMonthNav} style={navBtn}>◀</span>
        <span style={{ fontWeight: 'bold', textTransform: 'capitalize' }}>{monthLabel}</span>
        <span onClick={nextMonthNav} style={navBtn}>▶</span>
      </div>

      {/* Calendar grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 24px)', textAlign: 'center' }}>
        {dayHeaders.map((d, i) => (
          <div key={i} style={{ fontWeight: 'bold', padding: '2px 0', fontSize: '10px', color: '#808080' }}>{d}</div>
        ))}
        {cells.map((cell, i) => (
          <div key={i} style={{
            padding: '2px 0', fontSize: '11px', lineHeight: '16px',
            color: cell.current ? '#000' : '#C0C0C0',
            ...(cell.current && isToday(cell.day) ? { background: '#000080', color: '#FFF' } : {}),
          }}>
            {cell.day}
          </div>
        ))}
      </div>
    </div>
  );
}
