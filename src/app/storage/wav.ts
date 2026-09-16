/** Reads the RIFF header of a WAV file (never the sample data). */

export interface WavInfo {
  formatCode: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  durationSeconds: number;
}

export class InvalidWavError extends Error {}

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

export function inspectWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fourCC = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || !['RIFF', 'RF64'].includes(fourCC(0)) || fourCC(8) !== 'WAVE') {
    throw new InvalidWavError('Not a WAV file (missing RIFF/WAVE header)');
  }
  let off = 12;
  let fmt: Omit<WavInfo, 'durationSeconds'> | null = null;
  while (off + 8 <= bytes.length) {
    const id = fourCC(off);
    const size = view.getUint32(off + 4, true);
    if (id === 'fmt ') {
      if (size < 16 || off + 24 > bytes.length) throw new InvalidWavError('fmt chunk too small');
      fmt = {
        formatCode: view.getUint16(off + 8, true),
        channels: view.getUint16(off + 10, true),
        sampleRate: view.getUint32(off + 12, true),
        bitsPerSample: view.getUint16(off + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new InvalidWavError('data chunk appears before fmt chunk');
      if (![PCM, FLOAT, EXTENSIBLE].includes(fmt.formatCode)) {
        throw new InvalidWavError(`Unsupported WAV encoding (format code ${fmt.formatCode})`);
      }
      const { channels, sampleRate, bitsPerSample } = fmt;
      if (channels < 1 || channels > 8 || sampleRate < 8000 || sampleRate > 384000 || bitsPerSample < 8 || bitsPerSample > 64 || bitsPerSample % 8) {
        throw new InvalidWavError('WAV header has implausible values');
      }
      // Size may be 0xFFFFFFFF ("unknown") from streaming writers; trust the file length then.
      const available = bytes.length - off - 8;
      const dataBytes = size === 0xffffffff ? available : Math.min(size, available);
      const frames = Math.floor(dataBytes / (channels * (bitsPerSample / 8)));
      return { ...fmt, durationSeconds: frames / sampleRate };
    }
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  throw new InvalidWavError('WAV file is truncated or has no audio data');
}
