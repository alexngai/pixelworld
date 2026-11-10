import type { FrameClock } from "./types";

/** The longest frame step (seconds): a stall (a tab in the background, a slow bake) doesn't jump the game. */
export const MAX_FRAME_DT = 0.1;

/**
 * A view's game clock (D-073): wall-clock frame times in, game time out.
 * Game time starts at the view's first complete frame (`start`), stops while
 * paused and runs at `timeScale`; every frame's wall-clock step is capped at
 * `MAX_FRAME_DT` before scaling.
 */
export class GameClock {
  private hold = false;
  private scale = 1;
  private running = false;
  private elapsed = 0;

  get paused(): boolean {
    return this.hold;
  }

  set paused(on: boolean) {
    this.hold = !!on;
  }

  get timeScale(): number {
    return this.scale;
  }

  set timeScale(s: number) {
    if (!Number.isFinite(s) || s < 0) throw new RangeError(`timeScale must be a finite number ≥ 0, not ${s}`);
    this.scale = s;
  }

  /** Whether game time runs (the first complete frame is drawn). */
  get started(): boolean {
    return this.running;
  }

  /** Game seconds since the start. */
  get time(): number {
    return this.elapsed;
  }

  /** The first complete frame is drawn: game time runs from the next frame. */
  start(): void {
    this.running = true;
  }

  /** A frame `ms` wall-clock milliseconds after the last one: its clock. */
  tick(ms: number): FrameClock {
    const realDt = Math.max(0, Math.min(MAX_FRAME_DT, ms / 1000));
    const dt = this.running && !this.hold ? realDt * this.scale : 0;
    this.elapsed += dt;
    return { dt, realDt, time: this.elapsed, started: this.running, paused: this.hold };
  }
}
