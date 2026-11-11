import { DIRECT_RAMP_BASE, FACE_LINE, FACE_OBJECT, MeshBuilder, type MeshData } from "./mesh";

/**
 * Small voxel models for procedural (and later hand-made .vox) objects.
 * Voxel values: 0 = empty, otherwise a material index into `materials`.
 * Axes: x east, y south, z up (same as the grid).
 */
export class VoxelModel {
  readonly data: Uint8Array;
  /**
   * One-pixel lines (D-095), in the model's voxel coordinates (fractions allowed),
   * each a material index as voxels have: drawn as lines, not voxels, so
   * something as thin as a wire stays a pixel wide at any angle. Unique and
   * instanced objects both draw them.
   */
  readonly lines: { a: [number, number, number]; b: [number, number, number]; m: number }[] = [];

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
    // `ctx.ramps(role)[0]` of a role the asset doesn't have would otherwise draw in no colour at all
    if (!(Number.isInteger(rampId) && rampId >= 0))
      throw new Error(
        `VoxelModel.material(${rampId}): not a ramp id. Was it ctx.ramps(role)[0] for a role the style asset doesn't have? ` +
          "ramps() is empty then; ramp(role) throws, naming the asset and the role.",
      );
    let i = this.materials.indexOf(rampId, 1);
    if (i < 0) {
      i = this.materials.length;
      this.materials.push(rampId);
    }
    return i;
  }

  /** A one-pixel line from a to b (voxel coordinates) in material m. */
  line(a: [number, number, number], b: [number, number, number], m: number): void {
    this.lines.push({ a, b, m });
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
 * A model's one-pixel lines (VoxelModel.lines, D-095) as line segments in
 * `mb`, placed as meshVoxels places its voxels (origin, scale), owned by
 * `cell`; build() it and mark it `primitive: "lines"`.
 */
export function meshLines(
  model: VoxelModel,
  scale: VoxelScale,
  origin: readonly [number, number, number],
  cell: readonly [number, number],
  mb: MeshBuilder = new MeshBuilder(),
): MeshBuilder {
  for (const l of model.lines)
    for (const p of [l.a, l.b])
      mb.vertex(
        [origin[0] + p[0] * scale.h, origin[1] + p[1] * scale.h, origin[2] + p[2] * scale.v],
        [0, 0, 1],
        DIRECT_RAMP_BASE + model.materials[l.m]!,
        FACE_LINE,
        1,
        cell[0],
        cell[1],
      );
  return mb;
}

/**
 * Mesh the visible faces of a voxel model, merging coplanar faces of the
 * same material into rectangles (greedy meshing). The model's (0, 0, 0)
 * corner sits at `origin` (world units); `cell` is the owning cell, or
 * "column" to give every voxel column the cell under it (objects bigger than
 * a bake tile's margin: each tile then bakes its own part, and faces are not
 * merged across cell lines).
 */
export function meshVoxels(
  model: VoxelModel,
  scale: VoxelScale,
  origin: readonly [number, number, number],
  cell: readonly [number, number] | "column",
  mb: MeshBuilder = new MeshBuilder(),
): MeshBuilder {
  const dims = [model.sx, model.sy, model.sz];
  const perColumn = cell === "column";
  const cellOf = (x: number, y: number): [number, number] => [
    Math.floor(origin[0] + (x + 0.5) * scale.h),
    Math.floor(origin[1] + (y + 0.5) * scale.h),
  ];
  // per-column ownership: an id per voxel column's cell, so faces only merge within a cell
  const colKey = perColumn ? new Int32Array(model.sx * model.sy) : null;
  if (colKey)
    for (let y = 0; y < model.sy; y++)
      for (let x = 0; x < model.sx; x++) {
        const [cx, cy] = cellOf(x, y);
        colKey[y * model.sx + x] = (cx & 0xffff) | ((cy & 0x7fff) << 16);
      }
  // For each axis d and direction (−/+), sweep slices and merge face masks.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    const mask = new Int32Array(du * dv);
    const owner = new Int32Array(du * dv);
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
            if (colKey) owner[j * du + i] = colKey[p[1]! * model.sx + p[0]!]!;
          }
        // greedy rectangles
        for (let j = 0; j < dv; j++)
          for (let i = 0; i < du; ) {
            const m = mask[j * du + i]!;
            if (!m) {
              i++;
              continue;
            }
            const o = owner[j * du + i]!;
            const same = (k: number) => mask[k] === m && owner[k] === o;
            let w = 1;
            while (i + w < du && same(j * du + i + w)) w++;
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (!same((j + h) * du + i + k)) break outer;
              h++;
            }
            for (let jj = 0; jj < h; jj++) for (let k = 0; k < w; k++) mask[(j + jj) * du + i + k] = 0;
            let own: readonly [number, number];
            if (perColumn) {
              const at = [0, 0, 0];
              at[d] = slice;
              at[u] = i;
              at[v] = j;
              own = cellOf(at[0]!, at[1]!);
            } else own = cell as readonly [number, number];
            emitFace(mb, d, u, v, dir, slice, i, j, w, h, model.materials[m]!, scale, origin, own);
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
