/**
 * The pads that ship with the app, so there is something to play before you
 * load any of your own.
 *
 * They were synthesised from scratch by tools/make-pads.py: original works,
 * free to use and change. Each one is a sustained root + fifth + octave in C,
 * which sits under both major and minor chords; the app re-tunes it to
 * whichever key you press.
 */
export interface StarterPad {
  id: string;
  name: string;
  description: string;
  file: string;
  /** All starter pads are recorded in C. */
  rootNote: number;
  detectedKey: string;
}

export const STARTER_PADS: StarterPad[] = [
  {
    id: 'warm',
    name: 'Warm Pad',
    description: 'Round analogue warmth. The safe one to start with.',
    file: 'pads/warm.wav',
    rootNote: 0,
    detectedKey: 'C major',
  },
  {
    id: 'air',
    name: 'Air',
    description: 'Soft and spacious, with a gentle octave shimmer.',
    file: 'pads/air.wav',
    rootNote: 0,
    detectedKey: 'C major',
  },
  {
    id: 'strings',
    name: 'Strings',
    description: 'An ensemble swell that sits under vocals.',
    file: 'pads/strings.wav',
    rootNote: 0,
    detectedKey: 'C major',
  },
  {
    id: 'choir',
    name: 'Choir',
    description: "Breathy voices humming an open 'ahh'.",
    file: 'pads/choir.wav',
    rootNote: 0,
    detectedKey: 'C major',
  },
];

/** Downloads a starter pad and hands it back as a File, ready to store. */
export async function fetchStarterPad(pad: StarterPad): Promise<File> {
  // Resolve against this module's own URL rather than the page's base, so the
  // app works wherever it is hosted (sub-path, preview host, file server).
  const url = new URL(pad.file, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load the ${pad.name} sound (HTTP ${res.status})`);
  const blob = await res.blob();
  return new File([blob], `${pad.id}.wav`, { type: 'audio/wav' });
}
