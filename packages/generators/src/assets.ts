import { MeshBuilder, type MeshData } from "./mesh";
import { FACADE_GENERATORS } from "./facades";
import { LANDMARK_KIT } from "./landmarkKit";
import { TOWER_GENERATORS } from "./towers";
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
  /** Quarter turns (vegetation, and landmarks without a footprint). */
  r?: number;
  /** Footprint polygon in world cells (buildings). */
  fp?: [number, number][];
  /** Real height in metres (buildings, landmarks). */
  hm?: number;
  /** Real metres per cell at the instance (warped worlds; the world's scale otherwise). */
  m?: number;
  /** Absolute top height in steps (dam crests), overriding hm. */
  top?: number;
  /** Landmark registry id (landmarks, M3). */
  id?: string;
  /** Overture roof shape (buildings, M3): flat, pyramidal, dome, hipped, gabled, … */
  rs?: string;
  /** Overture facade material, e.g. glass (buildings, M3). */
  fm?: string;
  /** Overture facade / roof colour (#rrggbb), kept for later use. */
  fc?: string;
  rc?: string;
  /** Typology hints (D-055): the direction the front faces (0-7, 45° steps from +x), a corner lot, year built, storeys. */
  fr?: number;
  cn?: number;
  yr?: number;
  fl?: number;
  /** Base height in steps (long landmarks, so every tile builds them alike). */
  z0?: number;
  /** A piece of a long landmark: the whole line's ends [ax, ay, bx, by] and half-width, in cells. */
  ln?: [number, number, number, number];
  lw?: number;
}

/** Footprints wider than this (cells) are owned per voxel column (see meshVoxels). */
export const BIG_FOOTPRINT_CELLS = 16;

/** A footprint's bounding box in cells: [x0, y0, x1, y1]. */
export function footprintBounds(fp: [number, number][]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of fp) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
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

export interface GenContext {
  rand: () => number;
  ramp: (role: string) => number;
  /** Ramp ids of every role named `role` or `role.<variant>` (e.g. wall, wall.gold). */
  ramps: (role: string) => number[];
  param: (name: string, fallback: number) => number;
  /** Footprint mask in voxels (buildings). */
  mask?: { sx: number; sy: number; on: Uint8Array };
  /** Target height in voxels (buildings, landmarks). */
  heightVox?: number;
  /**
   * Hints from the data (buildings): Overture roof shape and facade material,
   * and the typology's street front, corner lot, year built and storeys (D-055).
   */
  hints?: { roof?: string; facade?: string; front?: number; corner?: boolean; year?: number; floors?: number };
  /**
   * Where the model sits (footprint objects): its (0, 0) corner in world cells
   * and the voxel size in cells; for a piece of a long landmark, the whole line.
   */
  frame?: { x0: number; y0: number; voxel: number; line?: { a: [number, number]; b: [number, number]; half: number } };
}

export type Generator = (ctx: GenContext) => VoxelModel;

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
    // tiny blobs can lose every voxel to holes: keep at least the core
    if (!m.count()) m.set(Math.floor(c), Math.floor(c), Math.max(0, Math.round(trunkH)), body);
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

  /**
   * Building v2 (M3): an extruded footprint with a roof, a facade pattern and
   * rooftop details. `style` 0 residential, 1 low-rise, 2 tower. The roof comes
   * from the data where Overture has one (pyramidal, dome, hipped, gabled),
   * else from the style. Towers may step back near the top; facades pick a
   * pattern by seed (punched windows, ribbons, fins, curtain wall).
   */
  building: ({ rand, ramp, ramps, param, mask, heightVox, hints }) => {
    if (!mask) throw new Error("building generator needs a footprint");
    const style = param("style", 0);
    const H = Math.max(1, Math.round(heightVox ?? param("defaultHeight", 2)));
    const { sx, sy } = mask;
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && mask.on[y * sx + x] === 1;
    // depth: chessboard distance from outside (1 on the footprint's edge)
    const depth = new Int16Array(sx * sy);
    let maxDepth = 0;
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        if (!on(x, y)) continue;
        let d = 1;
        while (d < 64) {
          let ring = true;
          for (let k = -d; k <= d && ring; k++)
            if (!on(x + k, y - d) || !on(x + k, y + d) || !on(x - d, y + k) || !on(x + d, y + k)) ring = false;
          if (!ring) break;
          d++;
        }
        depth[y * sx + x] = d;
        maxDepth = Math.max(maxDepth, d);
      }
    const roofShape = hints?.roof ?? (style === 0 ? "hipped" : "flat");
    const glassFacade = hints?.facade === "glass";
    // pitched roofs: the cap's height; a broad, low building with a pyramidal
    // roof is a pyramid from the ground up
    let capH = 0;
    let pure = false;
    if (roofShape === "pyramidal") {
      pure = style !== 0 && maxDepth >= 4 && H <= 4 * maxDepth;
      capH = pure ? H : Math.min(H - 1, Math.round(maxDepth * 2.5));
    } else if (roofShape === "dome") capH = Math.min(H - 1, Math.round(maxDepth * 1.2));
    else if (roofShape === "hipped" || roofShape === "half_hipped" || roofShape === "gabled")
      capH = style === 0 ? Math.max(1, Math.ceil(maxDepth * 0.9)) : Math.min(H - 1, maxDepth);
    const Hw = pure ? 0 : style === 0 ? H : H - (roofShape === "flat" ? 0 : capH);
    const m = new VoxelModel(sx, sy, Math.max(H, Hw + capH) + 4);
    const walls = ramps("wall");
    const wall = m.material(walls[Math.floor(rand() * walls.length)]!);
    const roof = m.material(ramp("roof"));
    const window = m.material(ramp("window"));
    const litRamps = ramps("lit");
    const lit = litRamps.length ? m.material(litRamps[Math.floor(rand() * litRamps.length)]!) : window;
    const litFraction = param("litFraction", 0.35);
    const pane = () => (rand() < litFraction ? lit : window);
    const trims = ramps("trim");
    const trim = trims.length ? m.material(trims[Math.floor(rand() * trims.length)]!) : wall;
    // tower massing: up to two setbacks near the top
    const setbacks: [number, number][] = [];
    if (style === 2 && H >= 30 && maxDepth >= 3 && rand() < 0.6) {
      setbacks.push([Math.round(Hw * (0.62 + rand() * 0.12)), 1]);
      if (maxDepth >= 5 && rand() < 0.5) setbacks.push([Math.round(Hw * (0.84 + rand() * 0.06)), 2]);
    }
    const inset = (z: number) => setbacks.reduce((a, [z0, k]) => (z >= z0 ? k : a), 0);
    const keep = (x: number, y: number, z: number) => depth[y * sx + x]! > inset(z);
    const edgeAt = (x: number, y: number, z: number) =>
      !(on(x - 1, y) && keep(x - 1, y, z)) || !(on(x + 1, y) && keep(x + 1, y, z)) ||
      !(on(x, y - 1) && keep(x, y - 1, z)) || !(on(x, y + 1) && keep(x, y + 1, z));
    // facade pattern (towers): punched windows, ribbons, fins or a curtain wall
    const goldWall = walls.length > 1 && wall === m.material(walls[1]!);
    const towerPattern = glassFacade || goldWall ? 3 : Math.floor(rand() * 3);
    const big = sx * sy >= 64;
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        if (!on(x, y)) continue;
        for (let z = 0; z < Hw; z++) {
          if (!keep(x, y, z)) continue;
          let mat = wall;
          if (edgeAt(x, y, z)) {
            const c = x + y;
            if (style === 2 && z > 0) {
              if (towerPattern === 0 && z % 2 === 1 && c % 2 === 0) mat = pane();
              else if (towerPattern === 1 && z % 2 === 1) mat = pane();
              else if (towerPattern === 2 && c % 3 !== 0 && z % 4 !== 0) mat = pane();
              else if (towerPattern === 3 && z % 6 !== 0) mat = pane();
            } else if (style === 1) {
              if (z === 0 && c % 3 !== 0 && big) mat = pane(); // storefronts
              else if (z > 0 && z % 3 === 1 && c % 2 === 0) mat = pane();
              else if (big && z === Hw - 1 && Hw >= 3) mat = trim; // a sign band, no lettering
            } else if (style === 0 && z % 3 === 1 && c % 2 === 0) mat = window;
          }
          m.set(x, y, z, mat);
        }
        // roofs
        const d = depth[y * sx + x]!;
        const zTop = Math.max(0, Hw - 1);
        if (roofShape === "flat" || capH === 0) {
          if (!keep(x, y, zTop)) continue;
          if (style >= 1 && edgeAt(x, y, zTop)) m.set(x, y, Hw, trims.length && style === 2 ? trim : wall); // parapet
          else m.set(x, y, zTop, roof);
        } else {
          // caps rise from the outline left after any setbacks
          if (Hw > 0 && !keep(x, y, zTop)) continue;
          const ins = Hw > 0 ? inset(zTop) : 0;
          const de = d - ins;
          const md = Math.max(1, maxDepth - ins);
          let colTop: number;
          if (roofShape === "pyramidal") colTop = Hw + Math.round((capH * de) / md);
          else if (roofShape === "dome") {
            const u = 1 - de / md;
            colTop = Hw + Math.round(capH * Math.sqrt(Math.max(0, 1 - u * u)));
          } else if (roofShape === "gabled") {
            // ridge along the longer side: rise with the distance across the short side
            const across = sx >= sy ? Math.min(y, sy - 1 - y) + 1 : Math.min(x, sx - 1 - x) + 1;
            colTop = Hw + Math.min(capH, across);
          } else colTop = Hw + Math.min(capH, de); // hipped
          for (let z = Hw; z < colTop; z++) m.set(x, y, z, pure ? wall : roof);
        }
      }
    if (pure) {
      // a pyramid's skin is dark glass; its inside stays wall
      const glass = m.material(ramp("window"));
      const solid = (x: number, y: number, z: number) => m.get(x, y, z) !== 0;
      for (let z = 0; z < m.sz; z++)
        for (let y = 0; y < sy; y++)
          for (let x = 0; x < sx; x++)
            if (solid(x, y, z) && (!solid(x - 1, y, z) || !solid(x + 1, y, z) || !solid(x, y - 1, z) || !solid(x, y + 1, z) || !solid(x, y, z + 1)))
              m.set(x, y, z, glass);
    }
    // rooftop details on flat roofs
    if (roofShape === "flat" || capH === 0) {
      const tops: [number, number][] = [];
      for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (on(x, y) && depth[y * sx + x]! > inset(Hw) + 1) tops.push([x, y]);
      if (style === 1 && tops.length >= 12) {
        // rooftop equipment
        const n = 1 + Math.floor(rand() * Math.min(4, tops.length / 12));
        for (let k = 0; k < n; k++) {
          const [x, y] = tops[Math.floor(rand() * tops.length)]!;
          m.fill(x, y, Hw, x + 1 + (rand() < 0.5 ? 1 : 0), y + 1, Hw + 1, wall);
        }
      }
      if (style === 2 && tops.length) {
        const r = rand();
        const cx0 = Math.floor(sx / 3);
        const cy0 = Math.floor(sy / 3);
        if (r < 0.55 && sx > 2 && sy > 2) {
          // mechanical penthouse
          for (let y = cy0; y < sy - cy0; y++)
            for (let x = cx0; x < sx - cx0; x++) if (on(x, y) && keep(x, y, Hw)) m.fill(x, y, Hw, x + 1, y + 1, Hw + 2, wall);
        } else if (r < 0.8 && H >= 40) {
          // spire with a beacon
          const [x, y] = tops[Math.floor(tops.length / 2)]!;
          for (let z = Hw; z < Hw + 3; z++) m.set(x, y, z, wall);
          m.set(x, y, Hw + 3, trims.length ? trim : lit);
        }
      }
    }
    return m;
  },

  /** Arch dam: the footprint extruded from the riverbed to the crest. */
  dam: ({ ramp, mask, heightVox }) => {
    if (!mask) throw new Error("dam generator needs a footprint");
    const H = Math.max(2, Math.round(heightVox ?? 8));
    const m = new VoxelModel(mask.sx, mask.sy, H + 1);
    const face = m.material(ramp("face"));
    const crest = m.material(ramp("crest"));
    const band = m.material(ramp("detail"));
    const on = (x: number, y: number) => x >= 0 && y >= 0 && x < mask.sx && y < mask.sy && mask.on[y * mask.sx + x] === 1;
    for (let y = 0; y < mask.sy; y++)
      for (let x = 0; x < mask.sx; x++) {
        if (!on(x, y)) continue;
        for (let z = 0; z < H; z++) m.set(x, y, z, z % 6 === 5 ? band : face);
        m.set(x, y, H, crest);
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

/** Landmark generators added in M3 (D-051): generic shapes, no replicas of signage. */
const LANDMARK_GENERATORS: Record<string, Generator> = {
  /** Four-legged lattice tower: splayed legs, base arches, two platforms, a slender top. */
  latticeTower: ({ ramp, param, heightVox }) => {
    const H = Math.max(16, Math.round(heightVox ?? param("height", 60)));
    const B = Math.max(3, Math.round(H * param("baseRatio", 0.19)));
    const size = 2 * B + 2;
    const m = new VoxelModel(size, size, H + 3);
    const iron = m.material(ramp("structure"));
    const deck = m.material(ramp("deck"));
    const glow = m.material(ramp("accent"));
    const c = B + 1; // the centre falls between voxels B and B + 1
    const p1 = Math.round(H * 0.18);
    const p2 = Math.round(H * 0.38);
    const p3 = Math.round(H * 0.86);
    // outer edge of each leg: a concave curve from B at the base to 1 at the top
    const reach = (z: number) => 1 + (B - 1) * Math.pow(Math.max(0, 1 - z / (H * 0.92)), 2.2);
    const lo = (r: number) => Math.floor(c - r);
    const hi = (r: number) => Math.ceil(c + r) - 1;
    for (let z = 0; z < p3; z++) {
      const r = reach(z);
      const t = z < p2 ? 2 : 1; // legs thin out above the second platform
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (let k = 0; k < t; k++)
            for (let l = 0; l < t; l++)
              m.set(sx > 0 ? hi(r) - k : lo(r) + k, sy > 0 ? hi(r) - l : lo(r) + l, z, iron);
      if (z % 3 === 1 && r > 1.6 && z > p1) {
        // lattice bracing: a dotted ring between the legs
        for (let i = lo(r); i <= hi(r); i++)
          if ((i + z) % 2 === 0) {
            m.set(i, lo(r), z, iron);
            m.set(i, hi(r), z, iron);
            m.set(lo(r), i, z, iron);
            m.set(hi(r), i, z, iron);
          }
      }
    }
    // arches under the first platform, one per face
    const r1 = reach(p1);
    const span = (hi(r1) - lo(r1)) / 2;
    for (let i = lo(r1); i <= hi(r1); i++) {
      const u = (i - (lo(r1) + span)) / Math.max(1, span);
      const za = Math.round(p1 - (p1 * 0.55) * Math.sqrt(Math.max(0, 1 - u * u)));
      for (const [x, y] of [[i, lo(reach(za))], [i, hi(reach(za))], [lo(reach(za)), i], [hi(reach(za)), i]] as const)
        m.set(x, y, za, iron);
    }
    // two platforms with lights along their rims
    for (const pz of [p1, p2]) {
      const r = reach(pz) + 1;
      for (let y = lo(r); y <= hi(r); y++)
        for (let x = lo(r); x <= hi(r); x++) {
          const rim = x === lo(r) || x === hi(r) || y === lo(r) || y === hi(r);
          m.set(x, y, pz, rim && (x + y) % 2 === 0 ? glow : deck);
        }
    }
    // the top: a small cabin, then a spire with a beacon
    m.fill(Math.floor(c) - 1, Math.floor(c) - 1, p3, Math.floor(c) + 1, Math.floor(c) + 1, p3 + 2, deck);
    for (let z = p3 + 2; z < H; z++) m.set(Math.floor(c), Math.floor(c), z, iron);
    m.set(Math.floor(c), Math.floor(c), H, glow);
    return m;
  },

  /** Observation wheel in the x–z plane: rim, spokes, cabins, hub and A-frame legs. */
  wheel: ({ ramp, param, heightVox }) => {
    const H = Math.max(14, Math.round(heightVox ?? param("height", 60)));
    const R = Math.max(5, Math.round(H * 0.46));
    const hubZ = H - R - 1;
    const W = 2 * R + 5;
    const D = 7;
    const m = new VoxelModel(W, D, H + 2);
    const steel = m.material(ramp("structure"));
    const cabin = m.material(ramp("cabin"));
    const glow = m.material(ramp("accent"));
    const cx = R + 2;
    const cy = 3;
    const steps = Math.ceil(2 * Math.PI * R * 2);
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      m.set(Math.round(cx + R * Math.cos(a)), cy, Math.round(hubZ + R * Math.sin(a)), i % 6 === 0 ? glow : steel);
    }
    const spokes = Math.round(param("spokes", 16));
    for (let k = 0; k < spokes; k++) {
      const a = (k / spokes) * 2 * Math.PI;
      for (let r = 1; r < R; r++)
        if (r % 2 === 0 || k % 2 === 0) m.set(Math.round(cx + r * Math.cos(a)), cy, Math.round(hubZ + r * Math.sin(a)), steel);
    }
    const cabins = Math.round(param("cabins", 28));
    for (let k = 0; k < cabins; k++) {
      const a = (k / cabins) * 2 * Math.PI;
      const x = Math.round(cx + (R + 1) * Math.cos(a));
      const z = Math.round(hubZ + (R + 1) * Math.sin(a));
      for (let dy = -1; dy <= 1; dy++) m.set(x, cy + dy, z, cabin);
    }
    m.fill(cx - 1, cy - 1, hubZ - 1, cx + 2, cy + 2, hubZ + 2, steel);
    // A-frame legs from the hub to the ground on both sides of the wheel
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const x1 = cx + sx * Math.round(R * 0.45);
        const y1 = cy + sy * 3;
        for (let z = 0; z <= hubZ; z++) {
          const t = 1 - z / hubZ;
          m.set(Math.round(cx + (x1 - cx) * t), Math.round(cy + sy + (y1 - cy - sy) * t), z, steel);
        }
      }
    return m;
  },

  /** Arch bridge on its footprint band: an arch rib springing from both ends, columns and a deck on top. */
  archBridge: ({ ramp, mask, heightVox }) => {
    if (!mask) throw new Error("arch bridge generator needs a footprint");
    const H = Math.max(6, Math.round(heightVox ?? 24));
    const m = new VoxelModel(mask.sx, mask.sy, H + 2);
    const concrete = m.material(ramp("structure"));
    const deck = m.material(ramp("deck"));
    const rail = m.material(ramp("detail"));
    const cells: [number, number][] = [];
    for (let y = 0; y < mask.sy; y++) for (let x = 0; x < mask.sx; x++) if (mask.on[y * mask.sx + x]) cells.push([x, y]);
    if (!cells.length) return m;
    // the band's long axis (principal direction of its columns)
    const mx = cells.reduce((a, [x]) => a + x, 0) / cells.length;
    const my = cells.reduce((a, [, y]) => a + y, 0) / cells.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const [x, y] of cells) {
      sxx += (x - mx) ** 2;
      syy += (y - my) ** 2;
      sxy += (x - mx) * (y - my);
    }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const along = cells.map(([x, y]) => (x - mx) * ux + (y - my) * uy);
    const across = cells.map(([x, y]) => -(x - mx) * uy + (y - my) * ux);
    const a0 = Math.min(...along);
    const a1 = Math.max(...along);
    const w = Math.max(...across.map(Math.abs));
    cells.forEach(([x, y], i) => {
      const t = (along[i]! - a0) / Math.max(1e-6, a1 - a0);
      const rib = Math.round(H * (0.3 + 0.62 * 4 * t * (1 - t)));
      if (t > 0.06 && t < 0.94) {
        m.set(x, y, rib, concrete);
        m.set(x, y, rib - 1, concrete);
        // spandrel columns from the rib up to the deck
        if (Math.round(along[i]! - a0) % 6 === 0) for (let z = rib; z < H; z++) m.set(x, y, z, concrete);
      } else {
        for (let z = 0; z < H; z++) m.set(x, y, z, concrete); // abutments in the canyon walls
      }
      m.set(x, y, H, deck);
      if (Math.abs(across[i]!) >= w - 0.75) m.set(x, y, H + 1, rail);
    });
    return m;
  },

  /** Intake tower: a fluted round tower with a crown, standing in the lake. */
  intakeTower: ({ ramp, param, heightVox }) => {
    const H = Math.max(6, Math.round(heightVox ?? param("height", 30)));
    const R = param("radius", 2);
    const n = Math.ceil(R) + 2;
    const size = 2 * n + 1;
    const m = new VoxelModel(size, size, H + 2);
    const concrete = m.material(ramp("structure"));
    const detail = m.material(ramp("detail"));
    const crest = m.material(ramp("crest"));
    for (let z = 0; z <= H; z++)
      for (let y = -n; y <= n; y++)
        for (let x = -n; x <= n; x++) {
          const d = Math.hypot(x, y);
          if (d <= R + 0.3) m.set(n + x, n + y, z, z >= H - 1 ? crest : concrete);
          else if (d <= R + 1.3 && z < H - 3 && z > 1 && (x === 0 || y === 0 || Math.abs(x) === Math.abs(y)))
            m.set(n + x, n + y, z, detail); // fluting
          else if (d <= R + 1.3 && z >= H - 3 && z < H - 1) m.set(n + x, n + y, z, detail); // crown
        }
    return m;
  },

  /** Street light: a pole, an arm over the street, a lamp that glows at night. */
  streetLight: ({ ramp, param }) => {
    const h = Math.round(param("height", 6));
    const m = new VoxelModel(3, 1, h + 1);
    const pole = m.material(ramp("pole"));
    const lamp = m.material(ramp("lamp"));
    for (let z = 0; z < h; z++) m.set(0, 0, z, pole);
    m.set(1, 0, h - 1, pole);
    m.set(2, 0, h - 1, lamp);
    return m;
  },

  /** Traffic signal: a pole with a signal head. */
  trafficSignal: ({ ramp, param }) => {
    const h = Math.round(param("height", 5));
    const m = new VoxelModel(2, 1, h + 2);
    const pole = m.material(ramp("pole"));
    const head = m.material(ramp("head"));
    const light = m.material(ramp("light"));
    for (let z = 0; z < h; z++) m.set(0, 0, z, pole);
    m.set(1, 0, h - 1, head);
    m.set(1, 0, h, light);
    m.set(1, 0, h + 1, head);
    return m;
  },
};
Object.assign(GENERATORS, LANDMARK_GENERATORS, FACADE_GENERATORS, LANDMARK_KIT, TOWER_GENERATORS);

/**
 * Generate one model for a group, as buildObjects would (used by tests and
 * the offline hero bake): footprint mask, height in voxels, seed and hints.
 */
export function generateModel(
  catalog: AssetCatalog,
  rampIds: Map<string, number>,
  group: string,
  opts: {
    seed: number;
    mask?: { sx: number; sy: number; on: Uint8Array };
    heightVox?: number;
    hints?: GenContext["hints"];
    frame?: GenContext["frame"];
  },
): VoxelModel {
  const spec = resolveAsset(catalog, group);
  if (!spec) throw new Error(`no asset for group ${group}`);
  const gen = GENERATORS[spec.generator];
  if (!gen) throw new Error(`unknown generator ${spec.generator}`);
  const ctx = makeContext(spec, { rampIds } as ObjectBuildOptions, opts.seed);
  ctx.mask = opts.mask;
  ctx.heightVox = opts.heightVox;
  ctx.hints = opts.hints;
  ctx.frame = opts.frame;
  return gen(ctx);
}

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
    const base =
      inst.z0 !== undefined
        ? inst.z0
        : inst.fp
          ? Math.min(...inst.fp.map(([x, y]) => opts.heightAt(x, y)))
          : opts.heightAt(inst.x, inst.y);
    if (inst.fp || inst.hm !== undefined || inst.top !== undefined) {
      // unique object: footprint building or landmark
      const ctx = makeContext(spec, opts, inst.s);
      if (inst.rs || inst.fm || inst.fr !== undefined || inst.fl !== undefined)
        ctx.hints = {
          roof: inst.rs,
          facade: inst.fm,
          front: inst.fr,
          corner: inst.cn === 1,
          year: inst.yr,
          floors: inst.fl,
        };
      // voxel metres follow the local scale on warped worlds
      const voxelMeters = inst.m !== undefined ? opts.voxel.h * inst.m : opts.voxelMeters;
      if (inst.hm !== undefined) ctx.heightVox = (inst.hm / voxelMeters) * opts.heightStretch;
      if (inst.top !== undefined) ctx.heightVox = Math.max(1, (inst.top - base) / opts.voxel.v);
      let origin: [number, number, number];
      let model: VoxelModel;
      if (inst.fp) {
        const fpm = footprintMask(inst.fp, opts.voxel.h);
        ctx.mask = fpm.mask;
        ctx.frame = { x0: fpm.x0, y0: fpm.y0, voxel: opts.voxel.h };
        if (inst.ln && inst.lw !== undefined)
          ctx.frame.line = { a: [inst.ln[0], inst.ln[1]], b: [inst.ln[2], inst.ln[3]], half: inst.lw };
        model = gen(ctx);
        origin = [fpm.x0, fpm.y0, base];
        const [bx0, by0, bx1, by1] = footprintBounds(inst.fp);
        if (Math.max(bx1 - bx0, by1 - by0) > BIG_FOOTPRINT_CELLS) {
          meshVoxels(model, opts.voxel, origin, "column", merged);
          continue;
        }
      } else {
        // landmarks may be turned (an observation wheel's plane)
        model = inst.r ? rotateModel(gen(ctx), inst.r) : gen(ctx);
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
    // an empty variant would have no bounds: leave it out
    batches: [...variants.values()].filter((b) => b.mesh.vertexCount > 0).map((b) => ({
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
