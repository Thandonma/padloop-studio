import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';

import { StudioStore } from './state/studio.store';
import { Icon } from './ui/icon';
import { PadGrid } from './ui/pad-grid';
import { PadInspector } from './ui/pad-inspector';
import { TransportBar } from './ui/transport-bar';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, PadGrid, PadInspector, TransportBar],
  template: `
    <div class="mx-auto flex min-h-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6">
      <!-- Header -->
      <header class="flex flex-wrap items-center gap-3">
        <div class="mr-auto flex items-center gap-2.5">
          <div class="grid size-9 place-items-center rounded-xl bg-glow/15 text-glow">
            <app-icon name="wave" [size]="20" />
          </div>
          <div>
            <h1 class="text-base leading-tight font-bold tracking-tight">PadLoop Studio</h1>
            <p class="text-[11px] text-ink-400">Layered, key-locked ambient pads</p>
          </div>
        </div>

        @if (store.kit(); as kit) {
          <div class="flex flex-wrap items-center gap-2">
            <span class="label hidden sm:inline">Kit</span>
            @if (renaming()) {
              <input
                #nameInput
                class="field w-48"
                [value]="kit.name"
                maxlength="80"
                aria-label="Kit name"
                (keydown.enter)="finishRename(nameInput.value)"
                (keydown.escape)="renaming.set(false)"
                (blur)="finishRename(nameInput.value)"
                data-testid="kit-name-input"
              />
            } @else {
              <select class="field max-w-56" (change)="store.openKit(+$any($event.target).value)" aria-label="Open kit" data-testid="kit-select">
                @for (k of store.kits(); track k.id) {
                  <option [value]="k.id" [selected]="k.id === kit.id">{{ k.name }} ({{ k.layerCount }})</option>
                }
              </select>
            }
            <button class="btn" (click)="startRename()" title="Rename kit"><app-icon name="edit" [size]="15" /><span class="sr-only">Rename</span></button>
            <button class="btn" (click)="newKit()" data-testid="new-kit"><app-icon name="plus" [size]="15" /> New kit</button>
            <button class="btn" (click)="store.exportKit()" [disabled]="store.busy()" title="Save this kit and its samples to a .padkit file" data-testid="export-kit">
              <app-icon name="download" [size]="15" /> Export
            </button>
            <label class="btn" [class.opacity-40]="store.busy()" title="Load a .padkit file as a new kit">
              <app-icon name="upload" [size]="15" /> Import
              <input type="file" accept=".padkit" class="sr-only" [disabled]="store.busy()" (change)="onImport($event)" data-testid="import-kit" />
            </label>
            <button class="btn hover:text-danger" (click)="deleteKit()" title="Delete kit"><app-icon name="trash" [size]="15" /><span class="sr-only">Delete kit</span></button>
          </div>
        }
      </header>

      @if (store.storageError(); as err) {
        <div class="panel border-danger/40 p-4 text-sm" role="alert">
          <strong class="text-danger">PadLoop couldn't open its storage.</strong>
          {{ err }}. Try a current version of Chrome, Edge, Firefox or Safari, then
          <button class="underline" (click)="store.init()">try again</button>.
        </div>
      } @else if (!store.persistent()) {
        <div class="panel border-amber-300/30 p-3 text-sm text-amber-100" role="status">
          This browser window can't save data (a private window, perhaps). Everything works, but kits are lost when you
          close the tab. Use <strong>Export</strong> to keep a copy.
        </div>
      }

      <app-transport-bar />

      <div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <app-pad-grid class="block min-w-0" />
        <app-pad-inspector class="block min-w-0" />
      </div>

      <footer class="pt-2 text-center text-[11px] text-ink-400">
        Space play/pause · ← → skip 10s (Shift = 60s) · Home to start · Esc stop
        <br />
        Your kits and samples are saved in this browser only. Use Export to back them up or move them to another device.
      </footer>
    </div>

    <!-- Toasts -->
    <div class="pointer-events-none fixed right-4 bottom-4 left-4 z-50 flex flex-col items-end gap-2" aria-live="polite">
      @for (t of store.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur"
          [class]="t.kind === 'error' ? 'border-danger/40 bg-[#2a1016]/95 text-red-100' : 'border-white/10 bg-ink-800/95'"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        >
          <span class="flex-1">{{ t.text }}</span>
          <button class="text-ink-400 hover:text-ink-100" (click)="store.dismissToast(t.id)" aria-label="Dismiss"><app-icon name="x" [size]="14" /></button>
        </div>
      }
    </div>
  `,
})
export class App implements OnInit {
  protected readonly store = inject(StudioStore);
  protected readonly renaming = signal(false);

  ngOnInit(): void {
    // Handy in DevTools: __engine.debugLayer(id)
    (window as unknown as { __engine: unknown }).__engine = this.store.engine;
    void this.store.init();
  }

  protected startRename(): void {
    this.renaming.set(true);
    setTimeout(() => (document.querySelector('[data-testid="kit-name-input"]') as HTMLInputElement | null)?.select());
  }

  protected finishRename(value: string): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    this.store.renameKit(value);
  }

  protected onImport(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.store.importKit(file);
  }

  protected newKit(): void {
    const name = prompt('Name for the new kit', `Kit ${this.store.kits().length + 1}`);
    if (name?.trim()) void this.store.createKit(name.trim());
  }

  protected deleteKit(): void {
    const kit = this.store.kit();
    if (kit && confirm(`Delete “${kit.name}” and all of its samples? This can't be undone.`)) {
      void this.store.deleteKit();
    }
  }
}
