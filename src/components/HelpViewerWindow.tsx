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
type Tab = 'contents' | 'index';

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

  const [activeTab, setActiveTab] = useState<Tab>('contents');
  const [keywordFilter, setKeywordFilter] = useState('');
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [current, setCurrent] = useState<TopicHeader | null>(null);
  const { createUrl } = useBlobUrls();

  const titles = useMemo(() => hf ? [...hf.titles()] : [], [hf]);
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

  const handleNext = useCallback(() => {
    if (!hf || !current) return;
    if (current.browseForward !== 0xFFFFFFFF) {
      const next = hf.topicByOffset(current.browseForward);
      if (next) navigateTo(next);
    }
  }, [hf, current, navigateTo]);

  const handlePrev = useCallback(() => {
    if (!hf || !current) return;
    if (current.browseBack !== 0xFFFFFFFF) {
      const prev = hf.topicByOffset(current.browseBack);
      if (prev) navigateTo(prev);
    }
  }, [hf, current, navigateTo]);

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
            onIndex={() => setActiveTab('index')}
            onBack={handleBack}
            onPrev={handlePrev}
            onNext={handleNext}
            onPrint={() => window.print()}
            canBack={history.length > 0}
            canPrev={!!current && current.browseBack !== 0xFFFFFFFF}
            canNext={!!current && current.browseForward !== 0xFFFFFFFF}
          />
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <SidePanel
              activeTab={activeTab}
              onTabChange={setActiveTab}
              titles={titles}
              keywords={filteredKeywords}
              keywordFilter={keywordFilter}
              onKeywordFilterChange={setKeywordFilter}
              currentOffset={current?.vOffset ?? null}
              onPickTopic={(off) => {
                const t = hf.topicByOffset(off);
                if (t) navigateTo(t);
              }}
              onPickKeyword={(kw) => {
                if (kw.topicOffsets.length === 0) return;
                const t = hf.topicByOffset(kw.topicOffsets[0]);
                if (t) navigateTo(t);
              }}
            />
            <TopicPane
              hf={hf}
              topic={current}
              title={titleStr}
              onJumpHash={(hash) => {
                const t = hf.topicByHash(hash);
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
    </div>
  );
}

// --- Toolbar -----------------------------------------------------------

function Toolbar({ onContents, onIndex, onBack, onPrev, onNext, onPrint, canBack, canPrev, canNext }:
  { onContents: () => void; onIndex: () => void; onBack: () => void; onPrev: () => void; onNext: () => void; onPrint: () => void;
    canBack: boolean; canPrev: boolean; canNext: boolean; }) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 4, background: '#D4D0C8', borderBottom: '1px solid #808080' }}>
      <ToolbarButton label="Contents" onClick={onContents} />
      <ToolbarButton label="Index" onClick={onIndex} />
      <ToolbarButton label="Back" onClick={onBack} disabled={!canBack} />
      <ToolbarButton label="<<" onClick={onPrev} disabled={!canPrev} />
      <ToolbarButton label=">>" onClick={onNext} disabled={!canNext} />
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

// --- Side panel (Contents / Index) ------------------------------------

function SidePanel({ activeTab, onTabChange, titles, keywords, keywordFilter, onKeywordFilterChange,
  currentOffset, onPickTopic, onPickKeyword }: {
  activeTab: Tab; onTabChange: (t: Tab) => void;
  titles: { vOffset: number; title: string }[];
  keywords: Keyword[];
  keywordFilter: string; onKeywordFilterChange: (s: string) => void;
  currentOffset: number | null;
  onPickTopic: (off: number) => void;
  onPickKeyword: (kw: Keyword) => void;
}) {
  return (
    <div style={{ width: 220, display: 'flex', flexDirection: 'column', borderRight: '1px solid #808080', background: '#D4D0C8' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid #808080' }}>
        <TabButton label="Contents" active={activeTab === 'contents'} onClick={() => onTabChange('contents')} />
        <TabButton label="Index" active={activeTab === 'index'} onClick={() => onTabChange('index')} />
      </div>
      {activeTab === 'contents' ? (
        <div style={{ flex: 1, overflowY: 'auto', background: '#FFF', padding: 4 }}>
          {titles.filter(t => t.title).map(t => (
            <div
              key={t.vOffset}
              onClick={() => onPickTopic(t.vOffset)}
              style={{
                padding: '2px 6px',
                cursor: 'pointer',
                background: t.vOffset === currentOffset ? '#000080' : 'transparent',
                color: t.vOffset === currentOffset ? '#FFF' : '#000',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                userSelect: 'none',
              }}
              title={t.title}
            >
              {t.title}
            </div>
          ))}
        </div>
      ) : (
        <>
          <input
            type="text"
            placeholder="Type a keyword..."
            value={keywordFilter}
            onInput={(e) => onKeywordFilterChange((e.target as HTMLInputElement).value)}
            style={{ margin: 4, padding: 2, font: '11px Tahoma', border: '1px solid', borderColor: '#404040 #FFF #FFF #404040' }}
          />
          <div style={{ flex: 1, overflowY: 'auto', background: '#FFF', padding: 4 }}>
            {keywords.map(kw => (
              <div
                key={kw.keyword}
                onClick={() => onPickKeyword(kw)}
                style={{
                  padding: '2px 6px',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  userSelect: 'none',
                }}
                title={`${kw.keyword} (${kw.topicOffsets.length})`}
              >
                {kw.keyword}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: '4px 8px',
        font: '11px Tahoma',
        background: active ? '#FFF' : '#D4D0C8',
        border: 'none',
        borderBottom: active ? 'none' : '1px solid #808080',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
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
  const paragraphs = useMemo(() => topic ? hf.topicContent(topic) : [], [hf, topic]);

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

  return (
    <div style={{ flex: 1, overflowY: 'auto', background: '#FFFFCC', padding: 12 }}>
      <h2 style={{ font: 'bold 14px "Times New Roman", serif', margin: '0 0 12px', color: '#000' }}>{title}</h2>
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
        paragraphs.map((p, i) => (
          <ParagraphRender key={i} para={p} fonts={hf.font.descriptors} faces={hf.font.facenames}
                           bitmapUrls={bitmapUrls} onJumpHash={onJumpHash} onMacro={onMacro} />
        ))
      )}
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
