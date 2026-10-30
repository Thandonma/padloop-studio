import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { NOTE_NAMES, formatShift, formatTime, noteName, totalSemitones } from '../audio/music';
import { StudioStore } from '../state/studio.store';
import { AUDIO_FILE_ACCEPT } from '../storage/audio-formats';
import { Sound } from '../storage/models';
import { Icon } from './icon';
import { keyColor } from './keyboard';
import { Waveform } from './waveform';

@Component({
  selector: 'app-sound-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Waveform],
  template: `
    @let sounds = store.sounds();
    @let key = engine.activeKey();
    <section class="panel p-3 sm:p-5" aria-label="Sounds">
      <header class="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 class="text-sm font-semibold tracking-wide text-ink-300">Sounds</h2>
        <p class="text-xs text-ink-400">
          {{ sounds.length }} / {{ store.maxSounds }} · they all play together, in the key you press
        </p>
      </header>

      <!-- Add sounds -->
      <div class="flex flex-wrap gap-2">
        @for (pad of store.starterPads; track pad.id) {
          @let added = store.loadedStarterIds().has(pad.id);
          <button
            class="btn"
            [style.border-color]="added ? 'rgb(124 242 212 / 0.5)' : null"
            [disabled]="added || store.isFull() || !store.kit() || busyWith() === pad.id"
            [title]="pad.description"
            (click)="addStarter(pad)"
            [attr.data-testid]="'starter-' + pad.id"
          >
            <app-icon [name]="added ? 'check' : 'plus'" [size]="15" />
            {{ pad.name }}
          </button>
        }
        <label class="btn" [class.opacity-40]="store.isFull() || !store.kit()" title="Add your own audio file">
          <app-icon name="upload" [size]="15" /> Your audio
          <input
            type="file"
            [attr.accept]="accept"
            multiple
            class="sr-only"
            [disabled]="store.isFull() || !store.kit()"
            (change)="onPick($event)"
            data-testid="file-input"
          />
        </label>
      </div>

      <!-- Loading -->
      @for (job of store.jobs(); track job.id) {
        <div class="mt-3 rounded-lg border border-white/5 bg-ink-850 px-3 py-2 text-xs" role="status">
          <div class="flex justify-between gap-2">
            <span class="truncate">{{ job.name }}</span>
            <span [class.text-danger]="job.stage === 'error'" class="shrink-0 text-ink-400">
              @switch (job.stage) {
                @case ('reading') { Reading… }
                @case ('saving') { Saving… }
                @case ('error') { {{ job.error }} }
              }
            </span>
          </div>
          @if (job.stage !== 'error') {
            <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-700">
              <div class="h-full animate-pulse rounded-full bg-glow" [style.width.%]="job.stage === 'reading' ? 40 : 85"></div>
            </div>
          }
        </div>
      }

      <!-- The sounds themselves -->
      <ol class="mt-3 flex flex-col gap-2" data-testid="sound-list">
        @for (sound of sounds; track sound.id; let i = $index) {
          <li
            class="rounded-xl border border-white/[0.06] bg-ink-850/80 p-3"
            [class.opacity-55]="!sound.enabled"
            [attr.data-testid]="'sound-' + sound.id"
          >
            <div class="flex items-center gap-3">
              <div class="h-9 w-16 shrink-0 rounded-md bg-ink-900 px-1 text-ink-400 sm:w-20">
                <app-waveform [peaks]="engine.peaks().get(sound.id)" [color]="waveColor(key, sound.enabled)" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ sound.name }}</div>
                <div class="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-400">
                  <span>{{ fmt(sound.durationSeconds) }}</span>
                  @if (key !== null && engine.keyLock() && sound.rootNote !== null) {
                    <span [attr.data-testid]="'shift-' + sound.id">
                      {{ note(sound.rootNote) }}→{{ names[key] }} {{ shift(sound, key) }}
                    </span>
                  } @else if (sound.rootNote !== null) {
                    <span [attr.data-testid]="'shift-' + sound.id">recorded in {{ note(sound.rootNote) }}</span>
                  }
                  @if (engine.loading().has(sound.id)) {
                    <span class="text-amber-300">loading…</span>
                  }
                </div>
              </div>
              <button
                class="btn-icon size-8"
                (click)="store.updateSound(sound.id, { enabled: !sound.enabled })"
                [attr.aria-label]="sound.enabled ? 'Mute ' + sound.name : 'Unmute ' + sound.name"
                [attr.aria-pressed]="!sound.enabled"
                [attr.data-testid]="'mute-' + sound.id"
              >
                <app-icon [name]="sound.enabled ? 'speaker' : 'mute'" [size]="16" />
              </button>
              <button
                class="btn-icon size-8 hover:bg-danger/20 hover:text-danger"
                (click)="confirmDelete(sound)"
                [attr.aria-label]="'Remove ' + sound.name"
                [attr.data-testid]="'delete-' + sound.id"
              >
                <app-icon name="trash" [size]="16" />
              </button>
            </div>

            <label class="mt-2.5 flex items-center gap-3">
              <span class="label w-12 shrink-0">Volume</span>
              <input
                type="range" min="0" max="2" step="0.01"
                class="flex-1"
                [value]="sound.gain"
                [style.--fill]="sound.gain * 50 + '%'"
                (input)="store.updateSound(sound.id, { gain: +$any($event.target).value })"
                (dblclick)="store.updateSound(sound.id, { gain: 0.8 })"
                [attr.aria-label]="'Volume for ' + sound.name"
              />
              <span class="w-14 shrink-0 text-right font-mono text-[11px] text-ink-400">{{ db(sound.gain) }}</span>
            </label>

            @if (store.advanced()) {
              <div class="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/5 pt-3 sm:grid-cols-3">
                <label class="flex flex-col gap-1">
                  <span class="label">Recorded in</span>
                  <select
                    class="field py-1"
                    (change)="setRoot(sound, $any($event.target).value)"
                    [attr.data-testid]="'root-' + sound.id"
                  >
                    <option value="" [selected]="sound.rootNote == null">Unknown</option>
                    @for (n of names; track $index) {
                      <option [value]="$index" [selected]="sound.rootNote === $index">{{ n }}</option>
                    }
                  </select>
                </label>

                <div class="flex flex-col gap-1">
                  <span class="label">Octave</span>
                  <div class="flex items-center gap-1">
                    <button class="btn px-2 py-0.5" [disabled]="sound.octave <= -2" (click)="store.updateSound(sound.id, { octave: sound.octave - 1 })" aria-label="Octave down">−</button>
                    <span class="w-8 text-center font-mono text-sm">{{ sound.octave > 0 ? '+' : '' }}{{ sound.octave }}</span>
                    <button class="btn px-2 py-0.5" [disabled]="sound.octave >= 2" (click)="store.updateSound(sound.id, { octave: sound.octave + 1 })" aria-label="Octave up">+</button>
                  </div>
                </div>

                <label class="flex flex-col gap-1">
                  <span class="label flex justify-between">Fine <span class="font-mono normal-case">{{ sound.fineTuneCents }}¢</span></span>
                  <input
                    type="range" min="-100" max="100" step="1"
                    [value]="sound.fineTuneCents"
                    [style.--fill]="(sound.fineTuneCents + 100) / 2 + '%'"
                    (input)="store.updateSound(sound.id, { fineTuneCents: +$any($event.target).value })"
                    (dblclick)="store.updateSound(sound.id, { fineTuneCents: 0 })"
                    [attr.aria-label]="'Fine tune ' + sound.name"
                  />
                </label>
              </div>
            }
          </li>
        } @empty {
          @if (!store.jobs().length) {
            <li class="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-ink-400">
              No sounds yet. Add one of the pads above to hear how it works, or load your own audio file.
            </li>
          }
        }
      </ol>
    </section>
  `,
})
export class SoundList {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly names = NOTE_NAMES;
  protected readonly fmt = formatTime;
  protected readonly note = noteName;
  protected readonly busyWith = signal<string | null>(null);
  protected readonly accept = AUDIO_FILE_ACCEPT;

  protected waveColor(key: number | null, enabled: boolean): string {
    return keyColor(key ?? 0, enabled ? 0.9 : 0.3);
  }

  protected shift(sound: Sound, key: number): string {
    return formatShift(totalSemitones({ ...sound, padIndex: key }, this.engine.keyLock()));
  }

  protected db(gain: number): string {
    if (gain <= 0.001) return '−∞ dB';
    const v = 20 * Math.log10(gain);
    return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  }

  protected setRoot(sound: Sound, value: string): void {
    if (value === '') this.store.updateSound(sound.id, { clearRootNote: true, rootNote: null });
    else this.store.updateSound(sound.id, { rootNote: Number(value) });
  }

  protected async addStarter(pad: { id: string }): Promise<void> {
    this.busyWith.set(pad.id);
    try {
      await this.store.addStarterPad(this.store.starterPads.find((p) => p.id === pad.id)!);
    } finally {
      this.busyWith.set(null);
    }
  }

  protected confirmDelete(sound: Sound): void {
    if (confirm(`Remove “${sound.name}” from this kit?`)) void this.store.deleteSound(sound.id);
  }

  protected onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) void this.store.addFiles(files);
  }
}
