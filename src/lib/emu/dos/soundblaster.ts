/**
 * Sound Blaster 2.0 DSP emulation with DMA playback.
 *
 * DSP at ports 0x220-0x22F, DMA channel 1, IRQ 7.
 * Supports single-cycle and auto-init 8-bit DMA, direct DAC,
 * time constant, DSP identification, and version query.
 */

import type { DMAController } from './dma';

const SB_DSP_READY = 0xAA;
const SB_DSP_VERSION_HI = 2;
const SB_DSP_VERSION_LO = 1;

export const SB_IRQ = 7; // IRQ 7 → INT 0x0F

/** E2 DMA identification XOR table (from SB 2.0 DSP ROM reverse-engineering). */
const E2_INCR = [
  [1, -2, -4, 8, -16, 32, 64, -128],
  [-1, 2, -4, 8, 16, -32, 64, -128],
  [1, -2, 4, -8, 16, -32, -64, 128],
  [-1, 2, 4, -8, -16, 32, -64, 128],
];

export class SoundBlasterDSP {
  private resetState = 0;
  private dataQueue: number[] = [];
  private pendingParams: number[] = [];
  private expectedParams = 0;
  private lastCommand = 0;
  private speakerOn = false;
  private timeConstant = 128; // default ~8kHz
  private testRegister = 0;   // DSP test register (E4h write, E8h read)
  private e2Value = 0xAA;     // E2 DMA identification accumulator
  private e2Count = 0;        // E2 call counter (selects table row)

  // DMA playback state
  dmaActive = false;
  dmaLength = 0;         // total samples to transfer
  dmaTransferred = 0;    // samples transferred so far
  dmaAutoInit = false;
  irqPending = false;    // true when transfer complete, waiting for ACK
  private highSpeed = false;

  // PCM output buffer for AudioWorklet consumption
  pcmRing = new Float32Array(65536);
  pcmWritePos = 0;
  pcmReadPos = 0;

  /** Callback to fire IRQ 7 (set by DosAudio). */
  onIRQ: () => void = () => {};
  /** Callback for E2 DMA identification — writes a byte to DMA channel 0. */
  onE2Write: (value: number) => void = () => {};

  reset(): void {
    this.dataQueue = [SB_DSP_READY];
    this.resetState = 0;
    this.pendingParams = [];
    this.expectedParams = 0;
    this.lastCommand = 0;
    this.dmaActive = false;
    this.dmaLength = 0;
    this.dmaTransferred = 0;
    this.dmaAutoInit = false;
    this.irqPending = false;
    this.highSpeed = false;
    this.speakerOn = false;
    this.e2Value = 0xAA;
    this.e2Count = 0;
  }

  writeReset(val: number): void {
    if (val === 1) {
      this.resetState = 1;
    } else if (val === 0 && this.resetState === 1) {
      this.reset();
    }
  }

  writeCommand(val: number): void {
    // If collecting parameters for a previous command
    if (this.expectedParams > 0) {
      this.pendingParams.push(val);
      this.expectedParams--;
      if (this.expectedParams === 0) this.executeCommand();
      return;
    }

    this.lastCommand = val;
    this.pendingParams = [];

    switch (val) {
      case 0x10: // Direct DAC output — 1 param (sample byte)
        this.expectedParams = 1;
        break;
      case 0x14: // DMA DAC 8-bit (single cycle) — 2 params (length lo, hi)
      case 0x24: // DMA ADC 8-bit (single cycle) — treat same as 0x14
      case 0x91: // High-speed DMA 8-bit auto-init (no params, uses set length)
        if (val === 0x91) {
          this.dmaAutoInit = true;
          this.highSpeed = true;
          this.startDMA(this.dmaLength);
        } else {
          this.expectedParams = 2;
        }
        break;
      case 0x1C: // Auto-init DMA DAC 8-bit (no length params, uses 0x48 block size)
        this.dmaAutoInit = true;
        this.startDMA(this.dmaLength);
        break;
      case 0x20: // Direct ADC input — return silence (0x80)
        this.dataQueue.push(0x80);
        break;
      case 0x40: // Set time constant — 1 param
        this.expectedParams = 1;
        break;
      case 0x48: // Set DMA block transfer size — 2 params (lo, hi)
        this.expectedParams = 2;
        break;
      case 0xD0: // Halt DMA
        this.dmaActive = false;
        break;
      case 0xD1: // Enable speaker
        this.speakerOn = true;
        break;
      case 0xD3: // Disable speaker
        this.speakerOn = false;
        break;
      case 0xD4: // Continue DMA (after halt)
        if (this.dmaLength > 0) this.dmaActive = true;
        break;
      case 0xD8: // Get speaker status — 0xFF=on, 0x00=off
        this.dataQueue.push(this.speakerOn ? 0xFF : 0x00);
        break;
      case 0xDA: // Exit auto-init DMA
        this.dmaAutoInit = false;
        break;
      case 0xE0: // DSP identification — 1 param
        this.expectedParams = 1;
        break;
      case 0xE1: // Get DSP version
        this.dataQueue.push(SB_DSP_VERSION_HI, SB_DSP_VERSION_LO);
        break;
      case 0xE2: // DMA identification — 1 param
        this.expectedParams = 1;
        break;
      case 0xE4: // Write test register — 1 param
        this.expectedParams = 1;
        break;
      case 0xE8: // Read test register — return stored value
        this.dataQueue.push(this.testRegister);
        break;
      case 0xF2: // Force IRQ — immediately fire IRQ 7
        this.irqPending = true;
        this.onIRQ();
        break;
      case 0xF8: // Undocumented — some detection routines read a response
        this.dataQueue.push(0x00);
        break;
      default:
        break;
    }
  }

  private executeCommand(): void {
    const p = this.pendingParams;
    switch (this.lastCommand) {
      case 0x10: { // Direct DAC — write single sample
        if (this.speakerOn) {
          this.pcmRing[this.pcmWritePos & 0xFFFF] = (p[0] - 128) / 128;
          this.pcmWritePos++;
        }
        break;
      }
      case 0x14: // DMA DAC 8-bit single cycle
      case 0x24: {
        const length = (p[0] | (p[1] << 8)) + 1;
        this.dmaAutoInit = false;
        this.startDMA(length);
        break;
      }
      case 0x40: // Set time constant
        this.timeConstant = p[0];
        break;
      case 0x48: { // Set DMA block transfer size
        this.dmaLength = (p[0] | (p[1] << 8)) + 1;
        break;
      }
      case 0xE0: // DSP identification — return bitwise inverse
        this.dataQueue.push(~p[0] & 0xFF);
        break;
      case 0xE2: { // DMA identification — compute XOR and write to DMA channel 0
        const row = E2_INCR[this.e2Count & 3];
        let acc = this.e2Value;
        for (let i = 0; i < 8; i++) {
          if (p[0] & (1 << i)) acc = (acc + row[i]) & 0xFF;
        }
        this.e2Value = acc;
        this.e2Count++;
        this.onE2Write(acc);
        break;
      }
      case 0xE4: // Write test register
        this.testRegister = p[0];
        break;
    }
  }

  private dmaTicks = 0; // Number of tickDMA calls since DMA started

  dma?: import('./dma').DMAController;
  readMemFn?: (addr: number) => number;

  private startDMA(length: number): void {
    this.dmaLength = length;
    this.dmaTransferred = 0;
    this.dmaActive = true;
    this.dmaTicks = 0;
    if (this.dma) {
      console.log(`[SB-DMA] Start: length=${length} rate=${this.getSampleRate()}Hz autoInit=${this.dmaAutoInit}`);
    }
  }

  /** Get the sample rate derived from time constant. */
  getSampleRate(): number {
    return 1000000 / (256 - this.timeConstant);
  }

  /**
   * Transfer a batch of DMA samples. Called from the main tick loop.
   * Reads bytes from memory via the DMA controller and writes to PCM ring.
   * Returns true if transfer completed (IRQ should fire).
   */
  tickDMA(dma: DMAController, readMem: (addr: number) => number): boolean {
    if (!this.dmaActive || !dma.isActive(1)) return false;

    // Rate-limit transfer to match the programmed sample rate relative to
    // emulated CPU speed. Each tickDMA call corresponds to 256 CPU instructions.
    // At ~4.77 MHz and typical sample rates (8-22 kHz) this gives ~0.5-1.2
    // samples per tick, preventing DMA from completing before IRQ handlers run.
    this.dmaTicks++;
    const sampleRate = this.getSampleRate();
    const INSTRUCTIONS_PER_TICK = 256;
    const CPU_FREQ = 4770000; // ~4.77 MHz (original IBM PC)
    const expectedSamples = Math.min(
      Math.floor(this.dmaTicks * INSTRUCTIONS_PER_TICK * sampleRate / CPU_FREQ),
      this.dmaLength
    );
    const batch = Math.min(512, expectedSamples - this.dmaTransferred);
    for (let i = 0; i < batch; i++) {
      const physAddr = dma.getPhysicalAddr(1);
      const sample = readMem(physAddr);

      if (this.speakerOn) {
        this.pcmRing[this.pcmWritePos & 0xFFFF] = (sample - 128) / 128;
        this.pcmWritePos++;
      }

      // Advance DMA address and decrement count
      dma.currentAddr[1] = (dma.currentAddr[1] + 1) & 0xFFFF;
      const countBefore = dma.currentCount[1];
      dma.currentCount[1] = (countBefore - 1) & 0xFFFF;
      this.dmaTransferred++;

      // Check for DMA terminal count (count wrapped from 0 to 0xFFFF)
      if (countBefore === 0) {
        dma.status |= 0x02; // TC bit for channel 1
        if (dma.mode[1] & 0x10) {
          // Auto-init: reload address and count from base registers
          dma.currentAddr[1] = dma.baseAddr[1];
          dma.currentCount[1] = dma.baseCount[1];
        } else {
          // Single-cycle: mask channel, stop transfer
          dma.mask |= (1 << 1);
          this.dmaActive = false;
          this.irqPending = true;
          return true;
        }
      }
    }

    if (this.dmaTransferred >= this.dmaLength) {
      // Transfer complete
      dma.status |= 0x02; // TC bit for channel 1
      if (this.dmaAutoInit) {
        // Reload from base registers
        dma.currentAddr[1] = dma.baseAddr[1];
        dma.currentCount[1] = dma.baseCount[1];
        this.dmaTransferred = 0;
      } else {
        this.dmaActive = false;
      }
      this.irqPending = true;
      return true; // signal IRQ
    }
    return false;
  }

  /** Acknowledge IRQ (called when program reads port 0x22E during IRQ). */
  ackIRQ(): void { this.irqPending = false; }

  readData(): number {
    return this.dataQueue.length > 0 ? this.dataQueue.shift()! : 0xFF;
  }

  readStatus(): number {
    return this.dataQueue.length > 0 ? 0xFF : 0x7F;
  }
}
