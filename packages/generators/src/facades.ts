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

/**
 * Materials of a facade generator: a paint scheme (body, trim, accent), a roof,
 * glass and lit glass.
 *
 * A scheme is the variants that share a name: `wall.blue`, `trim.blue` and
 * `accent.blue` go together. When the trim or accent role names the same
 * variants as the wall (its list is as long; the lists are sorted by name, so
 * they line up), it comes from the body's scheme; otherwise it is picked on
 * its own. A variant listed twice (`wall.white`, `wall.white2`) is twice as
 * likely. The roof is picked from its own variants: light tar and gravel,
 * white coating or warm gravel on a flat roof.
 */
function palette(ctx: GenContext, m: VoxelModel) {
  const { rand, ramp, ramps } = ctx;
  const bodies = ramps("wall");
  const k = Math.floor(rand() * bodies.length);
  const body = m.material(bodies[k]!);
  const scheme = (role: string, fallback: number) => {
    const xs = ramps(role);
    if (!xs.length) return fallback;
    return m.material(xs.length === bodies.length ? xs[k]! : pick(rand, xs));
  };
  const trim = scheme("trim", body);
  const roofs = ramps("roof");
  const roof = m.material(roofs.length ? pick(rand, roofs) : ramp("roof"));
  const glass = m.material(ramp("window"));
  const lits = ramps("lit");
  const lit = lits.length ? m.material(pick(rand, lits)) : glass;
  const accent = scheme("accent", roof);
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

/** The row-house form of an era (params.type -1): Victorian, Edwardian, stucco or mid-century. */
function eraType(year: number | undefined): number {
  if (year === undefined) return 3;
  return year < 1906 ? 0 : year < 1920 ? 1 : year < 1950 ? 2 : 3;
}

/**
 * Row houses on narrow lots. params.type:
 * - 0 Victorian: a bay window, a false front with a cornice over a coloured
 *   frieze, now and then a Queen Anne gable.
 * - 1 Edwardian: a wider bay, a heavy cornice with dentils.
 * - 2 stucco (the Sunset and the Richmond): a garage and the entry at the
 *   street, a picture window above, a parapet with a tiled pent roof (mostly
 *   before the 1940s), sometimes a storybook gable.
 * - 3 mid-century: a garage and the entry at the street, a band of sliding
 *   windows, a flat fascia, sometimes a box bay and a veneer at the street.
 * - -1: the form of the era it was built in (hints.year), for detached houses.
 *
 * Painted-lady colouring comes from the scheme (see palette): a body paint,
 * trim at every floor line, on the bay posts, window hoods and the cornice,
 * and an accent on the frieze, the aprons under the bay windows and the door.
 * Victorians and Edwardians often have a garage under the bay and, on corner
 * lots, a corner store under the flats. Flat roofs are light; a parapet on
 * one lot line sets each house off from the next. Dark slate is kept for
 * gables.
 */
export const rowhouse: Generator = (ctx) => {
  const { rand, param, mask, hints } = ctx;
  if (!mask) throw new Error("rowhouse needs a footprint");
  const t = param("type", 0);
  const type = t >= 0 ? t : eraType(hints?.year);
  const year = hints?.year ?? (type === 3 ? 1965 : type === 2 ? 1935 : 1900);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  // neighbours differ by a voxel or so, so a row reads as separate lots
  const H = Math.max(3, Math.min(60, Math.round((ctx.heightVox ?? 8) + (rand() - 0.5) * 2.2)));
  let floors = Math.max(1, Math.min(6, hints?.floors ?? Math.round(H / 4)));
  // the roll counts storeys over a garage or a raised basement
  if (floors < 2 && H >= (type >= 2 ? 5 : 6)) floors = 2;
  const fh = Math.max(2, Math.floor(H / floors));
  // most Victorian rows are flat-roofed behind false fronts; Queen Annes add a gable
  const queenAnne = type === 0 && W >= 4 && rand() < (year >= 1888 ? 0.3 : 0.1);
  // storybook and Mediterranean revival belong to the 1920s and 30s
  const storybook = type === 2 && W >= 4 && year < 1942 && rand() < 0.22;
  const gable = queenAnne || storybook ? Math.max(1, Math.min(Math.floor(W / 2), Math.round(W * 0.4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + gable + 4);
  const p = palette(ctx, m);
  const eaves = ctx.ramps("eave");
  const tile = eaves.length ? m.material(eaves[0]!) : p.roof;
  // a stucco front's coping: a red-tiled pent roof, or plain
  const eave = rand() < (year < 1945 ? 0.75 : 0.35) ? tile : p.trim;
  massing(m, f, H, p.body, p.roof);
  const gables = ctx.ramps("gable");
  const gableRoof = gables.length ? m.material(pick(rand, gables)) : p.roof;
  // a parapet on one lot line: rows of light flat roofs read as separate houses
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! > 0 && f.along[i] === 0 && W >= 3) m.set(x, y, H, p.body);
    }

  // the bay: on one side of the front, the rest of the front stepped back a voxel
  const bayShare = type === 1 ? 0.55 : type === 2 ? 0.6 : type === 3 ? 0.5 : 0.45;
  const bayW = W >= 3 ? Math.max(1, Math.round(W * bayShare)) : 0;
  const bayLeft = rand() < 0.5;
  const inBay = (a: number) => (bayLeft ? a < bayW : a >= W - bayW);
  const boxBay = type >= 2 && rand() < (type === 2 ? 0.5 : 0.3);
  const bayFrom = type >= 2 || floors < 2 ? fh : type === 0 && floors >= 3 ? fh : 0;
  const recess = f.maxDepth >= 4 && bayW > 0 && (type < 2 || boxBay);
  if (recess)
    eachFront(f, 0, (x, y, a) => {
      if (!inBay(a)) for (let z = bayFrom; z < H; z++) m.set(x, y, z, 0);
    });
  const wallAt = (x: number, y: number, a: number, z: number) =>
    recess && !inBay(a) && z >= bayFrom ? [x - f.front[0], y - f.front[1]] : [x, y];
  const garage = type >= 2 || (W >= 5 && rand() < 0.45);
  const inGarage = (a: number) =>
    type === 2
      ? a >= Math.floor(W * 0.15) && a < Math.ceil(W * 0.7)
      : type === 3
        ? a >= Math.floor(W * 0.1) && a < Math.ceil(W * 0.6)
        : inBay(a);
  const doorAt = bayLeft ? Math.min(W - 1, bayW + Math.floor((W - bayW) / 2)) : Math.max(0, Math.floor((W - bayW) / 2) - 1);
  // mid-century: a brick or stone veneer at the street on some
  const veneer = type === 3 && rand() < 0.35;
  // a corner store under the flats: shop windows and a sign band (no lettering)
  const cornerStore = hints?.corner === true && type < 2 && W >= 4 && rand() < 0.5;
  // the windows beside the bay on a wide front: pairs between posts
  const n0 = bayLeft ? bayW : 0;
  const besideBay = (a: number) => a === doorAt || (W >= 8 && !inBay(a) && (a - n0) % 3 !== 0);
  const bayEdge = (a: number) => a === (bayLeft ? bayW - 1 : W - bayW) || a === (bayLeft ? 0 : W - 1);
  // window rows stop under the frieze and cornice (types 0-1) or the coping (2-3)
  const zTop = type >= 2 ? H - 1 : H - 2;

  for (let k = 0; k < floors; k++) {
    const z0 = k * fh;
    const ground = k === 0;
    eachFront(f, 0, (x, y, a) => {
      // the string course: trim along every floor line
      if (k > 0 && type < 2) {
        const [sx, sy] = wallAt(x, y, a, z0);
        onFace(m, f, sx!, sy!, z0, p.trim);
      }
      for (let z = z0 + 1; z < Math.min(zTop, z0 + fh); z++) {
        const [wx, wy] = wallAt(x, y, a, z);
        const zf = z - z0;
        const top = zf === fh - 1 && fh >= 3; // the lintel row
        if (ground) {
          if (cornerStore) {
            if (top) onFace(m, f, wx!, wy!, z, p.accent);
            else onFace(m, f, wx!, wy!, z, a === doorAt ? p.accent : a % 3 === 0 ? p.trim : p.pane());
          } else if (garage && inGarage(a) && (type >= 2 || !top)) {
            onFace(m, f, wx!, wy!, z, type >= 2 ? p.trim : p.accent); // the garage door
          } else if (a === doorAt && !top) onFace(m, f, wx!, wy!, z, p.accent); // the front door
          else if (veneer) onFace(m, f, wx!, wy!, z, p.accent);
          else if (!garage && inBay(a) && !top) onFace(m, f, wx!, wy!, z, p.pane());
          continue;
        }
        if (type === 3) {
          // a band of sliding windows with posts every few columns
          if (!top && a > 0 && a < W - 1) onFace(m, f, wx!, wy!, z, a % 4 === 0 ? p.trim : p.pane());
          continue;
        }
        if (top) {
          // hoods over the windows; at the driving scale a Victorian's bay carries its accent here
          if (type === 0 && inBay(a)) onFace(m, f, wx!, wy!, z, fh >= 5 ? p.trim : p.accent);
          else if (type === 1 && fh >= 5 && (inBay(a) || besideBay(a))) onFace(m, f, wx!, wy!, z, p.trim);
          continue;
        }
        if (type < 2 && fh >= 5 && zf === 1) {
          // aprons under the windows: a Victorian bay's panels in the accent
          if (type === 0 && inBay(a)) onFace(m, f, wx!, wy!, z, p.accent);
          continue;
        }
        if (inBay(a)) onFace(m, f, wx!, wy!, z, bayEdge(a) && bayW >= 3 && type < 2 ? p.trim : p.pane());
        else if (type === 2) {
          if (W >= 3 && a !== doorAt) onFace(m, f, wx!, wy!, z, p.pane()); // the picture window
        } else if (besideBay(a)) onFace(m, f, wx!, wy!, z, p.pane());
      }
    });
  }

  // the top: a frieze and cornice under a false front, a stucco parapet, or a fascia
  eachFront(f, 0, (x, y, a) => {
    const [wx, wy] = wallAt(x, y, a, H - 1);
    if (type === 2) {
      m.set(wx!, wy!, H - 1, p.body);
      if (!gable) m.set(wx!, wy!, H, eave); // a parapet, often with a tiled pent roof
      return;
    }
    if (type === 3) {
      m.set(wx!, wy!, H - 1, p.trim);
      return;
    }
    if (H >= 6) m.set(wx!, wy!, H - 3, (a + (bayLeft ? 0 : 1)) % 2 === 0 && type === 1 ? p.trim : p.accent);
    m.set(wx!, wy!, H - 2, p.trim);
    m.set(wx!, wy!, H - 1, p.trim);
  });
  if (gable > 0) {
    // a short pitched roof running back from the street, its gable end on the front
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const back = recess && !inBay(a) ? 1 : 0;
        const d = f.depth[i]! - back;
        if (f.depth[i]! < 0 || d < 0 || d > Math.max(2, Math.floor(W / 2))) continue;
        const rise = Math.min(gable, Math.min(a, W - 1 - a) + 1);
        const r = type === 2 ? tile : gableRoof;
        for (let z = H; z < H + rise; z++) m.set(x, y, z, d === 0 ? (z === H + rise - 1 ? r : p.body) : r);
      }
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const back = recess && !inBay(a) ? 1 : 0;
        if (f.depth[i]! - back === 0 && gable >= 2 && Math.abs(a - (W - 1) / 2) < 1) onFace(m, f, x, y, H, p.pane());
      }
  } else if (type < 2) {
    // the false front: a parapet with a raised centre (a pediment) above the flat roof
    eachFront(f, 0, (x, y, a) => {
      const [wx, wy] = wallAt(x, y, a, H);
      m.set(wx!, wy!, H, p.trim);
      if (W >= 5 && Math.abs(a - (W - 1) / 2) <= W / 6 && m.get(wx!, wy!, H)) m.set(wx!, wy!, H + 1, p.trim);
    });
  }
  // a roof deck on some wide, deep lots (the walking scale): a stair penthouse
  // by the far lot line and a rail around the deck in front of it
  if (W >= 8 && f.maxDepth >= 12 && gable === 0 && rand() < 0.3) {
    const pw = Math.max(2, Math.floor(W / 4));
    const d0 = Math.floor(f.maxDepth * 0.45);
    const ph = Math.max(2, Math.min(3, Math.floor(fh / 2)));
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const d = f.depth[i]!;
        if (d < 0) continue;
        if (a >= W - 1 - pw && a < W - 1 && d >= d0 && d < d0 + 3) {
          for (let z = H; z < H + ph; z++) m.set(x, y, z, z === H + ph - 1 ? p.roof : p.body);
          if (d === d0 && a === W - 1 - pw) onFace(m, f, x, y, H, p.accent); // its door
        } else if (d >= d0 - 5 && d < d0 && a >= 2 && a < W - 1 && (d === d0 - 5 || a === 2 || a === W - 2)) m.set(x, y, H, p.trim);
      }
  }
  // side walls are mostly blank: party walls, with a window here and there where they show
  sideWindows(m, f, H, fh, p.pane, 4);
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
  const { rand, param, mask, hints } = ctx;
  if (!mask) throw new Error("block needs a footprint");
  const type = param("type", 0);
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = Math.max(3, Math.min(120, Math.round(ctx.heightVox ?? 10)));
  const floors = Math.max(1, Math.min(30, hints?.floors ?? Math.round(H / 4)));
  const fh = Math.max(2, Math.floor(H / floors));
  const pierGable = type === 3 ? Math.max(1, Math.min(4, Math.floor(W / 4))) : 0;
  const m = new VoxelModel(f.sx, f.sy, H + Math.max(pierGable, 5) + 3);
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
    // balconies: a red rail at the foot of every floor; signs hung down the front
    for (let k = 1; k < floors; k++)
      eachFront(f, 0, (x, y) => {
        if (k * fh + 1 < H - 2) onFace(m, f, x, y, k * fh + 1, p.trim);
      });
    const signs = ctx.ramps("sign");
    if (signs.length && W >= 3)
      eachFront(f, 0, (x, y, a) => {
        if (a === 1 || (W >= 9 && a === W - 2))
          for (let z = fh; z < Math.min(H - 3, 3 * fh); z++) onFace(m, f, x, y, z, m.material(signs[(a + z) % signs.length]!));
      });
    // a jade tile eave with upturned corners
    const eaves = ctx.ramps("eave");
    const eave = eaves.length ? m.material(eaves[0]!) : p.roof;
    eachFront(f, 0, (x, y, a) => {
      m.set(x, y, H - 2, eave);
      m.set(x, y, H - 1, eave);
      if (a === 0 || a === W - 1) m.set(x, y, H, eave);
    });
    // a pagoda roof on some: two tiers of jade on red posts, near the front
    if (W >= 5 && f.maxDepth >= 5 && rand() < 0.35) {
      const pw = Math.max(3, Math.min(W - 2, Math.round(W * 0.5)));
      const a0 = Math.floor((W - pw) / 2);
      for (let y = 0; y < f.sy; y++)
        for (let x = 0; x < f.sx; x++) {
          const i = y * f.sx + x;
          const a = f.along[i]!;
          const d = f.depth[i]!;
          if (d < 1 || d > pw || a < a0 || a >= a0 + pw) continue;
          const da = Math.min(a - a0, a0 + pw - 1 - a);
          const dd = Math.min(d - 1, pw - d);
          const ring = Math.min(da, dd);
          m.set(x, y, H, ring === 0 ? p.trim : eave);
          m.set(x, y, H + 1, eave);
          if (ring >= 1) m.set(x, y, H + 2, eave);
          if (ring >= 1 && ring <= 1) m.set(x, y, H + 3, eave);
          if (ring >= 2) for (let z = H + 2; z < H + 5; z++) m.set(x, y, z, eave);
        }
    }
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
