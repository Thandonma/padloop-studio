/**
 * ".padkit" backup files: a kit's settings and every sound's WAV in one file,
 * so kits can be moved between browsers and devices.
 *
 * Layout: "PADKIT1\n" | uint32 LE header length | UTF-8 JSON header | WAV bytes...
 */
import { KitSettings, Sound } from './models';

const MAGIC = 'PADKIT1\n';

export type SoundExport = Pick<
  Sound,
  'name' | 'rootNote' | 'octave' | 'fineTuneCents' | 'gain' | 'enabled' | 'detectedKey' | 'starterId'
> & {
  byteLength: number;
  // Carried so compressed formats (mp3, m4a, ...) import without decoding;
  // optional, because kits exported before this was added don't have them.
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  durationSeconds?: number;
};

export interface KitFileHeader {
  app: 'padloop';
  version: 1;
  exportedAt: string;
  kit: KitSettings;
  sounds: SoundExport[];
}

export interface KitFileContents {
  header: KitFileHeader;
  samples: Uint8Array[];
}

export function encodeKitFile(kit: KitSettings, sounds: { sound: Sound; data: Uint8Array }[]): Blob {
  const header: KitFileHeader = {
    app: 'padloop',
    version: 1,
    exportedAt: new Date().toISOString(),
    kit: {
      name: kit.name,
      sessionMinutes: kit.sessionMinutes,
      masterVolume: kit.masterVolume,
      fadeSeconds: kit.fadeSeconds,
      keyLock: kit.keyLock,
    },
    sounds: sounds.map(({ sound: s, data }) => ({
      name: s.name,
      rootNote: s.rootNote,
      octave: s.octave,
      fineTuneCents: s.fineTuneCents,
      gain: s.gain,
      enabled: s.enabled,
      detectedKey: s.detectedKey,
      starterId: s.starterId,
      byteLength: data.byteLength,
      sampleRate: s.sampleRate,
      channels: s.channels,
      bitsPerSample: s.bitsPerSample,
      durationSeconds: s.durationSeconds,
    })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  const parts: BlobPart[] = [MAGIC, len, json, ...sounds.map((s) => s.data as Uint8Array<ArrayBuffer>)];
  return new Blob(parts, { type: 'application/octet-stream' });
}

export function decodeKitFile(bytes: Uint8Array): KitFileContents {
  const bad = () => new Error('This is not a PadLoop kit file');
  if (bytes.length < MAGIC.length + 4) throw bad();
  if (new TextDecoder().decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw bad();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = view.getUint32(MAGIC.length, true);
  let off = MAGIC.length + 4;
  if (off + jsonLen > bytes.length) throw bad();
  let header: KitFileHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(off, off + jsonLen)));
  } catch {
    throw bad();
  }
  if (header?.app !== 'padloop' || header.version !== 1 || !Array.isArray(header.sounds)) throw bad();
  off += jsonLen;
  const samples: Uint8Array[] = [];
  for (const s of header.sounds) {
    if (!(s.byteLength >= 0) || off + s.byteLength > bytes.length) throw new Error('Kit file is truncated');
    samples.push(bytes.slice(off, off + s.byteLength));
    off += s.byteLength;
  }
  return { header, samples };
}

export function safeFileName(name: string): string {
  return (name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'kit') + '.padkit';
}
