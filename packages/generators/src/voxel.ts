import { DIRECT_RAMP_BASE, FACE_LINE, FACE_OBJECT, FACE_TEXELS, MeshBuilder, type MeshData } from "./mesh";

/**
 * Small voxel models for procedural (and later hand-made .vox) objects.
 * Voxel values: 0 = empty, otherwise a material index into `materials`.
 * Axes: x east, y south, z up (same as the grid).
 */
export class VoxelModel {
  readonly data: Uint8Array;
  /**
   * One-pixel lines (D-098), in the model's voxel coordinates (fractions allowed),
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
 * A model's one-pixel lines (VoxelModel.lines, D-098) as line segments in
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
 * merged across cell lines). A builder with texels merges coplanar faces of
 * any material, keeping each voxel face's colour as a texel: a facade of
 * windows is then one rectangle, not one per window.
 */
export function meshVoxels(
  model: VoxelModel,
  scale: VoxelScale,
  origin: readonly [number, number, number],
  cell: readonly [number, number] | "column",
  mb: MeshBuilder = new MeshBuilder(),
): MeshBuilder {
  const dims = [model.sx, model.sy, model.sz];
  const data = model.data;
  const perColumn = cell === "column";
  const texels = mb.texels;
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
  // Each column is solid from the ground up to `run` and empty from `top` up. Between two
  // columns, below both their runs, no face can show; above a column's top there is nothing.
  // So the sweeps visit each column's band from run to top, not the whole box (D-010 towers
  // are mostly solid inside), and the greedy pass each row's span that holds faces.
  const { sx, sy, sz } = model;
  const layer = sx * sy;
  const run = new Int32Array(layer);
  const top = new Int32Array(layer);
  {
    // layer by layer, so the voxels are read in order
    const alive = new Int32Array(layer);
    let n = 0;
    for (let c = 0; c < layer; c++) if (data[c]) alive[n++] = c;
    for (let z = 0; n; z++) {
      let m = 0;
      for (let a = 0; a < n; a++) {
        const c = alive[a]!;
        run[c] = z + 1;
        if (z + 1 < sz && data[(z + 1) * layer + c]) alive[m++] = c;
      }
      n = m;
    }
    let zt = sz; // above the highest layer with anything
    for (; zt > 0; zt--) {
      let any = false;
      for (let k = (zt - 1) * layer, e = k + layer; k < e && !any; k++) any = data[k] !== 0;
      if (any) break;
    }
    n = 0;
    for (let c = 0; c < layer; c++) alive[n++] = c;
    for (let z = zt - 1; z >= 0 && n; z--) {
      let m = 0;
      for (let a = 0, base = z * layer; a < n; a++) {
        const c = alive[a]!;
        if (data[base + c]) top[c] = z + 1;
        else alive[m++] = c;
      }
      n = m;
    }
  }
  // the voxels that may have a face up or down, by layer: a column's bottom, the top of its run, and its band above
  let total = 0;
  for (let c = 0; c < layer; c++) total += 2 + Math.max(0, top[c]! - run[c]!);
  const atZ = new Int32Array(total);
  const zOf = new Int32Array(total);
  let nz = 0;
  for (let c = 0; c < layer; c++) {
    const r = run[c]!;
    if (r > 0) {
      atZ[nz] = c;
      zOf[nz++] = 0;
      if (r > 1) {
        atZ[nz] = c;
        zOf[nz++] = r - 1;
      }
    }
    for (let z = r, k = r * layer + c; z < top[c]!; z++, k += layer)
      if (data[k]) {
        atZ[nz] = c;
        zOf[nz++] = z;
      }
  }
  const zStart = new Int32Array(sz + 1);
  for (let a = 0; a < nz; a++) zStart[zOf[a]! + 1]!++;
  for (let z = 0; z < sz; z++) zStart[z + 1]! += zStart[z]!;
  const byZ = new Int32Array(nz);
  {
    const fill = zStart.slice(0, sz);
    for (let a = 0; a < nz; a++) byZ[fill[zOf[a]!]!++] = atZ[a]!;
  }
  // For each axis d and direction (−/+), sweep slices and merge face masks.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    const nd = dims[d]!;
    const mask = new Int32Array(du * dv); // left all zero by the greedy pass after each slice
    const owner = new Int32Array(du * dv);
    const lo = new Int32Array(dv); // per row: the span of i holding faces
    const hi = new Int32Array(dv);
    for (const dir of [-1, 1] as const) {
      for (let slice = 0; slice < nd; slice++) {
        lo.fill(du);
        hi.fill(0);
        // the neighbour across the face, when it is inside the model (outside is empty)
        const inside = slice + dir >= 0 && slice + dir < nd;
        let faces = false;
        const put = (i: number, j: number, m: number, c: number) => {
          const at = j * du + i;
          mask[at] = m;
          if (colKey) owner[at] = colKey[c]!;
          if (i < lo[j]!) lo[j] = i;
          if (i >= hi[j]!) hi[j] = i + 1;
          faces = true;
        };
        if (d === 2) {
          const across = dir * layer;
          for (let a = zStart[slice]!, e = zStart[slice + 1]!; a < e; a++) {
            const c = byZ[a]!;
            const k = slice * layer + c;
            const m = data[k]!;
            if (!m || (inside && data[k + across])) continue;
            put(c % sx, Math.floor(c / sx), m, c);
          }
        } else {
          // x slices (faces along y and z) or y slices (along z and x), column by column
          const across = d === 0 ? dir : dir * sx;
          for (let w = 0; w < (d === 0 ? sy : sx); w++) {
            const c = d === 0 ? w * sx + slice : slice * sx + w;
            const from = inside ? Math.min(run[c]!, run[c + across]!) : 0;
            for (let z = from, k = from * layer + c; z < top[c]!; z++, k += layer) {
              const m = data[k]!;
              if (!m || (inside && data[k + across])) continue;
              if (d === 0) put(w, z, m, c);
              else put(z, w, m, c);
            }
          }
        }
        if (!faces) continue;
        // greedy rectangles: of one material, or with texels of any
        for (let j = 0; j < dv; j++)
          for (let i = lo[j]!; i < hi[j]!; ) {
            const m = mask[j * du + i]!;
            if (!m) {
              i++;
              continue;
            }
            const o = owner[j * du + i]!;
            const same = texels ? (k: number) => mask[k] !== 0 && owner[k] === o : (k: number) => mask[k] === m && owner[k] === o;
            let w = 1;
            while (i + w < du && same(j * du + i + w)) w++;
            let h = 1;
            outer: while (j + h < dv) {
              for (let k = 0; k < w; k++) if (!same((j + h) * du + i + k)) break outer;
              h++;
            }
            // several colours: one texel per voxel face, row by row
            let tex: [number, number, number] | null = null;
            if (texels)
              for (let jj = 0; jj < h && !tex; jj++)
                for (let k = 0; k < w; k++)
                  if (mask[(j + jj) * du + i + k] !== m) {
                    tex = [mb.reserveTexels(w * h), w, h];
                    break;
                  }
            if (tex) {
              const out = mb.texelData;
              for (let jj = 0; jj < h; jj++)
                for (let k = 0; k < w; k++) {
                  const ramp = model.materials[mask[(j + jj) * du + i + k]!]!;
                  if (ramp > 255) throw new Error(`meshVoxels: ramp id ${ramp} doesn't fit a texel (at most 255)`);
                  out[tex[0] + jj * w + k] = ramp;
                }
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
            emitFace(mb, d, u, v, dir, slice, i, j, w, h, model.materials[m]!, scale, origin, own, tex);
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
  texels: readonly [number, number, number] | null = null,
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
  if (!texels) {
    for (const vtx of [a, b, c, a, c, e]) mb.vertex(vtx, n, DIRECT_RAMP_BASE + ramp, FACE_OBJECT, 1, cell[0], cell[1]);
    return;
  }
  // texel (k, jj) is the voxel face k along u and jj along v from (i, j)
  const uvs = [[0, 0], [w, 0], [w, h], [0, 0], [w, h], [0, h]] as const;
  [a, b, c, a, c, e].forEach((vtx, q) =>
    mb.vertex(vtx, n, FACE_TEXELS, FACE_OBJECT, 1, cell[0], cell[1], { faceU: uvs[q]![0], faceV: uvs[q]![1], texels }),
  );
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
