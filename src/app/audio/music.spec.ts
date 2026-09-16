import { computePeaks, makeSeamless } from './loop';
import { detectKey } from './key-detect';
import { formatTime, guessKeyFromFilename, rateForSemitones, semitoneShift, totalSemitones } from './music';
import { offsetAt, retune, startPhase } from './phase';

describe('music helpers', () => {
  it('picks the shortest transposition onto the pad key', () => {
    expect(semitoneShift(0, 0)).toBe(0);
    expect(semitoneShift(2, 0)).toBe(2); // C -> D up 2
    expect(semitoneShift(11, 0)).toBe(-1); // C -> B down 1
    expect(semitoneShift(6, 0)).toBe(-6); // tritone goes down
    expect(semitoneShift(0, 9)).toBe(3); // A -> C up 3
    for (let p = 0; p < 12; p++)
      for (let r = 0; r < 12; r++) {
        const s = semitoneShift(p, r);
        expect(s).toBeGreaterThanOrEqual(-6);
        expect(s).toBeLessThanOrEqual(5);
        expect((((r + s) % 12) + 12) % 12).toBe(p);
      }
  });

  it('combines key lock, octave and cents', () => {
    const l = { padIndex: 7, rootNote: 5, octave: -1, fineTuneCents: 50 };
    expect(totalSemitones(l, true)).toBeCloseTo(2 - 12 + 0.5);
    expect(totalSemitones(l, false)).toBeCloseTo(-12 + 0.5);
    expect(totalSemitones({ ...l, rootNote: null }, true)).toBeCloseTo(-11.5);
    expect(rateForSemitones(12)).toBeCloseTo(2);
  });

  it('guesses keys from file names like the backend does', () => {
    expect(guessKeyFromFilename('Warm Pad C#.wav')).toBe(1);
    expect(guessKeyFromFilename('strings_Eb_maj.wav')).toBe(3);
    expect(guessKeyFromFilename('Choir-F-minor.wav')).toBe(5);
    expect(guessKeyFromFilename('pad (Am).wav')).toBe(9);
    expect(guessKeyFromFilename('sounds as good.wav')).toBeNull();
    expect(guessKeyFromFilename('BASS.wav')).toBeNull();
  });

  it('formats time', () => {
    expect(formatTime(0)).toBe('00:00');
    expect(formatTime(605.9)).toBe('10:05');
    expect(formatTime(3725)).toBe('1:02:05');
  });
});

describe('loop phase', () => {
  it('maps timeline positions to loop offsets, wrapping', () => {
    const p = startPhase(10, 1.5);
    expect(offsetAt(p, 10, 4)).toBe(0);
    expect(offsetAt(p, 12, 4)).toBeCloseTo(3);
    expect(offsetAt(p, 13, 4)).toBeCloseTo(0.5);
    expect(offsetAt(p, 9, 4)).toBeCloseTo(2.5); // rewind before start
  });

  it('retunes without jumping', () => {
    const p = startPhase(0, 1);
    const q = retune(p, 3, 2, 10);
    expect(offsetAt(q, 3, 10)).toBeCloseTo(3);
    expect(offsetAt(q, 4, 10)).toBeCloseTo(5);
  });
});

function sine(freqs: number[], seconds: number, rate = 22050): Float32Array {
  const out = new Float32Array(Math.floor(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (const f of freqs) v += Math.sin((2 * Math.PI * f * i) / rate);
    out[i] = v / freqs.length;
  }
  return out;
}

describe('seamless loops', () => {
  it('shortens by the crossfade and joins end to start smoothly', () => {
    const data = sine([220], 1, 8000);
    const [out] = makeSeamless([data], 800);
    expect(out.length).toBe(8000 - 800);
    const jump = Math.abs(out[out.length - 1] - out[0]);
    const step = Math.max(...Array.from({ length: 100 }, (_, i) => Math.abs(out[i + 1] - out[i])));
    expect(jump).toBeLessThan(step * 1.5);
  });

  it('computes normalised peaks', () => {
    const p = computePeaks([sine([100], 0.5, 8000)], 16);
    expect(p).toHaveLength(16);
    expect(Math.max(...p)).toBeCloseTo(1);
  });
});

describe('key detection', () => {
  const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

  it('detects a C major chord', () => {
    const est = detectKey([sine([hz(48), hz(60), hz(64), hz(67)], 3)], 22050);
    expect(est.tonic).toBe(0);
    expect(est.mode).toBe('major');
  });

  it('detects an A minor chord', () => {
    const est = detectKey([sine([hz(45), hz(57), hz(60), hz(64)], 3)], 22050);
    expect(est.label).toBe('A minor');
  });

  it('detects F# major on a short sample', () => {
    const est = detectKey([sine([hz(54), hz(66), hz(70), hz(73)], 0.4)], 22050);
    expect(est.tonic).toBe(6);
  });
});
