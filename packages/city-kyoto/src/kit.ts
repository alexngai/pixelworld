import type { GenContext, VoxelModel } from "pixelworld/generators";

/**
 * A footprint seen from its street, and distances across it, for Kyoto's
 * generators. The footprint helpers follow Paris's (copied rather than
 * imported, so each city pack stands alone). Typed buildings keep the
 * building rules: everything inside the footprint and every voxel on another,
 * so an eave doesn't project over the street; the wall under it stands back
 * instead, or the space under a deep eave is filled with its shadow.
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

export const N4 = [
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

export const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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

/** Each column's steps to the outside through its 4 neighbours (1 on a wall, 0 outside). */
export function edgeDistance(mask: Mask): Int16Array {
  const { sx, sy, on } = mask;
  const dist = new Int16Array(sx * sy);
  const queue: number[] = [];
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (inside(x, y) && N4.some(([dx, dy]) => !inside(x + dx, y + dy))) {
        dist[y * sx + x] = 1;
        queue.push(y * sx + x);
      }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    const x = i % sx;
    const y = (i - x) / sx;
    for (const [dx, dy] of N4) {
      const nx = x + dx;
      const ny = y + dy;
      if (inside(nx, ny) && dist[ny * sx + nx] === 0) {
        dist[ny * sx + nx] = dist[i]! + 1;
        queue.push(ny * sx + nx);
      }
    }
  }
  return dist;
}

/**
 * Each column's steps to the outside along one axis (1 on a wall, 0 outside):
 * along x (`axis` 0) or y (1), through the run of footprint it stands in.
 */
export function axisDistance(mask: Mask, axis: 0 | 1): Int16Array {
  const { sx, sy, on } = mask;
  const out = new Int16Array(sx * sy);
  const [n, len] = axis === 0 ? [sy, sx] : [sx, sy];
  const at = (line: number, k: number) => (axis === 0 ? line * sx + k : k * sx + line);
  for (let line = 0; line < n; line++) {
    let k = 0;
    while (k < len) {
      if (!on[at(line, k)]) {
        k++;
        continue;
      }
      const k0 = k;
      while (k < len && on[at(line, k)]) k++;
      for (let j = k0; j < k; j++) out[at(line, j)] = Math.min(j - k0, k - 1 - j) + 1;
    }
  }
  return out;
}

/** A w × h footprint, all of it on. */
export function rectMask(w: number, h: number): Mask {
  return { sx: w, sy: h, on: new Uint8Array(w * h).fill(1) };
}

/** Paint `mat` on (x, y, z) only if it shows toward the street (its front neighbour is empty). */
export function onFace(m: VoxelModel, f: Facade, x: number, y: number, z: number, mat: number): void {
  if (!m.get(x, y, z)) return;
  // a diagonal front shows through its axis neighbours
  const [fx, fy] = f.front;
  const open = (fx !== 0 && !m.get(x + fx, y, z)) || (fy !== 0 && !m.get(x, y + fy, z));
  if (open) m.set(x, y, z, mat);
}

/** A painter for the wall at depth d: paint(a, z, mat) paints the voxels at position a along it where they show. */
export function frontPainter(m: VoxelModel, f: Facade, d: number) {
  const cols: [number, number][][] = Array.from({ length: f.width }, () => []);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) if (f.depth[y * f.sx + x] === d) cols[f.along[y * f.sx + x]!]!.push([x, y]);
  return (a: number, z: number, mat: number) => {
    for (const [x, y] of cols[a] ?? []) onFace(m, f, x, y, z, mat);
  };
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
      for (const [dx, dy] of N4) {
        if (dx === fx && dy === fy) continue; // the front has its own
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.sx && ny < f.sy && f.depth[ny * f.sx + nx]! >= 0) continue;
        fn(x, y, nx, ny, d, dx === -fx && dy === -fy);
      }
    }
}

/**
 * A role's material in the body's scheme: when the role lists as many variants
 * as the wall (the lists are sorted by name, so they line up) it takes the
 * wall's; otherwise one by seed. `fallback` when the asset has none.
 */
export function schemeRole(ctx: GenContext, m: VoxelModel, k: number, walls: number, role: string, fallback: number): number {
  const xs = ctx.ramps(role);
  if (!xs.length) return fallback;
  return m.material(xs.length === walls ? xs[k]! : pick(ctx.rand, xs));
}

/** The top voxel's z of column (x, y), -1 if empty. */
export function topAt(m: VoxelModel, x: number, y: number): number {
  for (let z = m.sz - 1; z >= 0; z--) if (m.get(x, y, z)) return z;
  return -1;
}

/**
 * Window bays across a front W wide: up to n bays of `ww` voxels, centred in
 * equal slots, as many as leave a pier between them and at both ends.
 */
export function bays(W: number, want: number, ww: number): [number, number][] {
  const spans: [number, number][] = [];
  const n = Math.max(Math.min(want, 1), Math.min(want, Math.floor((W - 1) / (ww + 1))));
  if (n < 1 || W < 1) return spans;
  const slot = W / n;
  const w = Math.max(1, Math.min(ww, Math.floor(slot) - (slot >= 2 ? 1 : 0)));
  for (let i = 0; i < n; i++) {
    const s = Math.round(i * slot + (slot - w) / 2);
    spans.push([s, s + w - 1]);
  }
  return spans;
}
