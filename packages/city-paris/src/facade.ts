import type { GenContext, VoxelModel } from "pixelworld/generators";

/**
 * A footprint seen from its street, and the parts Paris's fronts share: paint
 * schemes, window bays, roofs that step in from the front and rear walls,
 * dormers and chimney stacks. The footprint helpers follow San Francisco's and
 * New York's (copied rather than imported, so each city pack stands alone).
 * Everything stays inside the footprint and nothing overhangs: what projects
 * in life (a balcony, a cornice) is painted flush on the wall, and a roof
 * steps inward layer by layer, so each voxel rests on the one below.
 */

export type Mask = NonNullable<GenContext["mask"]>;

/** The 8 grid directions, in 45° steps from +x (y grows south). */
const DIRS: readonly [number, number][] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

const SIDES = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A footprint seen from its street. */
export interface Facade {
  sx: number;
  sy: number;
  /** Steps back from the front wall (0 on it), -1 outside the footprint. */
  depth: Int16Array;
  /** Steps in from the rear wall (0 on it), -1 outside. */
  back: Int16Array;
  /** Position along the front (0 … width-1), -1 outside. */
  along: Int16Array;
  width: number;
  maxDepth: number;
  front: readonly [number, number];
}

/** Which way a footprint faces: the hint, else its narrow side toward +y. */
export function frontDir(mask: Mask, hint?: number): number {
  if (hint !== undefined && hint >= 0 && hint < 8) return hint;
  return mask.sx <= mask.sy ? 2 : 0;
}

/** Steps from the wall facing `dir`, per column (-1 outside), and the deepest. */
function stepsFrom(mask: Mask, dir: number): { depth: Int16Array; max: number } {
  const { sx, sy, on } = mask;
  const [fx, fy] = DIRS[dir]!;
  const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const cells: [number, number][] = [];
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (on[y * sx + x]) cells.push([x, y]);
  // front-most first: a voxel's depth is its front neighbour's plus one
  cells.sort((a, b) => b[0] * fx + b[1] * fy - (a[0] * fx + a[1] * fy));
  const depth = new Int16Array(sx * sy).fill(-1);
  let max = 0;
  for (const [x, y] of cells) {
    const d = inMask(x + fx, y + fy) ? depth[(y + fy) * sx + x + fx]! + 1 : 0;
    depth[y * sx + x] = d;
    max = Math.max(max, d);
  }
  return { depth, max };
}

export function facadeOf(mask: Mask, front: number): Facade {
  const { sx, sy, on } = mask;
  const [fx, fy] = DIRS[front]!;
  const { depth, max: maxDepth } = stepsFrom(mask, front);
  const { depth: back } = stepsFrom(mask, (front + 4) % 8);
  const along = new Int16Array(sx * sy).fill(-1);
  // along: left to right as seen from the street
  const lx = fy;
  const ly = -fx;
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (on[y * sx + x]) {
        lo = Math.min(lo, x * lx + y * ly);
        hi = Math.max(hi, x * lx + y * ly);
      }
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (on[y * sx + x]) along[y * sx + x] = x * lx + y * ly - lo;
  return { sx, sy, depth, back, along, width: hi >= lo ? hi - lo + 1 : 0, maxDepth, front: [fx, fy] };
}

export const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Paint `mat` on (x, y, z) only if it shows toward the street (its front neighbour is empty). */
export function onFace(m: VoxelModel, f: Facade, x: number, y: number, z: number, mat: number): void {
  if (!m.get(x, y, z)) return;
  // a diagonal front shows through its axis neighbours
  const [fx, fy] = f.front;
  const open = (fx !== 0 && !m.get(x + fx, y, z)) || (fy !== 0 && !m.get(x, y + fy, z));
  if (open) m.set(x, y, z, mat);
}

/** A painter for the front wall at depth d: paint(a, z, mat) paints the voxels at position a along it where they show. */
export function frontPainter(m: VoxelModel, f: Facade, d: number) {
  const cols: [number, number][][] = Array.from({ length: f.width }, () => []);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) if (f.depth[y * f.sx + x] === d) cols[f.along[y * f.sx + x]!]!.push([x, y]);
  const paint = (a: number, z: number, mat: number) => {
    for (const [x, y] of cols[a] ?? []) onFace(m, f, x, y, z, mat);
  };
  /** Set (x, y, z) on the wall's columns at a, whatever is there, if the voxel below stands (a lip, a parapet). */
  const raise = (a: number, z: number, mat: number) => {
    for (const [x, y] of cols[a] ?? []) if (m.get(x, y, z - 1)) m.set(x, y, z, mat);
  };
  return { paint, raise, cols };
}

/**
 * Visit each exposed face of the walls other than the front: the voxel column
 * (x, y), its open neighbour (nx, ny), its depth and whether it is the rear.
 */
export function eachSide(f: Facade, fn: (x: number, y: number, nx: number, ny: number, d: number, rear: boolean) => void): void {
  const [fx, fy] = f.front;
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const d = f.depth[y * f.sx + x]!;
      if (d < 0) continue;
      for (const [dx, dy] of SIDES) {
        if (dx === fx && dy === fy) continue; // the front has its own
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.sx && ny < f.sy && f.depth[ny * f.sx + nx]! >= 0) continue;
        fn(x, y, nx, ny, d, dx === -fx && dy === -fy);
      }
    }
}

/**
 * Windows on the walls other than the front, one per storey from the storey
 * bases `floors` up to below zTop: on the rear (courtyard) every `rear`
 * voxels, on the sides only on a corner lot (every `side`; a party wall stays
 * blank). Wall at the floor line and, on taller storeys, at the lintel.
 */
export function backWindows(m: VoxelModel, f: Facade, floors: readonly number[], zTop: number, pane: () => number, rear: number, side: number): void {
  const fh = floors.length > 1 ? floors[1]! - floors[0]! : zTop;
  eachSide(f, (x, y, nx, ny, d, isRear) => {
    if (d < 1 && !isRear) return;
    const every = isRear ? rear : side;
    if (every <= 0 || (x + y) % every !== 0) return;
    for (const z0 of floors)
      for (let zf = 1; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop || (fh >= 4 && zf === fh - 1)) break;
        if (!m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
      }
  });
}

/**
 * A role's material in the body's scheme: when the role lists as many variants
 * as the wall (`wall.warm`, `trim.warm`: the lists are sorted by name, so
 * they line up) it takes the wall's; otherwise one by seed. `fallback` when
 * the asset has none.
 */
export function schemeRole(ctx: GenContext, m: VoxelModel, k: number, walls: number, role: string, fallback: number): number {
  const xs = ctx.ramps(role);
  if (!xs.length) return fallback;
  return m.material(xs.length === walls ? xs[k]! : pick(ctx.rand, xs));
}

/** The materials of a front: a body from the wall variants, the roles that follow it, glass and lit glass. */
export function paints(ctx: GenContext, m: VoxelModel) {
  const { rand, ramp, ramps } = ctx;
  const walls = ramps("wall");
  const k = Math.floor(rand() * walls.length);
  const body = m.material(walls[k]!);
  const role = (name: string, fallback: number) => schemeRole(ctx, m, k, walls.length, name, fallback);
  const trim = role("trim", body);
  const roofs = ramps("roof");
  const roof = m.material(roofs.length ? pick(rand, roofs) : ramp("roof"));
  const glass = m.material(ramp("window"));
  const lits = ramps("lit");
  const lit = lits.length ? m.material(pick(rand, lits)) : glass;
  const iron = role("iron", trim);
  const shop = role("shop", iron);
  const litFraction = ctx.param("litFraction", 0.3);
  return {
    body,
    trim,
    roof,
    glass,
    iron,
    shop,
    door: role("door", shop),
    cornice: role("cornice", trim),
    role,
    pane: () => (rand() < litFraction ? lit : glass),
  };
}
export type Paints = ReturnType<typeof paints>;

/**
 * Window bays across a front W wide: up to n bays of `ww` voxels, centred in
 * equal slots, as many as leave a pier between them and at both ends.
 * bayOf(a) is the bay at position a, or -1 on a pier.
 */
export function bays(W: number, want: number, ww: number): { n: number; bayOf: Int16Array; spans: [number, number][] } {
  const bayOf = new Int16Array(Math.max(0, W)).fill(-1);
  const spans: [number, number][] = [];
  const n = Math.max(Math.min(want, 1), Math.min(want, Math.floor((W - 1) / (ww + 1))));
  if (n < 1 || W < 1) return { n: 0, bayOf, spans };
  const slot = W / n;
  const w = Math.max(1, Math.min(ww, Math.floor(slot) - (slot >= 2 ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    const s = Math.round(i * slot + (slot - w) / 2);
    spans.push([s, s + w - 1]);
    for (let a = s; a < s + w && a < W; a++) bayOf[a] = i;
  }
  return { n, bayOf, spans };
}

/**
 * Fill the footprint to height Hw with `body`, then a roof of `roof` from Hw up
 * to at most Hr more: a column stays while it is at least inset(z) steps from
 * both the front and the rear wall (a mansard's brisis, a pitched roof's
 * slopes; the party walls rise straight). Its top layer is roof. inset grows
 * with z, so each layer stands on the one below.
 */
export function wallsAndRoof(m: VoxelModel, f: Facade, Hw: number, Hr: number, body: number, roof: number, inset: (dz: number) => number): void {
  const top = new Int16Array(f.sx * f.sy).fill(-1);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! < 0) continue;
      const d = Math.min(f.depth[i]!, f.back[i]!);
      let z = 0;
      for (; z < Hw; z++) m.set(x, y, z, body);
      for (; z < Hw + Hr && d >= inset(z - Hw); z++) m.set(x, y, z, roof);
      top[i] = z - 1;
    }
  // the skin of the walls' top: the roof's material where nothing stands on it
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const t = top[y * f.sx + x]!;
      if (t >= 0 && t === Hw - 1 && Hr > 0) m.set(x, y, t, roof);
    }
}

/**
 * A dormer in the roof over the bay [a0, a1], its face at depth d0 (where the
 * roof starts), standing on the wall top at Hw: a sill, glass, a lintel and a
 * small cap, filled back into the roof so every voxel rests on another.
 */
export function dormer(m: VoxelModel, f: Facade, a0: number, a1: number, d0: number, Hw: number, h: number, mats: { frame: number; cap: number; pane: () => number }): void {
  if (h < 3 || a0 < 1 || a1 > f.width - 2) return;
  // it runs back until the roof is as high as it (at most 4 voxels)
  const stop = new Int16Array(f.width).fill(d0 + 4);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const a = f.along[i]!;
      if (a >= 0 && f.depth[i]! >= d0 && m.get(x, y, Hw + h - 1)) stop[a] = Math.min(stop[a]!, f.depth[i]!);
    }
  const panes: [number, number, number][] = [];
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const a = f.along[i]!;
      const d = f.depth[i]!;
      if (a < a0 - 1 || a > a1 + 1 || d < d0 || d >= Math.min(...stop.subarray(a0 - 1, a1 + 2)) || !m.get(x, y, Hw - 1)) continue;
      const cheek = a < a0 || a > a1;
      for (let z = Hw; z < Hw + h; z++) {
        if (z > Hw && !m.get(x, y, z - 1)) break;
        const k = z - Hw;
        m.set(x, y, z, k === h - 1 ? mats.cap : mats.frame);
        if (d === d0 && !cheek && k >= 1 && k < h - 2) panes.push([x, y, z]);
      }
    }
  // the glass where it shows (on a diagonal front, a column at d0 can be closed in)
  for (const [x, y, z] of panes) onFace(m, f, x, y, z, mats.pane());
}

/** The top voxel's z of column (x, y), -1 if empty. */
export function topAt(m: VoxelModel, x: number, y: number): number {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
}

/**
 * A chimney stack of `body` on the roof at column (x, y), up `h` voxels from
 * its top, with a terracotta pot on it. Returns whether it was drawn.
 */
export function chimney(m: VoxelModel, x: number, y: number, h: number, mats: { body: number; pot: number }, pot: boolean): boolean {
  const t = topAt(m, x, y);
  if (t < 0 || t + h + 2 > m.sz) return false;
  for (let z = t + 1; z <= t + h; z++) m.set(x, y, z, mats.body);
  if (pot) m.set(x, y, t + h + 1, mats.pot);
  return true;
}

/** The column at (along a, depth d), if the footprint has one. */
export function columnAt(f: Facade, a: number, d: number): [number, number] | null {
  for (let y = 0; y < f.sy; y++) for (let x = 0; x < f.sx; x++) if (f.along[y * f.sx + x] === a && f.depth[y * f.sx + x] === d) return [x, y];
  return null;
}
