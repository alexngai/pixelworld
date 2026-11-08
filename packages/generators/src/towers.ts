import type { GenContext, Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Downtown towers by era (San Francisco, D-055): generators for footprint
 * towers that read as a city's skyline rather than as extruded boxes.
 *
 * - `decoTower`: the 1920s and 30s. Terracotta, buff or granite, continuous
 *   piers between recessed window bays, one or two setbacks and a stepped,
 *   pinnacled or lanterned crown with a finial.
 * - `sfTower`: everything after, by kind: white slabs with fins and notched
 *   corners (`slab`), dark granite slabs with vertical bays (`granite`), stone
 *   towers with setbacks and sculpted tops (`postmodern`) and pale glass towers
 *   with white mullions and varied crowns (`glass`). Kind -1 picks one by seed
 *   (deco included), for towers with no year.
 *
 * Both follow the style guide's building rules: inside the footprint, no
 * overhangs (a recess runs to the top of its stage; parapets and pinnacles
 * stand on piers), glass only on the skin. Without a footprint (a point
 * landmark) a tower stands on a rectangle sized from its height.
 */

type Mask = { sx: number; sy: number; on: Uint8Array };

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Chessboard depth of each footprint column from the outside: 1 on the edge, 0 outside. */
export function footprintDepth(mask: Mask): { depth: Int16Array; maxDepth: number } {
  const { sx, sy, on } = mask;
  const depth = new Int16Array(sx * sy);
  for (let i = 0; i < sx * sy; i++) depth[i] = on[i] ? 0x3fff : 0;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= sx || y >= sy ? 0 : depth[y * sx + x]!);
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      const i = y * sx + x;
      if (depth[i]) depth[i] = Math.min(depth[i]!, at(x - 1, y) + 1, at(x - 1, y - 1) + 1, at(x, y - 1) + 1, at(x + 1, y - 1) + 1);
    }
  let maxDepth = 0;
  for (let y = sy - 1; y >= 0; y--)
    for (let x = sx - 1; x >= 0; x--) {
      const i = y * sx + x;
      if (depth[i]) depth[i] = Math.min(depth[i]!, at(x + 1, y) + 1, at(x + 1, y + 1) + 1, at(x, y + 1) + 1, at(x - 1, y + 1) + 1);
      maxDepth = Math.max(maxDepth, depth[i]!);
    }
  return { depth, maxDepth };
}

/** A rectangle for a tower with no footprint (a point landmark): width and depth over its height. */
function boxMask(H: number, width: number, depth: number): Mask {
  const sx = Math.max(5, Math.round(H * width));
  const sy = Math.max(5, Math.round(H * depth));
  return { sx, sy, on: new Uint8Array(sx * sy).fill(1) };
}

/**
 * Notch a footprint's convex corners in steps (a serrated corner, as on slabs
 * with stepped balconies): a column goes where its runs to the edge across x
 * and y are both short. `steps` notches of `size` voxels each.
 */
function notchCorners(mask: Mask, steps: number, size: number): Mask {
  const { sx, sy, on } = mask;
  const inM = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const run = (x: number, y: number, dx: number, dy: number) => {
    let n = 0;
    while (inM(x + dx * (n + 1), y + dy * (n + 1))) n++;
    return n;
  };
  const out = new Uint8Array(on);
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inM(x, y)) continue;
      const ex = Math.min(run(x, y, -1, 0), run(x, y, 1, 0));
      const ey = Math.min(run(x, y, 0, -1), run(x, y, 0, 1));
      // long runs both ways: not a corner; keep thin footprints whole
      if (Math.floor(ex / size) + Math.floor(ey / size) < steps && run(x, y, -1, 0) + run(x, y, 1, 0) > 4 * size && run(x, y, 0, -1) + run(x, y, 0, 1) > 4 * size)
        out[y * sx + x] = 0;
    }
  return out.some((v) => v) ? { sx, sy, on: out } : mask;
}

/** Storey height in voxels: from the record's storeys where they fit the height, else 4. */
function storey(H: number, floors?: number): number {
  if (floors && floors >= 3) {
    const f = H / floors;
    if (f >= 2.5 && f <= 12) return Math.round(f);
  }
  return 4;
}

/** A role's ramps, scoped by a prefix first ("deco:wall"), then unscoped ("wall"). */
function scope(ctx: GenContext, prefix: string): GenContext {
  if (!prefix) return ctx;
  return {
    ...ctx,
    ramps: (role) => {
      const r = ctx.ramps(prefix + role);
      return r.length ? r : ctx.ramps(role);
    },
    ramp: (role) => {
      const r = ctx.ramps(prefix + role);
      return r.length ? r[0]! : ctx.ramp(role);
    },
  };
}

/**
 * A tower's materials. The wall is picked from its variants; spandrel and trim
 * follow it when they list as many variants (the lists are sorted by name, so
 * `wall.granite` goes with `spandrel.granite`), else they are picked on their own.
 */
function materials(ctx: GenContext, m: VoxelModel) {
  const { rand, ramps } = ctx;
  const walls = ramps("wall");
  const k = Math.floor(rand() * walls.length);
  const wall = m.material(walls[k]!);
  const scheme = (role: string, fallback: number) => {
    const xs = ramps(role);
    if (!xs.length) return fallback;
    return m.material(xs.length === walls.length ? xs[k]! : xs[Math.floor(rand() * xs.length)]!);
  };
  const glass = m.material(ctx.ramp("window"));
  const lits = ramps("lit");
  const lit = lits.length ? m.material(lits[Math.floor(rand() * lits.length)]!) : glass;
  const litFraction = ctx.param("litFraction", 0.45);
  return {
    wall,
    spandrel: scheme("spandrel", wall),
    trim: scheme("trim", wall),
    cap: scheme("cap", scheme("roof", wall)),
    roof: m.material(ramps("roof")[0] ?? walls[k]!),
    reflect: scheme("reflect", glass),
    glass,
    lit,
    litShare: litFraction,
    pane: () => (rand() < litFraction ? lit : glass),
  };
}

function hash2(a: number, b: number, c: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(c + 7, 0x27d4eb2f);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

/** One voxel of a tower's skin, as the massing engine hands it to a facade. */
interface Skin {
  x: number;
  y: number;
  z: number;
  /** Outward normal (one of them is 0 on a flat face). */
  nx: number;
  ny: number;
  /** On a corner (open on two sides) or a wall one voxel thick. */
  corner: boolean;
  /** Position along its face. */
  along: number;
  /** The top of its column at this setback (a terrace or the roof is above it). */
  last: boolean;
}

/** A facade's answer: the skin voxel's material, or a recess (the skin left open, `recess` set behind it). */
interface Face {
  mat: number;
  recess?: number;
}

interface TowerSpec {
  mask: Mask;
  depth: Int16Array;
  /** Top of the massing (exclusive) per column. */
  top: (x: number, y: number) => number;
  /** Setback (in depth steps) at a height: never decreasing upward. */
  inset: (z: number) => number;
  face: (s: Skin) => Face;
  /** Inside the walls; `roofTop` on a column's topmost voxel at its setback. */
  interior: (z: number, roofTop: boolean) => number;
  /** Stacked on a terrace's solid skin voxel (parapets, pinnacles), bottom first. */
  parapet?: (s: Skin) => number[];
}

/** Fill a tower's massing, dress its skin and terraces; returns the highest solid z. */
function drawTower(m: VoxelModel, t: TowerSpec): void {
  const { sx, sy, on } = t.mask;
  const inM = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const kept = (x: number, y: number, z: number) => inM(x, y) && z < t.top(x, y) && t.depth[y * sx + x]! > t.inset(z);
  const terraces: { s: Skin; stack: number[] }[] = [];
  // the massing and its roofs
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inM(x, y)) continue;
      const H = t.top(x, y);
      for (let z = 0; z < H; z++) if (kept(x, y, z)) m.set(x, y, z, t.interior(z, !kept(x, y, z + 1)));
    }
  // the skin: faces, recesses and terrace parapets
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inM(x, y)) continue;
      const H = t.top(x, y);
      for (let z = 0; z < H; z++) {
        if (!kept(x, y, z)) continue;
        const ox0 = !kept(x - 1, y, z);
        const ox1 = !kept(x + 1, y, z);
        const oy0 = !kept(x, y - 1, z);
        const oy1 = !kept(x, y + 1, z);
        if (!(ox0 || ox1 || oy0 || oy1)) continue;
        const nx = (ox1 ? 1 : 0) - (ox0 ? 1 : 0);
        const ny = (oy1 ? 1 : 0) - (oy0 ? 1 : 0);
        const corner = (ox0 || ox1) && (oy0 || oy1);
        const s: Skin = { x, y, z, nx, ny, corner: corner || (nx === 0 && ny === 0), along: nx !== 0 ? y : x, last: !kept(x, y, z + 1) };
        const f = t.face(s);
        const ix = x - nx;
        const iy = y - ny;
        // a recess needs a column behind it that stays inside the walls at this height
        const deep = f.recess !== undefined && !s.corner && inM(ix, iy) && t.depth[iy * sx + ix]! > t.inset(z) + 1 && z < t.top(ix, iy);
        if (deep) {
          m.set(x, y, z, 0);
          m.set(ix, iy, z, f.recess!);
        } else m.set(x, y, z, f.mat);
        if (s.last && t.parapet) terraces.push({ s, stack: t.parapet(s) });
      }
    }
  // no overhangs: an open recess under a solid voxel is closed again (top down, so runs close whole)
  for (let z = m.sz - 2; z >= 0; z--)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (!m.get(x, y, z) && m.get(x, y, z + 1) && kept(x, y, z)) m.set(x, y, z, m.get(x, y, z + 1));
  for (const { s, stack } of terraces) {
    if (!m.get(s.x, s.y, s.z)) continue; // parapets stand on piers, not on open bays
    stack.forEach((mat, k) => {
      if (!m.get(s.x, s.y, s.z + 1 + k)) m.set(s.x, s.y, s.z + 1 + k, mat);
    });
  }
}

/** The column nearest the middle of what stands at a height (for finials and spires). */
function centreAt(m: VoxelModel, z: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bd = Infinity;
  const cx = (m.sx - 1) / 2;
  const cy = (m.sy - 1) / 2;
  for (let y = 0; y < m.sy; y++)
    for (let x = 0; x < m.sx; x++) {
      if (!m.get(x, y, z) || m.get(x, y, z + 1)) continue;
      const d = Math.hypot(x - cx, y - cy);
      if (d < bd) {
        bd = d;
        best = [x, y];
      }
    }
  return best;
}

/** Highest solid voxel in the model. */
function topZ(m: VoxelModel): number {
  for (let z = m.sz - 1; z >= 0; z--) for (let i = 0; i < m.sx * m.sy; i++) if (m.data[z * m.sx * m.sy + i]) return z;
  return -1;
}

/** Stand a pole on the middle of the top (a finial, a flagpole or a spire). */
function spire(m: VoxelModel, h: number, mat: number, tip?: number): void {
  const z = topZ(m);
  if (z < 0) return;
  const c = centreAt(m, z);
  if (!c) return;
  for (let k = 1; k <= h; k++) m.set(c[0], c[1], z + k, k === h && tip !== undefined ? tip : mat);
}

/** Setbacks: [height, inset] steps aligned to storeys; up to two in the upper part. */
function setbacks(rand: () => number, H: number, half: number, fh: number, n: number, from = 0.58): [number, number][] {
  const out: [number, number][] = [];
  if (H < 24 || half < 4 || n <= 0) return out;
  const snap = (z: number) => Math.max(fh, Math.round(z / fh) * fh);
  const k1 = Math.max(1, Math.round(half * (0.14 + rand() * 0.1)));
  out.push([snap(H * (from + rand() * 0.14)), k1]);
  if (n >= 2 && H >= 40 && half - k1 >= 4) out.push([snap(H * (0.8 + rand() * 0.06)), k1 + Math.max(1, Math.round(half * (0.12 + rand() * 0.08)))]);
  return out;
}

const insetFrom = (steps: [number, number][]) => (z: number) => steps.reduce((a, [z0, k]) => (z >= z0 ? Math.max(a, k) : a), 0);

/**
 * A 1920s tower: piers between recessed bays, setbacks, a crown.
 * params: piers (voxels from pier to pier: 2 or 3; 0 picks by seed),
 * setbacks (0–2; default 2), crown (0 stepped, 1 pinnacled, 2 lantern; -1 by
 * seed), width and depth (a point landmark's plan over its height).
 * roles: wall, spandrel (behind the windows), trim (crown ornament and
 * finials), cap (a lantern's roof), roof, window, lit.
 */
const decoTower: Generator = (ctx) => {
  const { rand, param, heightVox, hints } = ctx;
  const H = Math.max(8, Math.round(heightVox ?? param("height", 60)));
  const mask = ctx.mask ?? boxMask(H, param("width", 0.32), param("depth", 0.28));
  const { depth, maxDepth: half } = footprintDepth(mask);
  const m = new VoxelModel(mask.sx, mask.sy, H + Math.max(8, Math.round(H * 0.12)));
  const p = materials(ctx, m);
  const fh = storey(H, hints?.floors);
  const P = param("piers", 0) >= 2 ? Math.round(param("piers", 0)) : rand() < 0.6 ? 2 : 3;
  const crownKind = param("crown", -1) >= 0 ? Math.round(param("crown", -1)) : Math.floor(rand() * 3);
  const baseH = Math.min(Math.max(3, fh * 2), Math.round(H / 4));
  const steps = setbacks(rand, H, half, fh, Math.round(param("setbacks", rand() < 0.75 ? 2 : 1)));
  const body = insetFrom(steps);
  // the crown: the top storeys, stepping in (stepped), straight with pinnacles, or a lantern
  const kBody = body(H - 1);
  const room = half - kBody; // depth left above the last setback
  const crownH = room >= 3 && H >= 30 ? Math.max(3, Math.round(H * (crownKind === 2 ? 0.14 : 0.08))) : 0;
  const crownZ = H - crownH;
  const stepH = Math.max(1, Math.round(crownH / 4));
  const lanternK = kBody + Math.max(1, Math.round(room * 0.55));
  const inset = (z: number): number => {
    const k = body(z);
    if (!crownH || z < crownZ) return k;
    const c = z - crownZ;
    if (crownKind === 0) return Math.min(half - 1, k + 1 + Math.floor(c / stepH)); // stepped
    if (crownKind === 1) return k + 1; // a pinnacled storey a step in
    // lantern: a storey a step in, then the lantern, then a pyramid cap
    const capZ = crownZ + Math.round(crownH * 0.6);
    if (z < crownZ + Math.max(2, Math.round(crownH * 0.25))) return k + 1;
    if (z < capZ) return Math.min(half - 1, lanternK);
    return Math.min(half, lanternK + 1 + (z - capZ));
  };
  const capZ = crownZ + Math.round(crownH * 0.6);
  drawTower(m, {
    mask,
    depth,
    top: () => H,
    inset,
    interior: (z, roofTop) => (crownKind === 2 && crownH && z >= capZ ? p.cap : roofTop ? p.roof : p.wall),
    face: (s) => {
      const pos = mod(s.along, P);
      const pier = s.corner || pos === 0;
      if (s.z < baseH) {
        // the base: tall storefronts between the piers under a solid band
        return { mat: !pier && s.z >= 1 && s.z < baseH - 1 ? p.pane() : p.wall };
      }
      if (crownH && s.z >= crownZ) {
        if (crownKind === 2 && s.z >= capZ) return { mat: p.cap };
        if (crownKind === 2 && inset(s.z) === Math.min(half - 1, lanternK))
          return { mat: !pier && mod(s.z - crownZ, 3) !== 0 && !s.last ? p.glass : p.trim }; // the lantern's openings
        // ornament: dentils of trim along each step's top course
        return { mat: s.last && mod(s.along, 2) === 0 ? p.trim : p.wall };
      }
      if (pier) return { mat: p.wall };
      const zf = mod(s.z - baseH, fh);
      // recessed bays: windows over dark spandrels, run up to the stage's top
      const inner = s.last || zf === 0 ? p.spandrel : p.pane();
      return { mat: zf === 0 ? p.spandrel : p.pane(), recess: inner };
    },
    parapet: (s) => {
      if (crownKind === 2 && s.z >= crownZ) return [];
      const pos = mod(s.along, P);
      if (!(s.corner || pos === 0)) return [];
      // piers rise past each terrace: corners and every other pier as pinnacles
      if (s.corner) return [p.wall, p.trim];
      return mod(s.along, 2 * P) === 0 ? [p.wall, p.trim] : [p.wall];
    },
  });
  // a finial or a flagpole on top
  if (H >= 20) spire(m, Math.max(2, Math.round(H * 0.05)), p.trim);
  return m;
};

/** The kinds `sfTower` draws, and their default shares when it picks by seed. */
const KINDS = ["deco", "slab", "granite", "postmodern", "glass"] as const;
type Kind = (typeof KINDS)[number];

/** A white slab: fins between flush windows (white and dark stripes from afar), notched corners, a penthouse. */
function slabTower(ctx: GenContext, mask0: Mask, H: number): VoxelModel {
  const { rand, hints } = ctx;
  const m = new VoxelModel(mask0.sx, mask0.sy, H + 8);
  const mask = rand() < 0.6 ? notchCorners(mask0, 2, 1) : mask0;
  const { depth, maxDepth: half } = footprintDepth(mask);
  const p = materials(ctx, m);
  const fh = storey(H, hints?.floors);
  const baseH = Math.min(fh * 2, Math.round(H / 5));
  const topK = half >= 5 ? 1 : 0;
  const topZ0 = H - (topK ? Math.max(2, fh) : 0);
  drawTower(m, {
    mask,
    depth,
    top: () => H,
    inset: (z) => (z >= topZ0 ? topK : 0),
    interior: (_z, roofTop) => (roofTop ? p.roof : p.wall),
    face: (s) => {
      const fin = s.corner || mod(s.along, 2) === 0;
      if (s.z < baseH) return { mat: !fin && s.z >= 1 ? p.pane() : p.wall };
      if (fin) return { mat: p.wall };
      const zf = mod(s.z - baseH, fh);
      return { mat: s.last || zf === 0 ? p.spandrel : p.pane() };
    },
    parapet: (s) => (s.corner || mod(s.along, 2) === 0 ? [p.wall] : []),
  });
  // a mechanical penthouse
  const z = topZ(m);
  if (half >= 6 && z > 0) {
    const r = Math.max(2, Math.round(half * 0.35));
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) if (depth[y * m.sx + x]! > half - r && m.get(x, y, z) && !m.get(x, y, z + 1)) m.fill(x, y, z + 1, x + 1, y + 1, z + 3, p.wall);
  }
  return m;
}

/** A dark granite slab: narrow vertical window bays flush between granite piers, a flat top. */
function graniteTower(ctx: GenContext, mask0: Mask, H: number): VoxelModel {
  const { rand, hints } = ctx;
  const m = new VoxelModel(mask0.sx, mask0.sy, H + 6);
  const mask = rand() < 0.5 ? notchCorners(mask0, 1, 2) : mask0;
  const { depth, maxDepth: half } = footprintDepth(mask);
  const p = materials(ctx, m);
  const fh = storey(H, hints?.floors);
  const baseH = Math.min(fh * 2, Math.round(H / 5));
  const steps = rand() < 0.4 ? setbacks(rand, H, half, fh, 1, 0.75) : [];
  drawTower(m, {
    mask,
    depth,
    top: () => H,
    inset: insetFrom(steps),
    interior: (_z, roofTop) => (roofTop ? p.roof : p.wall),
    face: (s) => {
      const pier = s.corner || mod(s.along, 2) === 0;
      if (s.z < baseH) return { mat: !pier && s.z >= 1 && s.z < baseH - 1 ? p.pane() : p.wall };
      if (pier) return { mat: p.wall };
      const zf = mod(s.z - baseH, fh);
      return { mat: s.last || zf === 0 ? p.wall : p.pane() };
    },
    parapet: (s) => (s.corner || mod(s.along, 2) === 0 ? [p.wall] : []),
  });
  return m;
}

/** A stone tower of the 1980s: punched windows, setbacks and a sculpted top (a pyramid, steps or a spire). */
function postmodernTower(ctx: GenContext, mask: Mask, H: number): VoxelModel {
  const { rand, hints } = ctx;
  const { depth, maxDepth: half } = footprintDepth(mask);
  const m = new VoxelModel(mask.sx, mask.sy, H + Math.max(10, Math.round(H * 0.25)));
  const p = materials(ctx, m);
  const fh = storey(H, hints?.floors);
  const baseH = Math.min(fh * 2, Math.round(H / 5));
  const steps = setbacks(rand, H, half, fh, 2, 0.62);
  const body = insetFrom(steps);
  const kTop = body(H - 1);
  const crown = hints?.roof === "pyramidal" ? 0 : Math.floor(rand() * 3); // 0 pyramid, 1 steps, 2 spire
  const room = half - kTop;
  const capH = room >= 2 ? (crown === 0 ? Math.min(room, Math.round(H * 0.18)) : crown === 1 ? Math.min(room - 1, 3) * 2 : 0) : 0;
  const Htot = H + capH;
  const inset = (z: number) => {
    if (z < H) return body(z);
    const c = z - H;
    return crown === 0 ? kTop + 1 + c : kTop + 1 + Math.floor(c / 2);
  };
  const W = rand() < 0.5 ? 1 : 2; // windows one or two voxels wide
  drawTower(m, {
    mask,
    depth,
    top: () => Htot,
    inset,
    interior: (z, roofTop) => (z >= H && crown === 0 ? p.cap : roofTop ? p.roof : p.wall),
    face: (s) => {
      if (s.z >= H) return { mat: crown === 0 ? p.cap : s.last ? p.trim : p.wall };
      const pos = mod(s.along, W + 1);
      if (s.z < baseH) return { mat: !s.corner && pos !== 0 && s.z >= 1 && s.z < baseH - 1 ? p.pane() : p.wall };
      const zf = mod(s.z - baseH, fh);
      // punched windows: a stone grid; the top storey of each stage a trim band
      if (s.last) return { mat: p.trim };
      return { mat: !s.corner && pos !== 0 && zf !== 0 && (fh < 4 || zf !== fh - 1) ? p.pane() : p.wall };
    },
    parapet: (s) => (s.z < H - 1 && mod(s.along, 2) === 0 ? [p.wall] : []),
  });
  if (crown === 2 && H >= 30) spire(m, Math.max(3, Math.round(H * 0.1)), p.trim);
  else if (crown === 0 && capH) spire(m, 2, p.trim);
  return m;
}

/**
 * A glass tower: a curtain wall of pale glass panels in a white frame (mullions
 * and floor lines), a lit panel here and there, and a crown by seed: a sloped
 * top, stepped corners, an open screen of fins, or a spire.
 */
function glassTower(ctx: GenContext, mask: Mask, H: number): VoxelModel {
  const { rand, hints } = ctx;
  const { depth, maxDepth: half } = footprintDepth(mask);
  const m = new VoxelModel(mask.sx, mask.sy, H + Math.max(10, Math.round(H * 0.16)));
  const p = materials(ctx, m);
  const fh = storey(H, hints?.floors);
  const baseH = Math.min(fh * 2, Math.round(H / 5));
  const crown = Math.floor(rand() * 4); // 0 sloped, 1 stepped, 2 fin screen, 3 spire
  const M = rand() < 0.5 ? 3 : 4; // mullion spacing
  // sloped top: the roof falls across the plan, along x or y
  const slopeH = crown === 0 ? Math.max(2, Math.round(H * 0.1)) : 0;
  const alongX = rand() < 0.5;
  const span = alongX ? mask.sx : mask.sy;
  const top = (x: number, y: number) => (slopeH ? H - Math.round((slopeH * (alongX ? x : y)) / Math.max(1, span - 1)) : H);
  const stepZ = H - Math.round(H * 0.14);
  const inset = (z: number) => (crown === 1 && half >= 5 && z >= stepZ ? 1 + Math.floor((z - stepZ) / Math.max(2, fh)) : 0);
  const salt = Math.floor(rand() * 0x7fffffff);
  drawTower(m, {
    mask,
    depth,
    top,
    inset: (z) => Math.min(half - 1, inset(z)),
    interior: (_z, roofTop) => (roofTop ? (slopeH ? p.reflect : p.roof) : p.wall),
    face: (s) => {
      const mullion = s.corner || mod(s.along, M) === 0;
      if (s.z < baseH) return { mat: mullion || s.z === baseH - 1 ? p.wall : p.glass };
      const zf = mod(s.z - baseH, fh);
      if (mullion || zf === 0) return { mat: p.wall };
      if (s.last && slopeH) return { mat: p.reflect };
      // a panel (between mullions, one storey) is lit or reflects the sky as a whole
      const col = Math.floor(s.along / M);
      const row = Math.floor((s.z - baseH) / fh);
      // a diagonal streak where the sky's reflection breaks, and a lit panel here and there
      if (mod(col + (s.nx !== 0 ? row : -row), 7) === 0) return { mat: p.glass };
      return { mat: hash2(col * 9 + (s.nx + 1) * 3 + (s.ny + 1), row, salt) < p.litShare * 0.5 ? p.lit : p.reflect };
    },
  });
  const z = topZ(m);
  if (crown === 2 && z > 0) {
    // an open screen: the facade's mullions run on past the roof
    const h = Math.max(3, Math.round(H * 0.06));
    for (let y = 0; y < m.sy; y++)
      for (let x = 0; x < m.sx; x++) {
        if (!m.get(x, y, H - 1) || m.get(x, y, H)) continue;
        const edge = !m.get(x - 1, y, H - 1) || !m.get(x + 1, y, H - 1) || !m.get(x, y - 1, H - 1) || !m.get(x, y + 1, H - 1);
        if (edge && mod(x + y, 2) === 0) for (let k = 0; k < h; k++) m.set(x, y, H + k, p.wall);
      }
  }
  if (crown === 3 && H >= 30) spire(m, Math.max(4, Math.round(H * 0.12)), p.wall);
  return m;
}

/** Pick a kind by seed, weighted by params and the data's hints. */
function pickKind(ctx: GenContext, H: number): Kind {
  const { rand, param, hints } = ctx;
  if (hints?.facade === "glass") return "glass";
  const w: Record<Kind, number> = {
    deco: H <= param("decoMaxHeight", 150) ? param("deco", 0.24) : 0,
    slab: param("slab", 0.2),
    granite: param("granite", 0.1),
    postmodern: param("postmodern", 0.2),
    glass: param("glass", 0.26),
  };
  const total = KINDS.reduce((a, k) => a + w[k], 0);
  let r = rand() * total;
  for (const k of KINDS) {
    r -= w[k];
    if (r < 0) return k;
  }
  return "glass";
}

/**
 * A downtown tower of a given kind (param `kind`: 0 deco, 1 slab, 2 granite,
 * 3 postmodern, 4 glass; -1 picks by seed and hints). With kind -1 each kind's
 * roles may be scoped by its name (`deco:wall`, `glass:reflect`) and fall
 * back to the plain role.
 * roles: wall, spandrel, trim, cap, reflect (pale glass panels), roof, window, lit.
 */
const sfTower: Generator = (ctx) => {
  const H = Math.max(8, Math.round(ctx.heightVox ?? ctx.param("height", 60)));
  const k = ctx.param("kind", -1);
  const kind: Kind = k >= 0 ? KINDS[Math.min(KINDS.length - 1, Math.round(k))]! : pickKind(ctx, H);
  const c = k >= 0 ? ctx : scope(ctx, kind + ":");
  const mask = ctx.mask ?? boxMask(H, ctx.param("width", 0.3), ctx.param("depth", 0.24));
  if (kind === "deco") return decoTower({ ...c, mask });
  if (kind === "slab") return slabTower(c, mask, H);
  if (kind === "granite") return graniteTower(c, mask, H);
  if (kind === "postmodern") return postmodernTower(c, mask, H);
  return glassTower(c, mask, H);
};

export const TOWER_GENERATORS: Record<string, Generator> = { decoTower, sfTower };
