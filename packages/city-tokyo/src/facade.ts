import { VoxelModel, type GenContext } from "pixelworld/generators";

/**
 * A footprint seen from its street, and the parts Tokyo's fronts share: paint
 * schemes, window bays, side windows and roof penthouses. The footprint
 * helpers are New York's (`facade.ts` in @pixelworlds/city-nyc), copied
 * rather than imported so that each city pack stands alone. Everything stays
 * inside the footprint and nothing overhangs: what projects in life (a
 * balcony, a sign board) is drawn flush on the wall, or stands in front of a
 * wall set back to make room for it.
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

export function facadeOf(mask: Mask, front: number): Facade {
  const { sx, sy, on } = mask;
  const [fx, fy] = DIRS[front]!;
  const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const cells: [number, number][] = [];
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (on[y * sx + x]) cells.push([x, y]);
  // front-most first: a voxel's depth is its front neighbour's plus one
  cells.sort((a, b) => b[0] * fx + b[1] * fy - (a[0] * fx + a[1] * fy));
  const depth = new Int16Array(sx * sy).fill(-1);
  const along = new Int16Array(sx * sy).fill(-1);
  let maxDepth = 0;
  for (const [x, y] of cells) {
    const d = inMask(x + fx, y + fy) ? depth[(y + fy) * sx + x + fx]! + 1 : 0;
    depth[y * sx + x] = d;
    maxDepth = Math.max(maxDepth, d);
  }
  // along: left to right as seen from the street
  const lx = fy;
  const ly = -fx;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of cells) {
    const a = x * lx + y * ly;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  for (const [x, y] of cells) along[y * sx + x] = x * lx + y * ly - lo;
  return { sx, sy, depth, along, width: cells.length ? hi - lo + 1 : 0, maxDepth, front: [fx, fy] };
}

export const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The footprint the facade starts at depth `from`, filled to height H with `body` under a `roof` skin. */
export function massing(m: VoxelModel, f: Facade, H: number, body: number, roof: number, from = 0): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      if (f.depth[y * f.sx + x]! < from) continue;
      for (let z = 0; z < H - 1; z++) m.set(x, y, z, body);
      m.set(x, y, H - 1, roof);
    }
}

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
  /** Set (x, y, z) on the wall's columns at a, whatever is there, if the voxel below stands (a parapet). */
  const raise = (a: number, z: number, mat: number) => {
    for (const [x, y] of cols[a] ?? []) if (m.get(x, y, z - 1)) m.set(x, y, z, mat);
  };
  return { paint, raise, cols };
}

/**
 * Visit each exposed face of the walls other than the front, from depth
 * `from` back: the voxel column (x, y), its open neighbour (nx, ny), its depth
 * and whether it is the rear.
 */
export function eachSide(f: Facade, from: number, fn: (x: number, y: number, nx: number, ny: number, d: number, rear: boolean) => void): void {
  const [fx, fy] = f.front;
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const d = f.depth[y * f.sx + x]!;
      if (d < from) continue;
      for (const [dx, dy] of SIDES) {
        if (dx === fx && dy === fy) continue; // the front has its own
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.sx && ny < f.sy && f.depth[ny * f.sx + nx]! >= from) continue;
        fn(x, y, nx, ny, d, dx === -fx && dy === -fy);
      }
    }
}

/**
 * Windows on the walls other than the front (party walls where they show, the
 * rear, a corner lot's side street), every `every` voxels, one per storey of
 * fh from z0 up to below zTop: wall at the floor line and, on taller storeys,
 * a lintel.
 */
export function sideWindows(m: VoxelModel, f: Facade, from: number, z0: number, zTop: number, fh: number, pane: () => number, every: number): void {
  eachSide(f, from + 1, (x, y, nx, ny) => {
    if ((x + y) % every !== 0) return;
    for (let z = z0 + 1; z < zTop; z++) {
      const zf = (z - z0) % fh;
      if (zf === 0 || (fh >= 3 && zf === fh - 1) || (fh >= 6 && zf === 1)) continue;
      if (!m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
    }
  });
}

/**
 * A role's material in the body's scheme: when the role lists as many variants
 * as the wall (`wall.brick`, `trim.brick`: the lists are sorted by name, so
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
  const litFraction = ctx.param("litFraction", 0.3);
  return {
    body,
    trim,
    roof,
    glass,
    iron,
    cornice: role("cornice", trim),
    accent: role("accent", iron),
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

/** A stair bulkhead on the roof: a small box in the body's colour, a voxel of roof on top, a door toward the street. */
export function bulkhead(m: VoxelModel, f: Facade, H: number, fh: number, a0: number, d0: number, w: number, d: number, mats: { body: number; roof: number; door: number }): void {
  const h = Math.max(2, Math.round(fh * 0.8));
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const a = f.along[i]!;
      const dd = f.depth[i]!;
      if (dd < d0 || dd >= d0 + d || a < a0 || a >= a0 + w || !m.get(x, y, H - 1) || m.get(x, y, H)) continue;
      for (let z = H; z < H + h; z++) m.set(x, y, z, z === H + h - 1 ? mats.roof : mats.body);
      if (dd === d0 && a === a0 + Math.floor(w / 2)) for (let z = H; z < H + Math.min(h - 1, Math.max(1, Math.round(fh * 0.6))); z++) onFace(m, f, x, y, z, mats.door);
    }
}

/** March from (x, y) in steps of (dx, dy) while `inside`: how many steps stay in. */
export function run(inside: (x: number, y: number) => boolean, x: number, y: number, dx: number, dy: number): number {
  let n = 0;
  while (inside(x + (n + 1) * dx, y + (n + 1) * dy)) n++;
  return n;
}
