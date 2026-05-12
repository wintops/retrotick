import { useState, useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { HlpFile } from '../lib/hlp';
import type { TopicHeader, Keyword } from '../lib/hlp';
import { rgbaToDataUrl } from '../lib/hlp/picture';
import { hashContext } from '../lib/hlp/hash';
import { executeMacros, type MacroHost } from '../lib/hlp/macro';
import {
  renderParagraphs, type RenderBitmap, type ClickAction, type ClickEvent,
} from '../lib/hlp/render';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
const CLIENT_W = 700;
const CLIENT_H = 520;

// Client insets used around the topic body. The reference uses `Rect.left
// += 3` etc. inside WM_PAINT, but the help main window is also created
// with WS_EX_CLIENTEDGE (`BYTE1(dwExStyle) = 2;` in CreateWindowExA) which
// adds a ~2 px sunken edge inside the frame. Our `Window` component
// doesn't reproduce that chrome, so we fold the extra ~2 px into the
// body padding to keep the first column of text away from the visible
// edge and let the title's negative leftIndent breathe.
const PAD_LEFT = 3 + 2;
const PAD_RIGHT = 8 + 2;
const PAD_TOP = 3;
const PAD_BOTTOM = 8;

interface Props {
  fileBytes: ArrayBuffer;
  fileName: string;
  onStop: () => void;
  onFocus: () => void;
  onMinimize: () => void;
  zIndex: number;
  focused: boolean;
  minimized: boolean;
}

interface HistoryEntry { vOffset: number; title: string; }

interface SecondaryState {
  topic: TopicHeader;
  pos: { x: number; y: number };
  size: { w: number; h: number };
  caption: string;
  bg: [number, number, number];
}

export function HelpViewerWindow({
  fileBytes, fileName, onStop, onFocus, onMinimize, zIndex, focused, minimized,
}: Props) {
  const hf = useMemo(() => {
    try { return new HlpFile(fileBytes); }
    catch (e) {
      console.error('[hlp] load failed:', e);
      return null;
    }
  }, [fileBytes]);

  // |SYSTEM window record carries position/size/flags. Treat values as raw
  // pixels (already authored against a 1024-px reference desktop) and
  // honor the maximize flag (bit 0x40 + SW_xxx == 3 means "open maximized").
  const winDef = hf?.system.windows[0];
  const captionTitleOverride = winDef?.caption?.replace(/^\x01/, '') || undefined;
  const fixedSize = !!winDef
    && (winDef.flags & 0x40) !== 0
    && winDef.maximize !== 0
    && winDef.maximize !== 3;

  const [maximized, setMaximized] = useState(() => {
    if (!winDef) return false;
    return (winDef.flags & 0x40) !== 0 && winDef.maximize === 3;
  });
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const [windowPos, setWindowPos] = useState(() => {
    if (winDef && (winDef.flags & 0x0C) === 0x0C) return { x: winDef.x, y: winDef.y };
    return { x: 80, y: 50 };
  });
  const [clientSize, setClientSize] = useState(() => {
    if (winDef && (winDef.flags & 0x30) === 0x30 && winDef.width > 0 && winDef.height > 0) {
      return { w: winDef.width, h: winDef.height };
    }
    return { w: CLIENT_W, h: CLIENT_H };
  });

  const handleMaximize = useCallback(() => {
    const TASKBAR_HEIGHT = 30;
    const CAPTION_H = 21;
    if (maximized) {
      const saved = preMaxState.current;
      if (saved) { setWindowPos({ x: saved.x, y: saved.y }); setClientSize({ w: saved.w, h: saved.h }); preMaxState.current = null; }
      setMaximized(false);
    } else {
      preMaxState.current = { x: windowPos.x, y: windowPos.y, w: clientSize.w, h: clientSize.h };
      setWindowPos({ x: 0, y: 0 });
      setClientSize({ w: window.innerWidth, h: window.innerHeight - TASKBAR_HEIGHT - CAPTION_H - 1 });
      setMaximized(true);
    }
  }, [maximized, windowPos, clientSize]);
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);

  const [keywordFilter, setKeywordFilter] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [current, setCurrent] = useState<TopicHeader | null>(null);
  const [popup, setPopup] = useState<{ topic: TopicHeader; anchor: { x: number; y: number } } | null>(null);
  const [secondaries, setSecondaries] = useState<Map<string, SecondaryState>>(new Map());

  const navigateTo = useCallback((topic: TopicHeader | null) => {
    if (!topic || !hf) return;
    setHistory(prev => current ? [...prev, { vOffset: current.vOffset, title: hf.titleOf(current.vOffset) || '(untitled)' }] : prev);
    setCurrent(topic);
  }, [current, hf]);

  /** Route a jump-style action to the correct window. WinHelp's window
   *  field is an index into |SYSTEM record-6 entries; when the target is
   *  "main" (case-insensitive) or unspecified, navigate the main viewer.
   *  Otherwise spawn or update a named secondary window with its own
   *  topic, position and size pulled from the |SYSTEM record. */
  const routeJump = useCallback((target: number, windowIdx: number | undefined) => {
    const t = hf?.topicByJumpTarget(target);
    if (!hf || !t) return;
    const winDef = (windowIdx !== undefined && windowIdx >= 0) ? hf.system.windows[windowIdx] : undefined;
    if (!winDef || !winDef.typeName || winDef.typeName.toLowerCase() === 'main') {
      setPopup(null);
      navigateTo(t);
      return;
    }
    const key = winDef.typeName;
    setSecondaries(prev => {
      const next = new Map(prev);
      const existing = next.get(key);
      next.set(key, {
        topic: t,
        pos: existing?.pos ?? { x: winDef.x > 0 ? winDef.x : 120, y: winDef.y > 0 ? winDef.y : 80 },
        size: existing?.size ?? {
          w: winDef.width > 0 ? winDef.width : 480,
          h: winDef.height > 0 ? winDef.height : 360,
        },
        caption: winDef.caption?.replace(/^\x01/, '') || winDef.typeName,
        bg: winDef.rgb[1] ?? [255, 255, 255],
      });
      return next;
    });
  }, [hf, navigateTo]);

  const closeSecondary = useCallback((key: string) => {
    setSecondaries(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const moveSecondary = useCallback((key: string, pos: { x: number; y: number }) => {
    setSecondaries(prev => {
      const e = prev.get(key);
      if (!e) return prev;
      const next = new Map(prev);
      next.set(key, { ...e, pos });
      return next;
    });
  }, []);

  const resizeSecondary = useCallback((key: string, size: { w: number; h: number }) => {
    setSecondaries(prev => {
      const e = prev.get(key);
      if (!e) return prev;
      const next = new Map(prev);
      next.set(key, { ...e, size });
      return next;
    });
  }, []);

  const setSecondaryTopic = useCallback((key: string, topic: TopicHeader) => {
    setSecondaries(prev => {
      const e = prev.get(key);
      if (!e) return prev;
      const next = new Map(prev);
      next.set(key, { ...e, topic });
      return next;
    });
  }, []);

  // ESC closes any open popup. Keep the listener mounted for the lifetime
  // of the viewer so it works regardless of which canvas has focus.
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPopup(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [popup]);

  const keywords = useMemo(() => hf ? [...hf.keywords()] : [], [hf]);

  useEffect(() => {
    if (!hf) return;
    const t = hf.contentsTopic();
    if (t) setCurrent(t);
    const host = makeHost(hf, navigateTo);
    for (const m of hf.system.startupMacros) {
      try { executeMacros(m, host); } catch (e) { console.warn('[hlp] startup macro failed:', e); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hf]);

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
      w = Math.max(360, w);
      h = Math.max(220, h);
      setClientSize({ w, h });
      setWindowPos({ x: px, y: py });
    };
    const onPointerUp = () => { moveDrag.current = null; resizeDrag.current = null; };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => { document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); };
  }, []);

  const onTitleBarMouseDown = useCallback((e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('span[style*="border"]')) return;
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: windowPos.x, startPosY: windowPos.y };
    onFocus();
  }, [windowPos, onFocus]);

  const handleBack = useCallback(() => {
    if (!hf || history.length === 0) return;
    const entry = history[history.length - 1];
    const target = hf.topicByOffset(entry.vOffset);
    if (target) {
      setCurrent(target);
      setHistory(prev => prev.slice(0, -1));
    }
  }, [hf, history]);

  const handleContents = useCallback(() => {
    if (!hf) return;
    const t = hf.contentsTopic();
    if (t) navigateTo(t);
  }, [hf, navigateTo]);

  const filteredKeywords = useMemo(() => {
    if (!keywordFilter) return keywords;
    const q = keywordFilter.toLowerCase();
    return keywords.filter(k => k.keyword.toLowerCase().includes(q));
  }, [keywords, keywordFilter]);

  const captionTitle = captionTitleOverride || hf?.system.title || fileName;

  if (!hf) {
    return (
      <Window
        title={`Help — ${fileName}`}
        style={WINDOW_STYLE}
        clientW={400}
        clientH={120}
        focused={focused}
        minimized={minimized}
        onClose={onStop}
        onMinimize={onMinimize}
        initialPos={windowPos}
      >
        <div style={{ padding: 16, font: '11px Tahoma' }}>
          Failed to open the help file. The file may be corrupted or use a format not yet supported.
        </div>
      </Window>
    );
  }

  return (
    <div
      style={{ position: 'absolute', left: `${windowPos.x}px`, top: `${windowPos.y}px`, zIndex, display: minimized ? 'none' : undefined }}
      onPointerDown={onFocus}
    >
      <Window
        title={captionTitle}
        style={fixedSize ? (WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX) : WINDOW_STYLE}
        clientW={clientSize.w}
        clientH={clientSize.h}
        focused={focused}
        minimized={minimized}
        maximized={maximized}
        onClose={onStop}
        onMinimize={onMinimize}
        onMaximize={fixedSize ? undefined : handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={fixedSize ? undefined : handleMaximize}
        onResizeStart={fixedSize ? undefined : onResizeStart}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '11px Tahoma, sans-serif' }}>
          {!fixedSize && (
            <Toolbar
              onContents={handleContents}
              onSearch={() => setSearchOpen(true)}
              onBack={handleBack}
              onPrint={() => window.print()}
              canBack={history.length > 0}
            />
          )}
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <TopicPane
              hf={hf}
              topic={current}
              onJumpAction={(target, win) => routeJump(target, win)}
              onPopupAction={(target, anchor, _win) => {
                const t = hf.topicByJumpTarget(target);
                if (t) setPopup({ topic: t, anchor });
              }}
              onContextString={(ctx) => {
                setPopup(null);
                const t = hf.topicByContext(ctx);
                if (t) navigateTo(t);
              }}
              onMacro={(macro) => {
                setPopup(null);
                const host = makeHost(hf, navigateTo);
                try { executeMacros(macro, host); }
                catch (e) { console.warn('[hlp] macro failed:', macro, e); }
              }}
            />
          </div>
        </div>
      </Window>
      {searchOpen && (
        <SearchDialog
          keywords={filteredKeywords}
          filter={keywordFilter}
          onFilterChange={setKeywordFilter}
          onClose={() => setSearchOpen(false)}
          onPick={(kw) => {
            if (kw.topicOffsets.length === 0) return;
            const t = hf.topicByOffset(kw.topicOffsets[0]);
            if (t) navigateTo(t);
            setSearchOpen(false);
          }}
        />
      )}
      {[...secondaries.entries()].map(([key, sec]) => (
        <SecondaryWindow
          key={key}
          hf={hf}
          state={sec}
          baseZ={zIndex + 1}
          onClose={() => closeSecondary(key)}
          onMove={(pos) => moveSecondary(key, pos)}
          onResize={(size) => resizeSecondary(key, size)}
          onSetTopic={(t) => setSecondaryTopic(key, t)}
          onMainJump={(target, win) => routeJump(target, win)}
          onPopup={(target, anchor) => {
            const t = hf.topicByJumpTarget(target);
            if (t) setPopup({ topic: t, anchor });
          }}
          onMacro={(macro) => {
            setPopup(null);
            const host = makeHost(hf, navigateTo);
            try { executeMacros(macro, host); }
            catch (e) { console.warn('[hlp] macro failed:', macro, e); }
          }}
        />
      ))}
      {popup && (
        <PopupView
          hf={hf}
          topic={popup.topic}
          anchor={popup.anchor}
          onClose={() => setPopup(null)}
          onJump={(target) => {
            setPopup(null);
            const t = hf.topicByJumpTarget(target);
            if (t) navigateTo(t);
          }}
          onChainPopup={(target, anchor) => {
            const t = hf.topicByJumpTarget(target);
            if (t) setPopup({ topic: t, anchor });
          }}
          onMacro={(macro) => {
            setPopup(null);
            const host = makeHost(hf, navigateTo);
            try { executeMacros(macro, host); }
            catch (e) { console.warn('[hlp] macro failed:', macro, e); }
          }}
        />
      )}
    </div>
  );
}

// --- Toolbar -----------------------------------------------------------

function Toolbar({ onContents, onSearch, onBack, onPrint, canBack }:
  { onContents: () => void; onSearch: () => void; onBack: () => void; onPrint: () => void;
    canBack: boolean; }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 4, background: '#D4D0C8', borderBottom: '1px solid #808080' }}>
      <ToolbarButton label="Contents" onClick={onContents} />
      <ToolbarButton label="Search" onClick={onSearch} />
      <ToolbarButton label="Back" onClick={onBack} disabled={!canBack} />
      <span style={{ flex: 1 }} />
      <ToolbarButton label="Print" onClick={onPrint} />
    </div>
  );
}

function ToolbarButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  const [pressed, setPressed] = useState(false);
  const sunken = pressed && !disabled;
  return (
    <button
      onPointerDown={() => !disabled && setPressed(true)}
      onPointerUp={() => { if (!disabled) { setPressed(false); onClick(); } }}
      onPointerLeave={() => setPressed(false)}
      disabled={disabled}
      style={{
        padding: '3px 10px',
        font: '11px Tahoma',
        background: '#D4D0C8',
        border: '1px solid',
        borderColor: sunken ? '#404040 #FFF #FFF #404040' : '#FFF #404040 #404040 #FFF',
        boxShadow: sunken ? 'none' : 'inset 1px 1px 0 #D4D0C8, inset -1px -1px 0 #808080',
        color: disabled ? '#808080' : '#000',
        textShadow: disabled ? '1px 1px 0 #FFF' : 'none',
        cursor: disabled ? 'default' : 'pointer',
        userSelect: 'none',
      }}
    >
      {label}
    </button>
  );
}

// --- Search dialog ----------------------------------------------------

function SearchDialog({ keywords, filter, onFilterChange, onClose, onPick }: {
  keywords: Keyword[];
  filter: string;
  onFilterChange: (s: string) => void;
  onClose: () => void;
  onPick: (kw: Keyword) => void;
}) {
  const [selected, setSelected] = useState<string | null>(keywords[0]?.keyword ?? null);
  useEffect(() => {
    if (!filter) return;
    const q = filter.toLowerCase();
    const hit = keywords.find(k => k.keyword.toLowerCase().startsWith(q));
    if (hit) setSelected(hit.keyword);
  }, [filter, keywords]);
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100000,
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
           style={{
             width: 380, padding: 12, background: '#D4D0C8',
             border: '1px solid', borderColor: '#FFFFFF #404040 #404040 #FFFFFF',
             boxShadow: '2px 2px 8px rgba(0,0,0,0.4)',
             font: '11px Tahoma, sans-serif',
             display: 'flex', flexDirection: 'column', gap: 8,
           }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontWeight: 'bold' }}>Search</span>
          <button onClick={onClose}
                  style={{ width: 18, height: 18, padding: 0, font: '10px Tahoma', cursor: 'pointer' }}>×</button>
        </div>
        <div>Type the first few letters of the word you're looking for:</div>
        <input
          autoFocus
          type="text"
          value={filter}
          onInput={(e) => onFilterChange((e.target as HTMLInputElement).value)}
          style={{ padding: '2px 4px', font: '11px Tahoma',
                   border: '1px solid', borderColor: '#404040 #FFF #FFF #404040' }}
        />
        <div>Then click an index entry below, and click Display:</div>
        <div style={{ flex: '0 0 auto', height: 200, overflowY: 'auto', background: '#FFF',
                      border: '1px solid', borderColor: '#404040 #FFF #FFF #404040' }}>
          {keywords.map(kw => (
            <div key={kw.keyword}
                 onClick={() => setSelected(kw.keyword)}
                 onDblClick={() => onPick(kw)}
                 ref={el => { if (el && kw.keyword === selected) el.scrollIntoView({ block: 'nearest' }); }}
                 style={{
                   padding: '2px 6px', cursor: 'pointer',
                   background: kw.keyword === selected ? '#000080' : 'transparent',
                   color: kw.keyword === selected ? '#FFF' : '#000',
                   whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                   userSelect: 'none',
                 }}>
              {kw.keyword}
            </div>
          ))}
          {keywords.length === 0 && (
            <div style={{ padding: 8, color: '#808080', font: 'italic 11px Tahoma' }}>
              No index entries match.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <ToolbarButton label="Display"
                         onClick={() => {
                           const kw = keywords.find(k => k.keyword === selected);
                           if (kw) onPick(kw);
                         }} />
          <ToolbarButton label="Cancel" onClick={onClose} />
        </div>
      </div>
    </div>
  );
}

// --- Topic pane -------------------------------------------------------

function TopicPane({ hf, topic, onJumpAction, onPopupAction, onContextString, onMacro }: {
  hf: HlpFile;
  topic: TopicHeader | null;
  onJumpAction: (hash: number, window: number | undefined) => void;
  onPopupAction: (hash: number, anchor: { x: number; y: number }, window: number | undefined) => void;
  onContextString: (ctx: string) => void;
  onMacro: (macro: string) => void;
}) {
  const split = useMemo(() => topic ? hf.topicSplit(topic) : { nonScroll: [], scroll: [] }, [hf, topic]);
  const paragraphs = useMemo(() => [...split.nonScroll, ...split.scroll], [split]);

  // Build a picture lookup once per topic. The picture opcode comes in
  // two forms — type 0x03 carries the |bm index in bytes 0..1, type 0x22
  // (HCW4) in bytes 2..3 — so we collect every unique id seen and decode
  // once. Each entry holds a sync data URL plus the SHG hotspot rects.
  const bitmaps = useMemo(() => {
    const ids = new Set<number>();
    for (const p of paragraphs) {
      for (const e of p.events) {
        if (e.kind !== 'picture') continue;
        if (e.type === 0x03 && e.payload.length >= 2) {
          ids.add(new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(0, true));
        } else if (e.type === 0x22 && e.payload.length >= 4) {
          ids.add(new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(2, true));
        }
      }
    }
    const m = new Map<number, RenderBitmap>();
    for (const id of ids) {
      const pic = hf.bitmap(id);
      if (!pic) continue;
      const url = rgbaToDataUrl(pic);
      if (url) m.set(id, { url, width: pic.width, height: pic.height, hotspots: pic.hotspots });
    }
    return m;
  }, [hf, paragraphs]);

  // Fallback only fires when the link decoded to nothing renderable.
  const useFallback = useMemo(() => {
    if (paragraphs.length === 0) return false;
    for (const p of paragraphs) {
      for (const e of p.events) {
        if (e.kind === 'text' && e.bytes.length > 0) return false;
        if (e.kind === 'picture' || e.kind === 'jump' || e.kind === 'popup'
            || e.kind === 'macroHotspot' || e.kind === 'crossFile') return false;
      }
    }
    return true;
  }, [paragraphs]);

  const fallbackText = useMemo(() => {
    if (!useFallback || !topic) return '';
    const link = hf.rawLink(topic.vOffset);
    if (!link) return '';
    const parts: string[] = [];
    for (const p of hf.topicReader.paragraphs(link)) {
      const t = extractAsciiRuns(p.linkData1, p.linkData2);
      if (t) parts.push(t);
    }
    return parts.join('\n\n');
  }, [useFallback, topic, hf]);

  const baseFontIdx = hf.system.defaultFont?.fontNumber ?? 0;

  const handleAction = useCallback((ev: ClickEvent) => {
    const action = ev.action;
    const anchor = { x: ev.clientX, y: ev.clientY };
    switch (action.kind) {
      case 'jump': onJumpAction(action.hash, action.window); break;
      case 'popup': onPopupAction(action.hash, anchor, action.window); break;
      case 'macro': onMacro(action.macro); break;
      case 'context': onContextString(action.context); break;
      case 'crossFile':
        if (action.popup) onPopupAction(action.hash, anchor, action.window);
        else onJumpAction(action.hash, action.window);
        break;
    }
  }, [onJumpAction, onPopupAction, onMacro, onContextString]);

  const nonScrollNodes = useMemo(() =>
    renderParagraphs(split.nonScroll, { fontTable: hf.font, bitmaps, initialFontIdx: baseFontIdx, onAction: handleAction }),
    [split.nonScroll, hf.font, bitmaps, baseFontIdx, handleAction],
  );
  const scrollNodes = useMemo(() =>
    renderParagraphs(split.scroll, { fontTable: hf.font, bitmaps, initialFontIdx: baseFontIdx, onAction: handleAction }),
    [split.scroll, hf.font, bitmaps, baseFontIdx, handleAction],
  );

  const showNonScroll = split.nonScroll.length > 0 && !useFallback;
  // The browser does reflow/word-wrap — we only set up the client-area
  // insets here. Padding matches WinHelp's WM_PAINT clip rect
  // (+3 left/top, -8 right/bottom) plus 2 px for the missing
  // WS_EX_CLIENTEDGE sunken edge.
  const bodyPad: Record<string, string> = {
    paddingLeft: `${PAD_LEFT}px`,
    paddingRight: `${PAD_RIGHT}px`,
    paddingTop: `${PAD_TOP}px`,
    paddingBottom: `${PAD_BOTTOM}px`,
  };
  // Reset the scroll position to the top whenever a different topic is
  // shown. WinHelp scrolls back to the start of a topic on every jump —
  // otherwise the user lands halfway through the new content and gets
  // disoriented. Keying off `topic` (the TopicHeader identity) is enough:
  // a re-render with the same topic (e.g. width change) keeps the scroll.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = 0;
  }, [topic]);
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#FFFFFF', overflow: 'hidden' }}>
      {showNonScroll && (
        <div style={{
          background: '#C0C0C0',
          borderBottom: '1px solid #808080',
          flex: '0 0 auto',
          ...bodyPad,
          paddingBottom: '6px',
        }}>
          {nonScrollNodes}
        </div>
      )}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', ...bodyPad }}>
        {paragraphs.length === 0 && (
          <div style={{ color: '#666' }}>(No body content for this topic.)</div>
        )}
        {useFallback ? (
          <>
            <div style={{ font: 'italic 11px Tahoma', color: '#888', marginBottom: 8 }}>
              (Could not decode this topic's structure — showing raw extracted text.)
            </div>
            <pre style={{ font: '12px "Times New Roman", serif', whiteSpace: 'pre-wrap', color: '#000', margin: 0 }}>
              {fallbackText || '(no readable text extracted)'}
            </pre>
          </>
        ) : (
          scrollNodes
        )}
      </div>
    </div>
  );
}

// --- Secondary window -------------------------------------------------

/** Floating secondary window declared via |SYSTEM record 6. WinHelp uses
 *  these for glossary panels, procedure boxes and similar sidekick views
 *  spawned from a jump that names a non-main window. Each secondary keeps
 *  its own current topic, drag/resize position and caption; closing it
 *  removes its state from the parent. */
function SecondaryWindow({ hf, state, baseZ, onClose, onMove, onResize, onSetTopic, onMainJump, onPopup, onMacro }: {
  hf: HlpFile;
  state: SecondaryState;
  baseZ: number;
  onClose: () => void;
  onMove: (pos: { x: number; y: number }) => void;
  onResize: (size: { w: number; h: number }) => void;
  onSetTopic: (t: TopicHeader) => void;
  onMainJump: (target: number, window: number | undefined) => void;
  onPopup: (target: number, anchor: { x: number; y: number }) => void;
  onMacro: (macro: string) => void;
}) {
  const moveDrag = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number } | null>(null);
  const resizeDrag = useRef<{ edge: string; startX: number; startY: number; startW: number; startH: number; startPosX: number; startPosY: number } | null>(null);
  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const m = moveDrag.current;
      if (m) { onMove({ x: m.startPosX + e.clientX - m.startX, y: m.startPosY + e.clientY - m.startY }); return; }
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
      onResize({ w: Math.max(220, w), h: Math.max(140, h) });
      onMove({ x: px, y: py });
    };
    const onPointerUp = () => { moveDrag.current = null; resizeDrag.current = null; };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    return () => { document.removeEventListener('pointermove', onPointerMove); document.removeEventListener('pointerup', onPointerUp); };
  }, [onMove, onResize]);

  const titleDown = useCallback((e: PointerEvent) => {
    e.preventDefault();
    moveDrag.current = { startX: e.clientX, startY: e.clientY, startPosX: state.pos.x, startPosY: state.pos.y };
  }, [state.pos]);
  const resizeStart = useCallback((edge: string, e: PointerEvent) => {
    e.preventDefault();
    resizeDrag.current = { edge, startX: e.clientX, startY: e.clientY, startW: state.size.w, startH: state.size.h, startPosX: state.pos.x, startPosY: state.pos.y };
  }, [state.size, state.pos]);

  return (
    <div style={{ position: 'absolute', left: state.pos.x, top: state.pos.y, zIndex: baseZ }}>
      <Window
        title={state.caption}
        style={WS_CAPTION | WS_SYSMENU | WS_THICKFRAME}
        clientW={state.size.w}
        clientH={state.size.h}
        focused
        onClose={onClose}
        onTitleBarMouseDown={titleDown}
        onResizeStart={resizeStart}
      >
        <TopicPane
          hf={hf}
          topic={state.topic}
          onJumpAction={(target, win) => {
            // Jumps inside a secondary stay in the secondary unless the
            // target action specifies "main" or another window.
            const winDef = (win !== undefined && win >= 0) ? hf.system.windows[win] : undefined;
            if (winDef && winDef.typeName && winDef.typeName.toLowerCase() !== 'main' && winDef.typeName === state.caption) {
              const t = hf.topicByJumpTarget(target);
              if (t) onSetTopic(t);
              return;
            }
            if (!win || !winDef || winDef.typeName.toLowerCase() === state.caption.toLowerCase()) {
              const t = hf.topicByJumpTarget(target);
              if (t) onSetTopic(t);
              return;
            }
            onMainJump(target, win);
          }}
          onPopupAction={(target, anchor, _win) => onPopup(target, anchor)}
          onContextString={(ctx) => {
            const t = hf.topicByContext(ctx);
            if (t) onSetTopic(t);
          }}
          onMacro={onMacro}
        />
      </Window>
    </div>
  );
}

// --- Popup overlay ----------------------------------------------------

const POPUP_MAX_WIDTH = 360;
const POPUP_PAD = 6;

/** Floating popup window — WinHelp's pale-yellow "definition" box. Anchors
 *  next to the hotspot the user clicked, flips up if it would run past
 *  the viewport bottom, and dismisses on outside click or ESC. Hotspots
 *  inside the popup work just like top-level ones (popups chain). */
function PopupView({ hf, topic, anchor, onClose, onJump, onChainPopup, onMacro }: {
  hf: HlpFile;
  topic: TopicHeader;
  anchor: { x: number; y: number };
  onClose: () => void;
  onJump: (hash: number) => void;
  onChainPopup: (hash: number, anchor: { x: number; y: number }) => void;
  onMacro: (macro: string) => void;
}) {
  const split = useMemo(() => hf.topicSplit(topic), [hf, topic]);
  // Popups present a single block — no non-scroll banner separation, so
  // merge both regions.
  const paragraphs = useMemo(() => [...split.nonScroll, ...split.scroll], [split]);

  const bitmaps = useMemo(() => {
    const ids = new Set<number>();
    for (const p of paragraphs) for (const e of p.events) {
      if (e.kind !== 'picture') continue;
      if (e.type === 0x03 && e.payload.length >= 2) {
        ids.add(new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(0, true));
      } else if (e.type === 0x22 && e.payload.length >= 4) {
        ids.add(new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(2, true));
      }
    }
    const m = new Map<number, RenderBitmap>();
    for (const id of ids) {
      const pic = hf.bitmap(id);
      if (!pic) continue;
      const url = rgbaToDataUrl(pic);
      if (url) m.set(id, { url, width: pic.width, height: pic.height, hotspots: pic.hotspots });
    }
    return m;
  }, [hf, paragraphs]);

  const handle = useCallback((e: ClickEvent) => {
    const a = e.action;
    const where = { x: e.clientX, y: e.clientY };
    switch (a.kind) {
      case 'jump': onJump(a.hash); break;
      case 'popup': onChainPopup(a.hash, where); break;
      case 'macro': onMacro(a.macro); break;
      case 'crossFile': a.popup ? onChainPopup(a.hash, where) : onJump(a.hash); break;
      case 'context': onJump(0); break;
    }
  }, [onJump, onChainPopup, onMacro]);

  const nodes = useMemo(() => renderParagraphs(paragraphs, {
    fontTable: hf.font, bitmaps,
    initialFontIdx: hf.system.defaultFont?.fontNumber ?? 0,
    onAction: handle,
  }), [paragraphs, hf.font, bitmaps, hf.system.defaultFont, handle]);

  // Anchor near the click. Flip up if the popup would run past the
  // viewport bottom; clamp left if it would overflow the right edge.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768;
  const popupRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: anchor.x + 12, y: anchor.y + 16 });
  useEffect(() => {
    const el = popupRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = anchor.x + 12;
    let y = anchor.y + 16;
    if (x + rect.width + 4 > vw) x = Math.max(4, vw - rect.width - 4);
    if (y + rect.height + 4 > vh) y = Math.max(4, anchor.y - rect.height - 8);
    setPos({ x, y });
  }, [anchor.x, anchor.y, vw, vh]);

  return (
    <>
      {/* Click-outside catcher — full-viewport transparent layer beneath
          the popup that swallows clicks and dismisses it. */}
      <div
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
        style={{ position: 'fixed', inset: 0, zIndex: 99998, background: 'transparent' }}
      />
      <div
        ref={popupRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: pos.x, top: pos.y,
          maxWidth: POPUP_MAX_WIDTH,
          zIndex: 99999,
          background: 'rgb(255,255,203)',
          border: '1px solid #000',
          boxShadow: '2px 2px 6px rgba(0,0,0,0.35)',
          padding: `${POPUP_PAD}px`,
        }}
      >
        {nodes}
      </div>
    </>
  );
}

// --- Helpers ----------------------------------------------------------

/** Last-resort text extractor: scan all link bytes and emit any contiguous
 *  printable runs >= 3 characters. Used only when paragraph decoding
 *  produced nothing renderable. */
export function extractAsciiRuns(linkData1: Uint8Array, linkData2: Uint8Array, minLen = 3): string {
  const all = new Uint8Array(linkData1.length + linkData2.length);
  all.set(linkData1, 0);
  all.set(linkData2, linkData1.length);
  const runs: string[] = [];
  let run = '';
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (c >= 0x20 && c < 0x7F) run += String.fromCharCode(c);
    else if (c >= 0xA0) run += String.fromCharCode(c);
    else {
      if (run.length >= minLen) runs.push(run);
      run = '';
    }
  }
  if (run.length >= minLen) runs.push(run);
  return runs.join(' ').replace(/\s+/g, ' ').trim();
}

function makeHost(hf: HlpFile, navigateTo: (t: TopicHeader | null) => void): MacroHost {
  const noop = () => {};
  return {
    jumpId: (_file, ctx) => navigateTo(hf.topicByContext(ctx)),
    jumpContext: (_file, n) => navigateTo(hf.topicByContextNumber(n)),
    jumpHash: (_file, h) => navigateTo(hf.topicByHash(h)),
    popupId: (_file, ctx) => navigateTo(hf.topicByContext(ctx)),
    popupContext: (_file, n) => navigateTo(hf.topicByContextNumber(n)),
    popupHash: (_file, h) => navigateTo(hf.topicByHash(h)),
    back: noop,
    contents: () => navigateTo(hf.contentsTopic()),
    search: noop, finder: noop, history: noop, next: noop, prev: noop,
    about: noop, exit: noop, print: noop,
    closeWindow: noop, focusWindow: noop,
    testALink: () => false, testKLink: () => false,
    klink: (name) => {
      const k = hf.lookupKeyword(name);
      if (k && k.topicOffsets.length > 0) navigateTo(hf.topicByOffset(k.topicOffsets[0]));
    },
    alink: (name) => {
      const cleaned = name.replace(/;$/, '');
      const k = hf.lookupAlink(cleaned);
      if (k && k.topicOffsets.length > 0) {
        navigateTo(hf.topicByOffset(k.topicOffsets[0]));
      } else {
        console.warn('[hlp] ALink', cleaned, 'has no matching topic');
      }
    },
    shellExecute: noop, execFile: noop,
    annotate: noop, bookmarkDefine: noop,
  };
}

// Keep hashContext import alive in case future hotspot variants need it.
void hashContext;
