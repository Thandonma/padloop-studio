import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AUDIO_FILE_ACCEPT } from '../storage/audio-formats';
import { Layer, MAX_LAYERS_PER_PAD } from '../storage/models';
import { NOTE_NAMES, formatShift, formatTime, noteName, totalSemitones } from '../audio/music';
import { StudioStore } from '../state/studio.store';
import { Icon } from './icon';
import { padColor } from './pad-grid';
import { Waveform } from './waveform';


@Component({
  selector: 'app-pad-inspector',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Waveform],
  template: `
    @let pad = store.selectedPad();
    @let layers = store.selectedLayers();
    <section class="panel flex flex-col p-4 sm:p-5" aria-label="Pad layers">
      <!-- Pad picker -->
      <div class="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist" aria-label="Choose pad">
        @for (n of names; track $index) {
          <button
            role="tab"
            class="min-w-9 rounded-md px-2 py-1 text-xs font-semibold transition"
            [attr.aria-selected]="pad === $index"
            [style.background]="pad === $index ? color($index, 0.2) : 'transparent'"
            [style.color]="pad === $index ? color($index) : null"
            [class.text-ink-400]="pad !== $index"
            (click)="store.selectedPad.set($index)"
          >
            {{ n }}
            @if (store.layersByPad()[$index].length) {
              <sup class="font-mono text-[9px] opacity-70">{{ store.layersByPad()[$index].length }}</sup>
            }
          </button>
        }
      </div>

      <header class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div class="label">Pad</div>
          <h2 class="text-3xl leading-none font-bold" [style.color]="color(pad)" data-testid="inspector-title">
            {{ names[pad] }}
          </h2>
        </div>
        <div class="text-right text-xs text-ink-400">
          {{ layers.length }} / {{ max }} layers
          <div class="mt-0.5">
            @if (engine.keyLock()) {
              All layers tuned to <span class="font-semibold text-ink-100">{{ names[pad] }}</span>
            } @else {
              Key lock off: layers play at their original pitch
            }
          </div>
        </div>
      </header>

      <!-- Drop zone -->
      <label
        class="mt-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition"
        [class.opacity-50]="layers.length >= max"
        [style.border-color]="dropping() ? color(pad) : 'rgb(255 255 255 / 0.15)'"
        [style.background]="dropping() ? color(pad, 0.08) : 'transparent'"
        (dragover)="$event.preventDefault(); dropping.set(true)"
        (dragleave)="dropping.set(false)"
        (drop)="onDrop($event)"
      >
        <app-icon name="upload" [size]="22" />
        <span class="text-sm font-medium">Drop audio files here or <span class="underline decoration-dotted underline-offset-2">browse</span></span>
        <span class="text-xs text-ink-400">Each file becomes a layer on {{ names[pad] }}. Key is read from the file name, or detected from the audio.</span>
        <input
          type="file"
          [attr.accept]="accept"
          multiple
          class="sr-only"
          [disabled]="layers.length >= max"
          (change)="onPick($event)"
          data-testid="file-input"
        />
      </label>

      <!-- Uploads in flight -->
      @for (job of uploadsHere(); track job.id) {
        <div class="mt-3 rounded-lg border border-white/5 bg-ink-850 px-3 py-2 text-xs" role="status">
          <div class="flex justify-between gap-2">
            <span class="truncate">{{ job.fileName }}</span>
            <span [class.text-danger]="job.stage === 'error'" class="shrink-0 text-ink-400">
              @switch (job.stage) {
                @case ('analysing') { Detecting key… }
                @case ('saving') { Saving… }
                @case ('error') { {{ job.error }} }
              }
            </span>
          </div>
          @if (job.stage !== 'error') {
            <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
              <div class="h-full bg-glow transition-[width]" [style.width.%]="job.stage === 'analysing' ? 35 : 85"></div>
            </div>
          }
        </div>
      }

      <!-- Layers -->
      <ol class="mt-4 flex flex-col gap-3" data-testid="layer-list">
        @for (layer of layers; track layer.id; let i = $index) {
          @let shift = shiftFor(layer);
          <li class="rounded-xl border border-white/[0.06] bg-ink-850/80 p-3" [class.opacity-55]="!layer.enabled" [attr.data-testid]="'layer-' + layer.id">
            <div class="flex items-center gap-3">
              <div class="h-10 w-20 shrink-0 rounded-md bg-ink-900 px-1 text-ink-400">
                <app-waveform [peaks]="engine.peaks().get(layer.id)" [color]="color(pad, layer.enabled ? 0.9 : 0.3)" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium" [title]="layer.originalName">
                  <span class="mr-1 font-mono text-[10px] text-ink-400">L{{ i + 1 }}</span>{{ layer.originalName }}
                </div>
                <div class="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-400">
                  <span>{{ fmt(layer.durationSeconds) }}</span>
                  <span>{{ (layer.sampleRate / 1000).toFixed(1) }} kHz</span>
                  <span>{{ layer.bitsPerSample ? layer.bitsPerSample + '-bit ' : '' }}{{ layer.channels === 1 ? 'mono' : layer.channels === 2 ? 'stereo' : layer.channels + 'ch' }}</span>
                  @if (layer.detectedKey) {
                    <span title="Detected from the audio">≈ {{ layer.detectedKey }}</span>
                  }
                  @if (engine.loading().has(layer.id)) {
                    <span class="text-amber-300">loading…</span>
                  }
                </div>
              </div>
              <button
                class="btn-icon size-8"
                (click)="store.updateLayer(layer.id, { enabled: !layer.enabled })"
                [attr.aria-label]="layer.enabled ? 'Mute layer' : 'Unmute layer'"
                [attr.aria-pressed]="!layer.enabled"
                [title]="layer.enabled ? 'Mute' : 'Unmute'"
              >
                <app-icon [name]="layer.enabled ? 'speaker' : 'mute'" [size]="16" />
              </button>
              <button
                class="btn-icon size-8 hover:bg-danger/20 hover:text-danger"
                (click)="confirmDelete(layer)"
                aria-label="Delete layer"
                title="Delete layer"
              >
                <app-icon name="trash" [size]="16" />
              </button>
            </div>

            <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <label class="flex flex-col gap-1">
                <span class="label">Recorded in</span>
                <select
                  class="field py-1"
                  (change)="setRoot(layer, $any($event.target).value)"
                  [attr.data-testid]="'root-' + layer.id"
                >
                  <option value="" [selected]="layer.rootNote == null">Unknown</option>
                  @for (n of names; track $index) {
                    <option [value]="$index" [selected]="layer.rootNote === $index">{{ n }}</option>
                  }
                </select>
              </label>

              <div class="flex flex-col gap-1">
                <span class="label">Shift</span>
                <div class="flex h-[30px] items-center font-mono text-sm" [attr.data-testid]="'shift-' + layer.id">
                  @if (engine.keyLock() && layer.rootNote != null) {
                    <span class="text-ink-400">{{ note(layer.rootNote) }}→{{ names[pad] }}</span>
                    <span class="ml-1.5">{{ formatShift(shift) }}</span>
                  } @else {
                    <span>{{ formatShift(shift) }}</span>
                  }
                </div>
              </div>

              <div class="flex flex-col gap-1">
                <span class="label">Octave</span>
                <div class="flex items-center gap-1">
                  <button class="btn px-2 py-0.5" [disabled]="layer.octave <= -2" (click)="store.updateLayer(layer.id, { octave: layer.octave - 1 })" aria-label="Octave down">−</button>
                  <span class="w-8 text-center font-mono text-sm">{{ layer.octave > 0 ? '+' : '' }}{{ layer.octave }}</span>
                  <button class="btn px-2 py-0.5" [disabled]="layer.octave >= 2" (click)="store.updateLayer(layer.id, { octave: layer.octave + 1 })" aria-label="Octave up">+</button>
                </div>
              </div>

              <label class="flex flex-col gap-1">
                <span class="label flex justify-between">Fine <span class="font-mono normal-case">{{ layer.fineTuneCents }}¢</span></span>
                <input
                  type="range" min="-100" max="100" step="1"
                  [value]="layer.fineTuneCents"
                  [style.--fill]="(layer.fineTuneCents + 100) / 2 + '%'"
                  (input)="store.updateLayer(layer.id, { fineTuneCents: +$any($event.target).value })"
                  (dblclick)="store.updateLayer(layer.id, { fineTuneCents: 0 })"
                />
              </label>

              <label class="col-span-2 flex flex-col gap-1 sm:col-span-4">
                <span class="label flex justify-between">Volume <span class="font-mono normal-case">{{ db(layer.gain) }}</span></span>
                <input
                  type="range" min="0" max="2" step="0.01"
                  [value]="layer.gain"
                  [style.--fill]="layer.gain * 50 + '%'"
                  (input)="store.updateLayer(layer.id, { gain: +$any($event.target).value })"
                  (dblclick)="store.updateLayer(layer.id, { gain: 0.8 })"
                />
              </label>
            </div>
          </li>
        } @empty {
          <li class="rounded-xl border border-white/5 px-4 py-8 text-center text-sm text-ink-400">
            No samples on {{ names[pad] }} yet. Add one or more audio files to layer them.
          </li>
        }
      </ol>
    </section>
  `,
})
export class PadInspector {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly names = NOTE_NAMES;
  protected readonly max = MAX_LAYERS_PER_PAD;
  protected readonly color = padColor;
  protected readonly fmt = formatTime;
  protected readonly note = noteName;
  protected readonly formatShift = formatShift;
  protected readonly dropping = signal(false);
  protected readonly accept = AUDIO_FILE_ACCEPT;

  protected readonly uploadsHere = computed(() =>
    this.store.uploads().filter((u) => u.padIndex === this.store.selectedPad()),
  );

  protected shiftFor(layer: Layer): number {
    return totalSemitones(layer, this.engine.keyLock());
  }

  protected db(gain: number): string {
    if (gain <= 0.001) return '−∞ dB';
    const v = 20 * Math.log10(gain);
    return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  }

  protected setRoot(layer: Layer, value: string): void {
    if (value === '') this.store.updateLayer(layer.id, { clearRootNote: true, rootNote: null });
    else this.store.updateLayer(layer.id, { rootNote: Number(value) });
  }

  protected confirmDelete(layer: Layer): void {
    if (confirm(`Remove “${layer.originalName}” from pad ${NOTE_NAMES[layer.padIndex]}?`)) {
      void this.store.deleteLayer(layer.id);
    }
  }

  protected onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) void this.store.addFiles(this.store.selectedPad(), files);
  }

  protected onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.dropping.set(false);
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (files.length) void this.store.addFiles(this.store.selectedPad(), files);
  }
}
