import { useState, useCallback, useEffect, useMemo, useRef } from 'preact/hooks';
import { Window, WS_CAPTION, WS_SYSMENU, WS_MINIMIZEBOX, WS_MAXIMIZEBOX, WS_THICKFRAME } from './win2k/Window';
import { HlpFile } from '../lib/hlp';
import type { TopicHeader, DecodedParagraph, RenderEvent, FontDescriptor, HlpPicture, Keyword } from '../lib/hlp';
import { FONT_BOLD, FONT_ITALIC, FONT_UNDERLINE, FONT_STRIKEOUT } from '../lib/hlp/font';
import { rgbaToBlob } from '../lib/hlp/picture';
import { useBlobUrls } from '../hooks/useBlobUrls';
import { executeMacros, type MacroHost } from '../lib/hlp/macro';

const WINDOW_STYLE = WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_THICKFRAME;
const CLIENT_W = 700;
const CLIENT_H = 520;

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

export function HelpViewerWindow({
  fileBytes, fileName, onStop, onFocus, onMinimize, zIndex, focused, minimized,
}: Props) {
  const [maximized, setMaximized] = useState(false);
  const preMaxState = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const hf = useMemo(() => {
    try { return new HlpFile(fileBytes); }
    catch (e) {
      console.error('[hlp] load failed:', e);
      return null;
    }
  }, [fileBytes]);

  const [windowPos, setWindowPos] = useState({ x: 80, y: 50 });
  const [clientSize, setClientSize] = useState({ w: CLIENT_W, h: CLIENT_H });

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
  const { createUrl } = useBlobUrls();

  const keywords = useMemo(() => hf ? [...hf.keywords()] : [], [hf]);

  const navigateTo = useCallback((topic: TopicHeader | null) => {
    if (!topic || !hf) return;
    setHistory(prev => current ? [...prev, { vOffset: current.vOffset, title: hf.titleOf(current.vOffset) || '(untitled)' }] : prev);
    setCurrent(topic);
  }, [current, hf]);

  // Initial topic
  useEffect(() => {
    if (!hf) return;
    const t = hf.contentsTopic();
    if (t) setCurrent(t);
    // Run startup macros
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

  const titleStr = current && hf ? (hf.titleOf(current.vOffset) || '(untitled)') : (hf?.system.title || 'Help');
  const captionTitle = `${hf?.system.title || fileName}`;

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
        style={WINDOW_STYLE}
        clientW={clientSize.w}
        clientH={clientSize.h}
        focused={focused}
        minimized={minimized}
        maximized={maximized}
        onClose={onStop}
        onMinimize={onMinimize}
        onMaximize={handleMaximize}
        onTitleBarMouseDown={onTitleBarMouseDown}
        onTitleBarDblClick={handleMaximize}
        onResizeStart={onResizeStart}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '11px Tahoma, sans-serif' }}>
          <Toolbar
            onContents={handleContents}
            onSearch={() => setSearchOpen(true)}
            onBack={handleBack}
            onPrint={() => window.print()}
            canBack={history.length > 0}
          />
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <TopicPane
              hf={hf}
              topic={current}
              title={titleStr}
              onJumpHash={(target) => {
                const t = hf.topicByJumpTarget(target);
                if (t) navigateTo(t);
              }}
              onMacro={(macro) => {
                const host = makeHost(hf, navigateTo);
                try { executeMacros(macro, host); }
                catch (e) { console.warn('[hlp] macro failed:', macro, e); }
              }}
              createUrl={createUrl}
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

// --- Search dialog (popup keyword index) ------------------------------

function SearchDialog({ keywords, filter, onFilterChange, onClose, onPick }: {
  keywords: Keyword[];
  filter: string;
  onFilterChange: (s: string) => void;
  onClose: () => void;
  onPick: (kw: Keyword) => void;
}) {
  const [selected, setSelected] = useState<string | null>(keywords[0]?.keyword ?? null);
  // Track scroll-to-keyword: as the user types, jump the listing to the
  // first matching prefix (Windows Help Index behavior).
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

function TopicPane({ hf, topic, title, onJumpHash, onMacro, createUrl }: {
  hf: HlpFile;
  topic: TopicHeader | null;
  title: string;
  onJumpHash: (hash: number) => void;
  onMacro: (macro: string) => void;
  createUrl: (b: Blob) => string;
}) {
  const [bitmapUrls, setBitmapUrls] = useState<Map<number, { url: string; width: number; height: number }>>(new Map());
  const split = useMemo(() => topic ? hf.topicSplit(topic) : { nonScroll: [], scroll: [] }, [hf, topic]);
  const paragraphs = useMemo(() => [...split.nonScroll, ...split.scroll], [split]);

  // Fallback only fires when the link has no useful render events.
  const useFallback = useMemo(() => {
    if (paragraphs.length === 0) return false;
    let textBytes = 0;
    for (const p of paragraphs) {
      for (const e of p.events) {
        if (e.kind === 'text') textBytes += e.bytes.length;
      }
    }
    return textBytes < 4;
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

  useEffect(() => {
    let cancelled = false;
    const ids = new Set<number>();
    for (const p of paragraphs) {
      for (const e of p.events) {
        if (e.kind === 'picture') {
          // type 0x03: |bmN reference, payload starts with u16 picture ID.
          // type 0x22 (HCW4 inline bitmap reference): 4-byte payload
          //   u16 LE subtype + u16 LE index.
          if (e.type === 0x03 && e.payload.length >= 2) {
            const dv = new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength);
            ids.add(dv.getUint16(0, true));
          } else if (e.type === 0x22 && e.payload.length >= 4) {
            const dv = new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength);
            ids.add(dv.getUint16(2, true));
          }
        }
      }
    }
    (async () => {
      const m = new Map<number, { url: string; width: number; height: number }>();
      for (const id of ids) {
        const pic = hf.bitmap(id);
        if (!pic) continue;
        const blob = await rgbaToBlob(pic);
        if (blob && !cancelled) m.set(id, { url: createUrl(blob), width: pic.width, height: pic.height });
      }
      if (!cancelled) setBitmapUrls(m);
    })();
    return () => { cancelled = true; };
  }, [hf, paragraphs, createUrl]);

  const nonScrollLogical = useMemo(() => splitIntoLogicalParas(split.nonScroll), [split.nonScroll]);
  const scrollGroups = useMemo(() => groupForRender(split.scroll), [split.scroll]);
  const hasNonScroll = nonScrollLogical.length > 0;
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#FFFFFF', overflow: 'hidden' }}>
      {/* Non-scroll header band: fixed gray background, holds the topic title
          and any other paragraphs flagged as non-scrolling. WinHelp renders
          these as a fixed banner above the scrolling body. */}
      {hasNonScroll && !useFallback && (
        <div style={{
          background: '#C0C0C0',
          borderBottom: '1px solid #808080',
          padding: '12px 12px 8px',
          flex: '0 0 auto',
        }}>
          {nonScrollLogical.map((p, i) => (
            <ParagraphRender key={`ns-${i}`} para={p} fonts={hf.font.descriptors} faces={hf.font.facenames}
                             bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro} />
          ))}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {paragraphs.length === 0 && (
          <div style={{ color: '#666' }}>(No body content for this topic.)</div>
        )}
        {useFallback ? (
          <>
            <div style={{ font: 'italic 11px Tahoma', color: '#888', marginBottom: 8 }}>
              (Body uses HCW4 type-32 records with phrase compression — showing extracted text.)
            </div>
            <pre style={{ font: '12px "Times New Roman", serif', whiteSpace: 'pre-wrap', color: '#000' }}>
              {fallbackText || '(no readable text extracted)'}
            </pre>
          </>
        ) : (
          scrollGroups.map((g, i) => g.kind === 'table' ? (
            <TableRender key={i} group={g} fonts={hf.font.descriptors} faces={hf.font.facenames}
                         bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro} />
          ) : (
            <ExpandableParagraph key={i} hf={hf} para={g.para}
                                 bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro}
                                 createUrl={createUrl} depth={0} />
          ))
        )}
      </div>
    </div>
  );
}

type RenderGroup =
  | { kind: 'para'; para: DecodedParagraph }
  | { kind: 'table'; rows: DecodedParagraph[]; columns: number; columnWidths: Array<{ width: number; gap: number }> };

/** Walk decoded paragraphs from a topic and group them for rendering:
 *  consecutive table-row records (type 23/35 with `cells` populated) are
 *  collected into one `table` group; everything else is split into logical
 *  paragraphs and emitted as `para` groups. */
function groupForRender(input: DecodedParagraph[]): RenderGroup[] {
  const out: RenderGroup[] = [];
  let i = 0;
  while (i < input.length) {
    const p = input[i];
    if (p.cells && p.table) {
      // Collect a run of table rows with the same column structure.
      const rows: DecodedParagraph[] = [p];
      let j = i + 1;
      while (j < input.length) {
        const next = input[j];
        if (!next.cells || !next.table || next.table.columns !== p.table.columns) break;
        rows.push(next);
        j++;
      }
      out.push({ kind: 'table', rows, columns: p.table.columns, columnWidths: p.table.columnWidths });
      i = j;
    } else {
      for (const split of splitIntoLogicalParas([p])) out.push({ kind: 'para', para: split });
      i++;
    }
  }
  return out;
}

/** Renders a run of table rows. Each row's `cells` array is one cell's
 *  events; we use ParagraphRender per cell so font/hotspot/picture events
 *  inside cells render correctly. */
function TableRender({ group, fonts, faces, bitmapUrls, onJumpHash, onMacro }: {
  group: Extract<RenderGroup, { kind: 'table' }>;
  fonts: FontDescriptor[];
  faces: string[];
  bitmapUrls: Map<number, { url: string; width: number; height: number }>;
  onJumpHash: (hash: number) => void;
  onMacro: (macro: string) => void;
}) {
  // WinHelp column widths are in twips (1/20 pt). We translate to CSS px
  // proportionally — the absolute values are typically too large to use
  // verbatim. Sum the widths and let the table size to its container.
  const totalW = group.columnWidths.reduce((s, c) => s + c.width, 0) || 1;
  return (
    <table style={{
      borderCollapse: 'collapse',
      margin: '6px 0',
      font: '12px "Times New Roman", serif',
    }}>
      <colgroup>
        {group.columnWidths.map((c, i) => (
          <col key={i} style={{ width: `${(c.width / totalW * 100).toFixed(2)}%` }} />
        ))}
      </colgroup>
      <tbody>
        {group.rows.map((row, ri) => (
          <tr key={ri}>
            {(row.cells || []).map((cellEvents, ci) => (
              <td key={ci} style={{
                verticalAlign: 'top',
                padding: '4px 8px',
                border: 'none',
              }}>
                <ParagraphRender
                  para={{ recordType: row.recordType, events: cellEvents }}
                  fonts={fonts} faces={faces}
                  bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Split each DecodedParagraph (one TopicLink record) into one logical
 *  paragraph per paraBegin/paraEnd cycle. type-32 links often pack several
 *  bullet items into a single record, but for the expand-on-click UI we
 *  want each bullet to be its own row.
 *
 *  We also drop logical paragraphs that contain no text and no hotspots —
 *  those are pure structural artifacts. Any font event seen before a row's
 *  first paraBegin carries over into that row so the active font state is
 *  preserved. */
function splitIntoLogicalParas(input: DecodedParagraph[]): DecodedParagraph[] {
  const out: DecodedParagraph[] = [];
  let curFont = 0;
  for (const dp of input) {
    let bucket: RenderEvent[] | null = null;
    let lastFontInBucket = curFont;
    const flush = () => {
      if (!bucket) return;
      bucket.push({ kind: 'paraEnd' });
      const hasContent = bucket.some(ev =>
        ev.kind === 'text' || ev.kind === 'jump' || ev.kind === 'popup'
        || ev.kind === 'macroHotspot' || ev.kind === 'crossFile' || ev.kind === 'picture');
      if (hasContent) out.push({ recordType: dp.recordType, events: bucket });
      bucket = null;
      curFont = lastFontInBucket;
    };
    for (const e of dp.events) {
      if (e.kind === 'paraBegin') {
        flush();
        bucket = [{ kind: 'paraBegin', state: e.state }, { kind: 'font', index: curFont }];
        lastFontInBucket = curFont;
        continue;
      }
      if (e.kind === 'paraEnd') { flush(); continue; }
      if (e.kind === 'font') lastFontInBucket = e.index;
      if (bucket) bucket.push(e);
      else if (e.kind === 'font') curFont = e.index;
    }
    flush();
  }
  return out;
}

/** Wraps ParagraphRender with an inline expand/collapse toggle for any
 *  jump hotspot the paragraph contains. Clicking the ▶ triangle expands
 *  the target topic's body underneath, indented; clicking the hotspot
 *  text itself navigates as before. */
function ExpandableParagraph({ hf, para, bitmapUrls, onJumpHash, onMacro, createUrl, depth }: {
  hf: HlpFile;
  para: DecodedParagraph;
  bitmapUrls: Map<number, { url: string; width: number; height: number }>;
  onJumpHash: (hash: number) => void;
  onMacro: (macro: string) => void;
  createUrl: (b: Blob) => string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const jumpHashes = useMemo(() => {
    const hs: number[] = [];
    for (const e of para.events) if (e.kind === 'jump') hs.push(e.hash);
    return hs;
  }, [para]);
  const toggleHash = useCallback((h: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(h)) next.delete(h); else next.add(h);
      return next;
    });
  }, []);
  // Single-jump paragraphs (the typical Contents bullet) get a leading
  // triangle. We avoid showing triangles on paragraphs with multiple jumps
  // (they're prose with several inline links) — those just navigate.
  const showToggle = jumpHashes.length === 1 && depth < 3;
  const onlyHash = showToggle ? jumpHashes[0] : -1;
  const isOpen = showToggle && expanded.has(onlyHash);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {showToggle && (
          <button
            onClick={() => toggleHash(onlyHash)}
            style={{
              flex: '0 0 auto',
              width: 14, height: 14, padding: 0,
              marginTop: 3, marginRight: 4,
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              font: '10px monospace',
              color: '#000',
              lineHeight: '14px',
            }}
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? '▼' : '▶'}
          </button>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ParagraphRender para={para} fonts={hf.font.descriptors} faces={hf.font.facenames}
                           bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro} />
        </div>
      </div>
      {isOpen && (
        <ExpandedTopic hf={hf} hash={onlyHash} bitmapUrls={bitmapUrls}
                       onJumpHash={onJumpHash} onMacro={onMacro} createUrl={createUrl}
                       depth={depth + 1} />
      )}
    </div>
  );
}

/** Inline-rendered child topic body, used when the user expands a jump
 *  hotspot. Resolves the hash to a topic and renders just its scrolling
 *  paragraphs (skipping the title/non-scroll banner) indented underneath
 *  the parent paragraph. */
function ExpandedTopic({ hf, hash, bitmapUrls, onJumpHash, onMacro, createUrl, depth }: {
  hf: HlpFile;
  hash: number;
  bitmapUrls: Map<number, { url: string; width: number; height: number }>;
  onJumpHash: (hash: number) => void;
  onMacro: (macro: string) => void;
  createUrl: (b: Blob) => string;
  depth: number;
}) {
  const target = useMemo(() => hf.topicByJumpTarget(hash), [hf, hash]);
  const split = useMemo(() => target ? hf.topicSplit(target) : null, [hf, target]);
  if (!target || !split) {
    return (
      <div style={{ marginLeft: 18, font: 'italic 11px Tahoma', color: '#888' }}>
        (no sub-topic resolved for this link)
      </div>
    );
  }
  // Skip paragraphs that are identical to ones the parent already shows
  // (e.g., the recurring "How To..." / hotspot list at the top of every
  // contents-style page). Heuristic: drop empty / structural paragraphs.
  const items = splitIntoLogicalParas(split.scroll).filter(p =>
    p.events.some(e => e.kind === 'jump' || (e.kind === 'text' && e.bytes.length > 0))
  );
  if (items.length === 0) {
    return (
      <div style={{ marginLeft: 18, font: 'italic 11px Tahoma', color: '#888' }}>
        (no expandable sub-items in target topic)
      </div>
    );
  }
  return (
    <div style={{ marginLeft: 18, borderLeft: '1px dotted #808080', paddingLeft: 8, marginBottom: 4 }}>
      {items.map((p, i) => (
        <ExpandableParagraph key={i} hf={hf} para={p}
                             bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro}
                             createUrl={createUrl} depth={depth} />
      ))}
    </div>
  );
}

function ParagraphRender({ para, fonts, faces, bitmapUrls, onJumpHash, onMacro }: {
  para: DecodedParagraph;
  fonts: FontDescriptor[];
  faces: string[];
  bitmapUrls: Map<number, { url: string; width: number; height: number }>;
  onJumpHash: (hash: number) => void;
  onMacro: (macro: string) => void;
}) {
  const groups: { fontIdx: number; chunks: { kind: 'text' | 'jump' | 'popup' | 'macro' | 'image'; content: string | number; hash?: number; macro?: string; underline?: boolean }[] }[] = [];
  let curFont = 0;
  let curHotspot: { kind: 'jump' | 'popup' | 'macro'; hash?: number; macro?: string; underline?: boolean } | null = null;
  let curGroup: typeof groups[number] | null = null;
  const ensureGroup = () => {
    if (!curGroup || curGroup.fontIdx !== curFont) {
      curGroup = { fontIdx: curFont, chunks: [] };
      groups.push(curGroup);
    }
  };
  for (const e of para.events) {
    if (e.kind === 'font') { curFont = e.index; continue; }
    if (e.kind === 'jump' || e.kind === 'popup') {
      curHotspot = { kind: e.kind, hash: e.hash, underline: e.underline } as any;
      continue;
    }
    if (e.kind === 'macroHotspot') {
      curHotspot = { kind: 'macro', macro: e.macro, underline: e.underline } as any;
      continue;
    }
    if (e.kind === 'crossFile') {
      curHotspot = { kind: 'jump', hash: e.hash, underline: e.underline } as any;
      continue;
    }
    if (e.kind === 'hotspotEnd') { curHotspot = null; continue; }
    if (e.kind === 'text') {
      ensureGroup();
      const text = decodeBytes(e.bytes);
      if (curHotspot) {
        curGroup!.chunks.push({ kind: curHotspot.kind, content: text, hash: curHotspot.hash, macro: curHotspot.macro, underline: curHotspot.underline });
      } else {
        curGroup!.chunks.push({ kind: 'text', content: text });
      }
      continue;
    }
    if (e.kind === 'paraEnd') {
      groups.push({ fontIdx: curFont, chunks: [{ kind: 'text', content: '\n' }] });
      curGroup = null;
      continue;
    }
    if (e.kind === 'lineBreak') {
      ensureGroup();
      curGroup!.chunks.push({ kind: 'text', content: '\n' });
      continue;
    }
    if (e.kind === 'tab') {
      ensureGroup();
      curGroup!.chunks.push({ kind: 'text', content: '\t' });
      continue;
    }
    if (e.kind === 'hardSpace' || e.kind === 'nbsp') {
      ensureGroup();
      curGroup!.chunks.push({ kind: 'text', content: ' ' });
      continue;
    }
    if (e.kind === 'picture') {
      ensureGroup();
      if (e.type === 0x03 && e.payload.length >= 2) {
        const id = new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(0, true);
        curGroup!.chunks.push({ kind: 'image', content: id });
      } else if (e.type === 0x22 && e.payload.length >= 4) {
        // HCW4 inline bitmap reference: u16 at offset 2 = |bmN index.
        const id = new DataView(e.payload.buffer, e.payload.byteOffset, e.payload.byteLength).getUint16(2, true);
        curGroup!.chunks.push({ kind: 'image', content: id });
      } else if (e.type === 0x05) {
        // Inline SHG hotspot picture (Related Topics arrow). The clickable
        // macro is attached separately via a following 0xCC opcode.
        curGroup!.chunks.push({ kind: 'text', content: '▶ ' });
      }
      continue;
    }
  }
  return (
    <p style={{ margin: '0 0 8px', font: '12px "Times New Roman", serif', lineHeight: '1.4' }}>
      {groups.map((g, gi) => {
        const fd = fonts[g.fontIdx];
        const style = fd ? fontDescriptorToStyle(fd, faces) : {};
        return (
          <span key={gi} style={style}>
            {g.chunks.map((c, ci) => {
              if (c.kind === 'image') {
                const info = bitmapUrls.get(c.content as number);
                if (info) return <img key={ci} src={info.url} alt="" width={info.width} height={info.height} style={{
                  display: 'inline-block',
                  verticalAlign: 'text-bottom',
                  imageRendering: 'pixelated',
                  margin: '0 1px',
                }} />;
                return <span key={ci}>[bm{c.content}]</span>;
              }
              if (c.kind === 'jump') {
                const dec = c.underline === false ? 'none' : 'underline';
                return <a key={ci} href="#" onClick={(e) => { e.preventDefault(); onJumpHash(c.hash!); }}
                          style={{ color: '#008000', textDecoration: dec, cursor: 'pointer' }}>
                  {c.content as string}
                </a>;
              }
              if (c.kind === 'popup') {
                const dec = c.underline === false ? 'none' : 'underline dotted';
                return <a key={ci} href="#" onClick={(e) => { e.preventDefault(); onJumpHash(c.hash!); }}
                          style={{ color: '#008000', textDecoration: dec, cursor: 'pointer' }}>
                  {c.content as string}
                </a>;
              }
              if (c.kind === 'macro') {
                const dec = c.underline === false ? 'none' : 'underline';
                return <a key={ci} href="#" title={c.macro}
                          onClick={(e) => { e.preventDefault(); if (c.macro) onMacro(c.macro); }}
                          style={{ color: '#008000', textDecoration: dec, cursor: 'pointer' }}>
                  {c.content as string}
                </a>;
              }
              return <span key={ci} style={{ whiteSpace: 'pre-wrap' }}>{c.content as string}</span>;
            })}
          </span>
        );
      })}
    </p>
  );
}

function fontDescriptorToStyle(fd: FontDescriptor, faces: string[]): Record<string, string | number> {
  const face = faces[fd.facenameIdx] || 'serif';
  const sizePt = fd.halfPoints / 2 || 12;
  const style: Record<string, string | number> = {
    fontFamily: `"${face}", serif`,
    fontSize: `${sizePt}pt`,
  };
  if (fd.attributes & FONT_BOLD) style.fontWeight = 'bold';
  if (fd.attributes & FONT_ITALIC) style.fontStyle = 'italic';
  const decorations: string[] = [];
  if (fd.attributes & FONT_UNDERLINE) decorations.push('underline');
  if (fd.attributes & FONT_STRIKEOUT) decorations.push('line-through');
  if (decorations.length) style.textDecoration = decorations.join(' ');
  if (fd.fgR | fd.fgG | fd.fgB) style.color = `rgb(${fd.fgR},${fd.fgG},${fd.fgB})`;
  return style;
}

function decodeBytes(b: Uint8Array): string {
  // Filter out control bytes that leaked through unrecognized format opcodes
  let out = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) continue;
    if (c < 0x20 && c !== 0x09 && c !== 0x0A) continue;
    out += String.fromCharCode(c);
  }
  return out;
}

/** Last-resort text extractor: scan all link bytes and emit any contiguous
 *  printable runs >= 3 characters. Each non-printable byte becomes a
 *  separator, since now-correct phrase decompression should produce intact
 *  words and we don't want heuristic word splitters mangling them. */
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
      // Strip trailing ";" suffix (means "auto-jump first match without
      // showing list dialog").
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
