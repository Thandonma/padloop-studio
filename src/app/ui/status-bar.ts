import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { NOTE_NAMES, formatTime } from '../audio/music';
import { StudioStore } from '../state/studio.store';
import { Icon } from './icon';
import { keyColor } from './keyboard';

const PRESETS = [5, 10, 15, 20, 30, 45, 60, 90, 120];

@Component({
  selector: 'app-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    @let key = engine.activeKey();
    <section class="panel p-3 sm:p-4" aria-label="Session">
      <div class="flex flex-wrap items-center gap-x-5 gap-y-3">
        <!-- Clock -->
        <div class="min-w-[8.5rem]">
          <div class="label flex items-center gap-2">
            <span
              class="size-2 rounded-full"
              [style.background]="key !== null ? color(key) : 'var(--color-ink-600)'"
              [style.box-shadow]="key !== null ? '0 0 10px ' + color(key) : null"
            ></span>
            <span data-testid="transport-state">{{ stateLabel() }}</span>
          </div>
          <div class="mt-0.5 font-mono text-2xl font-medium tracking-tight tabular-nums sm:text-3xl" data-testid="clock">
            {{ fmt(engine.position()) }}
            <span class="text-sm text-ink-400 sm:text-base">/ {{ lengthLabel() }}</span>
          </div>
        </div>

        <!-- Session length -->
        <label class="flex flex-col gap-1">
          <span class="label">Play for</span>
          <div class="flex gap-2">
            <select class="field py-1" (change)="onPreset($any($event.target).value)" data-testid="session-length">
              @for (p of presets; track p) {
                <option [value]="p" [selected]="presetValue() === '' + p">{{ p }} min</option>
              }
              <option value="0" [selected]="presetValue() === '0'">No limit</option>
              <option value="custom" [selected]="presetValue() === 'custom'">Custom…</option>
            </select>
            @if (custom()) {
              <input
                type="number" min="1" max="720" class="field w-20"
                [value]="minutes()"
                (change)="store.setSessionMinutes(+$any($event.target).value || 1)"
                aria-label="Custom minutes"
              />
            }
          </div>
        </label>

        <!-- Master volume -->
        <label class="flex min-w-40 flex-1 flex-col gap-1">
          <span class="label flex justify-between">
            Volume <span class="font-mono normal-case">{{ (engine.masterVolume() * 100).toFixed(0) }}%</span>
          </span>
          <input
            type="range" min="0" max="1" step="0.01"
            [value]="engine.masterVolume()"
            [style.--fill]="engine.masterVolume() * 100 + '%'"
            (input)="store.setMasterVolume(+$any($event.target).value)"
            aria-label="Master volume"
          />
        </label>

        <button class="btn" (click)="engine.stop()" [disabled]="!engine.playing() && engine.position() === 0" data-testid="stop">
          <app-icon name="stop" [size]="14" /> Stop
        </button>
      </div>

      @if (engine.ended()) {
        <p class="mt-2 text-sm text-glow" role="status">Session finished. Press a key to go again.</p>
      }

      @if (store.advanced()) {
        <div class="mt-3 border-t border-white/5 pt-3">
          <!-- Timeline -->
          <input
            type="range"
            class="w-full"
            min="0"
            [max]="timelineMax()"
            step="0.1"
            [value]="engine.position()"
            [style.--fill]="progress() + '%'"
            (input)="engine.seek(+$any($event.target).value)"
            aria-label="Session position"
            data-testid="timeline"
          />
          <div class="mt-1 flex justify-between font-mono text-[11px] text-ink-400 tabular-nums">
            <span>00:00</span>
            @if (engine.remaining(); as rem) {
              <span>−{{ fmt(rem) }} left</span>
            }
            <span>{{ lengthLabel() }}</span>
          </div>

          <div class="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3">
            <div class="flex items-center gap-2">
              <button class="btn-icon size-9" (click)="engine.skip(-skipSize())" [attr.aria-label]="'Rewind ' + skipSize() + ' seconds'">
                <app-icon name="back" [size]="16" />
              </button>
              <button class="btn-icon size-9" (click)="engine.skip(skipSize())" [attr.aria-label]="'Fast forward ' + skipSize() + ' seconds'">
                <app-icon name="forward" [size]="16" />
              </button>
              <select class="field py-1 text-xs" (change)="skipSize.set(+$any($event.target).value)" aria-label="Skip size">
                @for (s of [5, 10, 30, 60]; track s) {
                  <option [value]="s" [selected]="s === skipSize()">{{ s }}s</option>
                }
              </select>
            </div>

            <label class="flex min-w-36 flex-col gap-1">
              <span class="label flex justify-between">
                Fade <span class="font-mono normal-case">{{ engine.fadeSeconds().toFixed(1) }}s</span>
              </span>
              <input
                type="range" min="0" max="10" step="0.1"
                [value]="engine.fadeSeconds()"
                [style.--fill]="engine.fadeSeconds() * 10 + '%'"
                (input)="store.setFadeSeconds(+$any($event.target).value)"
                aria-label="Fade in and out time"
              />
            </label>

            <button
              class="btn"
              [style.border-color]="engine.keyLock() ? 'rgb(124 242 212 / 0.5)' : null"
              [attr.aria-pressed]="engine.keyLock()"
              (click)="store.setKeyLock(!engine.keyLock())"
              title="Re-tune every sound to the key you press"
              data-testid="key-lock"
            >
              <app-icon [name]="engine.keyLock() ? 'lock' : 'unlock'" [size]="15" />
              {{ engine.keyLock() ? 'Key lock on' : 'Key lock off' }}
            </button>

            <div class="flex items-center gap-2">
              <span class="label">Level</span>
              <div class="h-2 w-24 overflow-hidden rounded-full bg-ink-700" aria-hidden="true">
                <div
                  class="h-full rounded-full bg-gradient-to-r from-glow-dim via-glow to-amber-300 transition-[width] duration-75"
                  [style.width.%]="engine.level() * 100"
                ></div>
              </div>
            </div>
          </div>
        </div>
      }
    </section>
  `,
})
export class StatusBar {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly presets = PRESETS;
  protected readonly skipSize = signal(10);
  protected readonly customMode = signal(false);
  protected readonly fmt = formatTime;
  protected readonly color = keyColor;

  protected readonly minutes = computed(() => this.store.kit()?.sessionMinutes ?? 10);
  protected readonly custom = computed(
    () => this.customMode() || (this.minutes() !== 0 && !PRESETS.includes(this.minutes())),
  );
  protected readonly presetValue = computed(() => (this.custom() ? 'custom' : String(this.minutes())));
  protected readonly lengthLabel = computed(() => {
    const len = this.engine.sessionLength();
    return len == null ? '∞' : formatTime(len);
  });
  protected readonly timelineMax = computed(() => {
    const len = this.engine.sessionLength();
    return len ?? Math.max(600, Math.ceil((this.engine.position() + 60) / 300) * 300);
  });
  protected readonly progress = computed(() => (this.engine.position() / this.timelineMax()) * 100);
  protected readonly stateLabel = computed(() => {
    const key = this.engine.activeKey();
    if (key !== null) return `Playing in ${NOTE_NAMES[key]}`;
    return this.engine.position() > 0 ? 'Paused' : 'Ready';
  });

  protected onPreset(value: string): void {
    if (value === 'custom') {
      this.customMode.set(true);
      return;
    }
    this.customMode.set(false);
    this.store.setSessionMinutes(Number(value));
  }
}
