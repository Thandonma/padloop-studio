/** What a kit holds. A sound plays on whichever key you press. */
export interface Sound {
  id: number;
  kitId: number;
  position: number;
  name: string;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
  /** The key the recording was made in (0 = C ... 11 = B), or null if unknown. */
  rootNote: number | null;
  octave: number;
  fineTuneCents: number;
  gain: number;
  enabled: boolean;
  detectedKey: string | null;
  /** Set for sounds that came from the built-in starter pads. */
  starterId: string | null;
  createdAt: string;
}

export interface KitSummary {
  id: number;
  name: string;
  soundCount: number;
  updatedAt: string;
}

export interface KitSettings {
  name: string;
  sessionMinutes: number;
  masterVolume: number;
  fadeSeconds: number;
  keyLock: boolean;
}

export interface KitDetail extends KitSettings {
  id: number;
  createdAt: string;
  updatedAt: string;
  sounds: Sound[];
}

export type KitPatch = Partial<KitSettings>;

export type SoundPatch = Partial<
  Pick<Sound, 'name' | 'rootNote' | 'octave' | 'fineTuneCents' | 'gain' | 'enabled' | 'detectedKey'>
> & { clearRootNote?: boolean };

export const MAX_SOUNDS_PER_KIT = 8;
