import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { IS_SHARP, NOTE_NAMES, PAD_KEYS } from '../audio/music';
import { StudioStore } from '../state/studio.store';

/** Colour per key, walking the circle of fifths so related keys look related. */
export function keyColor(pc: number, alpha = 1): string {
  const hue = ((pc * 7) % 12) * 30 + 160;
  return `hsl(${hue % 360} 85% 66% / ${alpha})`;
}

// 14-column grid: naturals take two columns on the bottom row, sharps sit between them on top.
const COLUMN: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 7, 6: 8, 7: 9, 8: 10, 9: 11, 10: 12, 11: 13 };

@Component({
  selector: 'app-keyboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let active = engine.activeKey();
    <section class="panel p-3 sm:p-5" aria-label="Keys">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 class="text-sm font-semibold tracking-wide text-ink-300">
          @if (active !== null) {
            Playing in <span class="font-bold" [style.color]="color(active)">{{ names[active] }}</span>
          } @else if (store.hasSounds()) {
            Press a key to start
          } @else {
            Add a sound below, then press a key
          }
        </h2>
        <p class="hidden text-right text-xs text-ink-400 sm:block">
          Press again to fade out · another key moves everything across
        </p>
      </div>

      <div class="grid grid-cols-14 gap-1.5 sm:gap-2.5" role="group">
        @for (key of keys; track key) {
          @let on = active === key;
          <button
            type="button"
            class="group relative flex flex-col justify-between overflow-hidden rounded-xl border p-1.5 text-left transition select-none sm:p-3"
            [class]="sharp[key] ? 'row-start-1 h-20 sm:h-28' : 'row-start-2 h-24 sm:h-36'"
            [style.grid-column]="column(key) + ' / span 2'"
            [style.--pad-color]="color(key, 0.85)"
            [style.border-color]="on ? color(key, 0.9) : 'rgb(255 255 255 / 0.08)'"
            [class.hover:border-white]="!on"
            [style.background]="background(key, on)"
            [class.animate-breathe]="on"
            [class.opacity-55]="!store.hasSounds()"
            [attr.aria-pressed]="on"
            [attr.aria-label]="'Key ' + names[key] + (on ? ', playing' : '')"
            [attr.data-testid]="'key-' + key"
            [disabled]="!store.hasSounds()"
            (click)="press(key)"
          >
            <div class="flex items-start justify-between gap-1">
              <span class="text-lg leading-none font-bold sm:text-3xl" [style.color]="on ? color(key) : 'var(--color-ink-100)'">
                {{ names[key] }}
              </span>
              <kbd class="hidden rounded border border-white/10 px-1 font-mono text-[10px] text-ink-400 uppercase sm:inline">
                {{ shortcuts[key] }}
              </kbd>
            </div>
            @if (on) {
              <span class="text-[10px] font-semibold tracking-wider uppercase" [style.color]="color(key)">
                sustaining
              </span>
            }
          </button>
        }
      </div>
    </section>
  `,
  styles: `
    button {
      touch-action: manipulation;
    }
    .grid-cols-14 {
      grid-template-columns: repeat(14, minmax(0, 1fr));
    }
  `,
  host: {
    '(window:keydown)': 'onKey($event)',
  },
})
export class Keyboard {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly keys = Array.from({ length: 12 }, (_, i) => i);
  protected readonly names = NOTE_NAMES;
  protected readonly shortcuts = PAD_KEYS;
  protected readonly sharp = IS_SHARP;
  protected readonly color = keyColor;

  protected column(key: number): number {
    return COLUMN[key];
  }

  protected background(key: number, on: boolean): string {
    if (on) return `linear-gradient(160deg, ${keyColor(key, 0.38)}, ${keyColor(key, 0.1)})`;
    // Resting keys stay neutral so the one that is sounding stands out.
    return this.sharp[key] ? 'rgb(13 15 22 / 0.95)' : 'rgb(23 27 40 / 0.9)';
  }

  protected press(key: number): void {
    if (!this.store.hasSounds()) return;
    void this.engine.pressKey(key);
  }

  protected onKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable]')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.repeat) return;

    const key = (PAD_KEYS as readonly string[]).indexOf(ev.key.toLowerCase());
    if (key >= 0) {
      ev.preventDefault();
      this.press(key);
      return;
    }
    switch (ev.key) {
      case ' ':
      case 'Escape':
        if (target?.closest('button')) return;
        ev.preventDefault();
        this.engine.release();
        break;
      case 'ArrowLeft':
        ev.preventDefault();
        this.engine.skip(ev.shiftKey ? -60 : -10);
        break;
      case 'ArrowRight':
        ev.preventDefault();
        this.engine.skip(ev.shiftKey ? 60 : 10);
        break;
      case 'Home':
        this.engine.stop();
        break;
    }
  }
}
