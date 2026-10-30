import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';

import { StudioStore } from './state/studio.store';
import { Icon } from './ui/icon';
import { Keyboard } from './ui/keyboard';
import { SoundList } from './ui/sound-list';
import { StatusBar } from './ui/status-bar';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Keyboard, SoundList, StatusBar],
  template: `
    <div class="mx-auto flex min-h-full max-w-6xl flex-col gap-3 px-3 py-4 sm:gap-4 sm:px-6 sm:py-6">
      <!-- Header -->
      <header class="flex flex-wrap items-center gap-2 sm:gap-3">
        <div class="mr-auto flex items-center gap-2.5">
          <div class="grid size-9 place-items-center rounded-xl bg-glow/15 text-glow">
            <app-icon name="wave" [size]="20" />
          </div>
          <div>
            <h1 class="text-base leading-tight font-bold tracking-tight">PadLoop Studio</h1>
            <p class="text-[11px] text-ink-400">Worship pads in any key</p>
          </div>
        </div>

        @if (store.kit(); as kit) {
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
            <select class="field max-w-44" (change)="store.openKit(+$any($event.target).value)" aria-label="Open kit" data-testid="kit-select">
              @for (k of store.kits(); track k.id) {
                <option [value]="k.id" [selected]="k.id === kit.id">{{ k.name }} ({{ k.soundCount }})</option>
              }
            </select>
          }

          <!-- Everything else lives in one menu, to keep the top row calm -->
          <div class="relative">
            <button class="btn" (click)="menuOpen.set(!menuOpen())" [attr.aria-expanded]="menuOpen()" aria-haspopup="menu" data-testid="kit-menu">
              <app-icon name="menu" [size]="15" /> Kit
            </button>
            @if (menuOpen()) {
              <div
                class="panel absolute right-0 z-30 mt-1 flex w-56 flex-col p-1 text-sm shadow-2xl"
                role="menu"
                (click)="menuOpen.set(false)"
              >
                <button class="menu-item" (click)="startRename()" role="menuitem"><app-icon name="edit" [size]="15" /> Rename kit</button>
                <button class="menu-item" (click)="newKit()" role="menuitem" data-testid="new-kit"><app-icon name="plus" [size]="15" /> New kit</button>
                <button class="menu-item" (click)="store.exportKit()" [disabled]="store.busy()" role="menuitem" data-testid="export-kit">
                  <app-icon name="download" [size]="15" /> Export kit…
                </button>
                <label class="menu-item" role="menuitem">
                  <app-icon name="upload" [size]="15" /> Import kit…
                  <input type="file" accept=".padkit" class="sr-only" [disabled]="store.busy()" (change)="onImport($event)" data-testid="import-kit" />
                </label>
                <hr class="my-1 border-white/5" />
                <button class="menu-item hover:text-danger" (click)="deleteKit()" role="menuitem" data-testid="delete-kit">
                  <app-icon name="trash" [size]="15" /> Delete kit
                </button>
              </div>
            }
          </div>

          <button
            class="btn"
            [style.border-color]="store.advanced() ? 'rgb(124 242 212 / 0.5)' : null"
            [attr.aria-pressed]="store.advanced()"
            (click)="store.toggleAdvanced()"
            title="Show tuning and mixing controls"
            data-testid="advanced-toggle"
          >
            <app-icon name="sliders" [size]="15" />
            <span class="hidden sm:inline">Advanced</span>
          </button>
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
          close the tab. Use <strong>Export kit</strong> to keep a copy.
        </div>
      }

      <app-status-bar />
      <app-keyboard />
      <app-sound-list />

      <footer class="pt-1 text-center text-[11px] text-ink-400">
        Keys A W S E D F T G Y H U J · Space or Esc fades out · ← → skip 10s
        <br />
        Kits are saved in this browser only. Use Kit → Export to back them up or move them to another device.
      </footer>
    </div>

    <!-- Toasts -->
    <div class="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col items-end gap-2" aria-live="polite">
      @for (t of store.toasts(); track t.id) {
        <div
          class="pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border px-4 py-2.5 text-sm shadow-2xl backdrop-blur"
          [class]="t.kind === 'error' ? 'border-danger/40 bg-[#2a1016]/95 text-red-100' : 'border-white/10 bg-ink-800/95'"
          [attr.role]="t.kind === 'error' ? 'alert' : 'status'"
        >
          <span class="flex-1">{{ t.text }}</span>
          <button class="text-ink-400 hover:text-ink-100" (click)="store.dismissToast(t.id)" aria-label="Dismiss">
            <app-icon name="x" [size]="14" />
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .menu-item {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      border-radius: 0.5rem;
      padding: 0.5rem 0.65rem;
      text-align: left;
      cursor: pointer;
    }
    .menu-item:hover {
      background: rgb(255 255 255 / 0.06);
    }
  `,
  host: { '(document:click)': 'onDocumentClick($event)' },
})
export class App implements OnInit {
  protected readonly store = inject(StudioStore);
  protected readonly renaming = signal(false);
  protected readonly menuOpen = signal(false);

  ngOnInit(): void {
    // Handy in DevTools: __engine.debugSound(id)
    (window as unknown as { __engine: unknown }).__engine = this.store.engine;
    void this.store.init();
  }

  protected onDocumentClick(ev: MouseEvent): void {
    if (!this.menuOpen()) return;
    const target = ev.target as HTMLElement | null;
    if (!target?.closest('[data-testid=kit-menu], [role=menu]')) this.menuOpen.set(false);
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
    if (kit && confirm(`Delete “${kit.name}” and its sounds? This can't be undone.`)) {
      void this.store.deleteKit();
    }
  }
}
