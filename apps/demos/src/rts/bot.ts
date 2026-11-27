import type { Building, RtsGame } from "./game";
import { BUILDINGS, UNITS, passable, placementError, type Point, type RtsCommand, type Team } from "./rules";

/**
 * Fogfront's bot (D-121): a side the server plays, deciding once a second
 * from what its side sees, through the same orders a page sends. It keeps
 * six runners gathering, raises a lodge (a second when glim piles up),
 * trains wardens, meets foes that come near its hearth, and sends its idle
 * wardens at the other hearth five at a time, then three.
 */

/** Runners it keeps, and wardens it waits for before the first attack and the rest. */
const RUNNERS = 6;
const FIRST_WAVE = 5;
const WAVE = 3;
/** Foes this near its hearth are met by every warden it has. */
const GUARD = 12;

const centre = (b: Building): Point => ({ x: b.x + b.size / 2, y: b.y + b.size / 2 });

export class Bot {
  private attacked = false;

  constructor(
    private readonly game: RtsGame,
    readonly team: Team,
  ) {}

  /** This second's orders. */
  orders(): RtsCommand[] {
    const g = this.game;
    const out: RtsCommand[] = [];
    const mine = [...g.units.values()].filter((u) => u.team === this.team);
    const runners = mine.filter((u) => u.kind === "runner");
    const wardens = mine.filter((u) => u.kind === "warden");
    const own = [...g.buildings.values()].filter((b) => b.team === this.team);
    const hearth = own.find((b) => b.kind === "hearth");
    if (!hearth) return out;
    const lodges = own.filter((b) => b.kind === "lodge");
    let glim = g.glim[this.team];
    const spend = (n: number) => glim >= n && ((glim -= n), true);

    // a lodge first, then runners, then wardens; a second lodge when glim piles up
    if ((lodges.length === 0 || (lodges.length < 2 && glim > 400)) && glim >= BUILDINGS.lodge.cost) {
      const spot = this.spot(hearth);
      if (spot && spend(BUILDINGS.lodge.cost)) out.push({ t: "build", kind: "lodge", ...spot });
    }
    if (runners.length + hearth.queue.length < RUNNERS && hearth.queue.length < 1 && spend(UNITS.runner.cost)) out.push({ t: "train", b: hearth.id });
    for (const l of lodges) if (l.built >= 1 && l.queue.length < 2 && spend(UNITS.warden.cost)) out.push({ t: "train", b: l.id });
    const seeps = [...g.seeps.values()].filter((s) => s.left > 0);
    for (const r of runners)
      if (r.order.k === "idle" && seeps.length) {
        const s = seeps.reduce((a, b) => (Math.hypot(a.x - r.x, a.y - r.y) <= Math.hypot(b.x - r.x, b.y - r.y) ? a : b));
        out.push({ t: "gather", u: [r.id], seep: s.id });
      }

    // foes near home: every warden meets them
    const home = centre(hearth);
    const near = [...g.units.values()].find((u) => u.team !== this.team && g.canSee(this.team, u.id) && Math.hypot(u.x - home.x, u.y - home.y) < GUARD);
    if (near && wardens.length) {
      out.push({ t: "move", u: wardens.map((w) => w.id), x: near.x, y: near.y, attack: true });
      return out;
    }
    // idle wardens at the other hearth, once there are enough
    const idle = wardens.filter((w) => w.order.k === "idle" && w.target === null);
    const target = [...g.buildings.values()].find((b) => b.team !== this.team && b.kind === "hearth");
    if (target && idle.length >= (this.attacked ? WAVE : FIRST_WAVE)) {
      this.attacked = true;
      const at = centre(target);
      out.push({ t: "move", u: idle.map((w) => w.id), x: at.x, y: at.y, attack: true });
    }
    return out;
  }

  /** Whether the cells round a footprint are open, so it doesn't shut a way. */
  private clearRound(x: number, y: number, size: number): boolean {
    for (let dy = -1; dy <= size; dy++)
      for (let dx = -1; dx <= size; dx++) if ((dx < 0 || dy < 0 || dx === size || dy === size) && !passable(this.game.grid, x + dx, y + dy)) return false;
    return true;
  }

  /** Somewhere a lodge can go near the hearth, nearest it first, with open ground round it. */
  private spot(hearth: Building): Point | null {
    const at = this.game.placing(this.team);
    const size = BUILDINGS.lodge.size;
    const h = centre(hearth);
    for (let r = 3; r <= 9; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = Math.floor(h.x + dx - size / 2);
          const y = Math.floor(h.y + dy - size / 2);
          if (placementError(this.game.grid, "lodge", x, y, at) === null && this.clearRound(x, y, size)) return { x, y };
        }
    return null;
  }
}
