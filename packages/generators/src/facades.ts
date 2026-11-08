import type { GenContext, Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Street-facing building typologies (D-055): row houses and blocks whose front
 * faces their street (the `front` hint, from the pipeline), so a city reads by
 * its ordinary fabric. Everything stays inside the footprint and nothing
 * overhangs: bays are drawn by recessing the rest of the front, cornices sit on
 * the wall below them, and windows go only on exposed faces.
 */

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
function frontDir(mask: { sx: number; sy: number }, hint?: number): number {
  if (hint !== undefined && hint >= 0 && hint < 8) return hint;
  return mask.sx <= mask.sy ? 2 : 0;
}

export function facadeOf(mask: { sx: number; sy: number; on: Uint8Array }, front: number): Facade {
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

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

/** Materials of a facade generator: body (a paint scheme), trim, roof, glass, lit, accent. */
function palette(ctx: GenContext, m: VoxelModel) {
  const { rand, ramp, ramps } = ctx;
  const bodies = ramps("wall");
  const body = m.material(pick(rand, bodies));
  const trims = ramps("trim");
  const trim = trims.length ? m.material(pick(rand, trims)) : body;
  const roof = m.material(ramp("roof"));
  const glass = m.material(ramp("window"));
  const lits = ramps("lit");
  const lit = lits.length ? m.material(pick(rand, lits)) : glass;
  const accents = ramps("accent");
  const accent = accents.length ? m.material(pick(rand, accents)) : roof;
  const litFraction = ctx.param("litFraction", 0.3);
  return { body, trim, roof, glass, lit, accent, pane: () => (rand() < litFraction ? lit : glass) };
}

/** Fill the footprint to height H with `body`, a roof skin on top. */
function massing(m: VoxelModel, f: Facade, H: number, body: number, roof: number): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      if (f.depth[y * f.sx + x]! < 0) continue;
      for (let z = 0; z < H - 1; z++) m.set(x, y, z, body);
      m.set(x, y, H - 1, roof);
    }
}

/** Visit the voxel columns of the front (depth d), with their position along it. */
function eachFront(f: Facade, d: number, fn: (x: number, y: number, a: number) => void): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) if (f.depth[y * f.sx + x] === d) fn(x, y, f.along[y * f.sx + x]!);
}

/** Paint `mat` on (x, y, z) only if it shows toward the street (its front neighbour is empty). */
function onFace(m: VoxelModel, f: Facade, x: number, y: number, z: number, mat: number): void {
  if (!m.get(x, y, z)) return;
  // a diagonal front shows through its axis neighbours
  const [fx, fy] = f.front;
  const open = (fx !== 0 && !m.get(x + fx, y, z)) || (fy !== 0 && !m.get(x, y + fy, z));
  if (open) m.set(x, y, z, mat);
}

/** Windows on every exposed side wall face except the front (rear and detached sides). */
function sideWindows(m: VoxelModel, f: Facade, H: number, fh: number, pane: () => number, every = 2): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const d = f.depth[y * f.sx + x]!;
      if (d <= 0) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        if (dx === -f.front[0] && dy === -f.front[1]) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < f.sx && ny < f.sy && f.depth[ny * f.sx + nx]! >= 0) continue;
        if ((x + y) % every !== 0) continue;
        for (let z = 1; z < H - 1; z++) {
          const zf = z % fh;
          // a window per floor: wall at the floor line and, on taller floors, a lintel
          if (zf === 0 || (fh >= 3 && zf === fh - 1)) continue;
          if (!m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
        }
      }
    }
}

/**
 * Row houses on narrow lots. params.type: 0 Victorian (bay window, false-front
 * cornice or a Queen Anne gable, by year), 1 Edwardian (stacked bays, heavy
 * cornice), 2 stucco (garage below, a picture window, a tiled eave or a
 * storybook gable).
 */
export const rowhouse: Generator = (ctx) => {
  const { rand, param, mask, hints } = ctx;
  if (!mask) throw new Error("rowhouse needs a footprint");
  const type = param("type", 0);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  // neighbours differ by a voxel or so, so a row reads as separate lots
  const H = Math.max(3, Math.min(60, Math.round((ctx.heightVox ?? 8) + (rand() - 0.5) * 2.2)));
  const floors = Math.max(1, Math.min(6, hints?.floors ?? Math.round(H / 4)));
  const fh = Math.max(2, Math.floor(H / floors));
  const year = hints?.year ?? 1900;
  const queenAnne = type === 0 && (year >= 1888 || rand() < 0.3) && W >= 3;
  const storybook = type === 2 && rand() < 0.3 && W >= 4;
  const gable = queenAnne || storybook ? Math.max(1, Math.min(Math.floor(W / 2), Math.round(W * 0.45))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + gable + 3);
  const p = palette(ctx, m);
  // stucco houses: a tiled eave and storybook gables (the `eave` role)
  const eaves = ctx.ramps("eave");
  const eave = eaves.length ? m.material(pick(rand, eaves)) : p.roof;
  const roofs = ctx.ramps("roof");
  massing(m, f, H, p.body, roofs.length > 1 ? m.material(pick(rand, roofs)) : p.roof);
  const gables = ctx.ramps("gable");
  const gableRoof = gables.length ? m.material(pick(rand, gables)) : p.roof;
  // a fire wall on one lot line: rows of flat roofs read as separate houses
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! > 0 && f.along[i] === 0 && W >= 3) m.set(x, y, H - 1, p.trim);
    }

  // the bay: on one side of the front, the rest of the front stepped back a voxel
  const bayW = W >= 3 ? Math.max(1, Math.round(W * (type === 1 ? 0.55 : 0.45))) : 0;
  const bayLeft = rand() < 0.5;
  const inBay = (a: number) => (bayLeft ? a < bayW : a >= W - bayW);
  const bayFrom = type === 2 || floors < 2 ? fh : type === 0 && floors >= 3 ? fh : 0;
  const recess = f.maxDepth >= 4 && bayW > 0 && type !== 2;
  if (recess)
    eachFront(f, 0, (x, y, a) => {
      if (!inBay(a)) for (let z = bayFrom; z < H; z++) m.set(x, y, z, 0);
    });

  const wallAt = (x: number, y: number, a: number) => (recess && !inBay(a) ? [x - f.front[0], y - f.front[1]] : [x, y]);
  // windows, floor by floor
  for (let k = 0; k < floors; k++) {
    const z0 = k * fh;
    const ground = k === 0;
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a);
      for (let z = z0 + 1; z < Math.min(H - 1, z0 + fh); z++) {
        if (type === 2 && ground) {
          // the garage door, centred, and the entry stair beside it
          const door = a >= Math.floor(W * 0.2) && a < Math.ceil(W * 0.75);
          if (door) onFace(m, f, wx!, wy!, z, p.trim);
          continue;
        }
        if (inBay(a)) {
          const edge = (bayLeft ? a === bayW - 1 : a === W - bayW) || (bayLeft ? a === 0 : a === W - 1);
          onFace(m, f, wx!, wy!, z, edge && bayW >= 3 && type !== 2 ? p.trim : p.pane());
        } else if (type === 2) {
          // a picture window across the living floor
          if (k === 1 || floors === 1) onFace(m, f, wx!, wy!, z, p.pane());
        } else {
          const mid = bayLeft ? Math.floor((bayW + W) / 2) : Math.floor((W - bayW) / 2);
          if (ground && a === mid) onFace(m, f, wx!, wy!, z, p.accent); // the door
          else if (!ground && (a === mid || W >= 8)) onFace(m, f, wx!, wy!, z, p.pane());
        }
      }
    });
  }

  // the top: a cornice and false front, an eave of tile, or a gable to the street
  eachFront(f, 0, (x, y, a) => {
    const [wx, wy] = wallAt(x, y, a);
    if (type === 2) {
      m.set(wx!, wy!, H - 1, eave);
      return;
    }
    m.set(wx!, wy!, H - 2, p.trim);
    m.set(wx!, wy!, H - 1, p.trim);
    if (type === 1 && (a + (bayLeft ? 0 : 1)) % 2 === 0) m.set(wx!, wy!, H - 3, p.trim); // dentils
  });
  if (gable > 0) {
    // a pitched roof running back from the street, its gable end on the front
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        // where the front is stepped back, the gable stands on the wall behind
        const back = recess && !inBay(a) ? 1 : 0;
        const d = f.depth[i]! - back;
        if (f.depth[i]! < 0 || d < 0 || d > Math.max(2, Math.min(Math.floor(f.maxDepth * 0.5), W))) continue;
        const rise = Math.min(gable, Math.min(a, W - 1 - a) + 1);
        const r = type === 2 ? eave : gableRoof;
        for (let z = H; z < H + rise; z++) m.set(x, y, z, d === 0 ? (z === H + rise - 1 ? r : p.body) : r);
      }
    // the attic window, in the gable end
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const back = recess && !inBay(a) ? 1 : 0;
        if (f.depth[i]! - back === 0 && gable >= 2 && Math.abs(a - (W - 1) / 2) < 1) onFace(m, f, x, y, H, p.pane());
      }
  } else if (type !== 2) {
    // the false front: a parapet above the flat roof
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a);
      m.set(wx!, wy!, H, p.trim);
    });
  }
  sideWindows(m, f, H, fh, p.pane, 3);
  return m;
};

/**
 * Blocks on wider lots. params.type: 0 apartments with stacked bays and a
 * cornice, 1 historic commercial (storefronts, paired windows, cornice),
 * 2 Chinatown (balconies, a green tile eave), 3 a pier shed (arched bulkhead,
 * low gable), 4 a warehouse (window grid, sawtooth roof), 5 a plain modern
 * block (ribbon windows).
 */
export const block: Generator = (ctx) => {
  const { param, mask, hints } = ctx;
  if (!mask) throw new Error("block needs a footprint");
  const type = param("type", 0);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = Math.max(3, Math.min(120, Math.round(ctx.heightVox ?? 10)));
  const floors = Math.max(1, Math.min(30, hints?.floors ?? Math.round(H / 4)));
  const fh = Math.max(2, Math.floor(H / floors));
  const pierGable = type === 3 ? Math.max(1, Math.min(4, Math.floor(W / 4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + pierGable + 3);
  const p = palette(ctx, m);
  massing(m, f, H, p.body, p.roof);

  const bayEvery = W >= 12 ? 5 : 3;
  const recessFront = type === 0 && f.maxDepth >= 4 && W >= 4;
  const isBay = (a: number) => a % bayEvery >= 1 && a % bayEvery <= Math.min(2, bayEvery - 1) && a < W - 1;
  if (recessFront)
    eachFront(f, 0, (x, y, a) => {
      if (!isBay(a)) for (let z = fh; z < H; z++) m.set(x, y, z, 0);
    });
  const wallAt = (x: number, y: number, a: number) =>
    recessFront && !isBay(a) ? [x - f.front[0], y - f.front[1]] : [x, y];

  eachFront(f, 0, (x, y, a) => {
    const [wx, wy] = wallAt(x, y, a);
    for (let z = 1; z < H - 1; z++) {
      const k = Math.floor(z / fh);
      const zf = z - k * fh;
      if (zf === 0) continue; // floor lines stay wall
      const ground = k === 0;
      if (type === 3) {
        // the bulkhead: a tall arch in the middle third, piers either side
        const mid = Math.abs(a - (W - 1) / 2) <= Math.max(1, W / 6);
        if (mid && z < H - 2) onFace(m, f, wx!, wy!, z, z >= H - 3 ? p.trim : p.accent);
        else if (z === H - 2 && a % 2 === 0) onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      if (ground && (type === 1 || type === 2)) {
        // storefronts between piers
        onFace(m, f, wx!, wy!, z, a % 4 === 0 ? p.trim : z === fh - 1 ? p.trim : p.pane());
        continue;
      }
      if (type === 4) {
        if (a % 3 !== 0 && zf !== fh - 1) onFace(m, f, wx!, wy!, z, p.glass);
        continue;
      }
      const lintel = fh >= 3 && zf === fh - 1;
      if (type === 5) {
        // ribbon windows
        if (!lintel) onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      if (type === 0) {
        // the bays glazed floor to floor; one window between them
        if (isBay(a) ? !lintel : (W < 6 || a % bayEvery === 0) && !lintel && zf === Math.max(1, Math.floor(fh / 2)))
          onFace(m, f, wx!, wy!, z, p.pane());
        continue;
      }
      // historic commercial and Chinatown: paired windows between piers
      if (a % 3 !== 0 && !lintel) onFace(m, f, wx!, wy!, z, p.pane());
      if (type === 2 && zf === 1 && a % 3 === 0) onFace(m, f, wx!, wy!, z, p.trim); // balcony posts
    }
  });
  if (type === 2) {
    // balconies: a rail of trim at the foot of every floor, and a green tile eave
    for (let k = 1; k < floors; k++)
      eachFront(f, 0, (x, y) => {
        if (k * fh + 1 < H - 2) onFace(m, f, x, y, k * fh + 1, p.trim);
      });
    const eaves = ctx.ramps("eave");
    const eave = eaves.length ? m.material(eaves[0]!) : p.roof;
    eachFront(f, 0, (x, y, a) => {
      m.set(x, y, H - 2, eave);
      m.set(x, y, H - 1, eave);
      if (a === 0 || a === W - 1) m.set(x, y, H, eave); // upturned corners
    });
  } else if (type === 0 || type === 1) {
    // the cornice
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a);
      m.set(wx!, wy!, H - 2, p.trim);
      m.set(wx!, wy!, H - 1, p.trim);
    });
  }
  if (type === 3) {
    // a low gable along the shed
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        if (f.depth[i]! < 0) continue;
        const a = f.along[i]!;
        const rise = Math.min(pierGable, Math.floor(Math.min(a, W - 1 - a) / 2) + 1);
        for (let z = H; z < H + rise; z++) m.set(x, y, z, f.depth[i] === 0 && z < H + rise - 1 ? p.body : p.roof);
      }
  }
  if (type === 4 && f.maxDepth >= 4) {
    // sawtooth roof: teeth across the depth, glazed on their steep side
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const d = f.depth[i]!;
        if (d < 0) continue;
        const t = d % 4;
        for (let z = H; z < H + t; z++) m.set(x, y, z, t > 0 && z === H + t - 1 && d % 4 === 3 ? p.glass : p.roof);
      }
  }
  sideWindows(m, f, H, fh, p.pane, type === 4 ? 3 : 2);
  return m;
};

export const FACADE_GENERATORS: Record<string, Generator> = { rowhouse, block };
