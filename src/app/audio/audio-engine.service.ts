import { Injectable, computed, signal } from '@angular/core';

import { computePeaks, crossfadeSeconds, makeSeamless } from './loop';
import { rateForSemitones, totalSemitones } from './music';
import { LoopPhase, offsetAt, retune, startPhase } from './phase';

/** What the engine needs to know about one sound in the kit. */
export interface EngineSound {
  id: number;
  rootNote: number | null;
  octave: number;
  fineTuneCents: number;
  gain: number;
  enabled: boolean;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** Everything sounding in one key: a bus plus one voice per enabled sound. */
interface Rig {
  key: number;
  gain: GainNode;
  voices: Map<number, Voice>;
}

const CLICK_FADE = 0.03; // seconds, used where a fade only needs to avoid a pop

/**
 * Web Audio engine. Press a key and every enabled sound in the kit sustains in
 * that key, looping, until you press it again. Pressing another key moves the
 * whole thing across in a crossfade, so the music never stops abruptly.
 *
 * Signal graph:
 *   source -> sound gain -> key bus -> session gain -> master -> limiter -> analyser -> out
 */
@Injectable({ providedIn: 'root' })
export class AudioEngineService {
  // ----- public reactive state -----
  /** The key currently sounding (0 = C ... 11 = B), or null when silent. */
  readonly activeKey = signal<number | null>(null);
  readonly playing = computed(() => this.activeKey() !== null);
  readonly position = signal(0);
  /** Session length in seconds, or null for endless. */
  readonly sessionLength = signal<number | null>(600);
  readonly masterVolume = signal(0.8);
  readonly fadeSeconds = signal(2);
  readonly keyLock = signal(true);
  readonly level = signal(0);
  /** Sound id -> normalised waveform peaks */
  readonly peaks = signal<ReadonlyMap<number, number[]>>(new Map());
  /** Sound ids currently being loaded or decoded */
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

  private sounds = new Map<number, EngineSound>();
  private buffers = new Map<number, AudioBuffer>();
  private pending = new Map<number, Promise<AudioBuffer | null>>();
  /** Sounds decode one at a time, so opening a kit can't exhaust a phone's memory all at once. */
  private loadQueue: Promise<unknown> = Promise.resolve();
  private phases = new Map<number, LoopPhase>();
  private rig: Rig | null = null;

  private audioLoader: (soundId: number) => Promise<ArrayBuffer> = () =>
    Promise.reject(new Error('No audio loader configured'));

  private startCtxTime = 0;
  private startPos = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Create/resume the AudioContext. Must follow a user gesture at least once. */
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

  setAudioLoader(loader: (soundId: number) => Promise<ArrayBuffer>): void {
    this.audioLoader = loader;
  }

  // ------------------------------------------------------------------
  // Sounds
  // ------------------------------------------------------------------

  /** Replace the kit's sounds (after loading a kit, or editing one). */
  setSounds(list: EngineSound[]): void {
    const next = new Map(list.map((s) => [s.id, { ...s }]));
    for (const id of [...this.sounds.keys()]) {
      if (!next.has(id)) {
        this.stopVoice(id, CLICK_FADE);
        this.sounds.delete(id);
        this.phases.delete(id);
        this.buffers.delete(id);
        this.pending.delete(id);
        this.updatePeaks((m) => m.delete(id));
      }
    }
    for (const sound of next.values()) {
      const prev = this.sounds.get(sound.id);
      this.sounds.set(sound.id, sound);
      if (!this.buffers.has(sound.id)) void this.load(sound);
      if (!prev) this.onSoundAdded(sound);
      else this.onSoundChanged(prev, sound);
    }
  }

  /** Hand the engine an already-decoded buffer (saves re-reading it). */
  prime(soundId: number, buffer: AudioBuffer): void {
    if (!this.buffers.has(soundId)) this.storeBuffer(soundId, buffer);
  }

  forgetAll(): void {
    this.stop();
    this.sounds.clear();
    this.buffers.clear();
    this.pending.clear();
    this.phases.clear();
    this.peaks.set(new Map());
  }

  loopDuration(soundId: number): number {
    return this.buffers.get(soundId)?.duration ?? 0;
  }

  /** Playback rate for a sound in the given key. */
  rateFor(sound: EngineSound, key: number | null): number {
    const padIndex = key ?? sound.rootNote ?? 0;
    return rateForSemitones(totalSemitones({ ...sound, padIndex }, this.keyLock()));
  }

  private async load(sound: EngineSound): Promise<AudioBuffer | null> {
    let p = this.pending.get(sound.id);
    if (!p) {
      this.setLoading(sound.id, true);
      p = this.loadQueue
        .then(async () => {
          if (!this.sounds.has(sound.id)) return null; // deleted meanwhile
          const buf = await this.decode(await this.audioLoader(sound.id));
          if (!this.sounds.has(sound.id)) return null;
          if (!this.buffers.has(sound.id)) this.storeBuffer(sound.id, buf);
          return this.buffers.get(sound.id) ?? null;
        })
        .catch((err) => {
          console.error(`Could not load sound ${sound.id}`, err);
          this.pending.delete(sound.id);
          return null;
        })
        .finally(() => this.setLoading(sound.id, false));
      this.pending.set(sound.id, p);
      this.loadQueue = p;
    }
    return p;
  }

  private storeBuffer(soundId: number, raw: AudioBuffer): void {
    const channels = Array.from({ length: raw.numberOfChannels }, (_, i) => raw.getChannelData(i));
    this.updatePeaks((m) => m.set(soundId, computePeaks(channels, 64)));
    const xf = Math.round(crossfadeSeconds(raw.duration) * raw.sampleRate);
    const seamless = makeSeamless(channels, xf);
    const buf = new AudioBuffer({
      length: seamless[0].length,
      numberOfChannels: seamless.length,
      sampleRate: raw.sampleRate,
    });
    seamless.forEach((data, i) => buf.copyToChannel(data, i));
    this.buffers.set(soundId, buf);
    this.pending.set(soundId, Promise.resolve(buf));

    // If a key is already sounding, bring the new arrival in with it.
    const sound = this.sounds.get(soundId);
    if (sound && this.rig) this.startVoice(sound, this.currentPos(), this.fadeSeconds());
  }

  private onSoundAdded(sound: EngineSound): void {
    const pos = this.currentPos();
    this.phases.set(sound.id, startPhase(pos, this.rateFor(sound, this.activeKey())));
    if (this.rig) this.startVoice(sound, pos, this.fadeSeconds());
  }

  private onSoundChanged(prev: EngineSound, sound: EngineSound): void {
    const pos = this.currentPos();
    this.applyRate(sound, pos);
    const voice = this.rig?.voices.get(sound.id);
    if (!sound.enabled && voice) {
      // Muted: fade it out and let the voice go, rather than leaving it running silently.
      this.stopVoice(sound.id, Math.min(0.4, Math.max(CLICK_FADE, this.fadeSeconds())));
      return;
    }
    if (voice && this.ctx) {
      voice.gain.gain.setTargetAtTime(sound.gain, this.ctx.currentTime, 0.02);
    } else if (sound.enabled && this.rig) {
      this.startVoice(sound, pos, Math.min(0.4, Math.max(CLICK_FADE, this.fadeSeconds())));
    }
  }

  private applyRate(sound: EngineSound, pos: number): void {
    const rate = this.rateFor(sound, this.activeKey());
    const phase = this.phases.get(sound.id);
    if (phase && phase.rate !== rate) {
      this.phases.set(sound.id, retune(phase, pos, rate, this.loopDuration(sound.id)));
    }
    const voice = this.rig?.voices.get(sound.id);
    if (voice && this.ctx) voice.source.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
  }

  // ------------------------------------------------------------------
  // Keys
  // ------------------------------------------------------------------

  isActive(key: number): boolean {
    return this.activeKey() === key;
  }

  /** Press a key: start it, switch to it, or (if it is already on) stop. */
  async pressKey(key: number): Promise<void> {
    if (this.activeKey() === key) {
      this.release();
      return;
    }
    await this.ensureContext();
    const starting = this.activeKey() === null;
    const pos = this.currentPos();
    const fade = this.fadeSeconds();

    if (starting) {
      this.ended.set(false);
      const len = this.sessionLength();
      this.startPos = len != null && pos >= len ? 0 : pos;
      this.startCtxTime = this.ctx!.currentTime;
      this.position.set(this.startPos);
    }
    this.activeKey.set(key);
    // Re-tune every sound to the new key, keeping each loop where it was.
    for (const sound of this.sounds.values()) {
      const phase = this.phases.get(sound.id);
      const rate = this.rateFor(sound, key);
      this.phases.set(
        sound.id,
        phase ? retune(phase, this.currentPos(), rate, this.loopDuration(sound.id)) : startPhase(this.currentPos(), rate),
      );
    }
    this.swapRig(key, this.currentPos(), starting ? Math.max(CLICK_FADE, fade) : fade);
    this.scheduleSessionFade();
    this.startTicking();
  }

  /** Fade everything out and stop the clock, keeping the position. */
  release(): void {
    if (!this.rig && this.activeKey() === null) return;
    const pos = this.currentPos();
    this.fadeOutRig(this.fadeSeconds());
    this.activeKey.set(null);
    this.position.set(pos);
    this.stopTicking();
    this.level.set(0);
  }

  /** Stop and go back to the beginning of the session. */
  stop(): void {
    this.fadeOutRig(this.activeKey() === null ? CLICK_FADE : Math.min(0.6, this.fadeSeconds()));
    this.activeKey.set(null);
    this.stopTicking();
    this.position.set(0);
    this.level.set(0);
    for (const [id, sound] of this.sounds) this.phases.set(id, startPhase(0, this.rateFor(sound, null)));
  }

  private swapRig(key: number, pos: number, fade: number): void {
    const ctx = this.ctx!;
    this.fadeOutRig(fade);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.sessionGain!);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + Math.max(CLICK_FADE, fade));
    this.rig = { key, gain, voices: new Map() };
    for (const sound of this.sounds.values()) this.startVoice(sound, pos, fade);
  }

  private fadeOutRig(fade: number): void {
    const rig = this.rig;
    if (!rig || !this.ctx) return;
    this.rig = null;
    const now = this.ctx.currentTime;
    const g = rig.gain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + fade);
    for (const v of rig.voices.values()) {
      try {
        v.source.stop(now + fade + 0.02);
      } catch {
        /* already stopped */
      }
      v.source.onended = () => {
        v.source.disconnect();
        v.gain.disconnect();
      };
    }
    setTimeout(() => rig.gain.disconnect(), (fade + 0.3) * 1000);
  }

  private startVoice(sound: EngineSound, pos: number, fade: number): void {
    const ctx = this.ctx;
    const rig = this.rig;
    const buffer = this.buffers.get(sound.id);
    if (!ctx || !rig || !buffer || !sound.enabled || rig.voices.has(sound.id)) return;

    const now = ctx.currentTime;
    const rate = this.rateFor(sound, rig.key);
    const phase = this.phases.get(sound.id) ?? startPhase(pos, rate);
    this.phases.set(sound.id, phase);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rate;
    const gain = ctx.createGain();
    source.connect(gain).connect(rig.gain);
    source.start(now, offsetAt(phase, pos, buffer.duration));

    // A sound joining a bus that is already up fades itself in; otherwise the
    // bus fade does the work.
    const busUp = rig.gain.gain.value > 0.99;
    gain.gain.setValueAtTime(busUp ? 0 : sound.gain, now);
    if (busUp) gain.gain.linearRampToValueAtTime(sound.gain, now + Math.max(CLICK_FADE, fade));
    rig.voices.set(sound.id, { source, gain });
  }

  private stopVoice(soundId: number, fade: number): void {
    const v = this.rig?.voices.get(soundId);
    if (!v || !this.ctx) return;
    this.rig!.voices.delete(soundId);
    const now = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.linearRampToValueAtTime(0, now + fade);
    try {
      v.source.stop(now + fade + 0.02);
    } catch {
      /* already stopped */
    }
    v.source.onended = () => {
      v.source.disconnect();
      v.gain.disconnect();
    };
  }

  // ------------------------------------------------------------------
  // Session timeline
  // ------------------------------------------------------------------

  currentPos(): number {
    if (this.playing() && this.ctx) {
      return this.startPos + (this.ctx.currentTime - this.startCtxTime);
    }
    return this.position();
  }

  seek(target: number): void {
    const len = this.sessionLength();
    const pos = Math.max(0, len == null ? target : Math.min(target, Math.max(0, len - 0.05)));
    const key = this.activeKey();
    if (key !== null && this.ctx) {
      this.startPos = pos;
      this.startCtxTime = this.ctx.currentTime;
      this.swapRig(key, pos, CLICK_FADE * 2);
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
    if (this.playing()) this.scheduleSessionFade();
  }

  setMasterVolume(v: number): void {
    this.masterVolume.set(v);
    if (this.ctx && this.masterGain) this.masterGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setFadeSeconds(s: number): void {
    this.fadeSeconds.set(s);
    if (this.playing()) this.scheduleSessionFade();
  }

  setKeyLock(on: boolean): void {
    this.keyLock.set(on);
    const pos = this.currentPos();
    for (const sound of this.sounds.values()) this.applyRate(sound, pos);
  }

  /** Fade the session out so it ends gracefully at the chosen length. */
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
    if (!this.playing()) {
      this.stopTicking();
      return;
    }
    const pos = this.currentPos();
    const len = this.sessionLength();
    if (len != null && pos >= len) {
      this.stop();
      this.ended.set(true);
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

  /** Debug/testing hook: what a sound is doing right now. */
  debugSound(soundId: number): { rate: number; offset: number; sounding: boolean } | null {
    const sound = this.sounds.get(soundId);
    const phase = this.phases.get(soundId);
    if (!sound || !phase) return null;
    return {
      rate: this.rateFor(sound, this.activeKey()),
      offset: offsetAt(phase, this.currentPos(), this.loopDuration(soundId)),
      sounding: !!this.rig?.voices.has(soundId),
    };
  }
}
