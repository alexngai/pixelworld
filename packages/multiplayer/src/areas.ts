/** What `Areas` loads from: a world's queries (`openWorld`'s `query`). */
export interface AreaWorld {
  ensure(x0: number, y0: number, x1: number, y1: number): Promise<void>;
  isLoaded(x0: number, y0: number, x1: number, y1: number): boolean;
}

export interface AreasOptions {
  /** Cells loaded around each player (default 16). */
  radius?: number;
  /** And around where it will be this many seconds on, at its speed (default 2). */
  ahead?: number;
  /** Cells around a player its step reads (default 2): `ready` says whether they are loaded. */
  reach?: number;
}

/**
 * The world around each player on a server, loaded ahead of where it is
 * going (D-120), for a world too big to load whole: open it with
 * `chunkBudgetMB` and the areas no one is near are let go, least recently
 * used first. `track` each player each tick (cheap while its area is
 * loaded: a check that also keeps it in use); a `step` that returns false
 * while `ready` is false waits for its area instead of moving over nothing.
 *
 *   protected step(id, input) { const c = this.cars.get(id)!; if (!this.areas.ready(c.x, c.y)) return false; … }
 *   protected override update() { for (const [id, c] of this.cars) this.areas.track(id, c.x, c.y, c.vx, c.vy); }
 */
export class Areas {
  /** The area asked for each that is still loading (its corners). */
  private readonly loading = new Map<string, readonly number[]>();
  private readonly radius: number;
  private readonly ahead: number;
  private readonly reach: number;
  /** The last load that failed, if one did (it is asked again on the next `track`). */
  failed: unknown = null;

  constructor(
    private readonly world: AreaWorld,
    opts: AreasOptions = {},
  ) {
    this.radius = opts.radius ?? 16;
    this.ahead = opts.ahead ?? 2;
    this.reach = opts.reach ?? 2;
  }

  /** A player (or anything that needs the world around it) at (x, y), moving (vx, vy) cells a second. */
  track(id: string, x: number, y: number, vx = 0, vy = 0): void {
    const ax = x + vx * this.ahead;
    const ay = y + vy * this.ahead;
    const r = this.radius;
    // snapped to 8 cells, so a load already asked for is asked for again only when the area moves on
    const x0 = Math.floor((Math.min(x, ax) - r) / 8) * 8;
    const y0 = Math.floor((Math.min(y, ay) - r) / 8) * 8;
    const x1 = Math.ceil((Math.max(x, ax) + r) / 8) * 8;
    const y1 = Math.ceil((Math.max(y, ay) + r) / 8) * 8;
    const was = this.loading.get(id);
    if ((was && was[0] === x0 && was[1] === y0 && was[2] === x1 && was[3] === y1) || this.world.isLoaded(x0, y0, x1, y1)) return;
    const rect = [x0, y0, x1, y1] as const;
    this.loading.set(id, rect);
    const done = () => {
      if (this.loading.get(id) === rect) this.loading.delete(id);
    };
    this.world.ensure(x0, y0, x1, y1).then(done, (e: unknown) => {
      this.failed = e;
      done();
    });
  }

  /** Whether the world a step at (x, y) reads is loaded. */
  ready(x: number, y: number): boolean {
    const r = this.reach;
    return this.world.isLoaded(x - r, y - r, x + r, y + r);
  }

  /** A player went: nothing more is loaded for it (what was stays until the budget needs the room). */
  forget(id: string): void {
    this.loading.delete(id);
  }

  /** Loads asked for and not yet in. */
  get pending(): number {
    return this.loading.size;
  }
}
