/**
 * Compact Freeverb-style stereo reverb with LP-damped comb filters.
 *
 * Designed for OPL2/SB output: short, warm reverb that adds spatial depth
 * without muddying dense FM synthesis. Sounds like a well-treated listening room.
 *
 * Architecture: 4 parallel comb filters → 2 series allpass filters (per channel).
 * L/R delay lengths differ by STEREO_SPREAD samples for natural stereo width.
 */

// Base delay lengths at 44100 Hz (Freeverb standard, low mutual correlation)
const COMB_DELAYS = [1116, 1188, 1277, 1356];
const AP_DELAYS = [556, 441];
const STEREO_SPREAD = 23; // sample offset between L/R channels

export class StereoReverb {
  private combBufL: Float32Array[] = [];
  private combBufR: Float32Array[] = [];
  private combIdxL: number[] = [0, 0, 0, 0];
  private combIdxR: number[] = [0, 0, 0, 0];
  private combFiltL = new Float64Array(4);
  private combFiltR = new Float64Array(4);

  private apBufL: Float32Array[] = [];
  private apBufR: Float32Array[] = [];
  private apIdxL: number[] = [0, 0];
  private apIdxR: number[] = [0, 0];

  private feedback: number;
  private damp1: number;
  private damp2: number;
  private wet: number;

  constructor(sampleRate: number) {
    const scale = sampleRate / 44100;
    for (let i = 0; i < 4; i++) {
      this.combBufL.push(new Float32Array(Math.round(COMB_DELAYS[i] * scale)));
      this.combBufR.push(new Float32Array(Math.round((COMB_DELAYS[i] + STEREO_SPREAD) * scale)));
    }
    for (let i = 0; i < 2; i++) {
      this.apBufL.push(new Float32Array(Math.round(AP_DELAYS[i] * scale)));
      this.apBufR.push(new Float32Array(Math.round((AP_DELAYS[i] + STEREO_SPREAD) * scale)));
    }
    this.feedback = 0.82;  // RT60 ≈ 0.7s — present but not lingering
    this.damp1 = 0.4;      // HF damping: warm room character
    this.damp2 = 1 - 0.4;
    this.wet = 0.16;       // subtle: adds depth without muddying
  }

  /** Update sample rate (reallocates buffers, resets state). */
  setSampleRate(sampleRate: number): void {
    const scale = sampleRate / 44100;
    for (let i = 0; i < 4; i++) {
      this.combBufL[i] = new Float32Array(Math.round(COMB_DELAYS[i] * scale));
      this.combBufR[i] = new Float32Array(Math.round((COMB_DELAYS[i] + STEREO_SPREAD) * scale));
      this.combIdxL[i] = 0; this.combIdxR[i] = 0;
      this.combFiltL[i] = 0; this.combFiltR[i] = 0;
    }
    for (let i = 0; i < 2; i++) {
      this.apBufL[i] = new Float32Array(Math.round(AP_DELAYS[i] * scale));
      this.apBufR[i] = new Float32Array(Math.round((AP_DELAYS[i] + STEREO_SPREAD) * scale));
      this.apIdxL[i] = 0; this.apIdxR[i] = 0;
    }
  }

  /** Process one stereo sample. Returns wet+dry mixed output. */
  processL = 0; processR = 0;
  process(inL: number, inR: number): void {
    const { feedback, damp1, damp2 } = this;
    let outL = 0, outR = 0;

    // 4 parallel comb filters with LP-damped feedback
    for (let i = 0; i < 4; i++) {
      const bL = this.combBufL[i], bR = this.combBufR[i];
      const iL = this.combIdxL[i], iR = this.combIdxR[i];
      const dL = bL[iL], dR = bR[iR];
      // One-pole LP in feedback path: simulates room HF absorption
      this.combFiltL[i] = dL * damp2 + this.combFiltL[i] * damp1;
      this.combFiltR[i] = dR * damp2 + this.combFiltR[i] * damp1;
      bL[iL] = inL + this.combFiltL[i] * feedback;
      bR[iR] = inR + this.combFiltR[i] * feedback;
      this.combIdxL[i] = (iL + 1) % bL.length;
      this.combIdxR[i] = (iR + 1) % bR.length;
      outL += dL; outR += dR;
    }
    outL *= 0.25; outR *= 0.25;

    // 2 series Schroeder allpass filters (diffuse the echo pattern)
    for (let i = 0; i < 2; i++) {
      const bL = this.apBufL[i], bR = this.apBufR[i];
      const iL = this.apIdxL[i], iR = this.apIdxR[i];
      const dL = bL[iL], dR = bR[iR];
      const tL = outL + dL * 0.5;
      const tR = outR + dR * 0.5;
      bL[iL] = tL; bR[iR] = tR;
      outL = dL - 0.5 * tL;
      outR = dR - 0.5 * tR;
      this.apIdxL[i] = (iL + 1) % bL.length;
      this.apIdxR[i] = (iR + 1) % bR.length;
    }

    this.processL = inL + outL * this.wet;
    this.processR = inR + outR * this.wet;
  }
}
