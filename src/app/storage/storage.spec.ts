import { decodeKitFile, encodeKitFile, safeFileName } from './kit-file';
import { Layer } from './models';
import { InvalidWavError, inspectWav } from './wav';

function wav(opts: { rate?: number; channels?: number; seconds?: number; list?: boolean; format?: number } = {}): Uint8Array {
  const { rate = 44100, channels = 2, seconds = 0.5, list = false, format = 1 } = opts;
  const frames = Math.floor(rate * seconds);
  const dataLen = frames * channels * 2;
  const listChunk = list ? 8 + 9 + 1 : 0; // odd-sized chunk + pad byte
  const buf = new ArrayBuffer(12 + listChunk + 24 + 8 + dataLen);
  const v = new DataView(buf);
  const str = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, buf.byteLength - 8, true);
  str(8, 'WAVE');
  let o = 12;
  if (list) {
    str(o, 'LIST');
    v.setUint32(o + 4, 9, true);
    o += 18;
  }
  str(o, 'fmt ');
  v.setUint32(o + 4, 16, true);
  v.setUint16(o + 8, format, true);
  v.setUint16(o + 10, channels, true);
  v.setUint32(o + 12, rate, true);
  v.setUint32(o + 16, rate * channels * 2, true);
  v.setUint16(o + 20, channels * 2, true);
  v.setUint16(o + 22, 16, true);
  o += 24;
  str(o, 'data');
  v.setUint32(o + 4, dataLen, true);
  return new Uint8Array(buf);
}

describe('inspectWav', () => {
  it('reads a stereo PCM header', () => {
    const info = inspectWav(wav({ seconds: 1.5 }));
    expect(info).toMatchObject({ channels: 2, sampleRate: 44100, bitsPerSample: 16 });
    expect(info.durationSeconds).toBeCloseTo(1.5, 3);
  });

  it('skips unknown odd-sized chunks', () => {
    const info = inspectWav(wav({ list: true, rate: 48000, channels: 1, seconds: 0.25 }));
    expect(info.sampleRate).toBe(48000);
    expect(info.durationSeconds).toBeCloseTo(0.25, 3);
  });

  it('rejects non-WAV, truncated and compressed files', () => {
    expect(() => inspectWav(new TextEncoder().encode('ID3 definitely an mp3'))).toThrow(InvalidWavError);
    expect(() => inspectWav(wav().slice(0, 30))).toThrow(InvalidWavError);
    expect(() => inspectWav(wav({ format: 2 }))).toThrow(/format code 2/);
  });
});

describe('kit files', () => {
  const layer = (over: Partial<Layer>): Layer => ({
    id: 1, kitId: 1, padIndex: 0, position: 0, originalName: 'a.wav', sizeBytes: 0, sampleRate: 44100,
    channels: 2, bitsPerSample: 16, durationSeconds: 1, rootNote: 0, octave: 0, fineTuneCents: 0,
    gain: 0.8, enabled: true, detectedKey: null, createdAt: '', ...over,
  });

  it('round-trips settings, layers and audio bytes', async () => {
    const a = wav({ seconds: 0.1 });
    const b = wav({ seconds: 0.2, channels: 1 });
    const blob = encodeKitFile(
      { name: 'Sunday', sessionMinutes: 15, masterVolume: 0.5, fadeSeconds: 3, keyLock: false },
      [
        { layer: layer({ padIndex: 3, rootNote: 9, octave: -1, originalName: 'Pad A.wav' }), data: a },
        { layer: layer({ padIndex: 3, rootNote: null, enabled: false, gain: 1.4, detectedKey: 'D major' }), data: b },
      ],
    );
    const { header, samples } = decodeKitFile(new Uint8Array(await blob.arrayBuffer()));
    expect(header.kit).toEqual({ name: 'Sunday', sessionMinutes: 15, masterVolume: 0.5, fadeSeconds: 3, keyLock: false });
    expect(header.layers[0]).toMatchObject({ padIndex: 3, rootNote: 9, octave: -1, originalName: 'Pad A.wav' });
    expect(header.layers[1]).toMatchObject({ rootNote: null, enabled: false, gain: 1.4, detectedKey: 'D major' });
    expect(samples[0]).toEqual(a);
    expect(samples[1]).toEqual(b);
  });

  it('rejects other files', async () => {
    expect(() => decodeKitFile(wav())).toThrow(/not a PadLoop kit/);
    const blob = encodeKitFile({ name: 'x', sessionMinutes: 1, masterVolume: 1, fadeSeconds: 1, keyLock: true }, [
      { layer: layer({}), data: wav() },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(() => decodeKitFile(bytes.slice(0, bytes.length - 10))).toThrow(/truncated/);
  });

  it('makes safe file names', () => {
    expect(safeFileName('Sunday Service: C#/Db')).toBe('Sunday-Service-CDb.padkit');
    expect(safeFileName('???')).toBe('kit.padkit');
  });
});
