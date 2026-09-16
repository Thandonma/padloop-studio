import { NOTE_NAMES, mod } from './music';

/**
 * Estimates the musical key of a recording: builds a chromagram (energy per
 * pitch class) with an FFT, then correlates it against the Krumhansl–Kessler
 * key profiles. Works well for sustained pads and chords.
 */

const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface KeyEstimate {
  tonic: number;
  mode: 'major' | 'minor';
  /** Pearson correlation of the best match, -1..1 */
  confidence: number;
  label: string;
  chroma: number[];
}

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const ang = (-2 * Math.PI) / size;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let start = 0; start < n; start += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

export function chromagram(channels: Float32Array[], sampleRate: number, maxSeconds = 30): number[] {
  const total = channels[0]?.length ?? 0;
  const len = Math.min(total, Math.floor(maxSeconds * sampleRate));
  const size = 16384;
  const hop = 8192;
  const chroma = new Array(12).fill(0);
  if (len < 1024) return chroma;

  // Precompute bin -> pitch class for 50 Hz .. 5 kHz
  const n = Math.min(size, 1 << Math.ceil(Math.log2(len)));
  const binPc = new Int8Array(n / 2).fill(-1);
  for (let k = 1; k < n / 2; k++) {
    const f = (k * sampleRate) / n;
    if (f < 50 || f > 5000) continue;
    binPc[k] = mod(Math.round(12 * Math.log2(f / 440)) + 9, 12);
  }
  const window = new Float64Array(n);
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const start = total > len ? Math.floor((total - len) / 2) : 0; // skip attack when we can
  for (let frame = start; ; frame += hop) {
    if (frame > start && frame + n > start + len) break;
    for (let i = 0; i < n; i++) {
      let s = 0;
      const idx = frame + i;
      if (idx < total) for (const ch of channels) s += ch[idx]; // zero-pad short files
      re[i] = (s / channels.length) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const frameChroma = new Array(12).fill(0);
    for (let k = 1; k < n / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      frameChroma[pc] += re[k] * re[k] + im[k] * im[k];
    }
    const sum = frameChroma.reduce((a, b) => a + b, 0);
    if (sum > 1e-9) for (let i = 0; i < 12; i++) chroma[i] += Math.sqrt(frameChroma[i] / sum);
    if (n < size) break; // short file: single frame
  }
  const max = Math.max(...chroma, 1e-9);
  return chroma.map((c) => c / max);
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export function estimateKey(chroma: number[]): KeyEstimate {
  let best: KeyEstimate = { tonic: 0, mode: 'major', confidence: -2, label: '', chroma };
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = chroma.map((_, i) => chroma[mod(i + tonic, 12)]);
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]] as const) {
      const r = pearson(rotated, profile);
      if (r > best.confidence) {
        best = { tonic, mode, confidence: r, label: `${NOTE_NAMES[tonic]} ${mode}`, chroma };
      }
    }
  }
  return best;
}

export function detectKey(channels: Float32Array[], sampleRate: number): KeyEstimate {
  return estimateKey(chromagram(channels, sampleRate));
}
