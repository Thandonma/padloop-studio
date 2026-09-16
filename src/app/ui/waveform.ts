import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-waveform',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 64 24" preserveAspectRatio="none" class="h-full w-full" aria-hidden="true">
      @if (path(); as d) {
        <path [attr.d]="d" [attr.fill]="color()" />
      } @else {
        <line x1="0" y1="12" x2="64" y2="12" stroke="currentColor" stroke-opacity="0.25" stroke-dasharray="2 2" />
      }
    </svg>
  `,
  host: { class: 'block' },
})
export class Waveform {
  readonly peaks = input<number[] | undefined>();
  readonly color = input('currentColor');

  protected readonly path = computed(() => {
    const p = this.peaks();
    if (!p?.length) return null;
    const top = p.map((v, i) => `${i === 0 ? 'M' : 'L'}${i + 0.5} ${12 - Math.max(0.4, v * 11)}`);
    const bottom = [...p].reverse().map((v, j) => `L${p.length - j - 0.5} ${12 + Math.max(0.4, v * 11)}`);
    return `${top.join(' ')} ${bottom.join(' ')} Z`;
  });
}
