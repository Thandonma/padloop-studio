/**
 * Which audio file types PadLoop accepts as pad layers. WAV headers are read
 * directly without decoding (see wav.ts); other formats are handed to the
 * browser's own decoder, so support follows whatever codecs the browser ships.
 */
import { WavInfo, inspectWav } from './wav';

const EXTENSIONS = ['.wav', '.wave', '.mp3', '.ogg', '.oga', '.m4a', '.mp4', '.aac', '.flac', '.webm'] as const;

const MIME_TYPES =
  'audio/wav,audio/x-wav,audio/wave,audio/mpeg,audio/ogg,audio/mp4,audio/aac,audio/flac,audio/webm';

export const AUDIO_FILE_ACCEPT = `${EXTENSIONS.join(',')},${MIME_TYPES}`;

export function isSupportedAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isWavFile(name: string): boolean {
  return /\.wave?$/i.test(name);
}

/**
 * Header metadata for a layer being stored. WAV files are parsed directly;
 * other formats are decoded once to read their sample rate/channels/duration
 * (bit depth isn't meaningful once decoded, so it's reported as 0).
 */
export async function inspectAudio(data: Uint8Array, filename: string, ctx: AudioContext): Promise<WavInfo> {
  if (isWavFile(filename)) return inspectWav(data);
  const copy = data.slice();
  const buffer = await ctx.decodeAudioData(copy.buffer as ArrayBuffer);
  return {
    formatCode: 0,
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    bitsPerSample: 0,
    durationSeconds: buffer.duration,
  };
}
