import { DIRECT_RAMP_BASE, FACE_OBJECT, MeshBuilder, type MeshData } from "./mesh";

/**
 * Small voxel models for procedural (and later hand-made .vox) objects.
 * Voxel values: 0 = empty, otherwise a material index into `materials`.
 * Axes: x east, y south, z up (same as the grid).
 */
export class VoxelModel {
  readonly data: Uint8Array;

  constructor(
    readonly sx: number,
    readonly sy: number,
    readonly sz: number,
    /** Ramp id per material index (index 0 unused). */
    readonly materials: number[] = [0],
  ) {
    this.data = new Uint8Array(sx * sy * sz);
  }

  material(rampId: number): number {
    let i = this.materials.indexOf(rampId, 1);
    if (i < 0) {
      i = this.materials.length;
      this.materials.push(rampId);
    }
    return i;
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= 0 && y >= 0 && z >= 0 && x < this.sx && y < this.sy && z < this.sz;
  }

  get(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.data[(z * this.sy + y) * this.sx + x]! : 0;
  }

  set(x: number, y: number, z: number, m: number): void {
    if (this.inside(x, y, z)) this.data[(z * this.sy + y) * this.sx + x] = m;
  }

  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, m: number): void {
    for (let z = z0; z < z1; z++) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.set(x, y, z, m);
  }

  count(): number {
    let n = 0;
    for (const v of this.data) if (v) n++;
    return n;
  }
}

/** Size of one voxel in world units (cells horizontally, steps vertically). */
export interface VoxelScale {
  h: number;
  v: number;
}

/**
 * Mesh the visible faces of a voxel model, merging coplanar faces of the
 * same material into rectangles (greedy meshing). The model's (0, 0, 0)
 * corner sits at `origin` (world units); `cell` is the owning cell.
 */
export function meshVoxels(
  model: VoxelModel,
  scale: VoxelScale,
  origin: readonly [number, number, number],
  cell: readonly [number, number],
  mb: MeshBuilder = new MeshBuilder(),
): MeshBuilder {
  const dims = [model.sx, model.sy, model.sz];
  // For each axis d and direction (−/+), sweep slices and merge face masks.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    const mask = new Int32Array(du * dv);
    for (const dir of [-1, 1] as const) {
      for (let slice = 0; slice < dims[d]!; slice++) {
        mask.fill(0);
        const p = [0, 0, 0];
        const q = [0, 0, 0];
        q[d] = dir;
        for (let j = 0; j < dv; j++)
          for (let i = 0; i < du; i++) {
            p[d] = slice;
            p[u] = i;
            p[v] = j;
            const m = model.get(p[0]!, p[1]!, p[2]!);
            if (!m) continue;
            if (model.get(p[0]! + q[0]!, p[1]! + q[1]!, p[2]! + q[2]!)) continue;
            mask[j * du + i] = m;
          }
        // greedy rectangles
        for (let j = 0; j < dv; j++)
          for (let i = 0; i < du; ) {
            const m = mask[j * du + i]!;
            if (!m) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < du && mask[j * du + i + w] === m) w++;
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (mask[(j + h) * du + i + k] !== m) break outer;
              h++;
            }
            for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) mask[(j + jj) * du + i + k] = 0;
            emitFace(mb, d, u, v, dir, slice, i, j, w, h, model.materials[m]!, scale, origin, cell);
            i += w;
          }
      }
    }
  }
  return mb;
}

function emitFace(
  mb: MeshBuilder,
  d: number,
  u: number,
  v: number,
  dir: -1 | 1,
  slice: number,
  i: number,
  j: number,
  w: number,
  h: number,
  ramp: number,
  scale: VoxelScale,
  origin: readonly [number, number, number],
  cell: readonly [number, number],
): void {
  const plane = dir > 0 ? slice + 1 : slice;
  const corner = (a: number, b: number): [number, number, number] => {
    const c = [0, 0, 0];
    c[d] = plane;
    c[u] = a;
    c[v] = b;
    return [origin[0] + c[0]! * scale.h, origin[1] + c[1]! * scale.h, origin[2] + c[2]! * scale.v];
  };
  const n: [number, number, number] = [0, 0, 0];
  n[d] = dir;
  const a = corner(i, j);
  const b = corner(i + w, j);
  const c = corner(i + w, j + h);
  const e = corner(i, j + h);
  const mat = DIRECT_RAMP_BASE + ramp;
  for (const vtx of [a, b, c, a, c, e]) mb.vertex(vtx, n, mat, FACE_OBJECT, 1, cell[0], cell[1]);
}

/** Small deterministic PRNG (mulberry32) for generators. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function meshFromBuilder(mb: MeshBuilder): MeshData {
  return mb.build();
}
