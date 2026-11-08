import { MeshBuilder, type MeshData } from "./mesh";
import { VoxelModel, meshVoxels, rng, type VoxelScale } from "./voxel";

/**
 * Procedural assets for semantic groups (D-030). A style pack maps group
 * names to a generator and its parameters; the pipeline only names groups.
 *
 * Objects use a fixed pixel scale: one voxel is a 2×1 px top and 1 px tall
 * at native zoom, whatever the map's layout scale (object scale, D-010).
 */

/** An object placed by the pipeline (world cell coordinates). */
export interface ObjectInstance {
  /** Semantic group, e.g. "tree.conifer" or "building.tower". */
  g: string;
  x: number;
  y: number;
  /** Seed: picks the variant and drives the generator. */
  s: number;
  /** Quarter turns (vegetation only). */
  r?: number;
  /** Footprint polygon in world cells (buildings). */
  fp?: [number, number][];
  /** Real height in metres (buildings, landmarks). */
  hm?: number;
}

/** Style-pack entry for a group: generator name, role → ramp name, parameters. */
export interface AssetSpec {
  generator: string;
  ramps: Record<string, string>;
  params?: Record<string, number | number[]>;
}

export type AssetCatalog = Record<string, AssetSpec>;

/** Find the spec for a group by longest dotted prefix ("tree.conifer.ponderosa" → "tree.conifer"). */
export function resolveAsset(catalog: AssetCatalog, group: string): AssetSpec | null {
  for (let g = group; g; g = g.includes(".") ? g.slice(0, g.lastIndexOf(".")) : "") {
    const spec = catalog[g];
    if (spec) return spec;
  }
  return null;
}

interface GenContext {
  rand: () => number;
  ramp: (role: string) => number;
  /** Ramp ids of every role named `role` or `role.<variant>` (e.g. wall, wall.gold). */
  ramps: (role: string) => number[];
  param: (name: string, fallback: number) => number;
  /** Footprint mask in voxels (buildings). */
  mask?: { sx: number; sy: number; on: Uint8Array };
  /** Target height in voxels (buildings, landmarks). */
  heightVox?: number;
}

type Generator = (ctx: GenContext) => VoxelModel;

const GENERATORS: Record<string, Generator> = {
  conifer: ({ rand, ramp, param }) => {
    const h = Math.round(param("minHeight", 7) + rand() * param("heightJitter", 4));
    const r0 = param("radius", 2);
    const m = new VoxelModel(2 * r0 + 1, 2 * r0 + 1, h + 1);
    const crown = m.material(ramp("crown"));
    const trunk = m.material(ramp("trunk"));
    m.fill(r0, r0, 0, r0 + 1, r0 + 1, 2, trunk);
    for (let z = 2; z <= h; z++) {
      const t = (z - 2) / Math.max(1, h - 2);
      const tier = (h - z) % 3 === 0 ? 0.6 : 0; // layered skirts
      const rr = Math.max(0, Math.round(r0 * (1 - t) + tier + (rand() - 0.5) * 0.5));
      for (let y = -rr; y <= rr; y++)
        for (let x = -rr; x <= rr; x++) if (Math.abs(x) + Math.abs(y) <= rr + (rr > 1 ? 1 : 0)) m.set(r0 + x, r0 + y, z, crown);
    }
    m.set(r0, r0, h, crown);
    return m;
  },

  blob: ({ rand, ramp, param }) => {
    const rx = param("radius", 1.5) + rand() * param("radiusJitter", 0.4);
    const rz = param("height", 1.6) + rand() * 0.4;
    const trunkH = param("trunk", 1);
    const size = Math.ceil(rx) * 2 + 1;
    const c = (size - 1) / 2;
    const m = new VoxelModel(size, size, Math.ceil(trunkH + 2 * rz) + 1);
    const body = m.material(ramp("body"));
    if (trunkH > 0) m.fill(Math.floor(c), Math.floor(c), 0, Math.floor(c) + 1, Math.floor(c) + 1, trunkH, m.material(ramp("trunk")));
    const holes = param("holes", 0.12);
    for (let z = 0; z < m.sz; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) {
          const d = ((x - c) / rx) ** 2 + ((y - c) / rx) ** 2 + ((z - trunkH - rz) / rz) ** 2;
          if (d <= 1 && rand() > holes) m.set(x, y, z, body);
        }
    return m;
  },

  palm: ({ rand, ramp, param }) => {
    const h = Math.round(param("minHeight", 8) + rand() * param("heightJitter", 3));
    const reach = Math.round(param("reach", 3));
    const size = 2 * reach + 3;
    const m = new VoxelModel(size, size, h + 2);
    const trunk = m.material(ramp("trunk"));
    const frond = m.material(ramp("fronds"));
    const c = reach + 1;
    const lean = rand() < 0.5 ? 1 : 0;
    for (let z = 0; z < h; z++) m.set(c + (z > h / 2 ? lean : 0), c, z, trunk);
    const tx = c + lean;
    m.set(tx, c, h, frond);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]] as const;
    for (const [dx, dy] of dirs) {
      const len = dx && dy ? reach - 1 : reach;
      for (let k = 1; k <= len; k++) m.set(tx + dx * k, c + dy * k, h - (k === len ? 1 : 0), frond);
    }
    return m;
  },

  boulder: ({ rand, ramp }) => {
    const sx = 2 + Math.floor(rand() * 2);
    const sy = 2 + Math.floor(rand() * 2);
    const m = new VoxelModel(sx, sy, 2);
    const rock = m.material(ramp("rock"));
    m.fill(0, 0, 0, sx, sy, 1, rock);
    if (rand() < 0.6) m.set(Math.floor(rand() * sx), Math.floor(rand() * sy), 1, rock);
    return m;
  },

  /** Extruded footprint; `style` picks roof and facade treatment. */
  building: ({ rand, ramp, ramps, param, mask, heightVox }) => {
    if (!mask) throw new Error("building generator needs a footprint");
    const style = param("style", 0); // 0 residential, 1 low-rise, 2 tower
    const H = Math.max(1, Math.round(heightVox ?? param("defaultHeight", 2)));
    const roofExtra = style === 0 ? Math.ceil(Math.min(mask.sx, mask.sy) / 2) : 2;
    const m = new VoxelModel(mask.sx, mask.sy, H + roofExtra + 1);
    const walls = ramps("wall");
    const wall = m.material(walls[Math.floor(rand() * walls.length)]!);
    const roof = m.material(ramp("roof"));
    const window = m.material(ramp("window"));
    // Lit windows look like glass by day and glow at night (emissive ramp).
    const litRamps = ramps("lit");
    const lit = litRamps.length ? m.material(litRamps[Math.floor(rand() * litRamps.length)]!) : window;
    const litFraction = param("litFraction", 0.35);
    const pane = () => (rand() < litFraction ? lit : window);
    // Optional neon trim along the top of the walls (signature lighting).
    const trims = ramps("trim");
    const trim = trims.length ? m.material(trims[Math.floor(rand() * trims.length)]!) : wall;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.sx && y < mask.sy && mask.on[y * mask.sx + x] === 1;
    const edge = (x: number, y: number) => !on(x - 1, y) || !on(x + 1, y) || !on(x, y - 1) || !on(x, y + 1);
    for (let y = 0; y < mask.sy; y++)
      for (let x = 0; x < mask.sx; x++) {
        if (!on(x, y)) continue;
        for (let z = 0; z < H; z++) {
          let mat = wall;
          if (edge(x, y) && z > 0) {
            if (style === 2 && z % 2 === 1 && (x + y) % 2 === 0) mat = pane();
            if (style === 1 && z === Math.max(1, Math.floor(H / 2)) && (x + y) % 2 === 0) mat = pane();
            if (style === 0 && z === 0) mat = wall;
          }
          m.set(x, y, z, mat);
        }
        if (style === 1 && edge(x, y)) m.set(x, y, H, trim); // parapet
        else if (style === 1) m.set(x, y, H - 1, roof);
        if (style === 2) m.set(x, y, H - 1, edge(x, y) ? trim : roof);
      }
    if (style === 0) {
      // hip roof: inset one voxel per layer
      for (let k = 0; k < roofExtra; k++)
        for (let y = k; y < mask.sy - k; y++)
          for (let x = k; x < mask.sx - k; x++) {
            let inner = true;
            for (let dy = -k; dy <= k && inner; dy++) for (let dx = -k; dx <= k && inner; dx++) if (!on(x + dx, y + dy)) inner = false;
            if (inner) m.set(x, y, H + k, roof);
          }
    }
    if (style === 2 && mask.sx > 2 && mask.sy > 2) {
      // crown: a smaller block on the roof
      const cx0 = Math.floor(mask.sx / 3);
      const cy0 = Math.floor(mask.sy / 3);
      for (let y = cy0; y < mask.sy - cy0; y++)
        for (let x = cx0; x < mask.sx - cx0; x++) if (on(x, y)) m.fill(x, y, H, x + 1, y + 1, H + 2, wall);
    }
    return m;
  },

  observationTower: ({ ramp, param, heightVox }) => {
    const H = Math.round(heightVox ?? param("height", 48));
    const R = 6;
    const size = 2 * R + 1;
    const m = new VoxelModel(size, size, H + 6);
    const concrete = m.material(ramp("structure"));
    const glass = m.material(ramp("window"));
    const accent = m.material(ramp("accent"));
    const c = R;
    const disc = (z: number, r: number, mat: number, ring?: number) => {
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y);
          if (d <= r + 0.3) m.set(c + x, c + y, z, ring !== undefined && d > r - 0.8 ? ring : mat);
        }
    };
    const podZ = Math.round(H * 0.82);
    for (let z = 0; z < podZ; z++) disc(z, z < 4 ? 2 : 1, concrete);
    for (const [lx, ly] of [[-4, 2], [4, 2], [0, -4]] as const) {
      for (let z = 0; z < Math.round(H * 0.25); z++) {
        const t = z / (H * 0.25);
        m.set(c + Math.round(lx * (1 - t)), c + Math.round(ly * (1 - t)), z, concrete);
      }
    }
    disc(podZ, 4, concrete);
    disc(podZ + 1, 5, concrete, glass);
    disc(podZ + 2, 5, concrete, glass);
    disc(podZ + 3, 4, concrete, accent);
    disc(podZ + 4, 3, concrete);
    for (let z = podZ + 5; z < H + 6; z++) m.set(c, c, z, accent);
    return m;
  },

  /** Round stone tower with crenellations and slit windows; optional low round room at its foot. */
  lookoutTower: ({ rand, ramp, param, heightVox }) => {
    const H = Math.round(heightVox ?? param("height", 16));
    const R = param("radius", 2.5);
    const KR = param("roomRadius", 0); // 0 = no room
    const KH = Math.max(1, Math.round(H * 0.2));
    const tr = Math.ceil(R);
    const kr = Math.ceil(KR);
    const sx = 2 * tr + 1 + (KR > 0 ? kr + 1 : 0);
    const sy = Math.max(2 * tr + 1, 2 * kr + 1);
    const m = new VoxelModel(sx, sy, H + 2);
    const stone = m.material(ramp("stone"));
    const dark = m.material(ramp("detail"));
    const cx = tr;
    const cy = Math.floor(sy / 2);
    for (let z = 0; z < H; z++) {
      const r = z > H * 0.75 ? R + 0.4 : R; // slight flare under the parapet
      for (let y = -tr - 1; y <= tr + 1; y++)
        for (let x = -tr - 1; x <= tr + 1; x++) {
          const d = Math.hypot(x, y);
          if (d > r + 0.2) continue;
          const shell = d > r - 1;
          const slit = shell && z % 4 === 2 && z > 1 && (x === 0 || y === 0);
          const band = shell && z === Math.round(H * 0.8);
          m.set(cx + x, cy + y, z, slit || band ? dark : rand() < 0.06 ? dark : stone);
        }
    }
    for (let y = -tr - 1; y <= tr + 1; y++)
      for (let x = -tr - 1; x <= tr + 1; x++) {
        const d = Math.hypot(x, y);
        if (d <= R + 0.6 && d > R - 0.6 && (x + y) % 2 === 0) m.set(cx + x, cy + y, H, stone); // crenellation
      }
    if (KR > 0) {
      const kx = cx + tr + 1;
      for (let z = 0; z < KH; z++)
        for (let y = -kr; y <= kr; y++)
          for (let x = -kr; x <= kr; x++)
            if (Math.hypot(x, y) <= KR + 0.2) m.set(kx + x, cy + y, z, z === KH - 1 && Math.hypot(x, y) > KR - 1 ? dark : stone);
    }
    return m;
  },

  sign: ({ ramp, param }) => {
    const w = Math.round(param("width", 9));
    const hgt = Math.round(param("height", 7));
    const post = Math.round(param("post", 3));
    const m = new VoxelModel(w, 1, post + hgt);
    const panel = m.material(ramp("panel"));
    const neon = m.material(ramp("neon"));
    const pole = m.material(ramp("post"));
    m.fill(1, 0, 0, 2, 1, post, pole);
    m.fill(w - 2, 0, 0, w - 1, 1, post, pole);
    const cx = (w - 1) / 2;
    const cz = (hgt - 1) / 2;
    for (let z = 0; z < hgt; z++)
      for (let x = 0; x < w; x++) {
        const d = Math.abs(x - cx) / (w / 2) + Math.abs(z - cz) / (hgt / 2);
        if (d <= 1.05) m.set(x, 0, post + z, d > 0.75 ? neon : panel);
      }
    return m;
  },
};

/** Rotate a model by quarter turns around the vertical axis. */
export function rotateModel(model: VoxelModel, quarters: number): VoxelModel {
  let m = model;
  for (let q = 0; q < (((quarters % 4) + 4) % 4); q++) {
    const out = new VoxelModel(m.sy, m.sx, m.sz, [...m.materials]);
    for (let z = 0; z < m.sz; z++)
      for (let y = 0; y < m.sy; y++) for (let x = 0; x < m.sx; x++) out.set(m.sy - 1 - y, x, z, m.get(x, y, z));
    m = out;
  }
  return m;
}

/**
 * Voxel size in world units for a render scale: objects keep a fixed pixel
 * size (2×1 px voxel tops, 1 px tall) however large a world cell is drawn.
 */
export function objectVoxelScale(renderScale: number): VoxelScale {
  return { h: 1 / (16 * renderScale), v: 1 / (8 * renderScale) };
}

export interface ObjectBuildOptions {
  catalog: AssetCatalog;
  rampIds: Map<string, number>;
  /** Voxel size in world units. */
  voxel: VoxelScale;
  /** Voxel size in metres (horizontal), for converting building footprints and heights. */
  voxelMeters: number;
  /** Extra vertical stretch for buildings and landmarks (pixel-art cities read taller). */
  heightStretch: number;
  /** Terrain height (world steps) under a point. */
  heightAt: (x: number, y: number) => number;
  /** Variants generated per group for instanced objects. */
  variants?: number;
}

export interface InstancedBatch {
  mesh: MeshData;
  /** xyz per instance, world units. */
  offsets: Float32Array;
  /** owning cell per instance. */
  cells: Float32Array;
}

export interface ObjectMeshes {
  /** Unique objects (buildings, landmarks) merged into one mesh. */
  merged: MeshData;
  /** Repeated objects (vegetation, rocks) drawn instanced per variant. */
  batches: InstancedBatch[];
  skipped: number;
}

function makeContext(spec: AssetSpec, opts: ObjectBuildOptions, seed: number): GenContext {
  const rand = rng(seed);
  return {
    rand,
    ramp: (role) => {
      const name = spec.ramps[role];
      const id = name !== undefined ? opts.rampIds.get(name) : undefined;
      if (id === undefined) throw new Error(`asset ramp '${role}' (${name}) is not in the palette`);
      return id;
    },
    ramps: (role) =>
      Object.keys(spec.ramps)
        .filter((k) => k === role || k.startsWith(role + "."))
        .sort()
        .map((k) => {
          const id = opts.rampIds.get(spec.ramps[k]!);
          if (id === undefined) throw new Error(`asset ramp '${k}' (${spec.ramps[k]}) is not in the palette`);
          return id;
        }),
    param: (name, fallback) => {
      const v = spec.params?.[name];
      return typeof v === "number" ? v : fallback;
    },
  };
}

/** Rasterize a footprint polygon (world cells) into voxel columns. */
export function footprintMask(
  fp: [number, number][],
  voxelCells: number,
): { mask: { sx: number; sy: number; on: Uint8Array }; x0: number; y0: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of fp) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x0 = Math.floor(minX / voxelCells) * voxelCells;
  const y0 = Math.floor(minY / voxelCells) * voxelCells;
  const sx = Math.max(1, Math.ceil((maxX - x0) / voxelCells));
  const sy = Math.max(1, Math.ceil((maxY - y0) / voxelCells));
  const on = new Uint8Array(sx * sy);
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      const px = x0 + (i + 0.5) * voxelCells;
      const py = y0 + (j + 0.5) * voxelCells;
      let inside = false;
      for (let a = 0, b = fp.length - 1; a < fp.length; b = a++) {
        const [xa, ya] = fp[a]!;
        const [xb, yb] = fp[b]!;
        if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) inside = !inside;
      }
      on[j * sx + i] = inside ? 1 : 0;
    }
  // tiny footprints still get one column
  if (!on.some((v) => v)) on[Math.floor(sy / 2) * sx + Math.floor(sx / 2)] = 1;
  return { mask: { sx, sy, on }, x0, y0 };
}

/** Build meshes for a set of instances. */
export function buildObjects(instances: ObjectInstance[], opts: ObjectBuildOptions): ObjectMeshes {
  const merged = new MeshBuilder();
  const variants = new Map<string, { mesh: MeshData; offsets: number[]; cells: number[] }>();
  const nVariants = opts.variants ?? 6;
  let skipped = 0;
  for (const inst of instances) {
    const spec = resolveAsset(opts.catalog, inst.g);
    if (!spec) {
      skipped++;
      continue;
    }
    const gen = GENERATORS[spec.generator];
    if (!gen) throw new Error(`unknown generator ${spec.generator}`);
    const cell: [number, number] = [Math.floor(inst.x), Math.floor(inst.y)];
    // Footprints sit on their lowest corner so slopes don't leave them floating.
    const base = inst.fp
      ? Math.min(...inst.fp.map(([x, y]) => opts.heightAt(x, y)))
      : opts.heightAt(inst.x, inst.y);
    if (inst.fp || inst.hm !== undefined) {
      // unique object: footprint building or landmark
      const ctx = makeContext(spec, opts, inst.s);
      if (inst.hm !== undefined) ctx.heightVox = (inst.hm / opts.voxelMeters) * opts.heightStretch;
      let origin: [number, number, number];
      let model: VoxelModel;
      if (inst.fp) {
        const fpm = footprintMask(inst.fp, opts.voxel.h);
        ctx.mask = fpm.mask;
        model = gen(ctx);
        origin = [fpm.x0, fpm.y0, base];
      } else {
        model = gen(ctx);
        origin = [inst.x - (model.sx * opts.voxel.h) / 2, inst.y - (model.sy * opts.voxel.h) / 2, base];
      }
      meshVoxels(model, opts.voxel, origin, cell, merged);
      continue;
    }
    const variant = Math.abs(inst.s) % nVariants;
    const key = `${inst.g}#${variant}#${inst.r ?? 0}`;
    let batch = variants.get(key);
    if (!batch) {
      const model = rotateModel(gen(makeContext(spec, opts, 1000 + variant * 7919 + hash(inst.g))), inst.r ?? 0);
      // instance origin is the model's bottom centre
      const origin: [number, number, number] = [-(model.sx * opts.voxel.h) / 2, -(model.sy * opts.voxel.h) / 2, 0];
      batch = { mesh: meshVoxels(model, opts.voxel, origin, [0, 0]).build(), offsets: [], cells: [] };
      variants.set(key, batch);
    }
    batch.offsets.push(inst.x, inst.y, base);
    batch.cells.push(cell[0], cell[1]);
  }
  return {
    merged: merged.build(),
    batches: [...variants.values()].map((b) => ({
      mesh: b.mesh,
      offsets: new Float32Array(b.offsets),
      cells: new Float32Array(b.cells),
    })),
    skipped,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
