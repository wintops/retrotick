/**
 * PC Speaker emulation with two modes:
 *
 * 1. Classic: PIT channel 2 square wave via OscillatorNode
 * 2. Guitar: Karplus-Strong plucked string synthesis via AudioWorklet
 *
 * Guitar mode turns every beep into a guitar pluck — hilariously musical.
 */

const WORKLET_CODE = `
class KarplusStrongProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = null;
    this.len = 0;
    this.pos = 0;
    this.active = false;
    this.decay = 1.0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'pluck') {
        const len = Math.round(sampleRate / d.freq);
        if (len < 2 || len > 8192) return;
        this.buf = new Float32Array(len);
        // Two-pass lowpass filtered noise — warm, body-rich pluck
        let prev = 0;
        for (let i = 0; i < len; i++) {
          const noise = Math.random() * 2 - 1;
          prev = 0.4 * noise + 0.6 * prev;
          this.buf[i] = prev;
        }
        // Second pass — even warmer, more fundamental
        prev = this.buf[0];
        for (let i = 1; i < len; i++) {
          this.buf[i] = 0.3 * this.buf[i] + 0.7 * prev;
          prev = this.buf[i];
        }
        this.len = len;
        this.pos = 0;
        this.active = true;
      } else if (d.type === 'stop') {
        this.active = false;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!this.active || !this.buf) { out.fill(0); return true; }
    const buf = this.buf, len = this.len;
    for (let i = 0; i < out.length; i++) {
      const curr = buf[this.pos];
      const next = buf[(this.pos + 1) % len];
      out[i] = curr;
      buf[this.pos] = (curr + next) * 0.5 * this.decay;
      this.pos = (this.pos + 1) % len;
    }
    return true;
  }
}
registerProcessor('karplus-strong', KarplusStrongProcessor);
`;

export class PCSpeaker {
  private oscillator: OscillatorNode | null = null;
  private gain: GainNode | null = null;
  private ctx: AudioContext | null = null;
  private enabled = false;
  private frequency = 0;

  // Guitar mode (Karplus-Strong)
  private guitarNode: AudioWorkletNode | null = null;
  private guitarGain: GainNode | null = null;
  private bodyEq: BiquadFilterNode | null = null;
  private highCut: BiquadFilterNode | null = null;
  private guitarReady = false;
  guitarMode = true;

  constructor(ctx: AudioContext | null) {
    this.ctx = ctx;
    if (ctx) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.gain.connect(ctx.destination);
    }
  }

  /** Must be called after user gesture to set up AudioWorklet */
  async initGuitar(): Promise<void> {
    if (!this.ctx || this.guitarReady) return;
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      this.guitarNode = new AudioWorkletNode(this.ctx, 'karplus-strong');

      // Acoustic guitar body EQ: boost low-mids + tame highs
      this.bodyEq = this.ctx.createBiquadFilter();
      this.bodyEq.type = 'lowshelf';
      this.bodyEq.frequency.value = 250;
      this.bodyEq.gain.value = 8; // +8dB bass boost — warm body resonance

      this.highCut = this.ctx.createBiquadFilter();
      this.highCut.type = 'lowpass';
      this.highCut.frequency.value = 3500; // roll off harsh highs
      this.highCut.Q.value = 0.7;

      this.guitarGain = this.ctx.createGain();
      this.guitarGain.gain.value = 0;
      this.guitarNode.connect(this.bodyEq);
      this.bodyEq.connect(this.highCut);
      this.highCut.connect(this.guitarGain);
      this.guitarGain.connect(this.ctx.destination);
      this.guitarReady = true;
    } catch {
      // AudioWorklet not available — fall back to square wave
      this.guitarReady = false;
    }
  }

  update(port61: number, pitReload: number): void {
    const speakerOn = (port61 & 0x03) === 0x03; // both gate and enable
    const freq = pitReload > 0 ? 1193182 / pitReload : 0;

    if (speakerOn && freq >= 20 && freq <= 20000) {
      const freqChanged = Math.abs(this.frequency - freq) > 0.5;
      if (!this.enabled || freqChanged) {
        this.frequency = freq;
        if (this.guitarMode && this.guitarReady) {
          this.pluckGuitar(freq);
        } else {
          this.startTone(freq);
        }
      }
      this.enabled = true;
    } else {
      if (this.enabled) {
        if (this.guitarMode && this.guitarReady) {
          this.stopGuitar();
        } else {
          this.stopTone();
        }
      }
      this.enabled = false;
    }
  }

  // --- Classic square wave ---

  private startTone(freq: number): void {
    if (!this.ctx || !this.gain) return;
    if (!this.oscillator) {
      this.oscillator = this.ctx.createOscillator();
      this.oscillator.type = 'square';
      this.oscillator.connect(this.gain);
      this.oscillator.start();
    }
    this.oscillator.frequency.setValueAtTime(freq, this.ctx.currentTime);
    this.gain.gain.setValueAtTime(0.08, this.ctx.currentTime); // Low volume for speaker
  }

  private stopTone(): void {
    if (this.gain && this.ctx) {
      this.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }
  }

  // --- Guitar (Karplus-Strong) ---

  private pluckGuitar(freq: number): void {
    if (!this.guitarNode || !this.guitarGain || !this.ctx) return;
    this.guitarNode.port.postMessage({ type: 'pluck', freq });
    this.guitarGain.gain.setValueAtTime(0.25, this.ctx.currentTime);
  }

  private stopGuitar(): void {
    if (!this.guitarGain || !this.ctx) return;
    // Quick fade out instead of abrupt cut — more natural
    this.guitarGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  }

  destroy(): void {
    this.stopTone();
    if (this.oscillator) {
      this.oscillator.stop();
      this.oscillator.disconnect();
      this.oscillator = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    if (this.guitarNode) {
      this.guitarNode.port.postMessage({ type: 'stop' });
      this.guitarNode.disconnect();
      this.guitarNode = null;
    }
    if (this.bodyEq) { this.bodyEq.disconnect(); this.bodyEq = null; }
    if (this.highCut) { this.highCut.disconnect(); this.highCut = null; }
    if (this.guitarGain) { this.guitarGain.disconnect(); this.guitarGain = null; }
  }
}
