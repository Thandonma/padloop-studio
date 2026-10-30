import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { AudioEngineService } from '../audio/audio-engine.service';
import { detectKey } from '../audio/key-detect';
import { guessKeyFromFilename } from '../audio/music';
import { infoFromBuffer, isSupportedAudioFile } from '../storage/audio-formats';
import { safeFileName } from '../storage/kit-file';
import { LibraryService } from '../storage/library.service';
import { KitDetail, KitPatch, KitSummary, MAX_SOUNDS_PER_KIT, Sound, SoundPatch } from '../storage/models';
import { STARTER_PADS, StarterPad, fetchStarterPad } from '../storage/starter-pads';

export interface LoadJob {
  id: string;
  name: string;
  stage: 'reading' | 'saving' | 'error';
  error?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

const LAST_KIT_KEY = 'padloop.lastKit';
const ADVANCED_KEY = 'padloop.advanced';

/** Application state: the open kit and its sounds, wired to storage and audio. */
@Injectable({ providedIn: 'root' })
export class StudioStore {
  private readonly library = inject(LibraryService);
  readonly engine = inject(AudioEngineService);

  readonly kits = signal<KitSummary[]>([]);
  readonly kit = signal<KitDetail | null>(null);
  readonly sounds = signal<Sound[]>([]);
  readonly jobs = signal<LoadJob[]>([]);
  readonly toasts = signal<Toast[]>([]);
  readonly loadingKit = signal(false);
  readonly storageError = signal<string | null>(null);
  readonly persistent = this.library.persistent;
  readonly busy = signal(false);
  /** Shows the extra tuning and mixing controls. */
  readonly advanced = signal(safeGet(ADVANCED_KEY) === '1');

  readonly starterPads = STARTER_PADS;
  readonly maxSounds = MAX_SOUNDS_PER_KIT;
  readonly hasSounds = computed(() => this.sounds().length > 0);
  readonly isFull = computed(() => this.sounds().length >= MAX_SOUNDS_PER_KIT);
  readonly loadedStarterIds = computed(
    () => new Set(this.sounds().map((s) => s.starterId).filter((id): id is string => !!id)),
  );

  private toastSeq = 0;
  private kitSaveTimer?: ReturnType<typeof setTimeout>;
  private pendingKitPatch: KitPatch = {};
  private soundSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingSoundPatches = new Map<number, SoundPatch>();

  constructor() {
    this.engine.setAudioLoader((id) => this.library.getAudio(id));
    effect(() => {
      const sounds = this.sounds();
      untracked(() => this.engine.setSounds(sounds));
    });
    effect(() => safeSet(ADVANCED_KEY, this.advanced() ? '1' : '0'));
    addEventListener('pagehide', () => this.flushSaves());
  }

  toggleAdvanced(): void {
    this.advanced.update((v) => !v);
  }

  // ------------------------------------------------------------------
  // Kits
  // ------------------------------------------------------------------

  async init(): Promise<void> {
    try {
      await this.library.init();
      await this.refreshKits();
      this.storageError.set(null);
      let target = this.kits()[0]?.id;
      const remembered = Number(safeGet(LAST_KIT_KEY));
      if (remembered && this.kits().some((k) => k.id === remembered)) target = remembered;
      if (target == null) {
        const created = await this.library.createKit('My kit');
        await this.refreshKits();
        target = created.id;
      }
      await this.openKit(target);
    } catch (err) {
      this.storageError.set(message(err));
    }
  }

  async refreshKits(): Promise<void> {
    this.kits.set(await this.library.listKits());
  }

  async openKit(id: number): Promise<void> {
    if (this.kit()?.id === id) return;
    this.flushSaves();
    this.loadingKit.set(true);
    try {
      const kit = await this.library.getKit(id);
      this.engine.forgetAll();
      this.applyKitSettings(kit);
      this.kit.set(kit);
      this.sounds.set(kit.sounds);
      safeSet(LAST_KIT_KEY, String(id));
    } catch (err) {
      this.error(err);
    } finally {
      this.loadingKit.set(false);
    }
  }

  async createKit(name: string): Promise<void> {
    try {
      const kit = await this.library.createKit(name);
      await this.refreshKits();
      await this.openKit(kit.id);
      this.info(`Created “${kit.name}”`);
    } catch (err) {
      this.error(err);
    }
  }

  async deleteKit(): Promise<void> {
    const kit = this.kit();
    if (!kit) return;
    try {
      this.clearPendingSaves();
      await this.library.deleteKit(kit.id);
      this.kit.set(null);
      this.sounds.set([]);
      this.engine.forgetAll();
      await this.refreshKits();
      const next = this.kits()[0];
      if (next) await this.openKit(next.id);
      else await this.createKit('My kit');
      this.info(`Deleted “${kit.name}”`);
    } catch (err) {
      this.error(err);
    }
  }

  async exportKit(): Promise<void> {
    const kit = this.kit();
    if (!kit) return;
    this.busy.set(true);
    try {
      this.flushSaves();
      const blob = await this.library.exportKit(kit.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = safeFileName(kit.name);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      this.info(`Exported “${kit.name}” (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      this.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  async importKit(file: File): Promise<void> {
    this.busy.set(true);
    try {
      const kit = await this.library.importKit(file);
      await this.refreshKits();
      await this.openKit(kit.id);
      this.info(`Imported “${kit.name}” with ${kit.sounds.length} sounds`);
    } catch (err) {
      this.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  renameKit(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.patchKit({ name: trimmed });
    this.kits.update((ks) => ks.map((k) => (k.id === this.kit()?.id ? { ...k, name: trimmed } : k)));
  }

  setSessionMinutes(minutes: number): void {
    const m = Math.max(0, Math.min(720, Math.round(minutes)));
    this.engine.setSessionLength(m === 0 ? null : m * 60);
    this.patchKit({ sessionMinutes: m });
  }

  setMasterVolume(v: number): void {
    this.engine.setMasterVolume(v);
    this.patchKit({ masterVolume: v });
  }

  setFadeSeconds(s: number): void {
    this.engine.setFadeSeconds(s);
    this.patchKit({ fadeSeconds: s });
  }

  setKeyLock(on: boolean): void {
    this.engine.setKeyLock(on);
    this.patchKit({ keyLock: on });
  }

  private applyKitSettings(kit: KitDetail): void {
    this.engine.setSessionLength(kit.sessionMinutes === 0 ? null : kit.sessionMinutes * 60);
    this.engine.setMasterVolume(kit.masterVolume);
    this.engine.setFadeSeconds(kit.fadeSeconds);
    this.engine.setKeyLock(kit.keyLock);
  }

  private patchKit(patch: KitPatch): void {
    const kit = this.kit();
    if (!kit) return;
    this.kit.set({ ...kit, ...patch });
    this.pendingKitPatch = { ...this.pendingKitPatch, ...patch };
    clearTimeout(this.kitSaveTimer);
    this.kitSaveTimer = setTimeout(() => {
      this.kitSaveTimer = undefined;
      void this.saveKit(kit.id);
    }, 400);
  }

  private async saveKit(id: number): Promise<void> {
    const patch = this.pendingKitPatch;
    this.pendingKitPatch = {};
    if (!Object.keys(patch).length) return;
    try {
      await this.library.updateKit(id, patch);
    } catch (err) {
      this.error(err);
    }
  }

  private flushSaves(): void {
    const kit = this.kit();
    if (kit && this.kitSaveTimer) {
      clearTimeout(this.kitSaveTimer);
      this.kitSaveTimer = undefined;
      void this.saveKit(kit.id);
    }
    for (const [id, t] of this.soundSaveTimers) {
      clearTimeout(t);
      void this.saveSound(id);
    }
    this.soundSaveTimers.clear();
  }

  private clearPendingSaves(): void {
    clearTimeout(this.kitSaveTimer);
    this.kitSaveTimer = undefined;
    this.pendingKitPatch = {};
    for (const t of this.soundSaveTimers.values()) clearTimeout(t);
    this.soundSaveTimers.clear();
    this.pendingSoundPatches.clear();
  }

  // ------------------------------------------------------------------
  // Sounds
  // ------------------------------------------------------------------

  /** Adds one of the pads that ship with the app. */
  async addStarterPad(pad: StarterPad): Promise<void> {
    const kit = this.kit();
    if (!kit || this.isFull()) {
      if (this.isFull()) this.error(`A kit holds up to ${MAX_SOUNDS_PER_KIT} sounds. Remove one first.`);
      return;
    }
    const job = this.startJob(pad.name);
    try {
      const file = await fetchStarterPad(pad);
      job.set({ stage: 'saving' });
      const sound = await this.library.addSound(kit.id, file, {
        rootNote: pad.rootNote,
        detectedKey: pad.detectedKey,
        starterId: pad.id,
        name: pad.name,
      });
      this.attach(kit.id, sound);
      job.done();
      this.info(`Added ${pad.name}. Press any key to play it.`);
    } catch (err) {
      job.fail(message(err));
    }
  }

  async addFiles(files: File[]): Promise<void> {
    const kit = this.kit();
    if (!kit) return;
    for (const file of files) {
      if (this.isFull()) {
        this.error(`A kit holds up to ${MAX_SOUNDS_PER_KIT} sounds. Remove one first.`);
        return;
      }
      if (!isSupportedAudioFile(file.name)) {
        this.error(`${file.name}: that file type isn't supported`);
        continue;
      }
      await this.addFile(kit.id, file);
    }
  }

  private async addFile(kitId: number, file: File): Promise<void> {
    const job = this.startJob(file.name);
    let buffer: AudioBuffer;
    let rootNote = guessKeyFromFilename(file.name);
    let detectedKey: string | null = null;
    try {
      // decodeAudioData detaches the buffer it is given, so hand it a copy.
      buffer = await this.engine.decode((await file.arrayBuffer()).slice(0));
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
      const est = detectKey(channels, buffer.sampleRate);
      detectedKey = est.label;
      rootNote ??= est.tonic;
    } catch {
      job.fail('your browser could not decode this audio file');
      return;
    }
    job.set({ stage: 'saving' });
    try {
      // The decode above already tells us the sample rate, channels and length,
      // which is the only way to know them for compressed formats.
      const sound = await this.library.addSound(kitId, file, {
        rootNote,
        detectedKey,
        info: infoFromBuffer(buffer),
      });
      this.engine.prime(sound.id, buffer);
      this.attach(kitId, sound);
      job.done();
      this.info(`Added ${sound.name}. It plays in whichever key you press.`);
    } catch (err) {
      job.fail(message(err));
    }
  }

  private attach(kitId: number, sound: Sound): void {
    if (this.kit()?.id !== kitId) return;
    this.sounds.update((ss) => [...ss, sound]);
    this.kits.update((ks) => ks.map((k) => (k.id === kitId ? { ...k, soundCount: k.soundCount + 1 } : k)));
  }

  updateSound(id: number, patch: SoundPatch): void {
    this.sounds.update((ss) =>
      ss.map((s) => {
        if (s.id !== id) return s;
        const { clearRootNote, ...fields } = patch;
        const next: Sound = { ...s, ...fields };
        if (clearRootNote) next.rootNote = null;
        return next;
      }),
    );
    this.pendingSoundPatches.set(id, { ...(this.pendingSoundPatches.get(id) ?? {}), ...patch });
    clearTimeout(this.soundSaveTimers.get(id));
    this.soundSaveTimers.set(
      id,
      setTimeout(() => {
        this.soundSaveTimers.delete(id);
        void this.saveSound(id);
      }, 350),
    );
  }

  private async saveSound(id: number): Promise<void> {
    const patch = this.pendingSoundPatches.get(id);
    this.pendingSoundPatches.delete(id);
    if (!patch) return;
    try {
      await this.library.updateSound(id, patch);
    } catch (err) {
      this.error(err);
    }
  }

  async deleteSound(id: number): Promise<void> {
    const sound = this.sounds().find((s) => s.id === id);
    if (!sound) return;
    clearTimeout(this.soundSaveTimers.get(id));
    this.soundSaveTimers.delete(id);
    this.pendingSoundPatches.delete(id);
    this.sounds.update((ss) => ss.filter((s) => s.id !== id));
    try {
      await this.library.deleteSound(id);
      this.kits.update((ks) => ks.map((k) => (k.id === sound.kitId ? { ...k, soundCount: k.soundCount - 1 } : k)));
    } catch (err) {
      this.sounds.update((ss) => [...ss, sound].sort((a, b) => a.position - b.position));
      this.error(err);
    }
  }

  // ------------------------------------------------------------------
  // Jobs and messages
  // ------------------------------------------------------------------

  private startJob(name: string) {
    const job: LoadJob = { id: `${Date.now()}-${Math.random()}`, name, stage: 'reading' };
    this.jobs.update((j) => [...j, job]);
    const update = (patch: Partial<LoadJob>) =>
      this.jobs.update((j) => j.map((x) => (x.id === job.id ? { ...x, ...patch } : x)));
    const drop = () => this.jobs.update((j) => j.filter((x) => x.id !== job.id));
    return {
      set: update,
      done: drop,
      fail: (msg: string) => {
        update({ stage: 'error', error: msg });
        this.error(`${name}: ${msg}`);
        setTimeout(drop, 6000);
      },
    };
  }

  info(text: string): void {
    this.toast('info', text);
  }

  error(err: unknown): void {
    this.toast('error', message(err));
  }

  dismissToast(id: number): void {
    this.toasts.update((t) => t.filter((x) => x.id !== id));
  }

  private toast(kind: Toast['kind'], text: string): void {
    const id = ++this.toastSeq;
    this.toasts.update((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => this.dismissToast(id), kind === 'error' ? 7000 : 3500);
  }
}

function message(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    if (/quota/i.test(err.message) || err.name === 'QuotaExceededError') {
      return 'Your browser is out of storage space for PadLoop. Export and delete a kit to free some up.';
    }
    return err.message;
  }
  return 'Something went wrong';
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
