import { MAX_MP3_AUDIO_BYTES, MP3_HEAD_BYTES, audioTooLarge, inspectAudio, isSupportedAudioFile, isWavFile, mp3KeepLength, shortenLongMp3 } from './audio-formats';
import { decodeKitFile, encodeKitFile, safeFileName } from './kit-file';
import { Sound } from './models';
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

describe('accepted audio formats', () => {
  it('takes the formats browsers can decode, and refuses the rest', () => {
    for (const name of ['pad.wav', 'PAD.WAVE', 'loop.mp3', 'a.ogg', 'b.m4a', 'c.flac', 'd.webm', 'e.aac']) {
      expect(isSupportedAudioFile(name)).toBe(true);
    }
    for (const name of ['notes.txt', 'song.mid', 'cover.png', 'track.wma', 'noextension']) {
      expect(isSupportedAudioFile(name)).toBe(false);
    }
    expect(isWavFile('pad.wav')).toBe(true);
    expect(isWavFile('pad.mp3')).toBe(false);
  });

  it('reads WAV headers directly and decodes everything else', async () => {
    const decode = vi.fn().mockResolvedValue({ numberOfChannels: 1, sampleRate: 48000, duration: 7.5 });
    const fromHeader = await inspectAudio(wav({ seconds: 2 }), 'pad.wav', decode);
    expect(fromHeader.durationSeconds).toBeCloseTo(2, 3);
    expect(decode).not.toHaveBeenCalled();

    const fromDecoder = await inspectAudio(new Uint8Array([1, 2, 3]), 'pad.mp3', decode);
    expect(decode).toHaveBeenCalledOnce();
    expect(fromDecoder).toMatchObject({ channels: 1, sampleRate: 48000, durationSeconds: 7.5, bitsPerSample: 0 });
  });
});

describe('long audio files', () => {
  const big = MAX_MP3_AUDIO_BYTES * 6;
  const head = (...b: number[]) => new Uint8Array([...b, ...new Array(MP3_HEAD_BYTES).fill(0)].slice(0, MP3_HEAD_BYTES));

  it('caps MP3s that start with a frame', () => {
    expect(mp3KeepLength(head(0xff, 0xfb), big)).toBe(MAX_MP3_AUDIO_BYTES);
  });

  it('does not count the ID3 tag against the cap', () => {
    // Synchsafe size: 1 << 7 = 128 bytes.
    const tagged = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 1, 0]);
    expect(mp3KeepLength(tagged, big)).toBe(MP3_HEAD_BYTES + 128 + MAX_MP3_AUDIO_BYTES);
  });

  it('leaves short MP3s and other formats whole', () => {
    expect(mp3KeepLength(head(0xff, 0xfb), 1000)).toBe(1000);
    expect(mp3KeepLength(head(0xff, 0xf1), big)).toBe(big); // AAC
    expect(mp3KeepLength(head(0x52, 0x49, 0x46, 0x46), big)).toBe(big); // WAV
  });

  it('cuts the file itself, keeping its name', async () => {
    const bytes = new Uint8Array(MAX_MP3_AUDIO_BYTES + 100);
    bytes.set([0xff, 0xfb]);
    const out = await shortenLongMp3(new File([bytes], 'Pad in D.mp3'));
    expect(out.size).toBe(MAX_MP3_AUDIO_BYTES);
    expect(out.name).toBe('Pad in D.mp3');
  });

  it('refuses oversized files that cannot be cut, but not long MP3s', () => {
    const sized = (name: string, mb: number) => ({ name, size: mb * 1024 * 1024 }) as File;
    expect(audioTooLarge(sized('a.m4a', 50), head(0, 0))).toContain('16 MB');
    expect(audioTooLarge(sized('a.wav', 50), head(0x52, 0x49))).toBeNull();
    expect(audioTooLarge(sized('a.wav', 70), head(0x52, 0x49))).toContain('64 MB');
    expect(audioTooLarge(sized('a.mp3', 50), head(0xff, 0xfb))).toBeNull();
  });
});

describe('kit files', () => {
  const sound = (over: Partial<Sound>): Sound => ({
    id: 1, kitId: 1, position: 0, name: 'a', sizeBytes: 0, sampleRate: 44100,
    channels: 2, bitsPerSample: 16, durationSeconds: 1, rootNote: 0, octave: 0, fineTuneCents: 0,
    gain: 0.8, enabled: true, detectedKey: null, starterId: null, createdAt: '', ...over,
  });

  it('round-trips settings, layers and audio bytes', async () => {
    const a = wav({ seconds: 0.1 });
    const b = wav({ seconds: 0.2, channels: 1 });
    const blob = encodeKitFile(
      { name: 'Sunday', sessionMinutes: 15, masterVolume: 0.5, fadeSeconds: 3, keyLock: false },
      [
        { sound: sound({ rootNote: 9, octave: -1, name: 'Pad A', starterId: 'warm', sampleRate: 48000, bitsPerSample: 0, durationSeconds: 9.5 }), data: a },
        { sound: sound({ rootNote: null, enabled: false, gain: 1.4, detectedKey: 'D major' }), data: b },
      ],
    );
    const { header, samples } = decodeKitFile(new Uint8Array(await blob.arrayBuffer()));
    expect(header.kit).toEqual({ name: 'Sunday', sessionMinutes: 15, masterVolume: 0.5, fadeSeconds: 3, keyLock: false });
    expect(header.sounds[0]).toMatchObject({ rootNote: 9, octave: -1, name: 'Pad A', starterId: 'warm' });
    // compressed formats need these, since they have no readable header
    expect(header.sounds[0]).toMatchObject({ sampleRate: 48000, bitsPerSample: 0, durationSeconds: 9.5 });
    expect(header.sounds[1]).toMatchObject({ rootNote: null, enabled: false, gain: 1.4, detectedKey: 'D major' });
    expect(samples[0]).toEqual(a);
    expect(samples[1]).toEqual(b);
  });

  it('rejects other files', async () => {
    expect(() => decodeKitFile(wav())).toThrow(/not a PadLoop kit/);
    const blob = encodeKitFile({ name: 'x', sessionMinutes: 1, masterVolume: 1, fadeSeconds: 1, keyLock: true }, [
      { sound: sound({}), data: wav() },
    ]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(() => decodeKitFile(bytes.slice(0, bytes.length - 10))).toThrow(/truncated/);
  });

  it('makes safe file names', () => {
    expect(safeFileName('Sunday Service: C#/Db')).toBe('Sunday-Service-CDb.padkit');
    expect(safeFileName('???')).toBe('kit.padkit');
  });
});
