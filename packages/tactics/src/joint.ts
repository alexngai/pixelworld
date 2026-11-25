import {
  A_WATER,
  INVADERS,
  SQUAD,
  addUnit,
  aimOf,
  step,
  strikeCell,
  structureAt,
  teamOf,
  type Combat,
  type FighterKind,
  type Loadout,
} from "./combat";

/**
 * A second squad joined to a fight (D-187): its rigs set down on open cells
 * that no invader strikes this round or arrives on, two cells from every
 * invader where it can be, nearest the squad already there; each with its
 * loadout's weapons. Returns the new rigs' units (in the order given; fewer
 * when the board has no room).
 */
export function joinSquad(c: Combat, rigs: readonly Loadout[]): number[] {
  const a = c.arena;
  const cheb = (p: number, q: number) =>
    Math.max(
      Math.abs((p % a.w) - (q % a.w)),
      Math.abs(Math.floor(p / a.w) - Math.floor(q / a.w)),
    );
  const struck = new Set<number>();
  const invaders: number[] = [];
  const squad: number[] = [];
  for (let u = 0; u < c.roster.length; u++) {
    if (c.hp[u]! <= 0) continue;
    if (teamOf(c, u) === SQUAD) squad.push(c.pos[u]!);
    if (teamOf(c, u) !== INVADERS) continue;
    invaders.push(c.pos[u]!);
    if (c.aim[u]! >= 0) struck.add(strikeCell(c, u, aimOf(c, u)));
  }
  const arriving = new Set(c.schedule.flat().map((x) => x.at));
  const ground = (k: number) =>
    a.floor !== undefined
      ? a.struct[k]! >= 0
      : a.struct[k]! < 0 && !(a.flags[k]! & A_WATER);
  const safe = (k: number) => (invaders.every((p) => cheb(p, k) >= 2) ? 0 : 1);
  const near = (k: number) =>
    squad.length ? Math.min(...squad.map((p) => cheb(p, k))) : 0;
  const cells = [...Array(a.w * a.h).keys()]
    .filter(
      (k) => ground(k) && c.occ[k]! < 0 && !struck.has(k) && !arriving.has(k),
    )
    .sort((p, q) => safe(p) - safe(q) || near(p) - near(q) || p - q);
  const out: number[] = [];
  for (const r of rigs) {
    const k = cells.find((x) => c.occ[x]! < 0);
    if (k === undefined) break;
    const u = addUnit(c, r.kind, k);
    c.arms[u] = r.arms;
    out.push(u);
  }
  return out;
}

/**
 * Reinforcements for a joint finale (D-187): `n` more invaders (brutes and
 * crawlers by turns), each set on an open cell beside a standing building, two
 * cells from every rig where it can be, and aimed at that building, so the two squads have
 * more to stop than one would. Returns the new invaders' units (fewer when
 * the board has no such cell).
 */
export function reinforce(c: Combat, n: number): number[] {
  const a = c.arena;
  const cheb = (p: number, q: number) =>
    Math.max(
      Math.abs((p % a.w) - (q % a.w)),
      Math.abs(Math.floor(p / a.w) - Math.floor(q / a.w)),
    );
  const rigs = c.roster.flatMap((_, u) =>
    teamOf(c, u) === SQUAD && c.hp[u]! > 0 ? [c.pos[u]!] : [],
  );
  const arriving = new Set(c.schedule.flat().map((x) => x.at));
  const out: number[] = [];
  // two cells from every rig where it can be, else anywhere free
  for (const gap of [2, 1])
    for (let k = 0; k < a.w * a.h && out.length < n; k++) {
      if (
        a.struct[k]! >= 0 ||
        a.flags[k]! & A_WATER ||
        c.occ[k]! >= 0 ||
        arriving.has(k) ||
        rigs.some((p) => cheb(p, k) < gap)
      )
        continue;
      // a standing building beside it
      const dir = [0, 1, 2, 3].find((d) => {
        const t = step(a, k, d);
        return t >= 0 && structureAt(c, t) >= 0;
      });
      if (dir === undefined) continue;
      const kind: FighterKind = out.length % 2 ? "crawler" : "brute";
      const u = addUnit(c, kind, k);
      c.aim[u] = dir;
      c.reach[u] = 1;
      out.push(u);
    }
  return out;
}
