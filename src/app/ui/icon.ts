import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

const PATHS: Record<string, string> = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  back: 'M11 7 5 12l6 5V7zm8 0-6 5 6 5V7z',
  forward: 'M13 7l6 5-6 5V7zM5 7l6 5-6 5V7z',
  start: 'M6 6h2v12H6zM18 6v12l-8.5-6L18 6z',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  upload: 'M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 16v3.5h16V16',
  download: 'M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 16v3.5h16V16',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z',
  unlock: 'M7 11V8a5 5 0 0 1 9.6-2M5.5 11h13v9.5h-13z',
  wave: 'M3 12h2l2-6 3 12 3-15 3 15 2-6h3',
  x: 'M6 6l12 12M18 6 6 18',
  mute: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16 9l5 6M21 9l-5 6',
  speaker: 'M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12',
  sparkle: 'M12 3v5M12 16v5M3 12h5M16 12h5M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18',
  release: 'M5 12h14',
};

const FILLED = new Set(['play', 'pause', 'stop', 'back', 'forward', 'start']);

@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      [attr.width]="size()"
      [attr.height]="size()"
      aria-hidden="true"
      [attr.fill]="filled() ? 'currentColor' : 'none'"
      [attr.stroke]="filled() ? 'none' : 'currentColor'"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
  host: { class: 'inline-flex shrink-0' },
})
export class Icon {
  readonly name = input.required<string>();
  readonly size = input(18);
  protected readonly path = computed(() => PATHS[this.name()] ?? '');
  protected readonly filled = computed(() => FILLED.has(this.name()));
}
