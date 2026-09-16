import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { IS_SHARP, NOTE_NAMES, PAD_KEYS } from '../audio/music';
import { StudioStore } from '../state/studio.store';

/** Colour per key, walking the circle of fifths so related keys look related. */
export function padColor(pc: number, alpha = 1): string {
  const hue = ((pc * 7) % 12) * 30 + 160;
  return `hsl(${hue % 360} 85% 66% / ${alpha})`;
}

// 14-column grid: naturals take two columns on the bottom row, sharps sit between them on top.
const COLUMN: Record<number, number> = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 7, 6: 8, 7: 9, 8: 10, 9: 11, 10: 12, 11: 13 };

@Component({
  selector: 'app-pad-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel p-4 sm:p-5" aria-label="Pads">
      <div class="mb-3 flex items-baseline justify-between gap-6">
        <h2 class="text-sm font-semibold tracking-wide text-ink-300">Pads</h2>
        <p class="hidden text-right text-xs text-ink-400 sm:block">
          {{ store.padMode() === 'latch' ? 'Tap a pad to sustain it, tap again to fade out.' : 'Hold a pad to play it.' }}
          Keys <kbd class="font-mono text-ink-300">A W S E D F T G Y H U J</kbd>. Drop WAVs on any pad.
        </p>
      </div>
      <div class="grid grid-cols-14 gap-1.5 sm:gap-2.5" role="group">
        @for (pad of pads; track pad) {
          @let layers = store.layersByPad()[pad];
          @let armed = engine.armedPads().has(pad);
          @let sounding = armed && engine.state() === 'playing';
          <button
            type="button"
            class="group relative flex flex-col justify-between overflow-hidden rounded-xl border p-1.5 text-left transition select-none sm:p-2.5"
            [class]="sharp[pad] ? 'row-start-1 h-20 sm:h-24' : 'row-start-2 h-24 sm:h-32'"
            [style.grid-column]="column(pad) + ' / span 2'"
            [style.--pad-color]="color(pad, 0.85)"
            [style.border-color]="armed ? color(pad, 0.9) : store.selectedPad() === pad ? 'rgb(255 255 255 / 0.35)' : 'rgb(255 255 255 / 0.07)'"
            [style.background]="padBackground(pad, layers.length > 0, sounding)"
            [class.animate-breathe]="sounding"
            [class.ring-2]="dragOver() === pad"
            [class.ring-white]="dragOver() === pad"
            [attr.aria-pressed]="armed"
            [attr.aria-label]="'Pad ' + names[pad] + ', ' + layers.length + ' layers' + (armed ? ', sustaining' : '')"
            [attr.data-testid]="'pad-' + pad"
            (pointerdown)="onDown(pad, $event)"
            (pointerup)="onUp(pad)"
            (pointerleave)="onUp(pad)"
            (pointercancel)="onUp(pad)"
            (keydown.enter)="$event.preventDefault(); press(pad)"
            (keydown.space)="$event.preventDefault(); $event.stopPropagation(); press(pad)"
            (keyup.enter)="onUp(pad)"
            (keyup.space)="onUp(pad)"
            (dragover)="$event.preventDefault(); dragOver.set(pad)"
            (dragleave)="dragOver.set(null)"
            (drop)="onDrop(pad, $event)"
          >
            <div class="flex items-start justify-between gap-1">
              <span class="text-lg leading-none font-bold sm:text-2xl" [style.color]="layers.length ? color(pad) : null">{{ names[pad] }}</span>
              <kbd class="hidden rounded border border-white/10 px-1 font-mono text-[10px] text-ink-400 uppercase sm:inline">{{ keys[pad] }}</kbd>
            </div>
            <div class="flex items-center justify-between gap-1">
              <div class="flex gap-0.5" aria-hidden="true">
                @for (l of layers; track l.id) {
                  <span
                    class="h-3 w-1 rounded-full sm:h-4 sm:w-1.5"
                    [style.background]="l.enabled ? color(pad) : 'rgb(255 255 255 / 0.15)'"
                    [class.animate-pulse]="engine.loading().has(l.id)"
                  ></span>
                }
              </div>
              @if (armed && engine.state() !== 'playing') {
                <span class="text-[9px] font-semibold tracking-wider text-amber-300 uppercase">queued</span>
              } @else if (!layers.length) {
                <span class="text-[10px] text-ink-400 opacity-0 transition group-hover:opacity-100">+ wav</span>
              }
            </div>
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
    '(window:keydown)': 'onKey($event, true)',
    '(window:keyup)': 'onKey($event, false)',
    '(window:blur)': 'releaseHeld()',
  },
})
export class PadGrid {
  protected readonly store = inject(StudioStore);
  protected readonly engine = this.store.engine;
  protected readonly pads = Array.from({ length: 12 }, (_, i) => i);
  protected readonly names = NOTE_NAMES;
  protected readonly keys = PAD_KEYS;
  protected readonly sharp = IS_SHARP;
  protected readonly color = padColor;
  protected readonly dragOver = signal<number | null>(null);
  private readonly held = new Set<number>();
  protected readonly hasLayers = computed(() => this.store.layersByPad().map((l) => l.length > 0));

  protected column(pad: number): number {
    return COLUMN[pad];
  }

  protected padBackground(pad: number, filled: boolean, sounding: boolean): string {
    if (sounding) return `linear-gradient(160deg, ${padColor(pad, 0.35)}, ${padColor(pad, 0.08)})`;
    if (filled) return `linear-gradient(160deg, ${padColor(pad, 0.14)}, rgb(18 21 32 / 0.9))`;
    return 'rgb(18 21 32 / 0.7)';
  }

  /** Select the pad and play / release it depending on mode. */
  protected press(pad: number): void {
    this.store.selectedPad.set(pad);
    if (!this.hasLayers()[pad]) return;
    if (this.store.padMode() === 'latch') {
      void this.engine.togglePad(pad);
    } else {
      this.held.add(pad);
      void this.engine.armPad(pad);
    }
  }

  protected onDown(pad: number, ev: PointerEvent): void {
    if (ev.button !== 0) return;
    this.press(pad);
  }

  protected onUp(pad: number): void {
    if (this.store.padMode() === 'hold' && this.held.delete(pad)) {
      this.engine.releasePad(pad);
    }
  }

  protected releaseHeld(): void {
    for (const pad of this.held) this.engine.releasePad(pad);
    this.held.clear();
  }

  protected onDrop(pad: number, ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(null);
    const files = Array.from(ev.dataTransfer?.files ?? []);
    if (files.length) {
      this.store.selectedPad.set(pad);
      void this.store.addFiles(pad, files);
    }
  }

  protected onKey(ev: KeyboardEvent, down: boolean): void {
    const target = ev.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable]')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    const pad = (PAD_KEYS as readonly string[]).indexOf(ev.key.toLowerCase());
    if (pad >= 0) {
      ev.preventDefault();
      if (ev.repeat) return;
      if (down) this.press(pad);
      else this.onUp(pad);
      return;
    }
    if (!down || ev.repeat && ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    switch (ev.key) {
      case ' ':
        if (target?.closest('button')) return; // let the button handle it
        ev.preventDefault();
        void this.engine.togglePlay();
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
        this.engine.seek(0);
        break;
      case 'Escape':
        this.engine.stop();
        break;
    }
  }
}
