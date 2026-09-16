import { mod } from './music';

/**
 * Where a looping layer is inside its sample, as a function of the session
 * timeline. Because the loop is periodic we only need an anchor point: at
 * timeline position `anchorPos` the layer was at `anchorOffset` seconds into
 * its buffer, travelling at `rate` buffer-seconds per timeline-second.
 *
 * This makes pause/resume, rewind and fast-forward exact: any timeline
 * position maps to a precise point in each loop.
 */
export interface LoopPhase {
  anchorPos: number;
  anchorOffset: number;
  rate: number;
}

export function startPhase(pos: number, rate: number): LoopPhase {
  return { anchorPos: pos, anchorOffset: 0, rate };
}

/** Offset (seconds into the loop buffer) at timeline position `pos`. */
export function offsetAt(phase: LoopPhase, pos: number, loopDuration: number): number {
  if (loopDuration <= 0) return 0;
  return mod(phase.anchorOffset + (pos - phase.anchorPos) * phase.rate, loopDuration);
}

/** Change the rate at `pos` without a jump in the loop position. */
export function retune(phase: LoopPhase, pos: number, newRate: number, loopDuration: number): LoopPhase {
  return { anchorPos: pos, anchorOffset: offsetAt(phase, pos, loopDuration), rate: newRate };
}
