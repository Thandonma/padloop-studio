/** Pitch-class helpers shared by the UI and the audio engine. Pad 0..11 = C..B. */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Black keys on a piano, used for the pad layout. */
export const IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Computer-keyboard shortcuts laid out like a piano (A = C, W = C#, S = D ...). */
export const PAD_KEYS = ['a', 'w', 's', 'e', 'd', 'f', 't', 'g', 'y', 'h', 'u', 'j'] as const;

export function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

export function noteName(pc: number | null | undefined): string {
  return pc == null ? '—' : NOTE_NAMES[mod(pc, 12)];
}

/**
 * Smallest transposition (in semitones) that moves a recording in `rootNote`
 * onto `padKey`. Always within -6..+5 so samples are never stretched further
 * than half an octave.
 */
export function semitoneShift(padKey: number, rootNote: number): number {
  return mod(padKey - rootNote + 6, 12) - 6;
}

export interface TuningInput {
  padIndex: number;
  rootNote: number | null;
  octave: number;
  fineTuneCents: number;
}

/** Total transposition in semitones for a layer, honouring key lock. */
export function totalSemitones(layer: TuningInput, keyLock: boolean): number {
  const keyShift = keyLock && layer.rootNote != null ? semitoneShift(layer.padIndex, layer.rootNote) : 0;
  return keyShift + 12 * layer.octave + layer.fineTuneCents / 100;
}

/** Web Audio playbackRate for a transposition in semitones. */
export function rateForSemitones(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatShift(semitones: number): string {
  if (Math.abs(semitones) < 0.005) return '±0';
  const rounded = Math.round(semitones * 100) / 100;
  return (rounded > 0 ? '+' : '') + rounded + ' st';
}

// ---------------------------------------------------------------------------
// Guessing a key from a file name ("Warm Pad C#m.wav" -> 1). Mirrors the Java
// NoteNames class so the UI can show the guess before uploading.
// ---------------------------------------------------------------------------

const TOKEN = /^([A-Ga-g])(#|b|s|sharp|flat)?(m|min|minor|maj|major|M)?$/;
const QUALITY_WORDS = new Set(['maj', 'major', 'min', 'minor']);
const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function parseToken(token: string): number | null {
  const m = TOKEN.exec(token);
  if (!m) return null;
  const [, letter, acc] = m;
  if (letter === letter.toLowerCase() && acc !== '#') return null;
  let pc = LETTER_PC[letter.toUpperCase()];
  if (acc) pc += acc === '#' || acc === 's' || acc === 'sharp' ? 1 : -1;
  return mod(pc, 12);
}

export function guessKeyFromFilename(filename: string): number | null {
  const base = filename.replace(/\.[A-Za-z0-9]+$/, '');
  const tokens = base.split(/[\s_\-.()[\]]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (QUALITY_WORDS.has(t.toLowerCase()) && i > 0) {
      const pc = parseToken(tokens[i - 1]);
      if (pc != null) return pc;
      continue;
    }
    const pc = parseToken(t);
    if (pc != null) return pc;
  }
  return null;
}
