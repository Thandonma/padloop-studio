/**
 * Which audio file types PadLoop accepts. WAV headers are read directly
 * without decoding (see wav.ts); other formats are handed to the browser's own
 * decoder, so support follows whatever codecs the browser ships.
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
 * How much MP3 audio a sound keeps, in bytes: a little over 3 minutes at
 * 320 kbps. A sound is decoded into memory in full (a 20-minute file takes
 * about 460 MB), which is enough for a phone to kill the tab, and a pad loops
 * anyway. MP3 frames stand alone, so the file can simply be cut short.
 */
export const MAX_MP3_AUDIO_BYTES = 8 * 1024 * 1024;

/** Largest files accepted in formats that can't be cut short safely. */
export const MAX_WAV_BYTES = 64 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;

/** Bytes of the file's start that {@link mp3KeepLength} needs to see. */
export const MP3_HEAD_BYTES = 10;

/**
 * How many bytes of a file to keep given its first bytes: the size cap for MP3
 * (plus any ID3 tag, whose cover art isn't audio), or everything for other formats.
 */
export function mp3KeepLength(head: Uint8Array, size: number): number {
  const hasId3 = head.length >= MP3_HEAD_BYTES && head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
  // Frame sync, with a non-zero layer so that AAC (layer 0) doesn't match.
  const isMpegFrame = head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0;
  if (!hasId3 && !isMpegFrame) return size;
  const tag = hasId3
    ? MP3_HEAD_BYTES + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f))
    : 0;
  return Math.min(size, tag + MAX_MP3_AUDIO_BYTES);
}

/** A long MP3 cut down to the length a sound keeps; other files come back unchanged. */
export async function shortenLongMp3(file: File): Promise<File> {
  const head = new Uint8Array(await file.slice(0, MP3_HEAD_BYTES).arrayBuffer());
  const keep = mp3KeepLength(head, file.size);
  return keep < file.size ? new File([file.slice(0, keep)], file.name, { type: file.type }) : file;
}

/** Why a file is too big to load safely, or null if it's fine. Run this after shortening. */
export function audioTooLarge(file: File, head: Uint8Array): string | null {
  if (mp3KeepLength(head, Number.MAX_SAFE_INTEGER) < Number.MAX_SAFE_INTEGER) return null;
  const limit = isWavFile(file.name) ? MAX_WAV_BYTES : MAX_COMPRESSED_BYTES;
  if (file.size <= limit) return null;
  return `too long to load on most phones (over ${limit / (1024 * 1024)} MB). Use a shorter clip, or an MP3`;
}

/** Facts about a decoded buffer, in the same shape a WAV header gives us. */
export function infoFromBuffer(buffer: AudioBuffer): WavInfo {
  return {
    formatCode: 0,
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    // Bit depth isn't meaningful once a file has been decoded.
    bitsPerSample: 0,
    durationSeconds: buffer.duration,
  };
}

/**
 * Header metadata for a file being stored. WAV files are parsed directly;
 * anything else is decoded once with the supplied decoder.
 */
export async function inspectAudio(
  data: Uint8Array,
  filename: string,
  decode: (bytes: ArrayBuffer) => Promise<AudioBuffer>,
): Promise<WavInfo> {
  if (isWavFile(filename)) return inspectWav(data);
  // decodeAudioData detaches the buffer it is given, so hand it a copy.
  return infoFromBuffer(await decode(data.slice().buffer as ArrayBuffer));
}
