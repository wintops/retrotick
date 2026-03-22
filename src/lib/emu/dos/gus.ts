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

// Voice control bits
const CTRL_STOPPED   = 0x01;
const CTRL_16BIT     = 0x02;
const CTRL_LOOP      = 0x04;
const CTRL_BIDIR     = 0x08;
const CTRL_DECREASING = 0x40;
const CTRL_IRQ       = 0x20;

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

// Pre-compute pan scalars: 16-position constant-power panning
const PAN_LEFT = new Float32Array(16);
const PAN_RIGHT = new Float32Array(16);
for (let i = 0; i < 16; i++) {
  const angle = (i / 15) * Math.PI / 2;
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
  private dmaCtrl = 0;       // DMA control register
  private dmaAddr = 0;       // DMA address register (GUS RAM target)
  private dmaPending = false; // DMA transfer pending

  // IRQ state
  private irqStatus = 0;
  private voiceIrqWave = 0;  // bitmask of voices with pending wave IRQ
  private voiceIrqVol = 0;   // bitmask of voices with pending vol IRQ

  // Timer state
  private timerCtrl = 0;
  private timer1Value = 0;
  private timer2Value = 0;
  private timer1Count = 0;
  private timer2Count = 0;

  // Reset
  private resetReg = 0;

  // Mix control
  private mixCtrl = 0;

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
      case 0x08: // Timer command (AdLib-compatible)
        if (value & 0x80) {
          // Reset timer IRQ flags
          this.irqStatus &= ~0x0C;
          this.checkIrq();
        }
        break;
      case 0x09: // Timer data (AdLib-compatible)
        break;
      case 0x0B: // IRQ/DMA control — ignore for now
        break;
      case 0x102: // Voice select
        this.voiceIndex = value & 0x1F;
        break;
      case 0x103: // Register select
        this.selectedRegister = value;
        break;
      case 0x104: // Register data — word or low byte
        if (value > 0xFF) {
          // Word write (from OUTSW or direct 16-bit access): full value, trigger
          this.registerData = value & 0xFFFF;
          this.writeRegister();
        } else {
          // Byte write (from OUT DX,AX split): store low byte, wait for high byte
          this.registerData = (this.registerData & 0xFF00) | (value & 0xFF);
        }
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

  /** Handle 16-bit port write (OUT DX, AX) */
  portWrite16(port: number, value: number): void {
    const off = port < 0x300 ? port - 0x200 : port - 0x300 + 0x100;
    if (off === 0x104) {
      this.registerData = value & 0xFFFF;
      this.writeRegister();
    } else {
      // Split into two byte writes
      this.portWrite(port, value & 0xFF);
      this.portWrite(port + 1, (value >> 8) & 0xFF);
    }
  }

  // ── Register read/write ─────────────────────────────────────────

  private readRegister(): number {
    const v = this.target;
    switch (this.selectedRegister) {
      // General registers
      case 0x41: { // DMA control — read acknowledges DMA IRQ
        const r = this.dmaCtrl;
        this.dmaCtrl &= ~0x40; // clear TC IRQ pending
        this.irqStatus &= 0x7F;
        this.checkIrq();
        return r << 8;
      }
      case 0x42: return this.dmaAddr;
      case 0x45: return this.timerCtrl << 8;
      case 0x4C: return this.resetReg << 8;
      case 0x8F: { // Voice IRQ status
        let status = 0x20; // bit 5 always set
        // Find first voice with pending IRQ
        for (let i = 0; i < this.activeVoiceCount; i++) {
          if (this.voiceIrqWave & (1 << i)) {
            status = i | 0x20 | 0x80; // wave IRQ
            this.voiceIrqWave &= ~(1 << i);
            break;
          }
          if (this.voiceIrqVol & (1 << i)) {
            status = i | 0x20 | 0x40; // vol IRQ
            this.voiceIrqVol &= ~(1 << i);
            break;
          }
        }
        if (!this.voiceIrqWave && !this.voiceIrqVol) {
          this.irqStatus &= ~0x20;
          this.checkIrq();
        }
        return status << 8;
      }

      // Voice registers (read-back)
      case 0x80: return v ? (v.wave.state << 8) : 0x0300;
      case 0x82: return v ? (v.wave.start >> 16) : 0;
      case 0x83: return v ? (v.wave.start & 0xFFFF) : 0;
      case 0x84: return v ? (v.wave.end >> 16) : 0;
      case 0x85: return v ? (v.wave.end & 0xFFFF) : 0;
      case 0x89: { // Current volume
        if (!v) return 0;
        const i = Math.max(0, Math.min(VOLUME_LEVELS - 1,
          Math.floor(v.vol.pos / VOLUME_INC_SCALAR)));
        return i << 4;
      }
      case 0x8A: return v ? (v.wave.pos >> 16) : 0;
      case 0x8B: return v ? (v.wave.pos & 0xFFFF) : 0;
      case 0x8D: return v ? (v.vol.state << 8) : 0x0300;
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
      case 0x42: // DMA address
        this.dmaAddr = data;
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
      case 0x4C: // Reset
        this.resetReg = hi;
        if (!(hi & 0x01)) this.reset();
        return;
    }

    // Voice-specific registers
    if (!v) return;
    switch (this.selectedRegister) {
      case 0x00: // Wave control
        v.wave.state = hi & 0x7F;
        break;
      case 0x01: // Wave rate (frequency control word)
        // DOSBox divides by 2: inc = ceil(val/2). The FC is relative to the
        // GUS internal rate which varies with active voices.
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
      case 0x0C: // Pan
        v.pan = hi & 0x0F;
        break;
      case 0x0D: // Volume control
        v.vol.state = hi & 0x7F;
        break;
    }
  }

  // ── DMA transfer ────────────────────────────────────────────────

  private dma?: DMAController;

  setDma(dma: DMAController): void { this.dma = dma; }

  private startDma(): void {
    if (!this.dma || !this.dma.isActive(1)) return;

    // Transfer from host memory to GUS RAM
    const isUpload = !(this.dmaCtrl & 0x02); // bit 1 = direction (0=host→GUS)
    if (!isUpload) return; // recording not supported

    const invertMsb = !!(this.dmaCtrl & 0x80); // bit 7 = invert MSB (unsigned→signed)
    let gusAddr = (this.dmaAddr << 4) & 0xFFFFF; // 20-bit GUS RAM address

    // Transfer up to DMA count+1 bytes
    const count = this.dma.currentCount[1] + 1;
    for (let i = 0; i < count; i++) {
      const physAddr = this.dma.getPhysicalAddr(1);
      let byte = this.readMemory(physAddr);
      if (invertMsb) byte ^= 0x80;
      this.ram[gusAddr & 0xFFFFF] = byte;
      gusAddr++;
      this.dma.currentAddr[1] = (this.dma.currentAddr[1] + 1) & 0xFFFF;
      this.dma.currentCount[1] = (this.dma.currentCount[1] - 1) & 0xFFFF;
    }

    // Set terminal count flag
    this.dma.status |= 0x02;
    this.dmaCtrl |= 0x40; // TC IRQ pending
    this.irqStatus |= 0x80;
    this.checkIrq();
  }

  // ── Audio rendering ─────────────────────────────────────────────

  /** Output sample rate (set from AudioContext.sampleRate during init) */
  outputRate = 44100;

  /** Render mixed GUS audio into stereo buffers (additive) */
  renderSamples(outL: Float32Array, outR: Float32Array, count: number): void {
    if (!(this.resetReg & 0x01)) return; // GUS not running

    for (let s = 0; s < count; s++) {
      let mixL = 0, mixR = 0;

      for (let vi = 0; vi < this.activeVoiceCount; vi++) {
        const v = this.voices[vi];

        // Skip stopped voices
        if ((v.wave.state & CTRL_STOPPED) && (v.vol.state & CTRL_STOPPED)) continue;

        // Read 8-bit sample from GUS RAM (signed: STMIK XORs MSB during upload)
        const addr = (v.wave.pos >> WAVE_FRACT_BITS) & 0xFFFFF;
        const b = this.ram[addr];
        const sample = (b > 127 ? b - 256 : b) / 128; // signed int8 → float [-1,+1]

        // Volume: get scalar from position
        const volIdx = Math.max(0, Math.min(VOLUME_LEVELS - 1,
          Math.floor(v.vol.pos / VOLUME_INC_SCALAR)));
        const vol = VOL_SCALARS[volIdx];

        // Pan
        const s1 = sample * vol;
        mixL += s1 * PAN_LEFT[v.pan];
        mixR += s1 * PAN_RIGHT[v.pan];

        // Advance wave position (scaled by GUS internal rate / output rate)
        const gusRate = 1000000 / (1.619695497 * this.activeVoiceCount);
        const rateScale = gusRate / this.outputRate;
        const savedInc = v.wave.inc;
        v.wave.inc = Math.round(savedInc * rateScale);
        this.advanceCtrl(v.wave, vi, true);
        v.wave.inc = savedInc; // restore original for register readback
        // Advance volume ramp
        this.advanceCtrl(v.vol, vi, false);
      }

      // RMS scaling like DOSBox (0.7071 = 1/sqrt(2))
      outL[s] += mixL * 0.7071;
      outR[s] += mixR * 0.7071;
    }
  }

  /** Check if wave rollover is enabled: vol has BIT16 and wave has no LOOP */
  private checkRollover(voiceIdx: number): boolean {
    const v = this.voices[voiceIdx];
    return !!(v.vol.state & CTRL_16BIT) && !(v.wave.state & CTRL_LOOP);
  }

  private advanceCtrl(ctrl: VoiceCtrl, voiceIdx: number, isWave: boolean): void {
    if (ctrl.state & CTRL_STOPPED) return;

    // Check rollover: for wave control, if vol has BIT16 and wave has no LOOP,
    // the voice continues past the boundary without stopping or looping (rollover).
    const rollover = isWave && this.checkRollover(voiceIdx);

    if (ctrl.state & CTRL_DECREASING) {
      ctrl.pos -= ctrl.inc;
      if (ctrl.pos <= ctrl.start) {
        if (rollover) {
          // Rollover: fire IRQ but keep going
        } else if (ctrl.state & CTRL_LOOP) {
          if (ctrl.state & CTRL_BIDIR) {
            ctrl.state &= ~CTRL_DECREASING;
            ctrl.pos = ctrl.start;
          } else {
            ctrl.pos = ctrl.end;
          }
        } else {
          ctrl.state |= CTRL_STOPPED;
          ctrl.pos = ctrl.start;
        }
        // Fire IRQ if enabled
        if (ctrl.state & CTRL_IRQ) {
          if (isWave) this.voiceIrqWave |= (1 << voiceIdx);
          else this.voiceIrqVol |= (1 << voiceIdx);
          this.irqStatus |= 0x20;
          this.checkIrq();
        }
      }
    } else {
      ctrl.pos += ctrl.inc;
      if (ctrl.pos >= ctrl.end) {
        if (rollover) {
          // Rollover: fire IRQ but keep going past end
        } else if (ctrl.state & CTRL_LOOP) {
          if (ctrl.state & CTRL_BIDIR) {
            ctrl.state |= CTRL_DECREASING;
            ctrl.pos = ctrl.end;
          } else {
            ctrl.pos = ctrl.start;
          }
        } else {
          ctrl.state |= CTRL_STOPPED;
          ctrl.pos = ctrl.end;
        }
        if (ctrl.state & CTRL_IRQ) {
          if (isWave) this.voiceIrqWave |= (1 << voiceIdx);
          else this.voiceIrqVol |= (1 << voiceIdx);
          this.irqStatus |= 0x20;
          this.checkIrq();
        }
      }
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

  private checkIrq(): void {
    if (this.irqStatus & (this.resetReg & 0x04 ? 0xFF : 0x00)) {
      this.onIRQ();
    }
  }

  // ── Reset ───────────────────────────────────────────────────────

  private reset(): void {
    for (const v of this.voices) {
      v.wave.state = CTRL_STOPPED;
      v.wave.pos = v.wave.start = v.wave.end = v.wave.inc = 0;
      v.vol.state = CTRL_STOPPED;
      v.vol.pos = v.vol.start = v.vol.end = v.vol.inc = 0;
      v.pan = 7;
    }
    this.irqStatus = 0;
    this.voiceIrqWave = 0;
    this.voiceIrqVol = 0;
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
