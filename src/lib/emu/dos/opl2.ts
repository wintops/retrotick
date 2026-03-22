/**
 * OPL2 (YM3812) FM synthesis emulation — enhanced.
 *
 * Emulates the AdLib-compatible FM chip at ports 0x388-0x389.
 * 9 channels, 18 operators, 4 waveforms, envelope generation with
 * attack/decay/sustain/release, feedback, FM/additive connection modes,
 * tremolo (AM), vibrato, KSL, EG type, percussion mode, and CSM.
 *
 * Enhancements beyond real hardware:
 * - 2x oversampling (reduces FM aliasing artifacts, especially in bass)
 * - Stereo channel spread (constant-power panning)
 * - Gentle warm saturation (tanh)
 * - Frequency-aware chorus (reduced on bass for tight low-end)
 * - dB-domain envelope with 72 dB dynamic range (smooth decay tails)
 * - Interpolated sine table + resampling
 * - 2-pole Butterworth low-pass filter (~14 kHz)
 * - Air shelf EQ (~10 kHz, +1.5 dB openness)
 * - DC blocking high-pass filter (~5 Hz)
 * - Freeverb-style stereo reverb (warm room ambience)
 * - Even harmonic generation (tube-like warmth)
 */

import { StereoReverb } from './reverb';

const OPL_RATE = 49716; // OPL2 native sample rate
const INTERNAL_RATE = OPL_RATE * 2; // 2x oversampling for FM anti-aliasing (cleaner bass)
const NUM_CHANNELS = 9;
const NUM_OPERATORS = 18;

// Operator index within a channel: channel i -> operators [CH_OP[i][0], CH_OP[i][1]]
const CH_OP: [number, number][] = [
  [0, 3], [1, 4], [2, 5], [6, 9], [7, 10], [8, 11], [12, 15], [13, 16], [14, 17],
];

// Register offset -> operator index mapping
const OP_OFFSET = [0, 1, 2, 3, 4, 5, -1, -1, 6, 7, 8, 9, 10, 11, -1, -1, 12, 13, 14, 15, 16, 17];

// Multiplier table
const MULTI = [0.5, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 12, 12, 15, 15];

// Sine table (10-bit, 1024 entries)
const SINE_TABLE = new Float64Array(1024);
for (let i = 0; i < 1024; i++) {
  SINE_TABLE[i] = Math.sin((i + 0.5) * Math.PI / 512);
}

// FM modulation depth: operator output +/-1 maps to +/-MOD_DEPTH cycles of phase shift.
const MOD_DEPTH = 4.0;

// ---- Stereo panning (constant-power) ----

const CHANNEL_PAN = [-0.35, 0.25, -0.15, 0.35, 0.0, -0.25, 0.15, -0.10, 0.10];
const PAN_L = new Float64Array(NUM_CHANNELS);
const PAN_R = new Float64Array(NUM_CHANNELS);
for (let i = 0; i < NUM_CHANNELS; i++) {
  const theta = (CHANNEL_PAN[i] + 1) * Math.PI / 4;
  PAN_L[i] = Math.cos(theta);
  PAN_R[i] = Math.sin(theta);
}

// ---- Soft saturation (gentle warmth, preserves bass dynamics) ----

const DRIVE = 1.15;
const INV_TANH_DRIVE = 1 / Math.tanh(DRIVE);

// ---- Chorus: per-channel slow LFO detuning ----

const CHORUS_RATES = [0.31, 0.67, 0.43, 0.59, 0.37, 0.53, 0.47, 0.41, 0.61]; // Hz
const CHORUS_DEPTH = 3; // +/- cents

// ---- Envelope timing tables ----

const ATTACK_TIMES = new Float64Array(64);
const DECAY_TIMES = new Float64Array(64);
for (let i = 0; i < 4; i++) { ATTACK_TIMES[i] = Infinity; DECAY_TIMES[i] = Infinity; }
for (let i = 4; i < 64; i++) {
  const group = i >> 2;
  const sub = i & 3;
  const groupScale = Math.pow(2, -(group - 1));
  const subScale = 1 - sub / 12;
  ATTACK_TIMES[i] = 2826 * groupScale * subScale;
  DECAY_TIMES[i] = 39280 * groupScale * subScale;
}
for (let i = 60; i < 64; i++) { ATTACK_TIMES[i] = 0; DECAY_TIMES[i] = 0; }

// ---- KSL (Key Scale Level) ----

const KSL_ROM = [0, 32, 40, 45, 48, 51, 53, 55, 56, 58, 59, 60, 61, 62, 63, 64];
const KSL_SHIFT = [31, 1, 2, 0];

// ---- LFO frequencies ----

const TREMOLO_FREQ = OPL_RATE / 13432; // ~3.7 Hz
const VIBRATO_FREQ = OPL_RATE / 8192;  // ~6.1 Hz

// ---- Operator state ----

const ENV_OFF = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
const ENV_SUSTAIN = 3;
const ENV_RELEASE = 4;

const SILENCE_DB = 72; // 72 dB dynamic range (smooth decay tails on good headphones)

// Anti-click ramp duration in samples at INTERNAL_RATE (~0.5ms)
const CLICK_RAMP_SAMPLES = Math.round(INTERNAL_RATE * 0.0005);

interface OpState {
  phase: number;          // 0..1 accumulator
  envLevel: number;       // dB attenuation: 0 = max volume, SILENCE_DB = silent
  envState: number;       // ENV_*
  feedback0: number;      // previous output for feedback
  feedback1: number;      // previous-previous output for feedback
  rampPos: number;        // anti-click ramp: 0=silent, CLICK_RAMP_SAMPLES=full
  rampDir: number;        // +1 = ramping up (key-on), -1 = ramping down (key-off), 0 = stable
}

// ---- OPL2 Emulator ----

export class OPL2 {
  private regs = new Uint8Array(256);
  private regIndex = 0; // address latch
  private ops: OpState[] = [];
  private sampleRate: number;
  private accumPhase = 0; // fractional resampling accumulator
  // 4-point history for cubic Hermite interpolation (newest = h3)
  private h0L = 0; private h1L = 0; private h2L = 0; private h3L = 0;
  private h0R = 0; private h1R = 0; private h2R = 0; private h3R = 0;
  private currL = 0; private currR = 0;
  // 2-pole Butterworth LPF state (Direct Form II Transposed)
  private lpS1L = 0; private lpS2L = 0;
  private lpS1R = 0; private lpS2R = 0;
  private lpA1 = 0; private lpA2 = 0; private lpB0 = 0;
  // DC blocking HPF state: y[n] = x[n] - x[n-1] + R*y[n-1]
  private dcPrevInL = 0; private dcPrevOutL = 0;
  private dcPrevInR = 0; private dcPrevOutR = 0;
  private dcR: number = 0;
  // Analog warmth: gentle mid-bass peaking EQ (~120 Hz, +2 dB)
  private wS1L = 0; private wS2L = 0;
  private wS1R = 0; private wS2R = 0;
  private wB0 = 0; private wB1 = 0; private wB2 = 0;
  private wA1 = 0; private wA2 = 0;
  // Air shelf EQ: high shelf at 10 kHz, +1.5 dB (openness/transparency)
  private airS1L = 0; private airS2L = 0;
  private airS1R = 0; private airS2R = 0;
  private airB0 = 0; private airB1 = 0; private airB2 = 0;
  private airA1 = 0; private airA2 = 0;
  // Stereo reverb
  private reverb: StereoReverb;
  // TPDF dither PRNG state (simple xorshift32)
  private ditherState = 0x12345678;
  private chorusPhase = new Float64Array(NUM_CHANNELS);

  // Global LFO state
  private tremoloPhase = 0;   // 0..1 triangle at ~3.7 Hz
  private vibratoPhase = 0;   // 0..1 triangle at ~6.1 Hz
  private noiseRNG = 1;       // 23-bit LFSR for percussion noise

  // Timer state — tick-based (each tickTimers call = 256 instructions ≈ 53.7µs at 4.77MHz)
  private timer1Value = 0;
  private timer2Value = 0;
  private timer1Count = 0;   // counts up from timer value; overflows at 256
  private timer2Count = 0;
  private timer1Running = false;
  private timer2Running = false;
  private timer1Expired = false;
  private timer2Expired = false;
  private timer1Mask = false;
  private timer2Mask = false;
  private timer1IRQFired = false; // track if IRQ already fired for this timer cycle
  private timer2IRQFired = false;

  /** Callback fired when an OPL2 timer expires (triggers hardware IRQ 7). */
  onTimerIRQ: () => void = () => {};

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.reverb = new StereoReverb(sampleRate);
    this.computeFilterCoeffs(sampleRate);
    for (let i = 0; i < NUM_OPERATORS; i++) {
      this.ops.push({ phase: 0, envLevel: SILENCE_DB, envState: ENV_OFF, feedback0: 0, feedback1: 0, rampPos: 0, rampDir: 0 });
    }
    for (let i = 0; i < NUM_CHANNELS; i++) {
      this.chorusPhase[i] = i / NUM_CHANNELS;
    }
  }

  /** Compute 2-pole Butterworth LPF + DC blocking HPF coefficients. */
  private computeFilterCoeffs(rate: number): void {
    // 2-pole Butterworth LPF at 14 kHz (sharper rolloff than 1-pole, preserves bass)
    const fc = 14000;
    const w0 = 2 * Math.PI * fc / rate;
    const alpha = Math.sin(w0) / (2 * Math.SQRT2); // Q = 1/sqrt(2) for Butterworth
    const cosw0 = Math.cos(w0);
    const a0 = 1 + alpha;
    this.lpB0 = ((1 - cosw0) / 2) / a0;
    // lpB1 = (1 - cosw0) / a0 = 2 * lpB0, lpB2 = lpB0 (symmetric)
    this.lpA1 = (-2 * cosw0) / a0;
    this.lpA2 = (1 - alpha) / a0;
    // DC blocking HPF: y[n] = x[n] - x[n-1] + R * y[n-1], R close to 1
    this.dcR = 1 - 2 * Math.PI * 5 / rate; // ~5 Hz cutoff
    // Air shelf: high shelf at 10 kHz, +1.5 dB (adds openness/transparency)
    const airFreq = 10000, airGain = 1.5;
    const airA = Math.pow(10, airGain / 40);
    const airW0 = 2 * Math.PI * airFreq / rate;
    const airAlpha = Math.sin(airW0) / (2 * 0.7); // Q=0.7
    const airCos = Math.cos(airW0);
    const airA0 = (airA + 1) - (airA - 1) * airCos + 2 * Math.sqrt(airA) * airAlpha;
    this.airB0 = (airA * ((airA + 1) + (airA - 1) * airCos + 2 * Math.sqrt(airA) * airAlpha)) / airA0;
    this.airB1 = (-2 * airA * ((airA - 1) + (airA + 1) * airCos)) / airA0;
    this.airB2 = (airA * ((airA + 1) + (airA - 1) * airCos - 2 * Math.sqrt(airA) * airAlpha)) / airA0;
    this.airA1 = (2 * ((airA - 1) - (airA + 1) * airCos)) / airA0;
    this.airA2 = ((airA + 1) - (airA - 1) * airCos - 2 * Math.sqrt(airA) * airAlpha) / airA0;

    // Analog warmth: peaking EQ at 120 Hz, +2 dB, Q=0.8
    // Simulates the mid-bass body of real AdLib analog output stage
    const wFreq = 120, wGain = 2, wQ = 0.8;
    const wA = Math.pow(10, wGain / 40); // sqrt of linear gain
    const wW0 = 2 * Math.PI * wFreq / rate;
    const wAlpha = Math.sin(wW0) / (2 * wQ);
    const wCos = Math.cos(wW0);
    const wA0 = 1 + wAlpha / wA;
    this.wB0 = (1 + wAlpha * wA) / wA0;
    this.wB1 = (-2 * wCos) / wA0;
    this.wB2 = (1 - wAlpha * wA) / wA0;
    this.wA1 = this.wB1; // same numerator/denominator cosine term
    this.wA2 = (1 - wAlpha / wA) / wA0;
  }

  /** Update the output sample rate (preserves all register/operator state). */
  setSampleRate(rate: number): void {
    this.sampleRate = rate;
    this.computeFilterCoeffs(rate);
    this.reverb.setSampleRate(rate);
  }

  writeAddr(val: number): void { this.regIndex = val & 0xFF; }

  /** Advance OPL2 timers — tick-based (called every 256 CPU instructions).
   *  Timer 1: 80µs per unit. Each tick call ≈ 53.7µs at 4.77MHz.
   *  Advance counter by 1 per call (close enough and ensures detection works). */
  tickTimers(): void {
    if (this.timer1Running && !this.timer1Expired) {
      this.timer1Count++;
      if (this.timer1Count >= 256) {
        this.timer1Expired = true;
        this.timer1Count = this.timer1Value; // reload
        if (!this.timer1Mask && !this.timer1IRQFired) {
          this.timer1IRQFired = true;
          this.onTimerIRQ();
        }
        if (this.regs[0x08] & 0x80) {
          for (let ch = 0; ch < NUM_CHANNELS; ch++) {
            const [op1, op2] = CH_OP[ch];
            this.ops[op1].envState = ENV_ATTACK;
            this.ops[op1].envLevel = SILENCE_DB;
            this.ops[op2].envState = ENV_ATTACK;
            this.ops[op2].envLevel = SILENCE_DB;
          }
        }
      }
    }
    if (this.timer2Running && !this.timer2Expired) {
      this.timer2Count++;
      if (this.timer2Count >= 256) {
        this.timer2Expired = true;
        this.timer2Count = this.timer2Value; // reload
        if (!this.timer2Mask && !this.timer2IRQFired) {
          this.timer2IRQFired = true;
          this.onTimerIRQ();
        }
      }
    }
  }

  readStatus(): number {
    this.tickTimers();
    // Bit 7: IRQ (any unmasked timer expired), Bit 6: Timer 1, Bit 5: Timer 2
    let status = 0;
    if (this.timer1Expired && !this.timer1Mask) status |= 0x40;
    if (this.timer2Expired && !this.timer2Mask) status |= 0x20;
    if (status) status |= 0x80; // IRQ flag
    return status;
  }

  /** Trigger key-on for a single operator. */
  private keyOnOp(opIdx: number): void {
    const op = this.ops[opIdx];
    op.envState = ENV_ATTACK;
    op.envLevel = SILENCE_DB;
    op.phase = 0;
    op.rampDir = 1; // fade in to prevent click
  }

  /** Trigger key-off for a single operator. */
  private keyOffOp(opIdx: number): void {
    const op = this.ops[opIdx];
    if (op.envState !== ENV_OFF) op.envState = ENV_RELEASE;
  }

  writeData(val: number): void {
    const reg = this.regIndex;
    const old = this.regs[reg];
    this.regs[reg] = val;

    // Timer registers
    if (reg === 0x02) { this.timer1Value = val; return; }
    if (reg === 0x03) { this.timer2Value = val; return; }
    if (reg === 0x04) {
      // Timer control register
      if (val & 0x80) {
        // Reset IRQ flags
        this.timer1Expired = false;
        this.timer2Expired = false;
        this.timer1IRQFired = false;
        this.timer2IRQFired = false;
        return;
      }
      this.timer1Mask = !!(val & 0x40);
      this.timer2Mask = !!(val & 0x20);
      const t1Start = !!(val & 0x01);
      const t2Start = !!(val & 0x02);
      if (t1Start && !this.timer1Running) {
        this.timer1Running = true;
        this.timer1Count = this.timer1Value; // start counting from value
        this.timer1Expired = false;
        this.timer1IRQFired = false;
      } else if (!t1Start) {
        this.timer1Running = false;
      }
      if (t2Start && !this.timer2Running) {
        this.timer2Running = true;
        this.timer2Count = this.timer2Value;
        this.timer2Expired = false;
        this.timer2IRQFired = false;
      } else if (!t2Start) {
        this.timer2Running = false;
      }
      return;
    }

    // Key-on/off: registers 0xB0-0xB8
    if (reg >= 0xB0 && reg <= 0xB8) {
      const ch = reg - 0xB0;
      const keyOn = (val >> 5) & 1;
      const wasOn = (old >> 5) & 1;
      const [op1, op2] = CH_OP[ch];
      if (keyOn && !wasOn) { this.keyOnOp(op1); this.keyOnOp(op2); }
      else if (!keyOn && wasOn) { this.keyOffOp(op1); this.keyOffOp(op2); }
    }

    // Rhythm mode key-on/off: register 0xBD bits 0-4 control percussion instruments
    if (reg === 0xBD) {
      const rhythmOn = val & 0x20;
      if (rhythmOn) {
        // Bass drum (bit 4): channel 6, both operators
        if ((val & 0x10) && !(old & 0x10)) { this.keyOnOp(CH_OP[6][0]); this.keyOnOp(CH_OP[6][1]); }
        if (!(val & 0x10) && (old & 0x10)) { this.keyOffOp(CH_OP[6][0]); this.keyOffOp(CH_OP[6][1]); }
        // Snare drum (bit 3): channel 7, operator 2
        if ((val & 0x08) && !(old & 0x08)) this.keyOnOp(CH_OP[7][1]);
        if (!(val & 0x08) && (old & 0x08)) this.keyOffOp(CH_OP[7][1]);
        // Tom-tom (bit 2): channel 8, operator 1
        if ((val & 0x04) && !(old & 0x04)) this.keyOnOp(CH_OP[8][0]);
        if (!(val & 0x04) && (old & 0x04)) this.keyOffOp(CH_OP[8][0]);
        // Cymbal (bit 1): channel 8, operator 2
        if ((val & 0x02) && !(old & 0x02)) this.keyOnOp(CH_OP[8][1]);
        if (!(val & 0x02) && (old & 0x02)) this.keyOffOp(CH_OP[8][1]);
        // Hi-hat (bit 0): channel 7, operator 1
        if ((val & 0x01) && !(old & 0x01)) this.keyOnOp(CH_OP[7][0]);
        if (!(val & 0x01) && (old & 0x01)) this.keyOffOp(CH_OP[7][0]);
      }
    }
  }

  private opReg(opIdx: number, baseReg: number): number {
    const offset = opIdx < 6 ? opIdx : opIdx < 12 ? opIdx + 2 : opIdx + 4;
    return this.regs[baseReg + offset] ?? 0;
  }

  private getMulti(opIdx: number): number { return MULTI[this.opReg(opIdx, 0x20) & 0x0F]; }

  private getTotalLevel(opIdx: number): number {
    const tl = this.opReg(opIdx, 0x40) & 0x3F;
    return Math.pow(10, -tl * 0.75 / 20);
  }

  private opChannel(opIdx: number): number {
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      if (CH_OP[ch][0] === opIdx || CH_OP[ch][1] === opIdx) return ch;
    }
    return 0;
  }

  /** Calculate OPL2 effective rate (0-63) from a 4-bit register rate value.
   *  effectiveRate = min(63, regRate * 4 + Rof)
   *  Rof = (block*2 + fnum_bit) >> (KSR ? 0 : 2)
   *  Note-Select (reg 0x08 bit 6) controls which fnum bit is used. */
  private effectiveRate(opIdx: number, regRate: number): number {
    if (regRate === 0) return 0;
    const ch = this.opChannel(opIdx);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    const nts = (this.regs[0x08] >> 6) & 1;
    // NTS=0: fnum bit 9 (B0 bit 1), NTS=1: fnum bit 8 (B0 bit 0)
    const fnumBit = nts
      ? (this.regs[0xB0 + ch] & 0x01)
      : ((this.regs[0xB0 + ch] >> 1) & 0x01);
    const ksr = (this.opReg(opIdx, 0x20) >> 4) & 0x01; // KSR bit from reg 0x20
    const rof = (block * 2 + fnumBit) >> (ksr ? 0 : 2);
    return Math.min(63, regRate * 4 + rof);
  }

  private getAttackRate(opIdx: number): number {
    return this.effectiveRate(opIdx, (this.opReg(opIdx, 0x60) >> 4) & 0x0F);
  }
  private getDecayRate(opIdx: number): number {
    return this.effectiveRate(opIdx, this.opReg(opIdx, 0x60) & 0x0F);
  }
  /** Sustain level: 0-15, each step = 3 dB. Returns dB attenuation. */
  private getSustainLevel(opIdx: number): number {
    const sl = (this.opReg(opIdx, 0x80) >> 4) & 0x0F;
    return sl * 3; // 0=0dB, 15=45dB
  }
  private getReleaseRate(opIdx: number): number {
    return this.effectiveRate(opIdx, this.opReg(opIdx, 0x80) & 0x0F);
  }
  private getWaveform(opIdx: number): number {
    if (!(this.regs[0x01] & 0x20)) return 0; // waveform select not enabled
    return this.opReg(opIdx, 0xE0) & 0x03;
  }

  private getChannelFreq(ch: number): number {
    const fnum = this.regs[0xA0 + ch] | ((this.regs[0xB0 + ch] & 0x03) << 8);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    return fnum * Math.pow(2, block - 1) * OPL_RATE / (1 << 19);
  }

  private getFeedback(ch: number): number {
    return (this.regs[0xC0 + ch] >> 1) & 0x07;
  }

  private getConnection(ch: number): number {
    return this.regs[0xC0 + ch] & 0x01;
  }

  /** KSL attenuation as a linear multiplier (0..1). */
  private getKSL(opIdx: number, ch: number): number {
    const kslBits = (this.opReg(opIdx, 0x40) >> 6) & 0x03;
    if (kslBits === 0) return 1; // no attenuation
    const fnum = this.regs[0xA0 + ch] | ((this.regs[0xB0 + ch] & 0x03) << 8);
    const block = (this.regs[0xB0 + ch] >> 2) & 0x07;
    const fnumHigh = (fnum >> 6) & 0x0F;
    const baseLevel = KSL_ROM[fnumHigh] * 4 - (7 - block) * 32;
    const level = Math.max(0, baseLevel);
    const shift = KSL_SHIFT[kslBits];
    const attenUnits = shift >= 31 ? 0 : level >> shift;
    const attenDB = attenUnits * 0.1875;
    return Math.pow(10, -attenDB / 20);
  }

  private sineInterp(p: number): number {
    const fidx = p * 1024;
    const idx = fidx | 0;
    const frac = fidx - idx;
    return SINE_TABLE[idx & 1023] + (SINE_TABLE[(idx + 1) & 1023] - SINE_TABLE[idx & 1023]) * frac;
  }

  // Apply waveform shaping (with interpolated sine lookup)
  private waveform(phase: number, type: number): number {
    const p = ((phase % 1) + 1) % 1;
    switch (type) {
      case 0: return this.sineInterp(p);                                        // sine
      case 1: return p < 0.5 ? this.sineInterp(p) : 0;                         // half-sine
      case 2: return Math.abs(this.sineInterp(p));                              // abs-sine
      case 3: return (p % 0.5) < 0.25 ? this.sineInterp((p * 2) % 1) : 0;     // quarter-sine (pulse)
      default: return this.sineInterp(p);
    }
  }

  private updateEnvelope(op: OpState, opIdx: number, dt: number): number {
    if (op.envState === ENV_OFF) return 0;

    const tl = this.getTotalLevel(opIdx);

    switch (op.envState) {
      case ENV_ATTACK: {
        // Real OPL2 attack: rate proportional to distance from target.
        // dLevel/dt = -level * k, where k derived from attack time.
        // This gives a fast initial rise that slows as it approaches full volume,
        // matching the characteristic "punch" of real FM bass.
        const rate = this.getAttackRate(opIdx);
        if (rate < 4) { op.envLevel = SILENCE_DB; break; }
        if (rate >= 60) { op.envLevel = 0; op.envState = ENV_DECAY; break; }
        const attackTime = ATTACK_TIMES[rate] / 1000;
        // Solve for k: level(t) = SILENCE_DB * exp(-k*t), level(attackTime) ≈ 0
        // k = ln(SILENCE_DB/threshold) / attackTime
        const k = Math.log(SILENCE_DB / 0.005) / attackTime;
        op.envLevel -= op.envLevel * k * dt;
        if (op.envLevel < 0.005) { op.envLevel = 0; op.envState = ENV_DECAY; }
        break;
      }
      case ENV_DECAY: {
        const rate = this.getDecayRate(opIdx);
        const sl = this.getSustainLevel(opIdx);
        if (rate < 4) break;
        if (rate >= 60) { op.envLevel = sl; op.envState = ENV_SUSTAIN; break; }
        const decayTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / decayTime * SILENCE_DB;
        if (op.envLevel >= sl) { op.envLevel = sl; op.envState = ENV_SUSTAIN; }
        break;
      }
      case ENV_SUSTAIN: {
        // EG type (reg 0x20 bit 5): 1=hold at sustain, 0=continue decay with release rate
        const egType = (this.opReg(opIdx, 0x20) >> 5) & 1;
        if (egType === 0) {
          const rate = this.getReleaseRate(opIdx);
          if (rate >= 4) {
            if (rate >= 60) { op.envLevel = SILENCE_DB; op.envState = ENV_OFF; }
            else {
              const relTime = DECAY_TIMES[rate] / 1000;
              op.envLevel += dt / relTime * SILENCE_DB;
              if (op.envLevel >= SILENCE_DB) { op.envLevel = SILENCE_DB; op.envState = ENV_OFF; }
            }
          }
        }
        break;
      }
      case ENV_RELEASE: {
        const rate = this.getReleaseRate(opIdx);
        if (rate < 4) break;
        if (rate >= 60) { op.envLevel = SILENCE_DB; op.envState = ENV_OFF; break; }
        const relTime = DECAY_TIMES[rate] / 1000;
        op.envLevel += dt / relTime * SILENCE_DB;
        if (op.envLevel >= SILENCE_DB) { op.envLevel = SILENCE_DB; op.envState = ENV_OFF; }
        break;
      }
    }

    if (op.envLevel >= SILENCE_DB) { op.rampPos = 0; op.rampDir = 0; return 0; }
    // Anti-click ramp: smooth 0.5ms fade-in on key-on
    if (op.rampDir !== 0) {
      op.rampPos += op.rampDir;
      if (op.rampPos >= CLICK_RAMP_SAMPLES) { op.rampPos = CLICK_RAMP_SAMPLES; op.rampDir = 0; }
      else if (op.rampPos <= 0) { op.rampPos = 0; op.rampDir = 0; }
    }
    const rampGain = op.rampPos / CLICK_RAMP_SAMPLES;
    const amplitude = Math.pow(10, -op.envLevel / 20) * tl * rampGain;
    return Math.max(0, Math.min(1, amplitude));
  }

  private processChannel(
    ch: number, dt: number, tremoDB: number, vibMul: number,
  ): number {
    const freq = this.getChannelFreq(ch);
    if (freq <= 0) return 0;

    const [opIdx1, opIdx2] = CH_OP[ch];
    const op1 = this.ops[opIdx1];
    const op2 = this.ops[opIdx2];

    let amp1 = this.updateEnvelope(op1, opIdx1, dt);
    let amp2 = this.updateEnvelope(op2, opIdx2, dt);
    if (amp1 === 0 && amp2 === 0) return 0;

    amp1 *= this.getKSL(opIdx1, ch);
    amp2 *= this.getKSL(opIdx2, ch);

    if (this.opReg(opIdx1, 0x20) & 0x80) amp1 *= Math.pow(10, -tremoDB / 20);
    if (this.opReg(opIdx2, 0x20) & 0x80) amp2 *= Math.pow(10, -tremoDB / 20);

    // Chorus: per-channel micro-detuning (reduced on bass for tight low-end)
    const chorusLFO = Math.sin(this.chorusPhase[ch] * 2 * Math.PI);
    const chorusScale = freq < 150 ? 0.15 : freq < 300 ? 0.5 : 1.0;
    const chorusMul = Math.pow(2, chorusLFO * CHORUS_DEPTH * chorusScale / 1200);

    const multi1 = this.getMulti(opIdx1);
    const multi2 = this.getMulti(opIdx2);
    const vib1 = (this.opReg(opIdx1, 0x20) & 0x40) ? vibMul : 1;
    const vib2 = (this.opReg(opIdx2, 0x20) & 0x40) ? vibMul : 1;
    op1.phase += freq * multi1 * vib1 * chorusMul / INTERNAL_RATE;
    op2.phase += freq * multi2 * vib2 * chorusMul / INTERNAL_RATE;

    const connection = this.getConnection(ch);
    const feedback = this.getFeedback(ch);
    const wave1 = this.getWaveform(opIdx1);
    const wave2 = this.getWaveform(opIdx2);

    let mod1 = 0;
    if (feedback > 0) {
      mod1 = (op1.feedback0 + op1.feedback1) * MOD_DEPTH * Math.pow(2, feedback - 9);
    }
    const out1 = this.waveform(op1.phase + mod1, wave1) * amp1;
    op1.feedback1 = op1.feedback0;
    op1.feedback0 = out1;

    if (connection === 0) {
      return this.waveform(op2.phase + out1 * MOD_DEPTH, wave2) * amp2;
    } else {
      return out1 + this.waveform(op2.phase, wave2) * amp2;
    }
  }

  private percOpAmp(
    opIdx: number, ch: number, dt: number, tremoDB: number, vibMul: number,
  ): number {
    const op = this.ops[opIdx];
    let amp = this.updateEnvelope(op, opIdx, dt);
    if (amp === 0) return 0;
    amp *= this.getKSL(opIdx, ch);
    if (this.opReg(opIdx, 0x20) & 0x80) amp *= Math.pow(10, -tremoDB / 20);
    const freq = this.getChannelFreq(ch);
    if (freq > 0) {
      const vib = (this.opReg(opIdx, 0x20) & 0x40) ? vibMul : 1;
      op.phase += freq * this.getMulti(opIdx) * vib / INTERNAL_RATE;
    }
    return amp;
  }

  private generatePercussion(dt: number, tremoDB: number, vibMul: number): number {
    let output = 0;

    output += this.processChannel(6, dt, tremoDB, vibMul);

    const ph7 = ((this.ops[CH_OP[7][0]].phase * 1024) | 0) & 0x3FF;
    const ph8 = ((this.ops[CH_OP[8][1]].phase * 1024) | 0) & 0x3FF;
    const phaseNoise = (
      (((ph7 >> 2) ^ (ph7 >> 7)) & 1) |
      (((ph8 >> 3) ^ (ph8 >> 5)) & 1) |
      (((ph7 >> 3) ^ (ph8 >> 2)) & 1)
    ) !== 0;

    const lfsrBit = (this.noiseRNG & 1) !== 0;

    {
      const amp = this.percOpAmp(CH_OP[7][0], 7, dt, tremoDB, vibMul);
      if (amp > 0) output += (phaseNoise ? 0.5 : -0.5) * amp;
    }

    {
      const opIdx = CH_OP[7][1];
      const amp = this.percOpAmp(opIdx, 7, dt, tremoDB, vibMul);
      if (amp > 0) {
        const phaseBit = (((this.ops[opIdx].phase * 1024) | 0) & 0x200) !== 0;
        const snareBit = phaseNoise !== phaseBit !== lfsrBit;
        output += (snareBit ? 0.5 : -0.5) * amp;
      }
    }

    {
      const opIdx = CH_OP[8][0];
      const amp = this.percOpAmp(opIdx, 8, dt, tremoDB, vibMul);
      if (amp > 0) output += this.waveform(this.ops[opIdx].phase, this.getWaveform(opIdx)) * amp;
    }

    {
      const amp = this.percOpAmp(CH_OP[8][1], 8, dt, tremoDB, vibMul);
      if (amp > 0) output += (phaseNoise ? 0.5 : -0.5) * amp;
    }

    return output;
  }

  /** Generate one stereo sample at INTERNAL_RATE. Writes to currL/currR. */
  private generateOneSampleStereo(): void {
    let left = 0, right = 0;
    const dt = 1 / INTERNAL_RATE;

    // Advance global LFOs
    this.tremoloPhase = (this.tremoloPhase + TREMOLO_FREQ / INTERNAL_RATE) % 1;
    this.vibratoPhase = (this.vibratoPhase + VIBRATO_FREQ / INTERNAL_RATE) % 1;

    // Advance 23-bit LFSR noise generator
    const nbit = ((this.noiseRNG ^ (this.noiseRNG >> 14) ^ (this.noiseRNG >> 15)) & 1);
    this.noiseRNG = (this.noiseRNG >> 1) | (nbit << 22);

    // Advance chorus LFOs
    for (let ch = 0; ch < NUM_CHANNELS; ch++) {
      this.chorusPhase[ch] = (this.chorusPhase[ch] + CHORUS_RATES[ch] / INTERNAL_RATE) % 1;
    }

    const tremoloTriangle = 1 - 2 * Math.abs(this.tremoloPhase - 0.5);
    const deepTrem = (this.regs[0xBD] & 0x80) !== 0;
    const tremoDB = tremoloTriangle * (deepTrem ? 4.8 : 1.0);

    const vibTriangle = 4 * Math.abs(this.vibratoPhase - 0.5) - 1;
    const deepVib = (this.regs[0xBD] & 0x40) !== 0;
    const vibCents = vibTriangle * (deepVib ? 14 : 7);
    const vibMul = Math.pow(2, vibCents / 1200);

    const rhythmMode = (this.regs[0xBD] & 0x20) !== 0;
    const melodicEnd = rhythmMode ? 6 : 9;

    // Melodic channels with frequency-dependent stereo panning
    // Bass frequencies (<200 Hz) panned narrower for tight center imaging
    for (let ch = 0; ch < melodicEnd; ch++) {
      const s = this.processChannel(ch, dt, tremoDB, vibMul);
      const freq = this.getChannelFreq(ch);
      const narrowing = freq < 100 ? 0.2 : freq < 200 ? 0.5 : freq < 400 ? 0.75 : 1.0;
      const panL = PAN_L[ch] * narrowing + (1 - narrowing) * Math.SQRT1_2;
      const panR = PAN_R[ch] * narrowing + (1 - narrowing) * Math.SQRT1_2;
      left += s * panL;
      right += s * panR;
    }

    // Percussion: centered (equal L/R)
    if (rhythmMode) {
      const perc = this.generatePercussion(dt, tremoDB, vibMul);
      left += perc;
      right += perc;
    }

    // Normalize + tube-like saturation (tanh + subtle 2nd harmonic)
    const norm = 0.5 / NUM_CHANNELS;
    const satL = Math.tanh(left * norm * DRIVE) * INV_TANH_DRIVE;
    const satR = Math.tanh(right * norm * DRIVE) * INV_TANH_DRIVE;
    // Even harmonic generation: x² produces 2nd harmonic (warm, musical)
    // DC from squaring is removed by downstream DC blocking filter
    this.currL = satL + 0.04 * satL * satL;
    this.currR = satR + 0.04 * satR * satR;
  }

  /** Fill stereo buffers at the target sample rate.
   *  4x oversampled -> cubic Hermite interpolation -> Butterworth LPF -> DC block -> crossfeed. */
  generateSamples(outL: Float32Array, outR: Float32Array, length: number): void {
    const ratio = INTERNAL_RATE / this.sampleRate;
    const { lpB0, lpA1, lpA2, dcR } = this;
    const lpB1 = lpB0 * 2; // Butterworth symmetry: b1 = 2*b0, b2 = b0
    for (let i = 0; i < length; i++) {
      this.accumPhase += ratio;
      while (this.accumPhase >= 1) {
        this.accumPhase -= 1;
        this.h0L = this.h1L; this.h1L = this.h2L; this.h2L = this.h3L;
        this.h0R = this.h1R; this.h1R = this.h2R; this.h2R = this.h3R;
        this.generateOneSampleStereo();
        this.h3L = this.currL;
        this.h3R = this.currR;
      }
      // Cubic Hermite interpolation (4-point, 3rd-order) — much cleaner than linear
      const t = 1 - this.accumPhase;
      const t2 = t * t, t3 = t2 * t;
      const inL = 0.5 * (
        (2 * this.h1L) +
        (-this.h0L + this.h2L) * t +
        (2 * this.h0L - 5 * this.h1L + 4 * this.h2L - this.h3L) * t2 +
        (-this.h0L + 3 * this.h1L - 3 * this.h2L + this.h3L) * t3
      );
      const inR = 0.5 * (
        (2 * this.h1R) +
        (-this.h0R + this.h2R) * t +
        (2 * this.h0R - 5 * this.h1R + 4 * this.h2R - this.h3R) * t2 +
        (-this.h0R + 3 * this.h1R - 3 * this.h2R + this.h3R) * t3
      );
      // 2-pole Butterworth LPF (Direct Form II Transposed)
      const yL = lpB0 * inL + this.lpS1L;
      this.lpS1L = lpB1 * inL - lpA1 * yL + this.lpS2L;
      this.lpS2L = lpB0 * inL - lpA2 * yL;
      const yR = lpB0 * inR + this.lpS1R;
      this.lpS1R = lpB1 * inR - lpA1 * yR + this.lpS2R;
      this.lpS2R = lpB0 * inR - lpA2 * yR;
      // Analog warmth: mid-bass peaking EQ (120 Hz, +2 dB)
      const wL = this.wB0 * yL + this.wS1L;
      this.wS1L = this.wB1 * yL - this.wA1 * wL + this.wS2L;
      this.wS2L = this.wB2 * yL - this.wA2 * wL;
      const wR = this.wB0 * yR + this.wS1R;
      this.wS1R = this.wB1 * yR - this.wA1 * wR + this.wS2R;
      this.wS2R = this.wB2 * yR - this.wA2 * wR;
      // Air shelf: high shelf at 10 kHz, +1.5 dB (openness)
      const aL = this.airB0 * wL + this.airS1L;
      this.airS1L = this.airB1 * wL - this.airA1 * aL + this.airS2L;
      this.airS2L = this.airB2 * wL - this.airA2 * aL;
      const aR = this.airB0 * wR + this.airS1R;
      this.airS1R = this.airB1 * wR - this.airA1 * aR + this.airS2R;
      this.airS2R = this.airB2 * wR - this.airA2 * aR;
      // DC blocking HPF
      const hpL = aL - this.dcPrevInL + dcR * this.dcPrevOutL;
      this.dcPrevInL = aL; this.dcPrevOutL = hpL;
      const hpR = aR - this.dcPrevInR + dcR * this.dcPrevOutR;
      this.dcPrevInR = aR; this.dcPrevOutR = hpR;
      // Stereo reverb: warm room ambience
      this.reverb.process(hpL, hpR);
      const rvL = this.reverb.processL;
      const rvR = this.reverb.processR;
      // Headphone crossfeed: blend ~15% of opposite channel for natural imaging
      const cfL = rvL * 0.85 + rvR * 0.15;
      const cfR = rvR * 0.85 + rvL * 0.15;
      // TPDF dither: two uniform random values summed → triangular PDF
      // Amplitude: ±1 LSB of float32 mantissa at typical signal levels (~1e-6)
      let d = this.ditherState;
      d ^= d << 13; d ^= d >> 17; d ^= d << 5; this.ditherState = d;
      const d1 = (d & 0xFFFF) / 65536 - 0.5;
      d ^= d << 13; d ^= d >> 17; d ^= d << 5; this.ditherState = d;
      const d2 = (d & 0xFFFF) / 65536 - 0.5;
      const dither = (d1 + d2) * 1.5e-6; // ~-116 dBFS, below audible for music
      outL[i] = cfL + dither;
      outR[i] = cfR + dither;
    }
  }
}
