import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { formatTime } from '../audio/music';
import { StudioStore } from '../state/studio.store';
import { Icon } from './icon';

const PRESETS = [1, 5, 10, 15, 20, 30, 45, 60, 90, 120];

@Component({
  selector: 'app-transport-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  template: `
    <section class="panel p-4 sm:p-5" aria-label="Transport">
      <div class="flex flex-wrap items-center gap-x-6 gap-y-4">
        <!-- Clock -->
        <div class="min-w-[9.5rem]">
          <div class="label flex items-center gap-2">
            <span
              class="size-2 rounded-full"
              [class]="
                engine.state() === 'playing'
                  ? 'bg-glow shadow-[0_0_10px_var(--color-glow)]'
                  : engine.state() === 'paused'
                    ? 'bg-amber-300'
                    : 'bg-ink-600'
              "
            ></span>
            <span data-testid="transport-state">{{ stateLabel() }}</span>
          </div>
          <div class="mt-1 font-mono text-3xl font-medium tracking-tight tabular-nums" data-testid="clock">
            {{ fmt(engine.position()) }}
            <span class="text-base text-ink-400">/ {{ lengthLabel() }}</span>
          </div>
        </div>

        <!-- Buttons -->
        <div class="flex items-center gap-2">
          <button class="btn-icon" (click)="engine.seek(0)" aria-label="Back to start" title="Back to start (Home)">
            <app-icon name="start" />
          </button>
          <button class="btn-icon" (click)="engine.skip(-skipSize())" [attr.aria-label]="'Rewind ' + skipSize() + ' seconds'" [title]="'Rewind ' + skipSize() + 's (←)'">
            <app-icon name="back" />
          </button>
          <button
            class="inline-flex size-14 items-center justify-center rounded-full bg-glow text-ink-950 shadow-[0_0_30px_-6px_var(--color-glow)] transition hover:brightness-110"
            (click)="engine.togglePlay()"
            [attr.aria-label]="engine.state() === 'playing' ? 'Pause' : engine.state() === 'paused' ? 'Resume' : 'Play'"
            title="Play / pause (Space)"
            data-testid="play"
          >
            <app-icon [name]="engine.state() === 'playing' ? 'pause' : 'play'" [size]="26" />
          </button>
          <button class="btn-icon" (click)="engine.skip(skipSize())" [attr.aria-label]="'Fast forward ' + skipSize() + ' seconds'" [title]="'Fast forward ' + skipSize() + 's (→)'">
            <app-icon name="forward" />
          </button>
          <button class="btn-icon" (click)="engine.stop()" aria-label="Stop" title="Stop (Esc)" data-testid="stop">
            <app-icon name="stop" />
          </button>
          <select class="field ml-1 py-1 text-xs" (change)="skipSize.set(+$any($event.target).value)" aria-label="Skip size">
            @for (s of [5, 10, 30, 60]; track s) {
              <option [value]="s" [selected]="s === skipSize()">{{ s }}s</option>
            }
          </select>
        </div>

        <!-- Meter -->
        <div class="ml-auto flex items-center gap-3">
          <div class="h-2 w-28 overflow-hidden rounded-full bg-ink-700" aria-hidden="true">
            <div class="h-full rounded-full bg-gradient-to-r from-glow-dim via-glow to-amber-300 transition-[width] duration-75" [style.width.%]="engine.level() * 100"></div>
          </div>
          <button class="btn" (click)="engine.releaseAll()" [disabled]="engine.armedPads().size === 0" title="Fade out every pad">
            Release all
          </button>
        </div>
      </div>

      <!-- Timeline -->
      <div class="mt-4">
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
          } @else if (engine.sessionLength() === null) {
            <span>endless session</span>
          }
          <span>{{ lengthLabel() }}</span>
        </div>
        @if (engine.ended()) {
          <p class="mt-2 text-sm text-glow" role="status">Session finished. Press play to go again.</p>
        }
      </div>

      <!-- Settings -->
      <div class="mt-4 grid gap-4 border-t border-white/5 pt-4 sm:grid-cols-2 lg:grid-cols-5">
        <label class="flex flex-col gap-1.5">
          <span class="label">Session length</span>
          <div class="flex gap-2">
            <select class="field flex-1" (change)="onPreset($any($event.target).value)" data-testid="session-length">
              @for (p of presets; track p) {
                <option [value]="p" [selected]="presetValue() === '' + p">{{ p }} min</option>
              }
              <option value="0" [selected]="presetValue() === '0'">Endless</option>
              <option value="custom" [selected]="presetValue() === 'custom'">Custom…</option>
            </select>
            @if (custom()) {
              <input
                type="number"
                min="1"
                max="720"
                class="field w-20"
                [value]="minutes()"
                (change)="store.setSessionMinutes(+$any($event.target).value || 1)"
                aria-label="Custom minutes"
              />
            }
          </div>
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="label flex justify-between">Fade in / out <span class="font-mono normal-case">{{ engine.fadeSeconds().toFixed(1) }}s</span></span>
          <input type="range" min="0" max="10" step="0.1" [value]="engine.fadeSeconds()" [style.--fill]="engine.fadeSeconds() * 10 + '%'" (input)="store.setFadeSeconds(+$any($event.target).value)" />
        </label>

        <label class="flex flex-col gap-1.5">
          <span class="label flex justify-between">Master <span class="font-mono normal-case">{{ (engine.masterVolume() * 100).toFixed(0) }}%</span></span>
          <input type="range" min="0" max="1" step="0.01" [value]="engine.masterVolume()" [style.--fill]="engine.masterVolume() * 100 + '%'" (input)="store.setMasterVolume(+$any($event.target).value)" />
        </label>

        <div class="flex flex-col gap-1.5">
          <span class="label">Key lock</span>
          <button
            class="btn justify-start"
            [style.border-color]="engine.keyLock() ? 'rgb(124 242 212 / 0.5)' : null"
            [attr.aria-pressed]="engine.keyLock()"
            (click)="store.setKeyLock(!engine.keyLock())"
            title="Pitch-shift every layer to its pad's key"
            data-testid="key-lock"
          >
            <app-icon [name]="engine.keyLock() ? 'lock' : 'unlock'" [size]="16" />
            {{ engine.keyLock() ? 'On · match pad key' : 'Off · original pitch' }}
          </button>
        </div>

        <div class="flex flex-col gap-1.5">
          <span class="label">Pad mode</span>
          <div class="grid grid-cols-2 rounded-lg border border-white/10 bg-ink-850 p-0.5 text-sm" role="radiogroup">
            <button role="radio" class="rounded-md px-2 py-1" [class.bg-ink-700]="store.padMode() === 'latch'" [attr.aria-checked]="store.padMode() === 'latch'" (click)="store.padMode.set('latch')" title="Tap to sustain, tap again to release">
              Latch
            </button>
            <button role="radio" class="rounded-md px-2 py-1" [class.bg-ink-700]="store.padMode() === 'hold'" [attr.aria-checked]="store.padMode() === 'hold'" (click)="store.padMode.set('hold')" title="Sound only while held">
              Hold
            </button>
          </div>
        </div>
      </div>
    </section>
  `,
})
export class TransportBar {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly presets = PRESETS;
  protected readonly skipSize = signal(10);
  protected readonly customMode = signal(false);
  protected readonly fmt = formatTime;

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
    const armed = this.engine.armedPads().size;
    switch (this.engine.state()) {
      case 'playing':
        return armed ? `Playing · ${armed} pad${armed > 1 ? 's' : ''}` : 'Playing · no pads';
      case 'paused':
        return 'Paused';
      default:
        return 'Stopped';
    }
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
