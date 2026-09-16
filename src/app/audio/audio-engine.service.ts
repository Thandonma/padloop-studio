import { Injectable, computed, signal } from '@angular/core';

import { computePeaks, crossfadeSeconds, makeSeamless } from './loop';
import { rateForSemitones, totalSemitones } from './music';
import { LoopPhase, offsetAt, retune, startPhase } from './phase';

/** What the engine needs to know about a layer. */
export interface EngineLayer {
  id: number;
  padIndex: number;
  rootNote: number | null;
  octave: number;
  fineTuneCents: number;
  gain: number;
  enabled: boolean;
}

export type TransportState = 'stopped' | 'playing' | 'paused';

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface PadBus {
  gain: GainNode;
  voices: Map<number, Voice>;
}

const CLICK_FADE = 0.03; // seconds; used for pause / seek so nothing pops

/**
 * Web Audio engine: sustains any number of looping layers per pad, keeps
 * them on a shared session timeline and supports pause / resume / seek.
 *
 * Signal graph:
 *   source -> layerGain -> padGain -> sessionGain -> masterGain -> limiter -> analyser -> out
 */
@Injectable({ providedIn: 'root' })
export class AudioEngineService {
  // ----- public reactive state -----
  readonly state = signal<TransportState>('stopped');
  readonly position = signal(0);
  /** Session length in seconds, or null for endless. */
  readonly sessionLength = signal<number | null>(600);
  readonly armedPads = signal<ReadonlySet<number>>(new Set());
  readonly masterVolume = signal(0.8);
  readonly fadeSeconds = signal(2);
  readonly keyLock = signal(true);
  readonly level = signal(0);
  /** Layer id -> normalised waveform peaks */
  readonly peaks = signal<ReadonlyMap<number, number[]>>(new Map());
  /** Layer ids currently being downloaded/decoded */
  readonly loading = signal<ReadonlySet<number>>(new Set());
  readonly ended = signal(false);

  readonly remaining = computed(() => {
    const len = this.sessionLength();
    return len == null ? null : Math.max(0, len - this.position());
  });

  // ----- internals -----
  private ctx?: AudioContext;
  private sessionGain?: GainNode;
  private masterGain?: GainNode;
  private analyser?: AnalyserNode;
  private meterData?: Float32Array<ArrayBuffer>;

  private layers = new Map<number, EngineLayer>();
  private buffers = new Map<number, AudioBuffer>();
  private pending = new Map<number, Promise<AudioBuffer | null>>();
  private phases = new Map<number, LoopPhase>();
  private pads = new Map<number, PadBus>();

  /** Where layer audio comes from (the local library). */
  private audioLoader: (layerId: number) => Promise<ArrayBuffer> = () =>
    Promise.reject(new Error('No audio loader configured'));

  private startCtxTime = 0;
  private startPos = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Create/resume the AudioContext. Must be called from a user gesture at least once. */
  async ensureContext(): Promise<AudioContext> {
    const ctx = this.createContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    return ctx;
  }

  private createContext(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      this.sessionGain = ctx.createGain();
      this.masterGain = ctx.createGain();
      this.masterGain.gain.value = this.masterVolume();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 2;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.meterData = new Float32Array(this.analyser.fftSize);
      this.sessionGain.connect(this.masterGain).connect(limiter).connect(this.analyser).connect(ctx.destination);
      this.ctx = ctx;
    }
    return this.ctx;
  }

  /** Decode an audio file without needing playback to have started. */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.createContext().decodeAudioData(data);
  }

  // ------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------

  /** Replace the full set of layers (e.g. after loading a kit or editing one). */
  setLayers(list: EngineLayer[]): void {
    const next = new Map(list.map((l) => [l.id, { ...l }]));
    // Removed layers
    for (const id of [...this.layers.keys()]) {
      if (!next.has(id)) {
        this.stopVoice(id, CLICK_FADE);
        this.layers.delete(id);
        this.phases.delete(id);
        this.buffers.delete(id);
        this.pending.delete(id);
        this.updatePeaks((m) => m.delete(id));
      }
    }
    for (const layer of next.values()) {
      const prev = this.layers.get(layer.id);
      this.layers.set(layer.id, layer);
      if (!this.buffers.has(layer.id)) void this.load(layer);
      if (!prev) {
        this.onLayerAdded(layer);
      } else {
        this.onLayerChanged(prev, layer);
      }
    }
  }

  /** Hand the engine an already-decoded buffer (avoids re-downloading after upload). */
  prime(layerId: number, buffer: AudioBuffer): void {
    if (!this.buffers.has(layerId)) this.storeBuffer(layerId, buffer);
  }

  forgetAll(): void {
    this.stop();
    this.layers.clear();
    this.buffers.clear();
    this.pending.clear();
    this.phases.clear();
    this.armedPads.set(new Set());
    this.peaks.set(new Map());
  }

  setAudioLoader(loader: (layerId: number) => Promise<ArrayBuffer>): void {
    this.audioLoader = loader;
  }

  loopDuration(layerId: number): number {
    return this.buffers.get(layerId)?.duration ?? 0;
  }

  rateFor(layer: EngineLayer): number {
    return rateForSemitones(totalSemitones(layer, this.keyLock()));
  }

  private async load(layer: EngineLayer): Promise<AudioBuffer | null> {
    let p = this.pending.get(layer.id);
    if (!p) {
      this.setLoading(layer.id, true);
      p = this.audioLoader(layer.id)
        .then((data) => this.decode(data))
        .then((buf) => {
          if (!this.layers.has(layer.id)) return null; // deleted meanwhile
          if (!this.buffers.has(layer.id)) this.storeBuffer(layer.id, buf);
          return this.buffers.get(layer.id) ?? null;
        })
        .catch((err) => {
          console.error(`Could not load layer ${layer.id}`, err);
          this.pending.delete(layer.id);
          return null;
        })
        .finally(() => this.setLoading(layer.id, false));
      this.pending.set(layer.id, p);
    }
    return p;
  }

  private storeBuffer(layerId: number, raw: AudioBuffer): void {
    const channels = Array.from({ length: raw.numberOfChannels }, (_, i) => raw.getChannelData(i));
    this.updatePeaks((m) => m.set(layerId, computePeaks(channels, 64)));
    const xf = Math.round(crossfadeSeconds(raw.duration) * raw.sampleRate);
    const seamless = makeSeamless(channels, xf);
    const buf = new AudioBuffer({
      length: seamless[0].length,
      numberOfChannels: seamless.length,
      sampleRate: raw.sampleRate,
    });
    seamless.forEach((data, i) => buf.copyToChannel(data, i));
    this.buffers.set(layerId, buf);
    this.pending.set(layerId, Promise.resolve(buf));

    // If its pad is already sounding, bring the new layer in now.
    const layer = this.layers.get(layerId);
    if (layer && this.state() === 'playing' && this.armedPads().has(layer.padIndex)) {
      this.startVoice(layer, this.currentPos(), this.fadeSeconds());
    }
  }

  private onLayerAdded(layer: EngineLayer): void {
    const pos = this.currentPos();
    this.phases.set(layer.id, startPhase(pos, this.rateFor(layer)));
    if (this.state() === 'playing' && this.armedPads().has(layer.padIndex)) {
      this.startVoice(layer, pos, this.fadeSeconds());
    }
  }

  private onLayerChanged(prev: EngineLayer, layer: EngineLayer): void {
    const pos = this.currentPos();
    const playing = this.state() === 'playing';
    if (prev.padIndex !== layer.padIndex) {
      // Moved to another pad: restart it there.
      this.stopVoice(layer.id, CLICK_FADE);
      this.phases.set(layer.id, startPhase(pos, this.rateFor(layer)));
      if (playing && this.armedPads().has(layer.padIndex)) this.startVoice(layer, pos, this.fadeSeconds());
      return;
    }
    this.applyRate(layer, pos);
    const voice = this.pads.get(layer.padIndex)?.voices.get(layer.id);
    if (voice) voice.gain.gain.setTargetAtTime(layer.enabled ? layer.gain : 0, this.ctx!.currentTime, 0.02);
    if (layer.enabled && !prev.enabled && !voice && playing && this.armedPads().has(layer.padIndex)) {
      this.startVoice(layer, pos, CLICK_FADE);
    }
  }

  private applyRate(layer: EngineLayer, pos: number): void {
    const rate = this.rateFor(layer);
    const phase = this.phases.get(layer.id);
    if (phase && phase.rate !== rate) {
      this.phases.set(layer.id, retune(phase, pos, rate, this.loopDuration(layer.id)));
    }
    const voice = this.pads.get(layer.padIndex)?.voices.get(layer.id);
    if (voice && this.ctx) voice.source.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
  }

  // ------------------------------------------------------------------
  // Pads
  // ------------------------------------------------------------------

  isArmed(pad: number): boolean {
    return this.armedPads().has(pad);
  }

  async togglePad(pad: number): Promise<void> {
    if (this.isArmed(pad)) this.releasePad(pad);
    else await this.armPad(pad);
  }

  /** Start sustaining a pad. If the transport is stopped this also starts playback. */
  async armPad(pad: number): Promise<void> {
    await this.ensureContext();
    if (this.isArmed(pad)) return;
    const pos = this.currentPos();
    for (const layer of this.layersOn(pad)) {
      this.phases.set(layer.id, startPhase(pos, this.rateFor(layer)));
    }
    this.armedPads.update((s) => new Set(s).add(pad));
    if (this.state() === 'playing') {
      this.startPad(pad, pos, this.fadeSeconds());
    } else if (this.state() === 'stopped') {
      await this.play(this.fadeSeconds());
    }
  }

  /** Stop sustaining a pad (fades out over the release time). */
  releasePad(pad: number): void {
    if (!this.isArmed(pad)) return;
    this.armedPads.update((s) => {
      const n = new Set(s);
      n.delete(pad);
      return n;
    });
    this.stopPad(pad, this.state() === 'playing' ? this.fadeSeconds() : CLICK_FADE);
  }

  releaseAll(): void {
    for (const pad of [...this.armedPads()]) this.releasePad(pad);
  }

  private layersOn(pad: number): EngineLayer[] {
    return [...this.layers.values()].filter((l) => l.padIndex === pad);
  }

  private startPad(pad: number, pos: number, fade: number): void {
    for (const layer of this.layersOn(pad)) this.startVoice(layer, pos, fade);
  }

  private padBus(pad: number): PadBus {
    let bus = this.pads.get(pad);
    if (!bus) {
      const ctx = this.ctx!;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.sessionGain!);
      bus = { gain, voices: new Map() };
      this.pads.set(pad, bus);
    }
    return bus;
  }

  private startVoice(layer: EngineLayer, pos: number, fade: number): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(layer.id);
    if (!ctx || !buffer || !layer.enabled) return;
    const bus = this.padBus(layer.padIndex);
    if (bus.voices.has(layer.id)) return;

    const now = ctx.currentTime;
    const phase = this.phases.get(layer.id) ?? startPhase(pos, this.rateFor(layer));
    this.phases.set(layer.id, phase);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = this.rateFor(layer);
    const gain = ctx.createGain();
    source.connect(gain).connect(bus.gain);
    source.start(now, offsetAt(phase, pos, buffer.duration));
    bus.voices.set(layer.id, { source, gain });

    const g = bus.gain.gain;
    const current = g.value;
    // A layer joining a pad that is already sounding fades itself in;
    // otherwise the pad bus provides the fade.
    const voiceFade = current > 0.99 ? Math.max(CLICK_FADE, fade) : CLICK_FADE;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(layer.gain, now + voiceFade);

    // Bring the pad bus up (no-op if it is already fully up).
    g.cancelScheduledValues(now);
    g.setValueAtTime(current, now);
    g.linearRampToValueAtTime(1, now + Math.max(CLICK_FADE, fade * (1 - current)));
  }

  private stopVoice(layerId: number, fade: number): void {
    for (const bus of this.pads.values()) {
      const v = bus.voices.get(layerId);
      if (v) {
        this.fadeAndStop(v, fade);
        bus.voices.delete(layerId);
      }
    }
  }

  private fadeAndStop(v: Voice, fade: number): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fade);
    try {
      v.source.stop(now + fade + 0.01);
    } catch {
      /* already stopped */
    }
    v.source.onended = () => {
      v.source.disconnect();
      v.gain.disconnect();
    };
  }

  /** Fade a whole pad out, then detach its bus so a re-arm starts fresh. */
  private stopPad(pad: number, fade: number): void {
    const bus = this.pads.get(pad);
    if (!bus || !this.ctx) return;
    this.pads.delete(pad);
    const now = this.ctx.currentTime;
    const g = bus.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const v of bus.voices.values()) {
      try {
        v.source.stop(now + fade + 0.01);
      } catch {
        /* ignore */
      }
      v.source.onended = () => {
        v.source.disconnect();
        v.gain.disconnect();
      };
    }
    setTimeout(() => bus.gain.disconnect(), (fade + 0.2) * 1000);
  }

  private stopAllVoices(fade: number): void {
    for (const pad of [...this.pads.keys()]) this.stopPad(pad, fade);
  }

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------

  currentPos(): number {
    if (this.state() === 'playing' && this.ctx) {
      return this.startPos + (this.ctx.currentTime - this.startCtxTime);
    }
    return this.position();
  }

  async play(fade = CLICK_FADE): Promise<void> {
    const ctx = await this.ensureContext();
    if (this.state() === 'playing') return;
    const len = this.sessionLength();
    let pos = this.position();
    if (len != null && pos >= len) pos = 0;
    this.ended.set(false);
    this.startPos = pos;
    this.startCtxTime = ctx.currentTime;
    this.position.set(pos);
    this.state.set('playing');
    for (const pad of this.armedPads()) this.startPad(pad, pos, fade);
    this.scheduleSessionFade();
    this.startTicking();
  }

  pause(): void {
    if (this.state() !== 'playing') return;
    const pos = this.currentPos();
    this.stopAllVoices(CLICK_FADE);
    this.position.set(pos);
    this.state.set('paused');
    this.level.set(0);
    this.stopTicking();
  }

  async togglePlay(): Promise<void> {
    if (this.state() === 'playing') this.pause();
    else await this.play();
  }

  /** Stop and return to the start. Pads stay armed so Play brings them back. */
  stop(): void {
    if (this.ctx) this.stopAllVoices(this.state() === 'playing' ? Math.min(0.5, this.fadeSeconds()) : CLICK_FADE);
    this.stopTicking();
    this.state.set('stopped');
    this.position.set(0);
    this.level.set(0);
    for (const [id, layer] of this.layers) this.phases.set(id, startPhase(0, this.rateFor(layer)));
  }

  seek(target: number): void {
    const len = this.sessionLength();
    const pos = Math.max(0, len == null ? target : Math.min(target, Math.max(0, len - 0.05)));
    if (this.state() === 'playing' && this.ctx) {
      this.stopAllVoices(CLICK_FADE);
      this.startPos = pos;
      this.startCtxTime = this.ctx.currentTime;
      for (const pad of this.armedPads()) this.startPad(pad, pos, CLICK_FADE * 2);
      this.scheduleSessionFade();
    }
    this.position.set(pos);
    this.ended.set(false);
  }

  skip(deltaSeconds: number): void {
    this.seek(this.currentPos() + deltaSeconds);
  }

  // ------------------------------------------------------------------
  // Settings
  // ------------------------------------------------------------------

  setSessionLength(seconds: number | null): void {
    this.sessionLength.set(seconds);
    if (this.state() === 'playing') this.scheduleSessionFade();
  }

  setMasterVolume(v: number): void {
    this.masterVolume.set(v);
    if (this.ctx && this.masterGain) this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setFadeSeconds(s: number): void {
    this.fadeSeconds.set(s);
    if (this.state() === 'playing') this.scheduleSessionFade();
  }

  setKeyLock(on: boolean): void {
    this.keyLock.set(on);
    const pos = this.currentPos();
    for (const layer of this.layers.values()) this.applyRate(layer, pos);
  }

  /** Fade the whole session out so it ends gracefully at the chosen length. */
  private scheduleSessionFade(): void {
    const ctx = this.ctx;
    const g = this.sessionGain?.gain;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    g.cancelScheduledValues(now);
    const len = this.sessionLength();
    if (len == null) {
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(1, now + CLICK_FADE);
      return;
    }
    const pos = this.currentPos();
    const fade = Math.max(0.5, this.fadeSeconds());
    const endAt = now + (len - pos);
    const fadeStart = endAt - fade;
    if (fadeStart > now) {
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(1, now + CLICK_FADE);
      g.setValueAtTime(1, fadeStart);
    } else {
      g.setValueAtTime(Math.max(0, Math.min(1, (endAt - now) / fade)), now);
    }
    g.linearRampToValueAtTime(0, endAt);
  }

  // setInterval rather than requestAnimationFrame so the session still ends
  // on time when the tab is in the background.
  private startTicking(): void {
    this.stopTicking();
    this.timer = setInterval(this.tick, 50);
  }

  private stopTicking(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick = (): void => {
    if (this.state() !== 'playing') {
      this.stopTicking();
      return;
    }
    const pos = this.currentPos();
    const len = this.sessionLength();
    if (len != null && pos >= len) {
      this.stop();
      this.ended.set(true);
      this.level.set(0);
      return;
    }
    this.position.set(pos);
    this.updateMeter();
  };

  private updateMeter(): void {
    if (!this.analyser || !this.meterData) return;
    this.analyser.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    for (const v of this.meterData) sum += v * v;
    const rms = Math.sqrt(sum / this.meterData.length);
    const db = 20 * Math.log10(rms + 1e-9);
    this.level.set(Math.max(0, Math.min(1, (db + 60) / 60)));
  }

  private setLoading(id: number, on: boolean): void {
    this.loading.update((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  }

  private updatePeaks(fn: (m: Map<number, number[]>) => void): void {
    this.peaks.update((m) => {
      const n = new Map(m);
      fn(n);
      return n;
    });
  }

  /** Debug/testing hook: current playback rate and offset for a layer. */
  debugLayer(layerId: number): { rate: number; offset: number; sounding: boolean } | null {
    const layer = this.layers.get(layerId);
    const phase = this.phases.get(layerId);
    if (!layer || !phase) return null;
    const sounding = !!this.pads.get(layer.padIndex)?.voices.has(layerId);
    return {
      rate: this.rateFor(layer),
      offset: offsetAt(phase, this.currentPos(), this.loopDuration(layerId)),
      sounding,
    };
  }
}
