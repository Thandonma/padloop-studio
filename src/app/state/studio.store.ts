import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { AudioEngineService } from '../audio/audio-engine.service';
import { detectKey } from '../audio/key-detect';
import { guessKeyFromFilename, noteName } from '../audio/music';
import { isSupportedAudioFile } from '../storage/audio-formats';
import { safeFileName } from '../storage/kit-file';
import { LibraryService } from '../storage/library.service';
import { KitDetail, KitPatch, KitSummary, Layer, LayerPatch } from '../storage/models';

export interface UploadJob {
  id: string;
  padIndex: number;
  fileName: string;
  stage: 'analysing' | 'saving' | 'error';
  error?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

const LAST_KIT_KEY = 'padloop.lastKit';

/** Application state: the open kit and its layers, wired to storage and the audio engine. */
@Injectable({ providedIn: 'root' })
export class StudioStore {
  private readonly library = inject(LibraryService);
  readonly engine = inject(AudioEngineService);

  readonly kits = signal<KitSummary[]>([]);
  readonly kit = signal<KitDetail | null>(null);
  readonly layers = signal<Layer[]>([]);
  readonly selectedPad = signal(0);
  readonly uploads = signal<UploadJob[]>([]);
  readonly toasts = signal<Toast[]>([]);
  readonly loadingKit = signal(false);
  readonly storageError = signal<string | null>(null);
  readonly persistent = this.library.persistent;
  readonly busy = signal(false);
  /** 'latch': tap to sustain / tap again to release. 'hold': sound only while held. */
  readonly padMode = signal<'latch' | 'hold'>('latch');

  readonly layersByPad = computed(() => {
    const byPad: Layer[][] = Array.from({ length: 12 }, () => []);
    for (const l of this.layers()) byPad[l.padIndex]?.push(l);
    return byPad;
  });

  readonly selectedLayers = computed(() => this.layersByPad()[this.selectedPad()] ?? []);

  private toastSeq = 0;
  private kitSaveTimer?: ReturnType<typeof setTimeout>;
  private pendingKitPatch: KitPatch = {};
  private layerSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private pendingLayerPatches = new Map<number, LayerPatch>();

  constructor() {
    this.engine.setAudioLoader((id) => this.library.getAudio(id));
    // Keep the engine's view of the layers in sync with the store.
    effect(() => {
      const layers = this.layers();
      untracked(() => this.engine.setLayers(layers));
    });
    // Save pending edits if the tab is closed.
    addEventListener('pagehide', () => this.flushSaves());
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
        const created = await this.library.createKit('My first kit');
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
      this.layers.set(kit.layers);
      this.selectedPad.set(kit.layers[0]?.padIndex ?? 0);
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
      this.layers.set([]);
      this.engine.forgetAll();
      await this.refreshKits();
      const next = this.kits()[0];
      if (next) await this.openKit(next.id);
      else await this.createKit('My first kit');
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
      this.info(`Imported “${kit.name}” with ${kit.layers.length} layers`);
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

  /** Optimistic local update + debounced save. */
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
    for (const [id, t] of this.layerSaveTimers) {
      clearTimeout(t);
      void this.saveLayer(id);
    }
    this.layerSaveTimers.clear();
  }

  private clearPendingSaves(): void {
    clearTimeout(this.kitSaveTimer);
    this.kitSaveTimer = undefined;
    this.pendingKitPatch = {};
    for (const t of this.layerSaveTimers.values()) clearTimeout(t);
    this.layerSaveTimers.clear();
    this.pendingLayerPatches.clear();
  }

  // ------------------------------------------------------------------
  // Layers
  // ------------------------------------------------------------------

  async addFiles(padIndex: number, files: File[]): Promise<void> {
    const kit = this.kit();
    if (!kit) return;
    for (const file of files) {
      if (!isSupportedAudioFile(file.name)) {
        this.error(`${file.name}: unsupported audio format`);
        continue;
      }
      await this.addFile(kit.id, padIndex, file);
    }
  }

  private async addFile(kitId: number, padIndex: number, file: File): Promise<void> {
    const job: UploadJob = { id: `${Date.now()}-${Math.random()}`, padIndex, fileName: file.name, stage: 'analysing' };
    this.uploads.update((u) => [...u, job]);
    const setJob = (patch: Partial<UploadJob>) =>
      this.uploads.update((u) => u.map((j) => (j.id === job.id ? { ...j, ...patch } : j)));
    const fail = (msg: string) => {
      setJob({ stage: 'error', error: msg });
      this.error(`${file.name}: ${msg}`);
      setTimeout(() => this.uploads.update((u) => u.filter((j) => j.id !== job.id)), 6000);
    };

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
      fail('your browser could not decode this audio file');
      return;
    }

    setJob({ stage: 'saving' });
    try {
      const layer = await this.library.addLayer(kitId, padIndex, file, buffer, { rootNote, detectedKey });
      if (this.kit()?.id === kitId) {
        this.engine.prime(layer.id, buffer);
        this.layers.update((ls) => [...ls, layer]);
        this.kits.update((ks) => ks.map((k) => (k.id === kitId ? { ...k, layerCount: k.layerCount + 1 } : k)));
      }
      this.uploads.update((u) => u.filter((j) => j.id !== job.id));
      this.info(`${file.name} → pad ${noteName(padIndex)} (recorded in ${noteName(layer.rootNote)})`);
    } catch (err) {
      fail(message(err));
    }
  }

  updateLayer(id: number, patch: LayerPatch): void {
    this.layers.update((ls) =>
      ls.map((l) => {
        if (l.id !== id) return l;
        const { clearRootNote, ...fields } = patch;
        const next: Layer = { ...l, ...fields };
        if (clearRootNote) next.rootNote = null;
        return next;
      }),
    );
    this.pendingLayerPatches.set(id, { ...(this.pendingLayerPatches.get(id) ?? {}), ...patch });
    clearTimeout(this.layerSaveTimers.get(id));
    this.layerSaveTimers.set(
      id,
      setTimeout(() => {
        this.layerSaveTimers.delete(id);
        void this.saveLayer(id);
      }, 350),
    );
  }

  private async saveLayer(id: number): Promise<void> {
    const patch = this.pendingLayerPatches.get(id);
    this.pendingLayerPatches.delete(id);
    if (!patch) return;
    try {
      await this.library.updateLayer(id, patch);
    } catch (err) {
      this.error(err);
    }
  }

  async deleteLayer(id: number): Promise<void> {
    const layer = this.layers().find((l) => l.id === id);
    if (!layer) return;
    clearTimeout(this.layerSaveTimers.get(id));
    this.layerSaveTimers.delete(id);
    this.pendingLayerPatches.delete(id);
    this.layers.update((ls) => ls.filter((l) => l.id !== id));
    try {
      await this.library.deleteLayer(id);
      this.kits.update((ks) => ks.map((k) => (k.id === layer.kitId ? { ...k, layerCount: k.layerCount - 1 } : k)));
    } catch (err) {
      this.layers.update((ls) => [...ls, layer].sort((a, b) => a.padIndex - b.padIndex || a.position - b.position));
      this.error(err);
    }
  }

  // ------------------------------------------------------------------
  // Messages
  // ------------------------------------------------------------------

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
