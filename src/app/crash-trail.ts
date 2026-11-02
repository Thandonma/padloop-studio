/**
 * Remembers what the app was in the middle of, so that if the browser kills the
 * tab (a phone running out of memory, say) the next visit can say where it died.
 * A normal close or reload fires pagehide and clears it; a crash doesn't.
 */
const KEY = 'padloop.inProgress';

export function markStep(step: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ step, at: new Date().toISOString() }));
  } catch {
    // Storage blocked; the trail is only a diagnostic.
  }
}

export function clearStep(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // As above.
  }
}

/** The step a previous visit was cut off in, if any. Clears it. */
export function takeInterruptedStep(): { step: string; at: string } | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

addEventListener('pagehide', clearStep);
