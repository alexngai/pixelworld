import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";

/**
 * Tokyo's landmark shapes (D-092): a slab splitting into twin towers (the
 * Metropolitan Government Building), a round tower of banded panels (Shibuya
 * 109's cylinder) and a myōjin torii (the Meiji Shrine's great gate), each on
 * the proportions of the landmark of its type. No names, no logos, no crests:
 * where a sign or a plaque stands in life, a blank panel.
 *
 * Plans come from metres: a voxel is 1/16 of a cell across, and heights are
 * stretched by the style's heightStretch (1.5), so a plan dimension over the
 * height H in voxels is its metres over 1.5 × the height in metres.
 */

const role = (ctx: GenContext, m: VoxelModel, name: string, fallback: string): number => m.material(ctx.ramps(name)[0] ?? ctx.ramp(fallback));

/** Fill the box from (x0, y0, z0) to (x1, y1, z1), both corners included. */
const box = (m: VoxelModel, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: number): void =>
  m.fill(x0, y0, z0, x1 + 1, y1 + 1, z1 + 1, mat);

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * A city hall of two towers, along +x: a slab whose upper third splits into
 * a square tower at each end, each chamfered at its top storeys into a
 * square turned 45° under a plant room and a mast. The skin is a grid of
 * light stone piers and floor bands round dark stone and glass, finer on the
 * towers; a tall glazed lobby at the foot of the middle. Over the height H:
 * length 0.305 and depth 0.167 (111 by 61 m under 243 m), towers 0.36 of the
 * length each, the split at 0.66, the chamfer from 0.88.
 * params: length, depth, tower, split, chamfer, storeys (48).
 * roles: wall (the light stone), spandrel (the dark stone), roof, window, lit.
 */
export const twinTowerHall: Generator = (ctx) => {
  const { param, rand } = ctx;
  const H = Math.max(40, Math.round(ctx.heightVox ?? 360));
  const L = Math.max(12, Math.round(H * param("length", 0.305)));
  const D = Math.max(6, Math.round(H * param("depth", 0.167)));
  const T = Math.max(4, Math.round(L * param("tower", 0.36)));
  const zS = Math.round(H * param("split", 0.66));
  const zC = Math.round(H * param("chamfer", 0.88));
  const fh = Math.max(3, Math.round(H / param("storeys", 48)));
  const mast = Math.max(3, Math.round(H * 0.05));
  const m = new VoxelModel(L, D, H + mast + 2);
  const light = m.material(ctx.ramp("wall"));
  const dark = role(ctx, m, "spandrel", "wall");
  const roof = m.material(ctx.ramp("roof"));
  const glass = m.material(ctx.ramp("window"));
  const lits = ctx.ramps("lit");
  const lit = lits.length ? m.material(lits[0]!) : glass;
  const litFraction = param("litFraction", 0.4);
  const pane = () => (rand() < litFraction ? lit : glass);

  // the plan at each height: the slab, then the two towers, chamfered near the top
  const maxC = Math.floor(Math.min(T, D) / 2) - 1;
  const solid = (x: number, y: number, z: number): boolean => {
    if (x < 0 || y < 0 || x >= L || y >= D || z < 0 || z >= H) return false;
    if (z < zS) return true;
    const u = x < T ? x : x >= L - T ? x - (L - T) : -1;
    if (u < 0) return false;
    if (z < zC) return true;
    const c = Math.min(maxC, Math.round((z - zC) * 0.8) + 1);
    return Math.min(u, T - 1 - u) + Math.min(y, D - 1 - y) >= c;
  };
  for (let z = 0; z < H; z++)
    for (let y = 0; y < D; y++)
      for (let x = 0; x < L; x++) {
        if (!solid(x, y, z)) continue;
        const top = !solid(x, y, z + 1);
        const ex = !solid(x - 1, y, z) || !solid(x + 1, y, z);
        const ey = !solid(x, y - 1, z) || !solid(x, y + 1, z);
        if (top) {
          m.set(x, y, z, roof);
          continue;
        }
        if (!ex && !ey) {
          m.set(x, y, z, light);
          continue;
        }
        // the skin: s runs along the face
        const s = ey ? x : y;
        const zf = mod(z, fh);
        const tower = z >= zS;
        const pier = mod(s, tower ? 3 : 4) === 0;
        const corner = (ex && ey) || s === 0 || (ey ? s === L - 1 : s === D - 1);
        let mat: number;
        if (z < fh * 3 && !tower) {
          // the lobby: tall glass between piers at the foot of the middle
          const mid = x >= T && x < L - T;
          mat = mid && !pier && z > 0 && z < fh * 3 - 1 ? pane() : light;
        } else if (corner || zf === 0) mat = light;
        else if (pier) mat = light;
        else if (zf === 1 || zf === fh - 1) mat = light; // sills and lintels in the light stone
        else if (zf === 2 || (tower && mod(s, 6) === 3)) mat = dark; // dark panels under the glass, and stripes on the towers
        else mat = pane();
        m.set(x, y, z, mat);
      }
  // a plant room and a mast on each tower
  for (const x0 of [0, L - T]) {
    const cx = x0 + Math.floor(T / 2);
    const cy = Math.floor(D / 2);
    const r = Math.max(1, Math.floor(T / 6));
    box(m, cx - r, cy - r, H, cx + r, cy + r, H + 1, dark);
    for (let z = H + 2; z < H + mast; z++) m.set(cx, cy, z, light);
  }
  return m;
};

/**
 * A round tower of banded panels (Shibuya 109's cylinder) on a round
 * footprint, or a disc of radius `radius` × H without one: silver bands at
 * each floor line between bands of glass, a lit sign band below the top, and
 * on top a fin, a blank panel standing across the drum where the sign is.
 * params: radius (0.15), storeys (9), fin (its height over H; 0.22).
 * roles: wall (the panels), trim (the floor bands), sign (the sign band and
 * the fin's face), frame (the fin's back; trim if absent), roof, window, lit.
 */
export const cylinderTower: Generator = (ctx) => {
  const { param, rand } = ctx;
  const H = Math.max(12, Math.round(ctx.heightVox ?? 90));
  let mask = ctx.mask;
  if (!mask) {
    const r = Math.max(3, Math.round(H * param("radius", 0.15)));
    const s = 2 * r + 1;
    const on = new Uint8Array(s * s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) on[y * s + x] = (x - r) ** 2 + (y - r) ** 2 <= r * r + r * 0.6 ? 1 : 0;
    mask = { sx: s, sy: s, on };
  }
  const { sx, sy, on } = mask;
  const fin = Math.max(4, Math.round(H * param("fin", 0.22)));
  const m = new VoxelModel(sx, sy, H + fin + 1);
  const wall = m.material(ctx.ramp("wall"));
  const trim = role(ctx, m, "trim", "wall");
  const signMat = role(ctx, m, "sign", "trim");
  const frame = m.material(ctx.ramps("frame")[0] ?? ctx.ramps("trim")[0] ?? ctx.ramp("wall"));
  const roof = m.material(ctx.ramp("roof"));
  const glass = m.material(ctx.ramp("window"));
  const lits = ctx.ramps("lit");
  const lit = lits.length ? m.material(lits[0]!) : glass;
  const fh = Math.max(3, Math.round(H / param("storeys", 9)));
  const inMask = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const band = Math.max(2, Math.round(fh * 0.8));
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inMask(x, y)) continue;
      const edge = !inMask(x - 1, y) || !inMask(x + 1, y) || !inMask(x, y - 1) || !inMask(x, y + 1);
      for (let z = 0; z < H; z++) {
        let mat = wall;
        if (z === H - 1) mat = roof;
        else if (edge) {
          const zf = z % fh;
          if (z >= H - 1 - band) mat = signMat; // the lit band under the top
          else if (zf === 0) mat = trim;
          else if (z < fh) mat = zf < fh - 1 ? (rand() < 0.5 ? lit : glass) : trim; // the entrance's glass
          else mat = zf <= Math.max(1, Math.floor(fh / 3)) ? glass : wall;
        }
        m.set(x, y, z, mat);
      }
    }
  // the fin: a blank panel across the middle of the drum, its face toward +y
  let x0 = sx;
  let x1 = -1;
  const cy = Math.floor(sy / 2);
  for (let x = 0; x < sx; x++) if (inMask(x, cy)) [x0, x1] = [Math.min(x0, x), Math.max(x1, x)];
  const fw = Math.max(2, Math.round((x1 - x0 + 1) * 0.7));
  const fa = x0 + Math.floor((x1 - x0 + 1 - fw) / 2);
  for (let x = fa; x < fa + fw; x++)
    for (const y of [cy, cy + 1])
      if (inMask(x, y)) for (let z = H; z < H + fin; z++) m.set(x, y, z, y === cy + 1 ? signMat : z === H + fin - 1 ? trim : frame);
  return m;
};

/**
 * A myōjin torii, its lintel along +x: two round pillars on dark bases, a
 * tie beam (nuki) through them that runs a little past each, a strut in the
 * middle up to the second beam (shimaki), and over it the lintel (kasagi),
 * longer than the tie beam, whose ends curve up. The beams overhang the
 * pillars: a gate, not a building. Over the height H: the lintel 0.94 long
 * (17.1 m over 12 m), the pillars 0.5 apart (9.1 m) and 0.07 thick (1.2 m).
 * params: width, span, pillar.
 * roles: wood (the timber), cap (the lintel's top; wood if absent), base
 * (the pillars' feet; cap if absent).
 */
export const myojinTorii: Generator = (ctx) => {
  const { param } = ctx;
  const H = Math.max(10, Math.round(ctx.heightVox ?? 29));
  const pd = Math.max(1, Math.round(H * param("pillar", 0.07)));
  const W = Math.max(pd * 2 + 5, Math.round(H * param("width", 0.94)) | 1);
  const span = Math.round(H * param("span", 0.5));
  const D = pd + 2;
  const m = new VoxelModel(W, D, H + 2);
  const wood = m.material(ctx.ramp("wood"));
  const cap = role(ctx, m, "cap", "wood");
  const base = m.material(ctx.ramps("base")[0] ?? ctx.ramps("cap")[0] ?? ctx.ramp("wood"));
  const cx = (W - 1) / 2;
  const y0 = 1; // the pillars' first row; the lintel is a voxel wider each side
  const left = Math.round(cx - span / 2 - (pd - 1) / 2);
  const right = Math.round(cx + span / 2 - (pd - 1) / 2);
  const kh = Math.max(1, Math.round(H * 0.07)); // the lintel's rows
  const sh = Math.max(1, Math.round(H * 0.05)); // the second beam's
  const zK = H - kh; // the lintel's foot at its middle
  const zSh = zK - sh;
  const nh = Math.max(1, Math.round(H * 0.06));
  const zN = Math.round(H * 0.68);
  const lift = Math.max(1, Math.round(H * 0.035)); // how far the lintel's ends curve up
  // the pillars, rounded at their corners when thick, on dark bases
  for (const x0 of [left, right]) {
    for (let z = 0; z < zSh; z++)
      for (let dx = 0; dx < pd; dx++)
        for (let dy = 0; dy < pd; dy++) {
          const corner = pd >= 3 && (dx === 0 || dx === pd - 1) && (dy === 0 || dy === pd - 1);
          if (!corner) m.set(x0 + dx, y0 + dy, z, wood);
        }
    const bh = Math.max(1, Math.round(H * 0.05));
    box(m, x0 - 1, y0 - 1, 0, x0 + pd, y0 + pd, bh - 1, base);
  }
  // the tie beam, through the pillars and a little past them
  const ext = Math.max(1, Math.round(span * 0.16));
  const ny = pd >= 3 ? y0 + 1 : y0;
  box(m, left - ext, ny, zN, right + pd - 1 + ext, ny + Math.max(0, pd - 3), zN + nh - 1, wood);
  // the strut between the tie beam and the second beam
  const sw = Math.max(1, Math.round(pd / 2));
  box(m, Math.floor(cx) - Math.floor((sw - 1) / 2), ny, zN + nh, Math.floor(cx) + Math.floor(sw / 2), ny, zSh - 1, wood);
  // the second beam, as long as the lintel less its ends
  const inset = Math.max(1, Math.round(W * 0.06));
  box(m, inset, y0, zSh, W - 1 - inset, y0 + pd - 1, zK - 1, wood);
  // the lintel: its ends curve up, its top capped
  for (let x = 0; x < W; x++) {
    const t = Math.abs(x - cx) / (W / 2); // 0 in the middle, 1 at the ends
    const up = t > 0.62 ? Math.round(((t - 0.62) / 0.38) ** 1.6 * lift) : 0;
    for (let y = 0; y < D; y++)
      for (let z = zK + up; z < zK + kh + up; z++) m.set(x, y, z, z === zK + kh + up - 1 ? cap : wood);
    // fill under a raised end, so the curve reads as a beam's sweep, not a step
    for (let z = zK; z < zK + up; z++) m.set(x, Math.floor(D / 2), z, wood);
  }
  return m;
};

export const LANDMARK_GENERATORS: Record<string, Generator> = { twinTowerHall, cylinderTower, myojinTorii };
