/**
 * ".padkit" backup files: a kit's settings and every layer's WAV in one file,
 * so kits can be moved between browsers/devices.
 *
 * Layout: "PADKIT1\n" | uint32 LE header length | UTF-8 JSON header | WAV bytes...
 */
import { KitSettings, Layer } from './models';

const MAGIC = 'PADKIT1\n';

export type LayerExport = Pick<
  Layer,
  'padIndex' | 'originalName' | 'rootNote' | 'octave' | 'fineTuneCents' | 'gain' | 'enabled' | 'detectedKey'
> & { byteLength: number };

export interface KitFileHeader {
  app: 'padloop';
  version: 1;
  exportedAt: string;
  kit: KitSettings;
  layers: LayerExport[];
}

export interface KitFileContents {
  header: KitFileHeader;
  samples: Uint8Array[];
}

export function encodeKitFile(kit: KitSettings, layers: { layer: Layer; data: Uint8Array }[]): Blob {
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
    layers: layers.map(({ layer: l, data }) => ({
      padIndex: l.padIndex,
      originalName: l.originalName,
      rootNote: l.rootNote,
      octave: l.octave,
      fineTuneCents: l.fineTuneCents,
      gain: l.gain,
      enabled: l.enabled,
      detectedKey: l.detectedKey,
      byteLength: data.byteLength,
    })),
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.byteLength, true);
  const parts: BlobPart[] = [MAGIC, len, json, ...layers.map((l) => l.data as Uint8Array<ArrayBuffer>)];
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
  if (header?.app !== 'padloop' || header.version !== 1 || !Array.isArray(header.layers)) throw bad();
  off += jsonLen;
  const samples: Uint8Array[] = [];
  for (const l of header.layers) {
    if (!(l.byteLength >= 0) || off + l.byteLength > bytes.length) throw new Error('Kit file is truncated');
    samples.push(bytes.slice(off, off + l.byteLength));
    off += l.byteLength;
  }
  return { header, samples };
}

export function safeFileName(name: string): string {
  return (name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'kit') + '.padkit';
}
