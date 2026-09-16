/**
 * Makes a sample loop without a click by baking an equal-power crossfade of
 * its tail into its head. The result is `xf` samples shorter than the input,
 * and sample[last] flows straight into sample[0].
 */
export function makeSeamless(channels: Float32Array[], xf: number): Float32Array<ArrayBuffer>[] {
  const len = channels[0]?.length ?? 0;
  xf = Math.max(0, Math.min(Math.floor(xf), Math.floor(len / 3)));
  if (xf < 2) return channels.map((c) => new Float32Array(c));
  const outLen = len - xf;
  return channels.map((input) => {
    const out = new Float32Array(outLen);
    out.set(input.subarray(xf, outLen), xf);
    for (let i = 0; i < xf; i++) {
      const t = (i / xf) * (Math.PI / 2);
      out[i] = input[i] * Math.sin(t) + input[outLen + i] * Math.cos(t);
    }
    return out;
  });
}

/** Crossfade length used for a sample of `durationSec` seconds. */
export function crossfadeSeconds(durationSec: number): number {
  return Math.min(0.6, durationSec * 0.2);
}

/** Min/max pairs for drawing a small waveform. */
export function computePeaks(channels: Float32Array[], buckets: number): number[] {
  const len = channels[0]?.length ?? 0;
  const peaks: number[] = new Array(buckets).fill(0);
  if (!len) return peaks;
  const size = Math.max(1, Math.floor(len / buckets));
  const stride = Math.max(1, Math.floor(size / 64)); // sampling is plenty for a thumbnail
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    const end = Math.min(len, start + size);
    for (const ch of channels) {
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(ch[i]);
        if (v > max) max = v;
      }
    }
    peaks[b] = max;
  }
  const top = Math.max(...peaks, 1e-6);
  return peaks.map((p) => p / top);
}
