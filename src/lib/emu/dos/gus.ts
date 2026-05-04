/**
 * Gravis Ultrasound (GUS) emulation.
 *
 * Minimal implementation for STMIK-based programs (Second Reality, etc.).
 * Supports 32 voices with 8-bit samples from 1MB onboard RAM,
 * volume/pan control, looping, and DMA upload from host memory.
 */

import type { DMAController } from './dma';

// GUS constants
const GUS_RAM_SIZE = 1024 * 1024; // 1MB onboard RAM
const MAX_VOICES = 32;
const WAVE_FRACT_BITS = 9; // 9-bit fractional position (like DOSBox WAVE_WIDTH)
const WAVE_FRACT = 1 << WAVE_FRACT_BITS;
const VOLUME_LEVELS = 4096;
const VOLUME_INC_SCALAR = 512; // matches DOSBox — normalizes smallest increment (1/512)

// Voice control bits (must match DOSBox's CTRL enum in gus.h)
const CTRL_RESET      = 0x01;
const CTRL_STOPPED    = 0x02;
const CTRL_DISABLED   = 0x03; // RESET | STOPPED
const CTRL_16BIT      = 0x04;
const CTRL_LOOP       = 0x08;
const CTRL_BIDIR      = 0x10;
const CTRL_IRQ        = 0x20;
const CTRL_DECREASING = 0x40;

// Pre-compute volume scalars: 4096-entry log-to-linear table (matches DOSBox)
// Index 4095 = 1.0 (max), divided by 1.002709201 at each step backwards to index 1.
// Index 0 = 0.0 (silence). DELTA_DB = 0.002709201 ≈ 0.0235 dB per step.
const VOL_SCALARS = new Float32Array(VOLUME_LEVELS);
{
  const VOLUME_LEVEL_DIVISOR = 1.002709201;
  let scalar = 1.0;
  for (let i = VOLUME_LEVELS - 1; i >= 1; i--) {
    VOL_SCALARS[i] = scalar;
    scalar /= VOLUME_LEVEL_DIVISOR;
  }
  VOL_SCALARS[0] = 0;
}

// Pre-compute pan scalars: 16-position constant-power panning (matches DOSBox)
// Center at position 7, asymmetric: left half divides by 7, right half by 8
const PAN_LEFT = new Float32Array(16);
const PAN_RIGHT = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const norm = (i - 7.0) / (i < 7 ? 7 : 8);
  const angle = (norm + 1) * Math.PI / 4;
  PAN_LEFT[i] = Math.cos(angle);
  PAN_RIGHT[i] = Math.sin(angle);
}

interface VoiceCtrl {
  state: number;   // control register (stop/loop/bidir/direction/IRQ bits)
  start: number;   // start position (fixed-point with WAVE_FRACT bits)
  end: number;     // end position
  pos: number;     // current position
  inc: number;     // position increment per sample
}

interface GusVoice {
  wave: VoiceCtrl;
  vol: VoiceCtrl;
  pan: number;         // 0-15 pan position
  volRate: number;     // volume ramp rate
}

function makeCtrl(): VoiceCtrl {
  return { state: CTRL_STOPPED, start: 0, end: 0, pos: 0, inc: 0 };
}

function makeVoice(): GusVoice {
  return { wave: makeCtrl(), vol: makeCtrl(), pan: 7, volRate: 0 };
}

export class GUS {
  readonly ram = new Uint8Array(GUS_RAM_SIZE);
  private voices: GusVoice[] = [];
  private selectedRegister = 0;
  private registerData = 0;
  private voiceIndex = 0;
  private activeVoiceCount = 14;

  // DRAM peek/poke address (20-bit)
  private dramAddr = 0;

  // DMA state
  //   dmaCtrl bits (write meaning): 0=enable, 1=direction, 2=channel-16bit,
  //     3-4=rate, 5=want-IRQ-on-TC, 6=samples-are-16bit, 7=invert-MSB
  //   On read, bit 6 instead reports "TC IRQ pending" — we track that
  //   separately (dmaTcIrqPending) and OR it in on read.
  private dmaCtrl = 0;
  private dmaTcIrqPending = false;
  private dmaAddr = 0;       // DMA address register (GUS RAM target)
  private dmaAddrNibble = 0; // 4-bit remainder for 16-bit DMA alignment
  private dmaPending = false; // DMA transfer pending
  private sampleCtrl = 0;    // reg 0x49 — DMA sampling control
  /** Play-DMA channel (default 1; parsed from ULTRASND at load time).
   *  A channel >= 4 enables the 16-bit non-linear dma_addr transform. */
  dmaChannel = 1;

  // IRQ state — bit layout of irqStatus matches DOSBox:
  //   0x04 Timer 1, 0x08 Timer 2, 0x20 voice wave IRQ, 0x40 voice vol IRQ, 0x80 DMA TC
  private irqStatus = 0;
  private voiceIrqWave = 0;   // per-voice bitmask of pending wave IRQ
  private voiceIrqVol = 0;    // per-voice bitmask of pending vol IRQ
  private voiceIrqStatus = 0; // rotating voice index reported via reg 0x8F

  // Timer state
  private timerCtrl = 0;
  private timer1Value = 0;
  private timer2Value = 0;
  private timer1Count = 0;
  private timer2Count = 0;

  // Reset
  private resetReg = 0;

  // AdLib register select (for OPL2-compatible timer interface on ports GUS+8/GUS+9)
  private _adlibReg = 0;


  // Mix control
  private mixCtrl = 0;

  /** Runtime tracing. When true, log voice starts and DMA uploads via
   *  console.log with a `[GUS]` prefix. Intended for diagnosing progressive
   *  sample corruption across long playback (SR demo scenes).
   *  Enable from the browser console with `emu.dosAudio.gus.traceGus = true`.
   *  Capped at `_traceMaxEvents` to avoid flooding the console — bump if you
   *  need a longer window. */
  traceGus = false;
  private _traceEventCount = 0;
  private _traceMaxEvents = 5000;

  /** Compute a cheap 16-byte hash of GUS RAM at `addr`. Exposed for the
   *  browser console so the user can snapshot content at specific offsets
   *  and detect later corruption. */
  hashRam(addr: number, len = 16): string {
    let hash = 0;
    const end = Math.min(addr + len, this.ram.length);
    for (let i = addr; i < end; i++) hash = ((hash * 31) + this.ram[i & 0xFFFFF]) | 0;
    return '0x' + (hash >>> 0).toString(16).padStart(8, '0');
  }

  /** Reset the trace event counter so another burst of logs can be captured
   *  (call from the console between scenes). */
  resetTrace(): void { this._traceEventCount = 0; }

  /** Callback to fire GUS IRQ (set by DosAudio) */
  onIRQ: () => void = () => {};
  /** Callback to read host memory for DMA */
  readMemory: (addr: number) => number = () => 0;

  constructor() {
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push(makeVoice());
    }
  }

  private get target(): GusVoice | null {
    return this.voiceIndex < MAX_VOICES ? this.voices[this.voiceIndex] : null;
  }

  // ── Port I/O ────────────────────────────────────────────────────

  portRead(port: number): number {
    const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
    switch (off) {
      case 0x06: // IRQ status register
        return this.irqStatus;
      case 0x08: // Timer/AdLib status
        return ((this.irqStatus & 0x04) ? 0x40 : 0) |
               ((this.irqStatus & 0x08) ? 0x20 : 0) |
               ((this.irqStatus & 0x0C) ? 0x80 : 0);
      case 0x0A: // AdLib data read
        return 0;
      case 0x102: // Voice select readback
        return this.voiceIndex;
      case 0x103: // Selected register readback
        return this.selectedRegister;
      case 0x104: // Register data word read (low byte)
        return this.readRegister() & 0xFF;
      case 0x105: // Register data high byte
        return (this.readRegister() >> 8) & 0xFF;
      case 0x107: // DRAM read
        return this.ram[this.dramAddr & 0xFFFFF];
      default:
        return 0;
    }
  }

  portWrite(port: number, value: number): void {
    const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
    switch (off) {
      case 0x00: // Mix control register
        this.mixCtrl = value;
        break;
      case 0x08: // OPL2 address port — select register for next data write
        this._adlibReg = value & 0xFF;
        break;
      case 0x09: // OPL2 data port — write to previously selected AdLib register
        switch (this._adlibReg) {
          case 0x02: this.timer1Value = value & 0xFF; break;
          case 0x03: this.timer2Value = value & 0xFF; break;
          case 0x04: // Timer control
            if (value & 0x80) {
              // Bit 7: reset timer IRQ flags
              this.irqStatus &= ~0x0C;
              this.checkIrq();
            } else {
              // Bit 0: start/stop Timer 1, Bit 1: start/stop Timer 2
              if (value & 0x01) { this.timerCtrl |= 0x04; this.timer1Count = 0; }
              else               { this.timerCtrl &= ~0x04; }
              if (value & 0x02) { this.timerCtrl |= 0x08; this.timer2Count = 0; }
              else               { this.timerCtrl &= ~0x08; }
            }
            break;
        }
        break;
      case 0x0B: // IRQ/DMA control — ignore for now
        break;
      case 0x102: // Voice select
        this.voiceIndex = value & 0x1F;
        break;
      case 0x103: // Register select — DOSBox clears registerData here
        this.selectedRegister = value;
        this.registerData = 0;
        break;
      case 0x104: // Register data low byte — waits for high byte at 0x105.
        // DOSBox zeroes the high byte here (gus.cpp:1282). Word writes are
        // routed through portWrite16 so they never reach this byte path.
        this.registerData = value & 0xFF;
        break;
      case 0x105: // Register data high byte — triggers register write
        this.registerData = (this.registerData & 0x00FF) | ((value & 0xFF) << 8);
        this.writeRegister();
        break;
      case 0x107: // DRAM write
        this.ram[this.dramAddr & 0xFFFFF] = value;
        break;
    }
  }

  /** Handle an atomic 16-bit port write (OUT DX,AX / OUTSW).
   *  Port 0x304/0x344 is the register-data port — a word write stores the
   *  full 16-bit payload and triggers WriteToRegister in one shot (matches
   *  DOSBox gus.cpp:1278). Any other port falls back to two byte writes. */
  portWrite16(port: number, value: number): void {
    const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
    if (off === 0x104) {
      this.registerData = value & 0xFFFF;
      this.writeRegister();
      return;
    }
    this.portWrite(port, value & 0xFF);
    this.portWrite((port + 1) & 0xFFFF, (value >> 8) & 0xFF);
  }

  /** Handle an atomic 16-bit port read (IN AX,DX / INSW).
   *  Port 0x304/0x344 returns ReadFromRegister's 16-bit payload directly. */
  portRead16(port: number): number {
    const off = port < 0x300 ? port - 0x240 : port - 0x340 + 0x100;
    if (off === 0x104) return this.readRegister() & 0xFFFF;
    const lo = this.portRead(port) & 0xFF;
    const hi = this.portRead((port + 1) & 0xFFFF) & 0xFF;
    return ((hi << 8) | lo) & 0xFFFF;
  }

  // ── Register read/write ─────────────────────────────────────────

  private readRegister(): number {
    const v = this.target;
    switch (this.selectedRegister) {
      // General registers
      case 0x41: { // DMA control — read acknowledges DMA IRQ.
        // Bit 6 on read = TC-IRQ-pending (different meaning than write).
        const r = (this.dmaCtrl & ~0x40) | (this.dmaTcIrqPending ? 0x40 : 0);
        this.dmaTcIrqPending = false;
        this.irqStatus &= 0x7F;
        this.checkIrq();
        return r << 8;
      }
      case 0x42: return this.dmaAddr;
      case 0x45: return this.timerCtrl << 8;
      case 0x49: return this.dmaCtrl << 8; // DOSBox mirrors dma_control_register
      case 0x4C: return this.resetReg << 8;
      case 0x8F: { // Voice IRQ status — matches DOSBox gus.cpp:982-994.
        // Bit layout: low 5 bits = current voice index, bit 5 always set,
        // bit 6 SET if no vol IRQ for that voice, bit 7 SET if no wave IRQ.
        // (Inverted — bit clear means IRQ pending.)
        let reg = this.voiceIrqStatus | 0x20;
        const mask = 1 << this.voiceIrqStatus;
        if (!(this.voiceIrqVol & mask)) reg |= 0x40;
        if (!(this.voiceIrqWave & mask)) reg |= 0x80;
        this.voiceIrqVol &= ~mask;
        this.voiceIrqWave &= ~mask;
        this.checkVoiceIrq();
        return reg << 8;
      }

      // Voice registers (read-back). Bit 7 echoes this voice's bit in
      // voiceIrqWave — matches DOSBox Voice::ReadCtrlState (gus.cpp:200-206).
      case 0x80: {
        if (!v) return 0x0300;
        const bit7 = this.voiceIrqWave & (1 << this.voiceIndex) ? 0x80 : 0;
        return (v.wave.state | bit7) << 8;
      }
      case 0x82: return v ? (v.wave.start >> 16) : 0;
      case 0x83: return v ? (v.wave.start & 0xFFFF) : 0;
      case 0x84: return v ? (v.wave.end >> 16) : 0;
      case 0x85: return v ? (v.wave.end & 0xFFFF) : 0;
      case 0x89: { // Current volume — DOSBox uses ceil_sdivide (gus.cpp:1018)
        if (!v) return 0;
        const i = Math.max(0, Math.min(VOLUME_LEVELS - 1,
          Math.ceil(v.vol.pos / VOLUME_INC_SCALAR)));
        return i << 4;
      }
      case 0x8A: return v ? (v.wave.pos >> 16) : 0;
      case 0x8B: return v ? (v.wave.pos & 0xFFFF) : 0;
      case 0x8D: {
        if (!v) return 0x0300;
        const bit7 = this.voiceIrqVol & (1 << this.voiceIndex) ? 0x80 : 0;
        return (v.vol.state | bit7) << 8;
      }
      default: return this.registerData;
    }
  }

  private writeRegister(): void {
    const v = this.target;
    const data = this.registerData;
    const hi = (data >> 8) & 0xFF;

    switch (this.selectedRegister) {
      // General registers
      case 0x0E: // Active voices
        this.activeVoiceCount = Math.max(14, Math.min(32, 1 + (hi & 31)));
        this.selectedRegister = hi; // Jazz Jackrabbit compatibility
        return;
      case 0x41: // DMA control
        this.dmaCtrl = hi;
        if (hi & 0x01) this.startDma();
        return;
      case 0x42: // DMA address — invalidate nibble alignment (DOSBox gus.cpp:1354)
        this.dmaAddr = data;
        this.dmaAddrNibble = 0;
        return;
      case 0x43: // DRAM address LSW
        this.dramAddr = (this.dramAddr & 0xF0000) | data;
        return;
      case 0x44: // DRAM address MSB
        this.dramAddr = (this.dramAddr & 0x0FFFF) | ((data & 0x0F00) << 8);
        return;
      case 0x45: // Timer control
        this.timerCtrl = hi;
        if (!(hi & 0x04)) this.irqStatus &= ~0x04;
        if (!(hi & 0x08)) this.irqStatus &= ~0x08;
        this.checkIrq();
        return;
      case 0x46: // Timer 1
        this.timer1Value = hi;
        return;
      case 0x47: // Timer 2
        this.timer2Value = hi;
        return;
      case 0x49: // DMA sampling control (DOSBox gus.cpp:1386)
        this.sampleCtrl = hi;
        if (hi & 0x01) this.startDma();
        return;
      case 0x4C: // Reset
        this.resetReg = hi;
        if (!(hi & 0x01)) this.reset();
        return;
    }

    // Voice-specific registers
    if (!v) return;
    switch (this.selectedRegister) {
      case 0x00: { // Wave control — matches DOSBox UpdateCtrlState
        const mask = 1 << this.voiceIndex;
        if ((hi & 0xA0) === 0xA0) this.voiceIrqWave |= mask;
        else this.voiceIrqWave &= ~mask;
        const prevState = v.wave.state;
        v.wave.state = hi & 0x7F;
        // Trace voice START transitions: CTRL_DISABLED bits (RESET/STOPPED)
        // just cleared — the voice is about to begin playing its configured
        // sample. Captures (start>>9, end>>9, pos>>9) as 20-bit GUS RAM
        // addresses so the listener can correlate with the last DMA uploads.
        if (this.traceGus
            && (prevState & CTRL_DISABLED)
            && !(v.wave.state & CTRL_DISABLED)
            && this._traceEventCount < this._traceMaxEvents) {
          this._traceEventCount++;
          // eslint-disable-next-line no-console
          console.log(`[GUS] voice-start v=${this.voiceIndex}`
            + ` start=0x${(v.wave.start >>> 9).toString(16).padStart(5, '0')}`
            + ` end=0x${(v.wave.end >>> 9).toString(16).padStart(5, '0')}`
            + ` pos=0x${(v.wave.pos >>> 9).toString(16).padStart(5, '0')}`
            + ` inc=0x${v.wave.inc.toString(16)}`
            + ` state=0x${v.wave.state.toString(16)}`
            + ` pan=${v.pan}`
            + ` vol.state=0x${v.vol.state.toString(16)}`
            + ` vol.pos=0x${v.vol.pos.toString(16)}`
            + ` 16bit=${!!(v.wave.state & CTRL_16BIT)}`);
        }
        this.checkVoiceIrq();
        break;
      }
      case 0x01: // Wave rate (frequency control word)
        // DOSBox: inc = ceil(val/2). The /2 accounts for the GUS internal
        // position counter being half-rate relative to the FC register value.
        v.wave.inc = Math.ceil(data / 2);
        break;
      case 0x02: // Wave start MSW
        v.wave.start = (v.wave.start & 0x0000FFFF) | ((data & 0x1FFF) << 16);
        break;
      case 0x03: // Wave start LSW
        v.wave.start = (v.wave.start & 0xFFFF0000) | data;
        break;
      case 0x04: // Wave end MSW
        v.wave.end = (v.wave.end & 0x0000FFFF) | ((data & 0x1FFF) << 16);
        break;
      case 0x05: // Wave end LSW
        v.wave.end = (v.wave.end & 0xFFFF0000) | data;
        break;
      case 0x06: // Volume rate
        v.volRate = hi;
        v.vol.inc = calcVolInc(hi);
        break;
      case 0x07: // Volume start
        v.vol.start = (hi << 4) * VOLUME_INC_SCALAR;
        break;
      case 0x08: // Volume end
        v.vol.end = (hi << 4) * VOLUME_INC_SCALAR;
        break;
      case 0x09: // Current volume
        v.vol.pos = (data >> 4) * VOLUME_INC_SCALAR;
        break;
      case 0x0A: // Wave position MSW
        v.wave.pos = (v.wave.pos & 0x0000FFFF) | ((data & 0x1FFF) << 16);
        break;
      case 0x0B: // Wave position LSW
        v.wave.pos = (v.wave.pos & 0xFFFF0000) | data;
        break;
      case 0x0C: // Pan — DOSBox saturates at 15 instead of masking
        v.pan = hi > 15 ? 15 : hi;
        break;
      case 0x0D: { // Volume control — matches DOSBox UpdateCtrlState
        const mask = 1 << this.voiceIndex;
        if ((hi & 0xA0) === 0xA0) this.voiceIrqVol |= mask;
        else this.voiceIrqVol &= ~mask;
        v.vol.state = hi & 0x7F;
        this.checkVoiceIrq();
        break;
      }
    }
  }

  // ── DMA transfer ────────────────────────────────────────────────

  private dma?: DMAController;

  setDma(dma: DMAController): void {
    this.dma = dma;
    // Mirror DOSBox DmaCallback(IsUnmasked) → StartDmaTransfers: if startDma()
    // bailed earlier because the channel was masked, resume it now. Gated on
    // dmaPending so we only re-trigger genuinely deferred requests (not every
    // unrelated unmask that happens after a completed transfer).
    const prev = dma.onUnmask;
    dma.onUnmask = (ch: number) => {
      prev?.(ch);
      if (ch === this.dmaChannel && this.dmaPending) this.startDma();
    };
  }

  /** True when the DMA transfer uses the non-linear 16-bit address layout.
   *  Matches DOSBox IsDmaXfer16Bit: requires both dmaCtrl bit 2 (channel-
   *  16bit) AND the play-DMA channel >= 4. */
  private isDmaXfer16Bit(): boolean {
    return !!(this.dmaCtrl & 0x04) && this.dmaChannel >= 4;
  }

  /** Compute the 20-bit GUS RAM offset for the current DMA transfer.
   *  Mirrors DOSBox Gus::GetDmaOffset (gus.cpp:624-654). */
  private getDmaOffset(): number {
    let adjusted = this.dmaAddr & 0xFFFF;
    if (this.isDmaXfer16Bit()) {
      const upper = adjusted & 0xC000; // bits 14-15
      const lower = adjusted & 0x1FFF; // bits 0-12
      adjusted = (upper | (lower << 1)) & 0xFFFF;
    }
    return ((adjusted << 4) + this.dmaAddrNibble) & 0xFFFFF;
  }

  private startDma(): void {
    const ch = this.dmaChannel;
    if (!this.dma) return;
    if (!this.dma.isActive(ch)) {
      // Channel is masked — defer until writeSingleMask clears it (matches
      // DOSBox DmaCallback(IsUnmasked) behavior).
      this.dmaPending = true;
      return;
    }
    this.dmaPending = false;

    // DMA control register bit layout (matches DOSBox DmaControlRegister):
    //   bit 1 = direction (0=host→GUS, 1=GUS→host)
    //   bit 2 = is_channel_16bit (gates the non-linear address transform)
    //   bit 6 = are_samples_16bit (write-only; read reports TC-IRQ-pending)
    //   bit 7 = are_samples_high_bit_inverted (XOR 0x80 on the high byte only)
    const isUpload = !(this.dmaCtrl & 0x02);
    if (!isUpload) return; // recording not supported

    const invertMsb = !!(this.dmaCtrl & 0x80);
    const is16bitSamples = !!(this.dmaCtrl & 0x40);
    const xfer16 = this.isDmaXfer16Bit();
    let gusAddr = this.getDmaOffset();
    const startGusAddr = gusAddr;

    // The DMA controller's count is in transfer units (bytes on an 8-bit
    // channel, words on a 16-bit channel). getPhysicalAddr already reflects
    // the per-transfer address; each iteration moves one byte into GUS RAM
    // for 8-bit channels, or one byte of the current word for 16-bit. The
    // 16-bit path (dmaChannel >= 4) isn't exercised by typical ULTRASND
    // configs (DMA=1) but the scaffolding is here for completeness.
    const count = (this.dma.currentCount[ch] + 1) & 0xFFFF;
    const bytesPerUnit = xfer16 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const physAddr = this.dma.getPhysicalAddr(ch);
      for (let b = 0; b < bytesPerUnit; b++) {
        this.ram[gusAddr & 0xFFFFF] = this.readMemory(physAddr + b);
        gusAddr++;
      }
      this.dma.currentAddr[ch] = (this.dma.currentAddr[ch] + bytesPerUnit) & 0xFFFF;
      this.dma.currentCount[ch] = (this.dma.currentCount[ch] - 1) & 0xFFFF;
    }
    const byteCount = count * bytesPerUnit;

    if (invertMsb) {
      const skip = is16bitSamples ? 2 : 1;
      let p = startGusAddr + (is16bitSamples ? 1 : 0);
      const end = startGusAddr + byteCount;
      while (p < end) {
        this.ram[p & 0xFFFFF] ^= 0x80;
        p += skip;
      }
    }

    // Update the DMA address register with the post-transfer position.
    // Matches DOSBox UpdateDmaAddr (gus.cpp:638): for 8-bit, the paragraph
    // address is (offset & 0xFFFF0) >> 4 and the nibble is zero; for 16-bit,
    // the non-linear transform is (upper | (lower >> 1)).
    const newOffset = (startGusAddr + byteCount) & 0xFFFFF;
    let adjusted: number;
    if (xfer16) {
      const upper = newOffset & 0xC0000;
      const lower = newOffset & 0x3FFFE;
      adjusted = upper | (lower >>> 1);
    } else {
      adjusted = newOffset & 0xFFFF0;
    }
    this.dmaAddr = (adjusted >>> 4) & 0xFFFF;
    this.dmaAddrNibble = adjusted & 0xF;

    // Set terminal count flag. Bit 6 on read of reg 0x41 means "TC IRQ
    // pending" (separate from the "samples are 16-bit" write meaning we
    // stored in dmaCtrl itself).
    this.dma.status |= 1 << ch;
    this.dmaTcIrqPending = true;

    if (this.traceGus && this._traceEventCount < this._traceMaxEvents) {
      this._traceEventCount++;
      // Hash the first 16 bytes of the uploaded region so the listener can
      // notice "same GUS RAM offset, different content" (a sample reload
      // would show a different hash).
      let hash = 0;
      const hashLen = Math.min(16, byteCount);
      for (let i = 0; i < hashLen; i++) {
        hash = ((hash * 31) + this.ram[(startGusAddr + i) & 0xFFFFF]) | 0;
      }
      // eslint-disable-next-line no-console
      console.log(`[GUS] dma-upload gus=0x${startGusAddr.toString(16).padStart(5, '0')}`
        + ` bytes=${byteCount}`
        + ` dmaCtrl=0x${this.dmaCtrl.toString(16)}`
        + ` invertMsb=${invertMsb}`
        + ` 16bitSamples=${is16bitSamples}`
        + ` hash=0x${(hash >>> 0).toString(16).padStart(8, '0')}`);
    }

    // Real 8237 sets the mask bit after Terminal Count in non-auto-init mode
    // (DOSBox dma.cpp:452). Without this, reg 0x41 bit 0 stays "live" in our
    // model, so a spurious re-write of reg 0x41 (with the DMA controller not
    // reprogrammed) could double-load stale bytes into GUS RAM.
    const autoInit = !!(this.dma.mode[ch] & 0x10);
    if (!autoInit) this.dma.mask |= 1 << ch;

    if (this.dmaCtrl & 0x20) { // wants_irq_on_terminal_count
      this.irqStatus |= 0x80;
      this.checkIrq();
    }
  }

  // ── Audio rendering ─────────────────────────────────────────────

  /** Output sample rate (set from AudioContext.sampleRate during init) */
  outputRate = 44100;

  /** Fractional accumulator for GUS internal rate → output rate conversion (ZOH) */
  private _gusAccum = 0;
  private _lastMixL = 0;
  private _lastMixR = 0;
  /** Scratch buffers for voice-by-voice rendering at the GUS internal rate. */
  private _tickL = new Float32Array(0);
  private _tickR = new Float32Array(0);


  /** Read an 8-bit sample scaled into 16-bit range (matches DOSBox Read8BitSample) */
  private read8Bit(addr: number): number {
    const b = this.ram[addr & 0xFFFFF];
    return (b > 127 ? b - 256 : b) * 256;
  }

  /** Read a 16-bit sample with GUS non-linear addressing (matches DOSBox Read16BitSample) */
  private read16Bit(addr: number): number {
    const upper = addr & 0xC0000;
    const lower = addr & 0x1FFFF;
    const i = (upper | (lower << 1)) & 0xFFFFF;
    const w = (this.ram[(i + 1) & 0xFFFFF] << 8) | this.ram[i];
    return w > 32767 ? w - 65536 : w;
  }

  /** Read a sample from GUS RAM with linear interpolation when inc < WAVE_FRACT.
   *  Matches DOSBox's Voice::GetSample (gus.cpp:118-139). */
  private getSample(v: GusVoice): number {
    const pos = v.wave.pos;
    const addr = (pos >> WAVE_FRACT_BITS) | 0;
    const fraction = pos & (WAVE_FRACT - 1);
    const shouldInterpolate = v.wave.inc < WAVE_FRACT && fraction !== 0;
    const is16bit = !!(v.wave.state & CTRL_16BIT);

    let sample = is16bit ? this.read16Bit(addr) : this.read8Bit(addr);
    if (shouldInterpolate) {
      const nextSample = is16bit ? this.read16Bit(addr + 1) : this.read8Bit(addr + 1);
      sample += (nextSample - sample) * fraction / WAVE_FRACT;
    }
    return sample;
  }

  /** Render mixed GUS audio into stereo buffers (additive).
   *  DOSBox renders frame-by-frame at the GUS internal rate voice-by-voice
   *  (`Voice::RenderFrames` emits all frames of one voice before moving on),
   *  then the mixer resamples to the output device. We replicate that: first
   *  accumulate every active voice's contribution into GUS-rate tick buffers,
   *  then ZOH-upsample those ticks into the output buffer. */
  renderSamples(outL: Float32Array, outR: Float32Array, count: number): void {
    if (!(this.resetReg & 0x01) || !(this.resetReg & 0x02)) return;

    const gusRate = Math.floor(1000000 / (1.619695497 * this.activeVoiceCount));
    const step = gusRate / this.outputRate;

    // Count the GUS ticks that will fire during this output block.
    const accumEnd = this._gusAccum + count * step;
    const totalTicks = Math.floor(accumEnd);

    if (totalTicks > 0) {
      if (this._tickL.length < totalTicks) {
        this._tickL = new Float32Array(totalTicks);
        this._tickR = new Float32Array(totalTicks);
      } else {
        this._tickL.fill(0, 0, totalTicks);
        this._tickR.fill(0, 0, totalTicks);
      }

      // Voice-by-voice: all frames of one voice before the next.
      for (let vi = 0; vi < this.activeVoiceCount; vi++) {
        const v = this.voices[vi];
        if (v.wave.state & v.vol.state & CTRL_DISABLED) continue;
        const panL = PAN_LEFT[v.pan];
        const panR = PAN_RIGHT[v.pan];
        const waveRollover = !!(v.vol.state & CTRL_16BIT) && !(v.wave.state & CTRL_LOOP);

        for (let t = 0; t < totalTicks; t++) {
          const sample = this.getSample(v);
          const volIdx = Math.max(0, Math.min(VOLUME_LEVELS - 1,
            Math.ceil(v.vol.pos / VOLUME_INC_SCALAR)));
          const s1 = (sample / 32768) * VOL_SCALARS[volIdx];
          this._tickL[t] += s1 * panL;
          this._tickR[t] += s1 * panR;
          this.incrementCtrlPos(v.wave, vi, true, waveRollover);
          this.incrementCtrlPos(v.vol, vi, false, false);
          if (v.wave.state & v.vol.state & CTRL_DISABLED) break;
        }
      }
    }

    // ZOH upsample tick buffers into the output at the device rate.
    let tickIdx = 0;
    for (let s = 0; s < count; s++) {
      this._gusAccum += step;
      while (this._gusAccum >= 1.0 && tickIdx < totalTicks) {
        this._gusAccum -= 1.0;
        this._lastMixL = this._tickL[tickIdx] * 0.7071;
        this._lastMixR = this._tickR[tickIdx] * 0.7071;
        tickIdx++;
      }
      outL[s] += this._lastMixL;
      outR[s] += this._lastMixR;
    }
  }

  /** Advance control position — faithful copy of DOSBox's IncrementCtrlPos */
  private incrementCtrlPos(ctrl: VoiceCtrl, voiceIdx: number, isWave: boolean, dontLoopOrRestart: boolean): void {
    if (ctrl.state & CTRL_DISABLED) return;

    let remaining = 0;
    if (ctrl.state & CTRL_DECREASING) {
      ctrl.pos -= ctrl.inc;
      remaining = ctrl.start - ctrl.pos;
    } else {
      ctrl.pos += ctrl.inc;
      remaining = ctrl.pos - ctrl.end;
    }

    // Not yet reaching a boundary
    if (remaining < 0) return;

    // Generate an IRQ if requested
    if (ctrl.state & CTRL_IRQ) {
      if (isWave) this.voiceIrqWave |= (1 << voiceIdx);
      else this.voiceIrqVol |= (1 << voiceIdx);
      this.checkVoiceIrq();
    }

    // Allow the current position to move beyond its limit (rollover)
    if (dontLoopOrRestart) return;

    // Should we loop?
    if (ctrl.state & CTRL_LOOP) {
      if (ctrl.state & CTRL_BIDIR) {
        ctrl.state ^= CTRL_DECREASING; // reverse direction
      }
      ctrl.pos = (ctrl.state & CTRL_DECREASING)
        ? ctrl.end - remaining
        : ctrl.start + remaining;
    } else {
      // No loop: stop the voice (DOSBox uses |= 1 = RESET bit)
      ctrl.state |= CTRL_RESET;
      ctrl.pos = (ctrl.state & CTRL_DECREASING) ? ctrl.start : ctrl.end;
    }
  }

  // ── Timer ───────────────────────────────────────────────────────

  /** Tick GUS timers — call periodically from the main loop */
  tickTimers(): void {
    if (!(this.resetReg & 0x01)) return;

    // Timer 1: 80µs base
    if (this.timerCtrl & 0x04) {
      this.timer1Count++;
      if (this.timer1Count >= (0x100 - this.timer1Value)) {
        this.timer1Count = 0;
        this.irqStatus |= 0x04;
        this.checkIrq();
      }
    }

    // Timer 2: 320µs base
    if (this.timerCtrl & 0x08) {
      this.timer2Count++;
      if (this.timer2Count >= (0x100 - this.timer2Value) * 4) {
        this.timer2Count = 0;
        this.irqStatus |= 0x08;
        this.checkIrq();
      }
    }
  }

  // ── IRQ ─────────────────────────────────────────────────────────

  /** Recompute voice-IRQ bits in irqStatus and advance voiceIrqStatus to
   *  the next voice with a pending IRQ. Matches DOSBox's CheckVoiceIrq. */
  private checkVoiceIrq(): void {
    this.irqStatus &= 0x9F; // clear voice wave (0x20) and vol (0x40) bits
    const activeMask = this.activeVoiceCount >= 32 ? 0xFFFFFFFF : ((1 << this.activeVoiceCount) - 1) >>> 0;
    const totalMask = (this.voiceIrqVol | this.voiceIrqWave) & activeMask;
    if (!totalMask) {
      this.checkIrq();
      return;
    }
    if (this.voiceIrqVol) this.irqStatus |= 0x40;
    if (this.voiceIrqWave) this.irqStatus |= 0x20;
    this.checkIrq();
    // Rotate voiceIrqStatus to the next voice with a pending IRQ
    while (!(totalMask & (1 << this.voiceIrqStatus))) {
      this.voiceIrqStatus++;
      if (this.voiceIrqStatus >= this.activeVoiceCount) this.voiceIrqStatus = 0;
    }
  }

  private checkIrq(): void {
    // DOSBox: mask is 0xFF when IRQs enabled, 0x9F otherwise (only voice-IRQ
    // bits 0x20/0x40 are gated by the reset register's IRQ-enable flag).
    const mask = (this.resetReg & 0x04) ? 0xFF : 0x9F;
    if (this.irqStatus & mask) this.onIRQ();
  }

  // ── Reset ───────────────────────────────────────────────────────

  /** Matches DOSBox Gus::Reset (gus.cpp:1082-1118). */
  private reset(): void {
    this.irqStatus = 0;
    this.dmaCtrl = 0;
    this.dmaTcIrqPending = false;
    this.dmaAddrNibble = 0;
    this.sampleCtrl = 0;
    this.timerCtrl = 0;
    this.timer1Value = 0;
    this.timer2Value = 0;
    this.timer1Count = 0;
    this.timer2Count = 0;

    // ResetCtrls: DOSBox writes wave.state and vol.state to 0x1 (RESET bit)
    for (const v of this.voices) {
      v.wave.state = CTRL_RESET;
      v.wave.pos = v.wave.start = v.wave.end = v.wave.inc = 0;
      v.vol.state = CTRL_RESET;
      v.vol.pos = v.vol.start = v.vol.end = v.vol.inc = 0;
      v.pan = 7;
      v.volRate = 0;
    }
    this.voiceIrqWave = 0;
    this.voiceIrqVol = 0;
    this.voiceIrqStatus = 0;

    this.voiceIndex = 0;
    this.activeVoiceCount = 14;
    this.dmaAddr = 0;
    this.dramAddr = 0;
    this.registerData = 0;
    this.selectedRegister = 0;
  }
}

/** Calculate volume increment from GUS rate byte (matches DOSBox) */
function calcVolInc(rate: number): number {
  // Rate byte: bits 5-0 = position in bank, bits 7-6 = bank selector
  // Bank 0: inc = pos * 512,  Bank 1: inc = pos * 64
  // Bank 2: inc = pos * 8,    Bank 3: inc = pos * 1
  const posInBank = rate & 0x3F;
  const decimator = 1 << (3 * ((rate >> 6) & 0x03)); // 1, 8, 64, 512
  return Math.ceil((posInBank * VOLUME_INC_SCALAR) / decimator);
}
