import type { GenContext, Generator, VoxelModel } from "pixelworld/generators";
import {
  bays,
  bracketedCornice,
  bulkhead,
  clamp,
  corniceRows,
  eachSide,
  facadeOf,
  fireEscape,
  frontDir,
  frontPainter,
  massing,
  modelFor,
  paints,
  pick,
  roofTanks,
  sideWindows,
  type Facade,
  type Paints,
} from "./facade";

/**
 * New York's street fabric (D-081): the brownstone row, the walk-up tenement,
 * the cast-iron loft and the prewar apartment block. Each reads by the parts
 * New Yorkers know it by: a stoop and a bracketed cornice, fire escapes over
 * shopfronts, a grid of columns and big windows, a stone base under a brick
 * shaft with wooden water tanks on the roof. Signs carry no lettering.
 */

/** Storeys: the record's (hints.floors) where it fits [lo, hi], else `typical`; never fewer voxels than three a storey. */
function storeys(ctx: GenContext, H: number, lo: number, hi: number, typical: number): number {
  const want = clamp(Math.round(ctx.hints?.floors ?? typical), lo, hi);
  return Math.max(1, Math.min(want, Math.floor(H / 3)));
}

/** A row building's height: the target, stepped a little up or down by seed so a row's roof line steps house by house. */
function rowHeight(ctx: GenContext, fallback: number, floors: number): number {
  const base = ctx.heightVox ?? ctx.param("height", fallback);
  return clamp(Math.round(base * (1 + (ctx.rand() - 0.5) * 0.12)), floors * 3 + 2, 400);
}

/** Water tanks need a role for their staves; tanks are left off an asset without one. */
function tankMats(ctx: GenContext, m: VoxelModel, p: Paints) {
  const wood = ctx.ramps("tank");
  return wood.length ? { wood: m.material(wood[0]!), iron: p.iron, cap: m.material(wood[0]!) } : null;
}

/** Window rows of a storey fh tall (zf from the floor line): a sill below at the walking scale, a lintel above. */
function windowRow(zf: number, fh: number): "sill" | "glass" | "lintel" | "wall" {
  if (zf === 0) return "wall";
  if (fh >= 4 && zf === fh - 1) return "lintel";
  if (fh >= 6 && zf === 1) return "sill";
  return "glass";
}

/** Party walls, mostly blank, with a window here and there where they show; more on a corner lot's side street. */
function sides(m: VoxelModel, f: Facade, from: number, z0: number, zTop: number, fh: number, p: Paints, corner: boolean): void {
  sideWindows(m, f, from, z0, zTop, fh, p.pane, corner ? 2 : 4);
}

/**
 * A brownstone (or a brick row house of the same plan): 3–5 storeys counting
 * the garden level, half a storey up behind an areaway with an iron fence.
 * A high stoop climbs from the sidewalk to the parlour floor's door on one
 * side, so the facade stands back from the front of its footprint by the
 * stoop's run (nothing leaves the footprint). The front is flat: windows in
 * two or three bays under stone lintels, tall ones on the parlour floor, the
 * door under a hood. On top, a bracketed cornice and its lip, and a parapet on
 * one lot line so a row's flat roofs read as separate houses.
 * roles: wall (wall.* variants), trim, cornice, stoop (trim if absent), iron,
 * accent (the doors), roof, window, lit.
 */
export const brownstone: Generator = (ctx) => {
  const { rand, mask, hints } = ctx;
  if (!mask) throw new Error("brownstone needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const floors = storeys(ctx, Infinity, 3, 5, 3 + Math.floor(rand() * 3));
  const H = rowHeight(ctx, 30, floors);
  // the garden level is about 0.6 of a storey; the rest share the height
  const fh0 = H / (floors - 1 + 0.6);
  const bh = Math.max(2, Math.round(fh0 * 0.6));
  const fh = Math.max(3, Math.floor((H - bh) / (floors - 1)));
  const fine = fh >= 6;
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  const stoopMat = p.role("stoop", p.trim);
  // the stoop's run: the facade steps back this far (none on a shallow or narrow lot)
  const sd = f.maxDepth >= 8 && W >= 4 ? clamp(Math.round(bh * 0.8), 1, 5) : 0;
  massing(m, f, H, p.body, p.roof, sd);
  const { paint, raise } = frontPainter(m, f, sd);

  const { n: nb, spans } = bays(W, W >= 9 ? 3 : W >= 5 ? 2 : 1, fine && W >= 9 ? 2 : 1);
  const entry = rand() < 0.5 ? 0 : nb - 1;
  const [e0, e1] = spans[entry]!;
  const s0 = nb > 1 ? Math.max(0, e0 - 1) : 0;
  const s1 = nb > 1 ? Math.min(W - 1, e1 + 1) : W - 1;
  const zTop = H - corniceRows(fh);

  // the garden level: windows behind the areaway, the stone watertable over it
  spans.forEach(([a0, a1], b) => {
    if (b === entry && sd > 0) return;
    for (let a = a0; a <= a1; a++) for (let z = 1; z < bh - 1; z++) paint(a, z, p.pane());
  });
  for (let a = 0; a < W; a++) paint(a, bh, p.trim);

  // the parlour floor and the floors above it
  for (let k = 0; k < floors - 1; k++) {
    const z0 = bh + k * fh;
    spans.forEach(([a0, a1], b) => {
      for (let zf = 1; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        if (k === 0 && b === entry) {
          // the door, a transom over it and a hood
          const door = zf < fh - 2 || (zf === fh - 2 && fh < 5);
          for (let a = a0; a <= a1; a++) paint(a, z, zf === fh - 1 ? p.trim : door ? p.accent : zf === fh - 2 ? p.pane() : p.body);
          continue;
        }
        const row = windowRow(zf, fh);
        // the parlour floor's windows run from the floor
        const kind = k === 0 && row === "sill" ? "glass" : row;
        for (let a = a0; a <= a1; a++) {
          if (kind === "glass") paint(a, z, p.pane());
          else if (kind !== "wall") paint(a, z, p.trim);
        }
      }
    });
    if (k === 0 && fine) {
      // the door's hood reaches a voxel past it, and a pediment over it
      if (e0 > 0) paint(e0 - 1, z0 + fh - 1, p.trim);
      if (e1 < W - 1) paint(e1 + 1, z0 + fh - 1, p.trim);
      if (z0 + fh < zTop) for (let a = e0; a <= e1; a++) paint(a, z0 + fh, p.trim);
    }
  }
  bracketedCornice(paint, raise, W, H, fh, { cornice: p.cornice, frieze: p.body }, (a) => a % 3 === 1);

  // the stoop and the areaway in front of the facade
  const rail = fh >= 7 ? 2 : 1;
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const d = f.depth[i]!;
      const a = f.along[i]!;
      if (d < 0 || d >= sd) continue;
      if (a >= s0 && a <= s1) {
        const top = Math.max(0, Math.round((bh * (d + 1)) / sd) - 1);
        for (let z = 0; z <= top; z++) m.set(x, y, z, stoopMat);
        if ((a === s0 || a === s1) && s1 - s0 >= 2) for (let z = top + 1; z <= top + rail; z++) m.set(x, y, z, p.iron);
      } else if (d === 0) {
        m.set(x, y, 0, p.iron); // the areaway's fence
        if (fine && (a % 2 === 0 || a === 0 || a === W - 1)) m.set(x, y, 1, p.iron);
      }
    }
  // a parapet on one lot line
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! > sd && f.along[i] === 0 && W >= 3 && m.get(x, y, H - 1)) m.set(x, y, H, p.body);
    }
  sides(m, f, sd, bh, zTop, fh, p, hints?.corner === true);
  return m;
};

/**
 * A walk-up tenement: 5–7 storeys of brick over shopfronts. At the street,
 * the tenants' door in one bay between two shops, each a run of glass over a
 * bulkhead under a sign band (no lettering); a corner lot's shop wraps round
 * the corner. Above, windows in bays under stone lintels and, on most, a fire
 * escape across two or three bays: platforms at each floor, railings and
 * stairs turning at each landing, drawn on the wall over the windows. On top,
 * a pressed-metal bracketed cornice; on the roof, a stair bulkhead and, on
 * the taller ones, a water tank.
 * roles: wall (wall.* variants), trim, cornice, sign (sign.* variants: the
 * shops' bands), iron, accent (doors), tank (the water tank's staves; no tank
 * without), roof, window, lit.
 */
export const tenement: Generator = (ctx) => {
  const { rand, mask, hints } = ctx;
  if (!mask) throw new Error("tenement needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const floors = storeys(ctx, Infinity, 5, 7, 5 + Math.floor(rand() * 3));
  const H = rowHeight(ctx, 40, floors);
  const fh = Math.max(3, Math.floor(H / floors));
  const fine = fh >= 6;
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  const signs = ctx.ramps("sign");
  const sign = signs.length ? m.material(pick(rand, signs)) : p.accent;
  massing(m, f, H, p.body, p.roof);
  const { paint, raise } = frontPainter(m, f, 0);
  const zTop = H - corniceRows(fh);

  const { n: nb, spans } = bays(W, Math.round(W / (fine ? 3 : 2.5)), fine ? 2 : 1);

  // the street: the tenants' door between two shops
  const entry = W >= 5 && nb >= 2 ? (nb >= 3 ? Math.floor(nb / 2) : rand() < 0.5 ? 0 : nb - 1) : -1;
  const [e0, e1] = entry >= 0 ? spans[entry]! : [-9, -9];
  const band = fine ? 2 : 1;
  const zBand = fh - band; // the sign band's first row
  const shopDoors = new Set<number>();
  for (const [lo, hi] of [
    [1, e0 - 2],
    [e1 + 2, W - 2],
  ] as const)
    if (hi - lo >= 2) shopDoors.add(entry >= 0 && lo > e1 ? lo : hi); // beside the tenants' door
  for (let a = 0; a < W; a++) {
    const pier = a === 0 || a === W - 1 || a === e0 - 1 || a === e1 + 1;
    const inEntry = a >= e0 && a <= e1;
    for (let z = 1; z < fh; z++) {
      if (inEntry) paint(a, z, z === fh - 1 ? p.trim : z < zBand - (fine ? 1 : 0) ? p.accent : p.pane());
      else if (pier) paint(a, z, z >= zBand ? sign : p.trim);
      else if (z >= zBand) paint(a, z, sign);
      else if (shopDoors.has(a)) paint(a, z, p.accent);
      else paint(a, z, fine && z === 1 ? p.trim : p.pane());
    }
  }

  // a fire escape across two or three bays, clear of the door's bay where the front allows
  let [x0, x1] = [-1, -1];
  if (nb >= 2 && fh >= 4 && rand() < 0.85) {
    const n = Math.min(nb - (nb >= 3 ? 1 : 0), rand() < 0.5 ? 2 : 3);
    const b0 = entry >= 0 && entry < nb / 2 ? nb - n : 0;
    [x0, x1] = [Math.max(0, spans[b0]![0] - 1), Math.min(W - 1, spans[b0 + n - 1]![1] + 1)];
  }
  // the floors above: windows, with stone sills and lintels where no fire escape covers them
  for (let k = 1; k < floors; k++)
    for (const [a0, a1] of spans)
      for (let zf = 1; zf < fh; zf++) {
        const z = k * fh + zf;
        if (z >= zTop) break;
        const row = windowRow(zf, fh);
        for (let a = a0; a <= a1; a++)
          if (row === "glass") paint(a, z, p.pane());
          else if (row !== "wall" && (a < x0 || a > x1)) paint(a, z, p.trim);
      }
  if (x1 > x0) fireEscape(paint, x0, x1, fh, zTop, fh, p.iron, rand() < 0.5);
  bracketedCornice(paint, raise, W, H, fh, { cornice: p.cornice, frieze: p.body }, (a) => a % (fine ? 3 : 2) === 1);

  // the roof: a stair bulkhead, a water tank on the taller ones
  if (W >= 6 && f.maxDepth >= 8 && rand() < 0.6)
    bulkhead(m, f, H, fh, rand() < 0.5 ? 1 : W - 4, Math.floor(f.maxDepth * 0.3), 3, 3, { body: p.body, roof: p.roof, door: p.accent });
  const tank = tankMats(ctx, m, p);
  if (tank && floors >= 6 && rand() < 0.45) roofTanks(ctx, m, f, H, fh, 1, tank);

  // the sides; a corner lot's shop wraps round the corner
  const corner = hints?.corner === true;
  if (corner)
    eachSide(f, 1, (x, y, nx, ny, d, rear) => {
      if (rear) return;
      for (let z = 1; z < fh; z++)
        if (m.get(x, y, z) && !m.get(nx, ny, z)) m.set(x, y, z, z >= zBand ? sign : d % 4 === 0 ? p.trim : fine && z === 1 ? p.trim : p.pane());
    });
  sides(m, f, 0, fh, zTop, fh, p, corner);
  return m;
};

/**
 * A cast-iron loft (SoHo, Tribeca): 4–7 storeys whose street front is a grid
 * of iron columns and entablatures round big windows, painted cream, grey or
 * white, on brick party walls. The windows' heads are arched at the walking
 * scale; the ground floor is glass between the columns over a dark bulkhead.
 * On top, a cornice bracketed over every column, on some a raised pediment in
 * the middle; on the roof, on many, a water tank. Some carry a fire escape.
 * roles: wall (the front's paint, wall.* variants), trim (columns and
 * entablatures), side (the party walls; wall if absent), cornice, iron,
 * accent (doors), tank, roof, window, lit.
 */
export const castIronLoft: Generator = (ctx) => {
  const { rand, mask, hints } = ctx;
  if (!mask) throw new Error("castIronLoft needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const floors = storeys(ctx, Infinity, 4, 7, 4 + Math.floor(rand() * 4));
  const H = rowHeight(ctx, 40, floors);
  const fh = Math.max(3, Math.floor(H / floors));
  const fine = fh >= 6;
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  const sideRamps = ctx.ramps("side");
  const side = sideRamps.length ? m.material(pick(rand, sideRamps)) : p.body;
  massing(m, f, H, side, p.roof);
  const { paint, raise } = frontPainter(m, f, 0);
  const zTop = H - corniceRows(fh);
  for (let a = 0; a < W; a++) for (let z = 0; z < H; z++) paint(a, z, p.body);

  // the grid: a column every `slot` voxels, centred on the front
  const slot = fine ? 4 : 3;
  const nb = Math.max(1, Math.floor((W - 1) / slot));
  const off = Math.max(0, Math.floor((W - 1 - nb * slot) / 2));
  const column = (a: number) => W < 3 || a <= off || a >= off + nb * slot || (a - off) % slot === 0;
  const doorBay = Math.floor(nb / 2);
  for (let k = 0; k < floors; k++)
    for (let zf = 0; zf < fh; zf++) {
      const z = k * fh + zf;
      if (z >= zTop) break;
      for (let a = 0; a < W; a++) {
        if (column(a)) {
          paint(a, z, p.trim);
          continue;
        }
        const i = (a - off) % slot; // 1 … slot-1 across the bay
        if (zf === 0) {
          if (k > 0) paint(a, z, p.trim); // the entablature
          continue;
        }
        if (k === 0) {
          // the storefront: glass over a dark bulkhead, a door in the middle bay
          const door = Math.floor((a - off) / slot) === doorBay && i === Math.ceil(slot / 2) - (slot % 2 === 0 ? 0 : 1);
          if (zf === fh - 1) paint(a, z, p.trim);
          else if (door && zf < fh - 2) paint(a, z, p.accent);
          else paint(a, z, fine && zf === 1 ? p.iron : p.pane());
          continue;
        }
        if (fh >= 4 && zf === fh - 1) continue; // the spandrel under the next entablature
        // an arched head: the window's top corners stay wall
        if (fine && zf === fh - 2 && (i === 1 || i === slot - 1)) continue;
        paint(a, z, p.pane());
      }
    }
  if (nb >= 2 && fh >= 4 && rand() < 0.35) {
    const b0 = Math.floor(rand() * (nb - 1));
    fireEscape(paint, off + b0 * slot, off + (b0 + 2) * slot, fh, zTop, fh, p.iron, rand() < 0.5);
  }
  bracketedCornice(paint, raise, W, H, fh, { cornice: p.cornice, frieze: p.body }, column);
  // a raised pediment in the middle of some
  if (W >= 7 && rand() < 0.5) {
    const rise = W >= 14 && fine ? 2 : 1;
    for (let a = 0; a < W; a++) {
      const t = Math.abs(a - (W - 1) / 2) / (W / 2);
      for (let r = 1; r <= rise; r++) if (t < 0.45 - (r - 1) * 0.15) raise(a, H + r, p.cornice);
    }
  }
  if (W >= 6 && f.maxDepth >= 8 && rand() < 0.4)
    bulkhead(m, f, H, fh, W - 4, Math.floor(f.maxDepth * 0.25), 3, 3, { body: side, roof: p.roof, door: p.accent });
  const tank = tankMats(ctx, m, p);
  if (tank && rand() < 0.6) roofTanks(ctx, m, f, H, fh, 1, tank);
  sides(m, f, 0, 0, zTop, fh, p, hints?.corner === true);
  return m;
};

/**
 * A prewar apartment block (1900–1940), base, shaft and cap: one to three
 * storeys of stone with the entrance in a stone surround, a belt course, a
 * brick shaft of paired windows under lintels with quoins at its corners,
 * one or two storeys of stone or terracotta at the top under a heavy
 * bracketed cornice. Any height: storeys come from the record, else from the
 * height (param `storey`, voxels a storey, default 8, the walking level's).
 * On the roof, wooden water tanks on steel stands and, on most, an elevator
 * penthouse.
 * roles: wall (the shaft: wall.* variants), base (the stone base; trim if
 * absent), trim (the cap, lintels, belt courses), cornice, iron, accent
 * (doors), tank, roof, window, lit.
 */
export const prewarBlock: Generator = (ctx) => {
  const { rand, mask, hints } = ctx;
  if (!mask) throw new Error("prewarBlock needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = Math.max(6, Math.round(ctx.heightVox ?? ctx.param("height", 80)));
  const floors = storeys(ctx, H, 2, 400, Math.round(H / ctx.param("storey", 8)));
  const fh = Math.max(3, Math.floor(H / floors));
  const fine = fh >= 6;
  const m = modelFor(f, H, fh);
  const p = paints(ctx, m);
  const base = p.role("base", p.trim);
  massing(m, f, H, p.body, p.roof);
  const { paint, raise } = frontPainter(m, f, 0);
  const zTop = H - corniceRows(fh);
  const nBase = floors <= 4 ? 1 : floors <= 12 ? 2 : 3;
  const nCap = floors <= 5 ? 0 : floors <= 14 ? 1 : 2;
  const zBase = nBase * fh;
  const zCap = Math.max(zBase, (floors - nCap) * fh);

  // the stages' faces: a stone base, a brick shaft with quoins, a stone cap
  for (let a = 0; a < W; a++)
    for (let z = 0; z < H; z++) {
      const quoin = fine && (a === 0 || a === W - 1 || (Math.floor(z / 2) % 2 === 0 && (a === 1 || a === W - 2)));
      paint(a, z, z < zBase ? base : z >= zCap ? p.trim : quoin ? p.trim : p.body);
    }

  const slot = fine ? 4 : 3;
  const { n: nb, spans } = bays(W, Math.max(1, Math.round(W / slot)), fine ? 2 : 1);
  // the entrance: the middle bay, in a stone surround, at least three voxels wide at the walking scale
  const mid = Math.floor(nb / 2);
  const [m0, m1] = spans[mid]!;
  const d0 = fine && m1 - m0 < 2 ? Math.max(1, m0 - 1) : m0;
  const d1 = fine && m1 - m0 < 2 ? Math.min(W - 2, m1 + (m1 - m0 < 1 ? 1 : 0)) : m1;
  const shops = rand() < 0.35;
  for (let zf = 1; zf < fh && zf < zTop; zf++)
    for (let a = 0; a < W; a++) {
      if (a >= d0 && a <= d1) paint(a, zf, zf < fh - 2 ? p.accent : zf === fh - 2 ? p.pane() : p.trim);
      else if (fine && (a === d0 - 1 || a === d1 + 1)) paint(a, zf, p.trim);
      else if (spans.some(([s, e]) => a >= s && a <= e) || shops)
        paint(a, zf, shops ? (zf === fh - 1 ? p.trim : a === 0 || a === W - 1 ? base : p.pane()) : windowRow(zf, fh) === "glass" ? p.pane() : base);
    }
  // the floors above: windows under lintels, a belt course over the base and under the cap
  for (let k = 1; k < floors; k++) {
    const z0 = k * fh;
    if (z0 >= zTop) break;
    if ((z0 === zBase || z0 === zCap) && k < floors - 1) for (let a = 0; a < W; a++) paint(a, z0, z0 === zCap ? p.cornice : p.trim);
    const stone = z0 < zBase || z0 >= zCap;
    for (const [a0, a1] of spans)
      for (let zf = 1; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        const row = windowRow(zf, fh);
        for (let a = a0; a <= a1; a++) {
          if (row === "glass") paint(a, z, p.pane());
          else if (row !== "wall" && !stone) paint(a, z, p.trim);
        }
      }
  }
  bracketedCornice(paint, raise, W, H, fh, { cornice: p.cornice, frieze: p.trim }, (a) => a % slot === 0);

  // the roof: an elevator penthouse, wooden water tanks
  if (W >= 8 && f.maxDepth >= 8 && rand() < 0.7) {
    const w = Math.max(3, Math.round(W / 5));
    bulkhead(m, f, H, fh, Math.floor(W * 0.15), Math.floor(f.maxDepth * 0.3), w, Math.max(3, Math.round(f.maxDepth / 5)), { body: p.body, roof: p.roof, door: p.accent });
  }
  const tank = tankMats(ctx, m, p);
  if (tank) roofTanks(ctx, m, f, H, fh, W >= 24 && f.maxDepth >= 24 ? 2 : 1, tank);
  sides(m, f, 0, 0, zTop, fh, p, hints?.corner === true);
  return m;
};

export const BUILDING_GENERATORS: Record<string, Generator> = { brownstone, tenement, castIronLoft, prewarBlock };
