import { BUILDINGS, LAYOUT, MAP, MAX_RISE, WOODS, cellIndex, mainRegion, walkFrom, type MapGrid } from "./rules";

/**
 * Fogfront's maps (D-128): a rectangle of a committed level, and where each
 * side starts and the glim lies, by hand (the Presidio's) or chosen from the
 * level's cells (`planMap`). The landmarks reaching into the rectangle are
 * its objectives, as on every map (`buildGrid`). A room plays one map, its
 * setting from the lobby.
 */

/** Where each side's hearth stands (top-left cells) and the seeps lie. */
export type Layout = typeof LAYOUT;

export interface RtsMap {
  id: string;
  /** For people. */
  name: string;
  /** The world package (`fixtures/<world>`), served at `/<world>/`. */
  world: string;
  /** The play area (cells of the level). */
  rect: { x0: number; y0: number; w: number; h: number };
  /** Hearths and seeps placed by hand; without, `planMap` chooses them. */
  layout?: Layout;
}

export const MAPS: Record<string, RtsMap> = {
  presidio: { id: "presidio", name: "the Presidio, San Francisco", world: "sf", rect: MAP, layout: LAYOUT },
  midtown: { id: "midtown", name: "Midtown Manhattan", world: "nyc-walk", rect: { x0: 230, y0: 410, w: 160, h: 160 } },
  higashiyama: { id: "higashiyama", name: "Higashiyama, Kyoto", world: "kyoto-walk", rect: { x0: 175, y0: 65, w: 155, h: 145 } },
  kowloon: { id: "kowloon", name: "Tsim Sha Tsui, Kowloon", world: "hongkong-walk", rect: { x0: 90, y0: 290, w: 138, h: 150 } },
  strip: { id: "strip", name: "the Las Vegas Strip", world: "southwest-walk", rect: { x0: 20, y0: 130, w: 150, h: 140 } },
};

/** A room opened without a map plays this one. */
export const DEFAULT_MAP = "presidio";

/** A map by its id (untrusted), or null. */
export const mapOf = (id: unknown): RtsMap | null => (typeof id === "string" && Object.hasOwn(MAPS, id) ? MAPS[id]! : null);

/** How `planMap` chooses. */
export const PLAN = {
  /** Hearth sites are compared a block this many cells a side at a time: the roomiest in each. */
  block: 8,
  /** Open ground is counted this many cells round a hearth's footprint. */
  room: 4,
  /** Hearths about this share of the map's diagonal apart (at least 0.8 of it): a cell nearer or further costs as much as a cell less of open ground. */
  apart: 0.5,
  /** A side's own seeps: this many cells' walk from its hearth, and further from the other's by more than that. */
  near: 5,
  /** Seeps at least this many cells apart; the two between, this share of the hearths' walk apart. */
  gap: 3,
  spread: 0.2,
};

/**
 * Hearths and seeps chosen from a map's cells (D-128), the same each time for
 * a level and a rectangle. Two hearth sites, each its footprint on open,
 * level, dry ground with no woods and the cells round it walkable (so it
 * closes no way), the roomiest pair about `PLAN.apart` of the diagonal apart
 * round the middle; three seeps by each, as far a walk from its own hearth
 * for both sides, behind it; and two between, as far a walk from either.
 * All of them in the map's largest walkable region, so each reaches every
 * other. Throws when the map has no room for them.
 */
export function planMap(g: MapGrid): Layout {
  const region = mainRegion(g);
  const size = BUILDINGS.hearth.size;
  const inRegion = (x: number, y: number) => {
    const i = cellIndex(g, x, y);
    return i >= 0 && region[i] === 1;
  };
  /** Ground a building or a seep may take: in the region, no woods. */
  const open = (x: number, y: number) => inRegion(x, y) && (g.flags[cellIndex(g, x, y)]! & WOODS) === 0;

  /** A hearth with its top-left at a cell: the open cells round it, or -1 where it can't stand. */
  const site = (x: number, y: number): number => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let dy = -1; dy <= size; dy++)
      for (let dx = -1; dx <= size; dx++) {
        const inside = dx >= 0 && dy >= 0 && dx < size && dy < size;
        if (!(inside ? open(x + dx, y + dy) : inRegion(x + dx, y + dy))) return -1;
        if (!inside) continue;
        const h = g.height[cellIndex(g, x + dx, y + dy)]!;
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    if (hi - lo > MAX_RISE) return -1;
    let room = 0;
    for (let dy = -PLAN.room; dy < size + PLAN.room; dy++) for (let dx = -PLAN.room; dx < size + PLAN.room; dx++) if (open(x + dx, y + dy)) room++;
    return room;
  };
  const sites: { x: number; y: number; room: number }[] = [];
  for (let by = 0; by < g.h; by += PLAN.block)
    for (let bx = 0; bx < g.w; bx += PLAN.block) {
      let best: (typeof sites)[number] | null = null;
      for (let y = g.y0 + by; y < g.y0 + Math.min(by + PLAN.block, g.h); y++)
        for (let x = g.x0 + bx; x < g.x0 + Math.min(bx + PLAN.block, g.w); x++) {
          const room = site(x, y);
          if (room > (best?.room ?? -1)) best = { x, y, room };
        }
      if (best) sites.push(best);
    }

  // the roomier pair, as near `apart` as may be, round the middle of the map; with none far enough, the farthest
  const far = PLAN.apart * Math.hypot(g.w, g.h);
  const [cx, cy] = [g.x0 + g.w / 2, g.y0 + g.h / 2];
  let pair: [(typeof sites)[number], (typeof sites)[number]] | null = null;
  let score = -Infinity;
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++) {
      const [a, b] = [sites[i]!, sites[j]!];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = d < 0.8 * far ? d - 1e6 : Math.min(a.room, b.room) - Math.abs(d - far) - 0.01 * Math.hypot((a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy);
      if (s > score) [pair, score] = [[a, b], s];
    }
  if (!pair) throw new Error("no room for two hearths");
  const [a, b] = pair;

  const foot = (s: { x: number; y: number }) => Array.from({ length: size * size }, (_, k) => cellIndex(g, s.x + (k % size), s.y + Math.floor(k / size)));
  const fromA = walkFrom(g, foot(a));
  const fromB = walkFrom(g, foot(b));
  const apart = Math.min(...foot(b).map((i) => fromA[i]!));
  const seeps: [number, number][] = [];
  /** The `count` open cells ranked lowest (null: not one), each at least `gap` cells from the seeps so far. */
  const pick = (count: number, rank: (i: number) => number | null, gap: number) => {
    const order: [number, number][] = [];
    for (let i = 0; i < region.length; i++) {
      const x = (i % g.w) + g.x0;
      const y = Math.floor(i / g.w) + g.y0;
      const r = open(x, y) ? rank(i) : null;
      if (r !== null) order.push([r, i]);
    }
    order.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let got = 0;
    for (const [, i] of order) {
      if (got === count) break;
      const x = (i % g.w) + g.x0;
      const y = Math.floor(i / g.w) + g.y0;
      if (seeps.some(([sx, sy]) => Math.hypot(sx - x, sy - y) < gap)) continue;
      seeps.push([x, y]);
      got++;
    }
    if (got < count) throw new Error("no room for the seeps");
  };
  // each side's own, behind its hearth (the furthest from the other's first)
  for (const [own, other] of [
    [fromA, fromB],
    [fromB, fromA],
  ] as const)
    pick(3, (i) => (own[i]! >= 2 && other[i]! > own[i]! + PLAN.near ? Math.abs(own[i]! - PLAN.near) * 1e4 - other[i]! : null), PLAN.gap);
  // two between, a cell's walk at most nearer one than the other, on or by the shortest way
  pick(2, (i) => (Math.abs(fromA[i]! - fromB[i]!) <= 1 && Math.min(fromA[i]!, fromB[i]!) > PLAN.near ? fromA[i]! + fromB[i]! : null), Math.max(PLAN.gap, PLAN.spread * apart));
  return { hearths: { kiln: [a.x, a.y], tide: [b.x, b.y] }, seeps };
}
