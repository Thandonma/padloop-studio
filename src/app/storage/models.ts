export interface KitSummary {
  id: number;
  name: string;
  layerCount: number;
  updatedAt: string;
}

export interface Layer {
  id: number;
  kitId: number;
  padIndex: number;
  position: number;
  originalName: string;
  sizeBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSeconds: number;
  rootNote: number | null;
  octave: number;
  fineTuneCents: number;
  gain: number;
  enabled: boolean;
  detectedKey: string | null;
  createdAt: string;
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
  layers: Layer[];
}

export type KitPatch = Partial<KitSettings>;

export type LayerPatch = Partial<
  Pick<Layer, 'padIndex' | 'rootNote' | 'octave' | 'fineTuneCents' | 'gain' | 'enabled' | 'detectedKey'>
> & { clearRootNote?: boolean };

export const MAX_LAYERS_PER_PAD = 8;
