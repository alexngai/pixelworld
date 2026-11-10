import { FOLLOW } from "./tuning";

/**
 * A chase camera's focus: a point ahead of the vehicle by a moment of
 * travel, eased so it doesn't jitter with every turn of the wheel. A jump
 * (a reset, another level) snaps it.
 */
export class Follow {
  x = 0;
  y = 0;
  h = 0;
  private placed = false;

  /** Ease toward a vehicle at (x, y, h) heading `heading` at `speed` cells/s; returns the focus. */
  update(x: number, y: number, h: number, heading: number, speed: number, dt: number): { x: number; y: number; h: number } {
    const ahead = Math.min(FOLLOW.max, Math.abs(speed) * FOLLOW.ahead) * Math.sign(speed || 1);
    const tx = x + Math.cos(heading) * ahead;
    const ty = y + Math.sin(heading) * ahead;
    if (!this.placed || Math.hypot(tx - this.x, ty - this.y) > 30) {
      this.snap(tx, ty, h);
      return this;
    }
    const a = 1 - Math.exp(-dt / FOLLOW.ease);
    this.x += (tx - this.x) * a;
    this.y += (ty - this.y) * a;
    this.h += (h - this.h) * a;
    return this;
  }

  snap(x: number, y: number, h: number): void {
    this.x = x;
    this.y = y;
    this.h = h;
    this.placed = true;
  }
}

/**
 * A little suspension: the drawn body lags the ground and settles, so steps
 * in the terrain read as bumps. Visual only; the car's height is the ground's.
 */
export class Bob {
  offset = 0;
  private vel = 0;
  private last: number | null = null;
  private lastRate: number | null = null;

  update(ground: number, dt: number): number {
    if (this.last !== null && dt > 0) {
      // a change of slope under the wheels kicks the body (a steady climb doesn't); a spring settles it
      const jump = ground - this.last;
      const rate = jump / dt;
      if (this.lastRate !== null && Math.abs(jump) < 2) this.vel -= (rate - this.lastRate) * 0.35;
      this.lastRate = rate;
      const k = 260;
      const c = 18;
      this.vel += (-k * this.offset - c * this.vel) * dt;
      this.offset = Math.max(-0.3, Math.min(0.3, this.offset + this.vel * dt));
    }
    this.last = ground;
    return this.offset;
  }

  reset(): void {
    this.offset = 0;
    this.vel = 0;
    this.last = null;
    this.lastRate = null;
  }
}
