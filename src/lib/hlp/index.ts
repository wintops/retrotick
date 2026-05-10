// HLP entry point — orchestrates the layers (container → topics → render).

import { HlpContainer } from './container';
import { parseSystem, type SystemInfo } from './system';
import { makePhraseTable, type PhraseTable } from './phrases';
import { TopicReader, type TopicHeader, type TopicLinkRaw } from './topic';
import { decodeDisplayLink, type DecodedParagraph } from './format';
import { lookupContext, lookupTitle, allTitles, lookupCtxomap, lookupTomap } from './context';
import { parseFont, type FontTable } from './font';
import { allKeywords, lookupKeyword, type Keyword } from './keyword';
import { parsePictureContainer, type HlpPicture } from './picture';
import { hashContext } from './hash';

export * from './types';

export class HlpFile {
  readonly container: HlpContainer;
  readonly system: SystemInfo;
  readonly phraseTable: PhraseTable;
  readonly topicReader: TopicReader;
  readonly font: FontTable;
  /** Cache of |bm<N> picture sets. */
  private bmCache = new Map<number, HlpPicture[]>();

  constructor(buf: ArrayBuffer | Uint8Array) {
    this.container = new HlpContainer(buf);
    const sysBody = this.container.read('|SYSTEM');
    if (!sysBody) throw new Error('|SYSTEM missing');
    this.system = parseSystem(sysBody);
    this.phraseTable = makePhraseTable(
      this.system.header.minor, this.system.header.flags,
      this.container.read('|Phrases'),
      this.container.read('|PhrIndex'),
      this.container.read('|PhrImage'),
    );
    const topicBody = this.container.read('|TOPIC');
    if (!topicBody) throw new Error('|TOPIC missing');
    this.topicReader = new TopicReader(topicBody, this.system.header.flags, this.system.header.minor, this.phraseTable);
    const fontBody = this.container.read('|FONT');
    this.font = fontBody ? parseFont(fontBody) : { facenames: [], descriptors: [] };
  }

  // --- Topic lookup -----------------------------------------------------

  /** Find a topic by context-string hash. */
  topicByHash(hash: number): TopicHeader | null {
    const ctx = this.container.read('|CONTEXT');
    if (!ctx) return null;
    const offsets = lookupContext(ctx, hash >>> 0);
    if (offsets.length === 0) return null;
    return this.topicReader.topicByOffset(offsets[0]);
  }

  /** Find a topic by context string (e.g. JumpId target). */
  topicByContext(name: string): TopicHeader | null {
    return this.topicByHash(hashContext(name));
  }

  /** Find a topic by numeric context (HELP_CONTEXT). */
  topicByContextNumber(n: number): TopicHeader | null {
    const ctx = this.container.read('|CTXOMAP');
    if (!ctx) return null;
    const off = lookupCtxomap(ctx, n);
    if (off === undefined) return null;
    return this.topicReader.topicByOffset(off);
  }

  /** Find a topic by sequential topic number via |TOMAP. */
  topicByTopicNumber(n: number): TopicHeader | null {
    const t = this.container.read('|TOMAP');
    if (!t) return null;
    const off = lookupTomap(t, n);
    if (off === undefined) return null;
    return this.topicReader.topicByOffset(off);
  }

  /** Look up a topic by its TOPICOFFSET (as stored in TTLBTREE/CONTEXT). */
  topicByOffset(topicOffset: number): TopicHeader | null {
    return this.topicReader.topicByOffset(topicOffset);
  }

  /** Title from |TTLBTREE for a TopicHeader. The header's vOffset is an
   *  internal stream position; we convert to TOPICOFFSET for the lookup. */
  titleOf(internalPos: number): string | undefined {
    const t = this.container.read('|TTLBTREE');
    if (!t) return undefined;
    const topicOffset = this.topicReader.posToTopicOffset(internalPos);
    return lookupTitle(t, topicOffset);
  }

  /** All (offset, title) pairs from |TTLBTREE. The vOffset returned is a
   *  TOPICOFFSET (suitable for topicByOffset). */
  *titles(): Generator<{ vOffset: number; title: string }> {
    const t = this.container.read('|TTLBTREE');
    if (!t) return;
    yield* allTitles(t);
  }

  /** Get the contents (default) topic. */
  contentsTopic(): TopicHeader | null {
    if (this.system.contentsTopic >= 0) {
      const direct = this.topicByOffset(this.system.contentsTopic);
      if (direct) return direct;
    }
    // fallback: first topic in stream
    const all = this.topicReader.topics();
    return all[0] ?? null;
  }

  // --- Topic content ----------------------------------------------------

  /** Decode all display paragraphs that belong to the given topic. Display
   *  record types: 1, 20, 22, 23, 32, 35. The font state carries across
   *  paragraph links — we prepend a synthetic font event to each link so
   *  the renderer doesn't reset to font 0. */
  topicContent(topic: TopicHeader): DecodedParagraph[] {
    const link = this.topicReader.readLink(topic.vOffset);
    if (!link) return [];
    const out: DecodedParagraph[] = [];
    let curFont = this.system.defaultFont?.fontNumber ?? 0;
    for (const p of this.topicReader.paragraphs(link)) {
      const t = p.recordType;
      if (t === 1 || t === 20 || t === 22 || t === 23 || t === 32 || t === 35) {
        try {
          const decoded = decodeDisplayLink(t, p.linkData1, p.linkData2);
          // Prepend an explicit font event so cross-link carry-over works.
          const events = decoded.events;
          const firstParaBegin = events.findIndex(e => e.kind === 'paraBegin');
          if (firstParaBegin >= 0) {
            events.splice(firstParaBegin + 1, 0, { kind: 'font', index: curFont });
          }
          // Update curFont to the LAST font event in this link (so it
          // propagates to the next link).
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (ev.kind === 'font') { curFont = ev.index; break; }
          }
          out.push(decoded);
        } catch (e) { console.warn('[hlp] decode link failed:', e); }
      }
    }
    return out;
  }

  rawLink(off: number): TopicLinkRaw | null {
    return this.topicReader.readLink(off);
  }

  // --- Pictures ---------------------------------------------------------

  /** Load picture |bm<N>. */
  bitmap(n: number): HlpPicture | null {
    const cached = this.bmCache.get(n);
    if (cached) return cached[0] ?? null;
    const body = this.container.read(`|bm${n}`);
    if (!body) return null;
    try {
      const pics = parsePictureContainer(body);
      this.bmCache.set(n, pics);
      return pics[0] ?? null;
    } catch (e) {
      console.warn('[hlp] |bm', n, 'parse failed:', e);
      return null;
    }
  }

  // --- Keywords ---------------------------------------------------------

  /** Walk all keywords in the K namespace. */
  *keywords(): Generator<Keyword> {
    const tree = this.container.read('|KWBTREE');
    const data = this.container.read('|KWDATA');
    if (!tree || !data) return;
    yield* allKeywords(tree, data);
  }

  lookupKeyword(name: string): Keyword | undefined {
    const tree = this.container.read('|KWBTREE');
    const data = this.container.read('|KWDATA');
    if (!tree || !data) return undefined;
    return lookupKeyword(tree, data, name);
  }

  /** Walk all keywords in the A namespace (ALink). */
  *alinks(): Generator<Keyword> {
    const tree = this.container.read('|AWBTREE');
    const data = this.container.read('|AWDATA');
    if (!tree || !data) return;
    yield* allKeywords(tree, data);
  }

  /** Look up a keyword in the A namespace (used by ALink macros). */
  lookupAlink(name: string): Keyword | undefined {
    const tree = this.container.read('|AWBTREE');
    const data = this.container.read('|AWDATA');
    if (!tree || !data) return undefined;
    return lookupKeyword(tree, data, name);
  }
}
