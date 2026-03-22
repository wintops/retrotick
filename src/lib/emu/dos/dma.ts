/**
 * Intel 8237A DMA Controller emulation (channels 0-3).
 *
 * Used by Sound Blaster for 8-bit PCM DMA transfers on channel 1.
 */

export class DMAController {
  // Per-channel state
  baseAddr = new Uint16Array(4);   // programmed base address
  baseCount = new Uint16Array(4);  // programmed base count (length - 1)
  currentAddr = new Uint16Array(4);
  currentCount = new Uint16Array(4);
  page = new Uint8Array(4);        // page register (high byte of 20-bit address)
  mode = new Uint8Array(4);        // mode register per channel
  mask = 0x0F;                     // all channels masked initially
  flipFlop = false;                // byte pointer flip-flop (low/high)
  status = 0;                      // status register (bit 0-3: TC reached for ch 0-3)

  /** Clear the byte pointer flip-flop. */
  clearFlipFlop(): void { this.flipFlop = false; }

  /** Write base address register for a channel. */
  writeAddr(ch: number, val: number): void {
    if (!this.flipFlop) {
      this.baseAddr[ch] = (this.baseAddr[ch] & 0xFF00) | val;
      this.currentAddr[ch] = (this.currentAddr[ch] & 0xFF00) | val;
    } else {
      this.baseAddr[ch] = (this.baseAddr[ch] & 0x00FF) | (val << 8);
      this.currentAddr[ch] = (this.currentAddr[ch] & 0x00FF) | (val << 8);
    }
    this.flipFlop = !this.flipFlop;
  }

  /** Write count register for a channel. */
  writeCount(ch: number, val: number): void {
    if (!this.flipFlop) {
      this.baseCount[ch] = (this.baseCount[ch] & 0xFF00) | val;
      this.currentCount[ch] = (this.currentCount[ch] & 0xFF00) | val;
    } else {
      this.baseCount[ch] = (this.baseCount[ch] & 0x00FF) | (val << 8);
      this.currentCount[ch] = (this.currentCount[ch] & 0x00FF) | (val << 8);
    }
    this.flipFlop = !this.flipFlop;
  }

  /** Read current address for a channel. */
  readAddr(ch: number): number {
    const val = this.currentAddr[ch];
    if (!this.flipFlop) { this.flipFlop = true; return val & 0xFF; }
    this.flipFlop = false; return (val >> 8) & 0xFF;
  }

  /** Read current count for a channel. */
  readCount(ch: number): number {
    const val = this.currentCount[ch];
    if (!this.flipFlop) { this.flipFlop = true; return val & 0xFF; }
    this.flipFlop = false; return (val >> 8) & 0xFF;
  }

  /** Write single channel mask register. */
  writeSingleMask(val: number): void {
    const ch = val & 3;
    if (val & 4) this.mask |= (1 << ch); else this.mask &= ~(1 << ch);
  }

  /** Write all-channel mask register. */
  writeAllMask(val: number): void { this.mask = val & 0x0F; }

  /** Write mode register. */
  writeMode(val: number): void {
    const ch = val & 3;
    this.mode[ch] = val;
  }

  /** Master clear (like hardware reset). */
  masterClear(): void {
    this.flipFlop = false;
    this.mask = 0x0F;
    this.status = 0;
  }

  /** Read status register (clears TC bits). */
  readStatus(): number {
    const s = this.status;
    this.status &= 0xF0; // clear TC bits on read
    return s;
  }

  /** Get the 20-bit physical start address for a channel. */
  getPhysicalAddr(ch: number): number {
    return (this.page[ch] << 16) | this.currentAddr[ch];
  }

  /** Check if channel is unmasked and ready for transfer. */
  isActive(ch: number): boolean {
    return (this.mask & (1 << ch)) === 0;
  }
}
