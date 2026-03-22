/**
 * DOS audio subsystem orchestrator.
 *
 * Ties together OPL2 (AdLib FM), Sound Blaster DSP + DMA, and PC Speaker.
 * Routes I/O port reads/writes to the appropriate subsystem, manages the
 * AudioWorklet for real-time stereo audio output, and handles PCM mixing.
 */

import { OPL2 } from './opl2';
import { DMAController } from './dma';
import { SoundBlasterDSP } from './soundblaster';
import { PCSpeaker } from './pc-speaker';
import { GUS } from './gus';

// Re-export component classes for external consumers
export { OPL2 } from './opl2';
export { DMAController } from './dma';
export { SoundBlasterDSP, SB_IRQ } from './soundblaster';
export { PCSpeaker } from './pc-speaker';
export { GUS } from './gus';

export class DosAudio {
  private opl2: OPL2;
  private speaker: PCSpeaker;
  private sbDsp: SoundBlasterDSP;
  readonly dma = new DMAController();
  private ctx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private started = false;
  /** Shared ring buffer for passing interleaved stereo samples to the AudioWorklet. */
  private sharedBuf: Float32Array | null = null;
  private writePos = 0;
  private fillTimer = 0;
  /** Callback to read a byte from emulator memory (set by emu-load). */
  readMemory: (addr: number) => number = () => 0;
  /** Callback to write a byte to emulator memory (set by emu-load). */
  writeMemory: (addr: number, val: number) => void = () => {};
  /** Callback to queue a hardware interrupt (set by emu-load). */
  onSBIRQ: () => void = () => {};
  /** Callback to queue GUS IRQ (IRQ 5 = INT 0x0D, set by emu-load). */
  onGUSIRQ: () => void = () => {};

  readonly gus = new GUS();

  constructor() {
    this.opl2 = new OPL2(44100); // will be updated when AudioContext is created
    this.speaker = new PCSpeaker(null);
    this.sbDsp = new SoundBlasterDSP();
    // Wire DSP IRQ callback through to our onSBIRQ (which gets set by emu-load)
    this.sbDsp.onIRQ = () => this.onSBIRQ();
    // Wire OPL2 timer IRQ through the same IRQ 7 path
    this.opl2.onTimerIRQ = () => this.onSBIRQ();
    // Wire E2 DMA identification — writes a computed byte to DMA channel 0 address
    this.sbDsp.onE2Write = (value: number) => {
      const addr = this.dma.getPhysicalAddr(0);
      this.writeMemory(addr, value);
    };
    // Give SB DSP access to DMA and memory for debugging
    this.sbDsp.dma = this.dma;
    this.sbDsp.readMemFn = (addr: number) => this.readMemory(addr);
    // Wire GUS
    this.gus.onIRQ = () => this.onGUSIRQ();
    this.gus.setDma(this.dma);
  }

  /** Initialize audio (must be called from user gesture). */
  init(audioContext: AudioContext): void {
    if (this.started) return;
    this.ctx = audioContext;
    this.started = true;

    this.opl2.setSampleRate(audioContext.sampleRate);
    this.opl2.onTimerIRQ = () => this.onSBIRQ();
    this.speaker = new PCSpeaker(audioContext);

    // Ring buffer stores interleaved stereo frames (L, R, L, R, ...).
    // RING_SIZE = number of stereo frames. Buffer = RING_SIZE * 2 floats.
    const RING_SIZE = 8192;
    const useShared = typeof SharedArrayBuffer !== 'undefined';
    const ringBuf = useShared
      ? new SharedArrayBuffer(RING_SIZE * 2 * 4 + 8) // stereo samples + writePos + readPos
      : null;

    // AudioWorklet processor code — stereo output
    const processorCode = `
class OPLProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.ring = null;
    this.readPos = 0;
    this.pendingL = [];
    this.pendingR = [];
    const shared = options.processorOptions?.sharedBuffer;
    if (shared) {
      this.ring = new Float32Array(shared, 0, ${RING_SIZE * 2});
      this.pointers = new Int32Array(shared, ${RING_SIZE * 2 * 4}, 2);
    } else {
      this.port.onmessage = (e) => {
        if (e.data.samplesL) {
          this.pendingL.push(...e.data.samplesL);
          this.pendingR.push(...e.data.samplesR);
        }
      };
    }
  }
  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    if (!outL || !outR) return true;
    if (this.ring) {
      const wp = Atomics.load(this.pointers, 0);
      for (let i = 0; i < outL.length; i++) {
        if (this.readPos !== wp) {
          const idx = (this.readPos % ${RING_SIZE}) * 2;
          outL[i] = this.ring[idx];
          outR[i] = this.ring[idx + 1];
          this.readPos++;
        } else {
          outL[i] = 0;
          outR[i] = 0;
        }
      }
      Atomics.store(this.pointers, 1, this.readPos);
    } else {
      for (let i = 0; i < outL.length; i++) {
        outL[i] = this.pendingL.length > 0 ? this.pendingL.shift() : 0;
        outR[i] = this.pendingR.length > 0 ? this.pendingR.shift() : 0;
      }
    }
    return true;
  }
}
if (!globalThis._oplRegistered) {
  registerProcessor('opl-processor', OPLProcessor);
  globalThis._oplRegistered = true;
}`;

    const blob = new Blob([processorCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    audioContext.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      if (!this.ctx) return;
      const node = new AudioWorkletNode(this.ctx, 'opl-processor', {
        outputChannelCount: [2],
        processorOptions: { sharedBuffer: ringBuf },
      });
      node.connect(this.ctx.destination);
      this.workletNode = node;

      // Use setInterval so audio generates even when the tab is in the background.
      // Track real time to generate exactly the right number of samples (no over/under-production).
      const FILL_INTERVAL_MS = 10;
      const sampleRate = audioContext.sampleRate;
      let lastFillTime = performance.now();
      if (ringBuf) {
        this.sharedBuf = new Float32Array(ringBuf, 0, RING_SIZE * 2);
        const pointers = new Int32Array(ringBuf, RING_SIZE * 2 * 4, 2);
        const fill = () => {
          if (!this.ctx) return;
          const now = performance.now();
          const elapsed = (now - lastFillTime) / 1000; // seconds
          // Cap to avoid huge bursts after tab regains focus
          const samplesToGen = Math.min(Math.floor(elapsed * sampleRate), RING_SIZE / 2) & ~1;
          if (samplesToGen <= 0) return;

          const rp = Atomics.load(pointers, 1);
          const wp = this.writePos;
          const available = RING_SIZE - (wp - rp);
          const count = Math.min(samplesToGen, available);
          if (count <= 0) return;

          const tmpL = new Float32Array(count);
          const tmpR = new Float32Array(count);
          this.opl2.generateSamples(tmpL, tmpR, count);
          this.mixPCMStereo(tmpL, tmpR, count);
          this.gus.renderSamples(tmpL, tmpR, count);
          for (let i = 0; i < count; i++) {
            const idx = ((wp + i) % RING_SIZE) * 2;
            this.sharedBuf![idx] = tmpL[i];
            this.sharedBuf![idx + 1] = tmpR[i];
          }
          this.writePos = wp + count;
          Atomics.store(pointers, 0, this.writePos);
          lastFillTime = now;
        };
        this.fillTimer = setInterval(fill, FILL_INTERVAL_MS) as unknown as number;
      } else {
        // Fallback: periodically post samples via message port, with time tracking
        const fill = () => {
          if (!this.workletNode) return;
          const now = performance.now();
          const elapsed = (now - lastFillTime) / 1000;
          const samplesToGen = Math.min(Math.floor(elapsed * sampleRate), 2048);
          if (samplesToGen <= 0) return;

          const tmpL = new Float32Array(samplesToGen);
          const tmpR = new Float32Array(samplesToGen);
          this.opl2.generateSamples(tmpL, tmpR, samplesToGen);
          this.mixPCMStereo(tmpL, tmpR, samplesToGen);
          this.gus.renderSamples(tmpL, tmpR, samplesToGen);
          this.workletNode.port.postMessage({
            samplesL: Array.from(tmpL),
            samplesR: Array.from(tmpR),
          });
          lastFillTime = now;
        };
        this.fillTimer = setInterval(fill, FILL_INTERVAL_MS) as unknown as number;
      }
    }).catch(() => {
      // AudioWorklet not supported — no OPL2 audio (PC speaker still works)
      URL.revokeObjectURL(url);
    });
  }

  /** Handle I/O port read. Returns value or -1 if not an audio port. */
  portIn(port: number): number {
    // AdLib ports
    if (port === 0x388 || port === 0x228) return this.opl2.readStatus();
    if (port === 0x389 || port === 0x229) return 0; // data read not meaningful

    // Sound Blaster DSP ports (base 0x220)
    if (port === 0x22A) return this.sbDsp.readData();
    if (port === 0x22E) {
      if (this.sbDsp.irqPending) this.sbDsp.ackIRQ();
      return this.sbDsp.readStatus();
    }
    if (port === 0x22C) return 0x00;

    if (port === 0x00) return this.dma.readAddr(0);
    if (port === 0x01) return this.dma.readCount(0);
    if (port === 0x02) return this.dma.readAddr(1);
    if (port === 0x03) return this.dma.readCount(1);
    if (port === 0x04) return this.dma.readAddr(2);
    if (port === 0x05) return this.dma.readCount(2);
    if (port === 0x06) return this.dma.readAddr(3);
    if (port === 0x07) return this.dma.readCount(3);
    if (port === 0x08) return this.dma.readStatus();

    // DMA page registers
    if (port === 0x87) return this.dma.page[0];
    if (port === 0x83) return this.dma.page[1];
    if (port === 0x81) return this.dma.page[2];
    if (port === 0x82) return this.dma.page[3];

    // GUS ports (base 0x240): 0x240-0x24F and 0x340-0x34F
    if ((port >= 0x240 && port <= 0x24F) || (port >= 0x340 && port <= 0x34F)) {
      return this.gus.portRead(port);
    }

    return -1; // Not an audio port
  }

  /** Handle I/O port write. Returns true if handled. */
  portOut(port: number, value: number): boolean {
    // AdLib ports
    if (port === 0x388 || port === 0x228) { this.opl2.writeAddr(value); return true; }
    if (port === 0x389 || port === 0x229) { this.opl2.writeData(value); return true; }

    // Sound Blaster DSP ports (base 0x220)
    if (port === 0x226) { this.sbDsp.writeReset(value); return true; }
    if (port === 0x22C) { this.sbDsp.writeCommand(value); return true; }

    // DMA controller ports (channels 0-3)
    if (port === 0x00) { this.dma.writeAddr(0, value); return true; }
    if (port === 0x01) { this.dma.writeCount(0, value); return true; }
    if (port === 0x02) { this.dma.writeAddr(1, value); return true; }
    if (port === 0x03) { this.dma.writeCount(1, value); return true; }
    if (port === 0x04) { this.dma.writeAddr(2, value); return true; }
    if (port === 0x05) { this.dma.writeCount(2, value); return true; }
    if (port === 0x06) { this.dma.writeAddr(3, value); return true; }
    if (port === 0x07) { this.dma.writeCount(3, value); return true; }
    if (port === 0x08) { /* command register — not needed for SB */ return true; }
    if (port === 0x09) { /* request register */ return true; }
    if (port === 0x0A) { this.dma.writeSingleMask(value); return true; }
    if (port === 0x0B) { this.dma.writeMode(value); return true; }
    if (port === 0x0C) { this.dma.clearFlipFlop(); return true; }
    if (port === 0x0D) { this.dma.masterClear(); return true; }
    if (port === 0x0E) { this.dma.mask = 0; return true; } // clear all masks
    if (port === 0x0F) { this.dma.writeAllMask(value); return true; }

    // DMA page registers
    if (port === 0x87) { this.dma.page[0] = value; return true; }
    if (port === 0x83) { this.dma.page[1] = value; return true; }
    if (port === 0x81) { this.dma.page[2] = value; return true; }
    if (port === 0x82) { this.dma.page[3] = value; return true; }

    // GUS ports (base 0x240): 0x240-0x24F and 0x340-0x34F
    if ((port >= 0x240 && port <= 0x24F) || (port >= 0x340 && port <= 0x34F)) {
      this.gus.portWrite(port, value);
      return true;
    }

    return false; // Not an audio port
  }

  /**
   * Advance DMA transfer and check OPL2 timers. Called from main tick loop.
   * Fires IRQ 7 (via onSBIRQ callback) when a transfer block completes
   * or an OPL2 timer expires.
   */
  tickDMA(): void {
    if (this.sbDsp.tickDMA(this.dma, this.readMemory)) {
      this.onSBIRQ();
    }
    this.opl2.tickTimers();
    this.gus.tickTimers();
  }

  /** Mix SB PCM samples into stereo output buffers (additive, resampled, centered). */
  private pcmAccum = 0;
  private mixPCMStereo(bufL: Float32Array, bufR: Float32Array, length: number): void {
    const dsp = this.sbDsp;
    const avail = (dsp.pcmWritePos - dsp.pcmReadPos) & 0xFFFF;
    if (avail === 0) return;
    const sbRate = dsp.getSampleRate();
    const outRate = this.ctx?.sampleRate ?? 44100;
    const ratio = sbRate / outRate;
    for (let i = 0; i < length; i++) {
      this.pcmAccum += ratio;
      while (this.pcmAccum >= 1 && dsp.pcmReadPos !== dsp.pcmWritePos) {
        this.pcmAccum -= 1;
        dsp.pcmReadPos = (dsp.pcmReadPos + 1) & 0xFFFF;
      }
      if (((dsp.pcmWritePos - dsp.pcmReadPos) & 0xFFFF) > 0) {
        const s = dsp.pcmRing[dsp.pcmReadPos & 0xFFFF] * 0.5;
        bufL[i] += s;
        bufR[i] += s;
      }
    }
  }

  /** Update PC speaker state (call when port 0x61 or PIT ch2 changes). */
  updateSpeaker(port61: number, pitCh2Reload: number): void {
    this.speaker.update(port61, pitCh2Reload);
  }

  destroy(): void {
    this.speaker.destroy();
    if (this.fillTimer) clearInterval(this.fillTimer);
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
  }
}
