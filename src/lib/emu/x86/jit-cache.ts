/**
 * JIT block cache — stores compiled basic blocks and tracks execution hotness.
 *
 * When an address is executed JIT_THRESHOLD times, the basic block starting
 * at that address is compiled into a JavaScript function and cached.
 * Self-modifying code is handled via segment-level invalidation.
 */

/** A compiled basic block */
export interface CompiledBlock {
  /** The compiled JavaScript function: (reg, mem, cpu) => nextEIP */
  fn: (reg: Int32Array, mem: any, cpu: any) => number;
  /** Linear address of the first instruction */
  startAddr: number;
  /** Linear address after the last instruction */
  endAddr: number;
  /** Number of x86 instructions in this block */
  instrCount: number;
  /** Memory segment keys (addr >>> 16) covered by this block */
  segKeys: number[];
}

/** Compile after this many executions of the same address */
const JIT_THRESHOLD = 50;

/** Maximum number of cached blocks (LRU eviction when exceeded) */
const MAX_CACHE_SIZE = 4096;

/** Fast direct-mapped cache slot */
interface CacheSlot {
  addr: number;
  block: CompiledBlock | null;
}

/** Direct-mapped cache size (must be power of 2) */
const FAST_CACHE_SIZE = 4096;
const FAST_CACHE_MASK = FAST_CACHE_SIZE - 1;

export class JitCache {
  /** Direct-mapped cache for O(1) lookup (array indexed by addr & mask) */
  private fastCache: CacheSlot[];

  /** Compiled blocks indexed by start address (canonical store) */
  private blocks = new Map<number, CompiledBlock>();

  /** Execution count per address (for hotness tracking) */
  private hotness = new Uint16Array(FAST_CACHE_SIZE); // fixed array, not Map

  /** Segment key → set of block start addresses (for invalidation) */
  private segmentBlocks = new Map<number, Set<number>>();

  /** Memory instance for segment marking (set by emulator) */
  memory: any = null;

  /** Total number of compilations (stats) */
  compilations = 0;
  /** Total number of cache hits (stats) */
  hits = 0;

  constructor() {
    this.fastCache = new Array(FAST_CACHE_SIZE);
    for (let i = 0; i < FAST_CACHE_SIZE; i++) {
      this.fastCache[i] = { addr: -1, block: null };
    }
  }

  /** Check if a compiled block exists for this address — O(1) array access */
  get(addr: number): CompiledBlock | null {
    const slot = this.fastCache[addr & FAST_CACHE_MASK];
    if (slot.addr === addr) {
      this.hits++;
      return slot.block;
    }
    return null;
  }

  /** Record an execution at this address. Returns true if it just crossed the threshold. */
  recordExecution(addr: number): boolean {
    const idx = addr & FAST_CACHE_MASK;
    const count = ++this.hotness[idx];
    // Only compile if the slot consistently sees the SAME address
    return count === JIT_THRESHOLD;
  }

  /** Store a compiled block */
  put(block: CompiledBlock): void {
    // Evict if canonical store is full
    if (this.blocks.size >= MAX_CACHE_SIZE) {
      const firstKey = this.blocks.keys().next().value;
      if (firstKey !== undefined) this.remove(firstKey);
    }

    this.blocks.set(block.startAddr, block);
    this.compilations++;

    // Install in fast cache
    const slot = this.fastCache[block.startAddr & FAST_CACHE_MASK];
    slot.addr = block.startAddr;
    slot.block = block;

    // Register in segment index for invalidation
    for (const segKey of block.segKeys) {
      let set = this.segmentBlocks.get(segKey);
      if (!set) {
        set = new Set();
        this.segmentBlocks.set(segKey, set);
        // Tell Memory to watch this segment for writes
        this.memory?.jitMarkSegment(segKey);
      }
      set.add(block.startAddr);
    }
  }

  /** Remove a block from the cache */
  private remove(addr: number): void {
    const block = this.blocks.get(addr);
    if (!block) return;
    this.blocks.delete(addr);
    // Clear fast cache slot
    const slot = this.fastCache[addr & FAST_CACHE_MASK];
    if (slot.addr === addr) { slot.addr = -1; slot.block = null; }
    // Remove from segment index
    for (const segKey of block.segKeys) {
      const set = this.segmentBlocks.get(segKey);
      if (set) {
        set.delete(addr);
        if (set.size === 0) {
          this.segmentBlocks.delete(segKey);
          this.memory?.jitUnmarkSegment(segKey);
        }
      }
    }
  }

  /** Invalidate all compiled blocks that cover a memory segment.
   *  Called when emulated code writes to a segment that has JIT code. */
  invalidateSegment(segKey: number): void {
    const set = this.segmentBlocks.get(segKey);
    if (!set) return;
    for (const addr of [...set]) {
      this.remove(addr);
      // Also reset hotness so the block can be recompiled
      this.hotness[addr & FAST_CACHE_MASK] = 0;
    }
  }

  /** Check if a segment has any compiled blocks */
  hasCodeInSegment(segKey: number): boolean {
    return this.segmentBlocks.has(segKey);
  }

  /** Clear entire cache */
  clear(): void {
    this.blocks.clear();
    this.hotness.fill(0);
    this.segmentBlocks.clear();
    for (let i = 0; i < FAST_CACHE_SIZE; i++) {
      this.fastCache[i].addr = -1;
      this.fastCache[i].block = null;
    }
  }
}
