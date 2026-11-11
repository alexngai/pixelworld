import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";
import { axisDistance, clamp, pick, rectMask, type Mask } from "./kit";

/**
 * Kyoto's temples and shrines (D-090): the hall under a hip-and-gable roof
 * (`templeHall`, also Kiyomizu-dera's main hall on its stage), the two-storey
 * gate (`towerGate`: a shrine's vermilion rōmon, a temple's sanmon), the
 * pagoda (`pagoda`), and Kyoto Tower's type (`candleTower`). Depictions are
 * generic: no names, no lettering, no figures.
 */

interface HallMats {
  base: number;
  pillar: number;
  shadow: number;
  bracket: number;
  wall: number;
  roof: number;
  ridge: number;
  gable: number;
  ornament: number;
}

function hallMats(ctx: GenContext, m: VoxelModel): HallMats {
  const opt = (role: string, fallback: number) => {
    const xs = ctx.ramps(role);
    return xs.length ? m.material(pick(ctx.rand, xs)) : fallback;
  };
  const roof = m.material(ctx.ramp("roof"));
  const pillar = m.material(ctx.ramp("pillar"));
  const roofs = ctx.ramps("roof");
  const shadow = opt("shadow", pillar);
  return {
    base: opt("base", pillar),
    pillar,
    shadow,
    bracket: opt("bracket", pillar),
    wall: opt("wall", pillar),
    roof: roofs.length > 1 ? m.material(pick(ctx.rand, roofs)) : roof,
    ridge: opt("ridge", roof),
    gable: opt("gable", shadow),
    ornament: opt("ornament", roof),
  };
}

interface HallSpec {
  /** The foot of the hall in the model. */
  z0: number;
  /** From z0 to the ridge. */
  H: number;
  /** The stone platform's height. */
  base: number;
  /** How far the hipped skirt runs in from each end, over the half-width: 0 a gable, 1 a hip. */
  hip: number;
  /** The roof's share of H, at most what the plan allows. */
  roof: number;
  /** The eaves' depth: 1 is about a fifth of the half-width. */
  eave: number;
  /** Bays along the long side (pillars between them). */
  bays?: number;
  /** The eaves' depth in voxels, over `eave`. */
  e?: number;
  /** Leave the space under the eaves open, pillars on the walls behind (landmarks); else fill it with shadow. */
  open?: boolean;
}

/**
 * A hall on the footprint `mask` (the model's size): a stone platform, walls
 * whose deep eaves are drawn by filling the space under them with shadow,
 * with pillars on its face and a band of brackets under the roof (a shallow
 * eave shows the walls: plaster between the pillars), and a hip-and-gable
 * roof (irimoya) whose ridge runs along the longer side: a hipped skirt,
 * flat at the eaves and steepening toward the ridge, lifted a voxel at the
 * corners, and a gable standing on it, plastered, with an ornament under
 * its apex and the ridge's ends raised. Every voxel stands on another.
 * Returns the wall top and the half-width.
 */
function hall(m: VoxelModel, mask: Mask, s: HallSpec, mats: HallMats): { Hw: number; D: number } {
  const { sx, sy, on } = mask;
  let x0 = sx;
  let x1 = -1;
  let y0 = sy;
  let y1 = -1;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (on[y * sx + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  if (x1 < 0) return { Hw: s.z0, D: 0 };
  const alongX = x1 - x0 >= y1 - y0;
  const dS = axisDistance(mask, alongX ? 0 : 1);
  const dFB = axisDistance(mask, alongX ? 1 : 0);
  let D = 1;
  let L = 1;
  for (let i = 0; i < on.length; i++) {
    D = Math.max(D, dFB[i]!);
    L = Math.max(L, dS[i]!);
  }
  // at most 2.6 voxels up for each in: the voxels are drawn taller than they are wide (heightStretch)
  let Hr = Math.max(1, Math.min(Math.round(s.H * s.roof), Math.round(D * 2.6)));
  if (s.H - Hr < s.base + 2) Hr = Math.max(1, s.H - s.base - 2);
  const Hw = s.z0 + s.H - Hr;
  const e = s.e ?? (D >= 4 ? clamp(Math.round(D * 0.22 * s.eave), 1, 8) : 0);
  const g0 = L - Math.round(s.hip * D) < 2 ? L : Math.round(s.hip * D);
  const rise = (d: number) => (d <= 1 ? 0 : Math.round((Hr - 1) * Math.pow((d - 1) / Math.max(1, D - 1), 1.5)));
  const roofRise = (i: number) => {
    const f = dFB[i]!;
    const a = dS[i]!;
    let r = a > g0 ? rise(f) : rise(Math.min(f, a));
    if (Hr >= 4 && f <= 2 && a <= 2) r += 1; // the corners lift
    return r;
  };
  const step = Math.max(3, Math.round(((alongX ? x1 - x0 : y1 - y0) + 1) / Math.max(1, s.bays ?? Math.round(L / Math.max(2, D / 2)))));
  // the face under the eaves: on the outer ring, or with `open` on the walls behind it
  const wallRing = s.open ? e + 1 : 1;
  const lo = s.z0 + s.base;
  const tall = Hw - lo;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * sx + x;
      if (!on[i]) continue;
      const near = Math.min(dFB[i]!, dS[i]!);
      let z = s.z0;
      for (; z < lo; z++) m.set(x, y, z, mats.base);
      if (s.open && near <= e) {
        z = Hw;
        m.set(x, y, z - 1, mats.shadow); // the eave's dark underside
      }
      for (; z < Hw; z++) m.set(x, y, z, near <= e ? mats.shadow : mats.wall);
      const r = roofRise(i);
      for (let t = 0; t <= r; t++, z++) m.set(x, y, z, mats.roof);
      if (near !== wallRing || tall < 2) continue;
      // pillars at the corners and every `step`, panels between, a band of brackets under the roof
      const onLong = dFB[i] === wallRing;
      const pos = onLong ? (alongX ? x : y) : alongX ? y : x;
      const corner = dFB[i] === wallRing && dS[i] === wallRing;
      const pillar = corner || pos % step === 0;
      const band = tall >= 6 ? 2 : 1;
      // under the brackets, plaster between the head beams (on a tall wall)
      const kabe = tall >= 8 ? 2 : 0;
      for (let zz = lo; zz < Hw; zz++) {
        const bracket = zz >= Hw - band;
        const plaster = zz >= Hw - band - kabe;
        m.set(x, y, zz, pillar ? mats.pillar : bracket ? ((pos + zz) % 2 === 0 ? mats.bracket : mats.shadow) : s.open || e <= 1 || plaster ? mats.wall : mats.shadow);
      }
    }
  // the gable: plaster above the skirt, the roof's edge on it, an ornament under the apex; the ridge, its ends raised
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * sx + x;
      if (!on[i] || g0 >= L) continue;
      const a = dS[i]!;
      const f = dFB[i]!;
      const t = Hw + roofRise(i);
      if (a === g0 + 1 && f >= 2) {
        const from = g0 === 0 ? Hw : Hw + rise(Math.min(f, g0)) + 1;
        for (let z = from; z < t; z++) m.set(x, y, z, z === t - 1 && f === D && t - from >= 3 ? mats.ornament : mats.gable);
      }
      if (a > g0 && f === D) {
        m.set(x, y, t, mats.ridge);
        if (a === g0 + 1 && t + 1 < m.sz) m.set(x, y, t + 1, mats.ridge);
      }
    }
  if (g0 >= L)
    for (let i = 0; i < on.length; i++)
      if (on[i] && Math.min(dFB[i]!, dS[i]!) === D) {
        const x = i % sx;
        const y = (i - x) / sx;
        m.set(x, y, Hw + roofRise(i), mats.ridge);
      }
  return { Hw, D };
}

/** The footprint's columns where keep(x, y) holds, as a mask of the same size. */
function subMask(mask: Mask, keep: (x: number, y: number) => boolean): Mask {
  const on = new Uint8Array(mask.sx * mask.sy);
  for (let y = 0; y < mask.sy; y++) for (let x = 0; x < mask.sx; x++) on[y * mask.sx + x] = mask.on[y * mask.sx + x] && keep(x, y) ? 1 : 0;
  return { sx: mask.sx, sy: mask.sy, on };
}

/**
 * A temple or shrine hall on its footprint (or, as a landmark without one,
 * on a plan from its height): a stone platform, deep eaves over pillars and
 * a band of brackets, and a hip-and-gable roof of tile, cypress bark or
 * copper whose ridge runs along the longer side (see `hall`). A shrine's
 * shallow eaves show white walls between vermilion pillars.
 * With `stage`, Kiyomizu-dera's main hall: the hall stands on a terrace at
 * `stage` of its height, and on the +y side a stage of boards on a lattice
 * of pillars and tie beams (kake-zukuri) runs out over the slope, between
 * two small roofed wings. A landmark, so the stage overhangs.
 * params: hip (0.4), roof (the roof's share of the height; 0.55), eave (the
 * eaves' depth; 1), width and depth (the plan over the height, without a
 * footprint; 1.6, 1.3), stage (the stage's height over the whole; 0),
 * stageDepth (its share of the plan's depth; 0.35), open (1: the space under
 * the eaves left open, for landmarks; 0: filled with shadow, as the building
 * rules ask).
 * roles: roof (roof.* variants), pillar, base, shadow, bracket, wall, ridge,
 * gable, ornament, deck and rail (the stage; pillar if absent).
 */
export const templeHall: Generator = (ctx) => {
  const { param } = ctx;
  const H = clamp(Math.round(ctx.heightVox ?? param("height", 30)), 6, 400);
  const mask = ctx.mask ?? rectMask(Math.max(5, Math.round(H * param("width", 1.6))), Math.max(5, Math.round(H * param("depth", 1.3))));
  const m = new VoxelModel(mask.sx, mask.sy, H + 3);
  const mats = hallMats(ctx, m);
  const spec = { hip: param("hip", 0.4), roof: param("roof", 0.55), eave: param("eave", 1), open: param("open", 0) >= 1 };
  const stage = param("stage", 0);
  if (stage <= 0) {
    hall(m, mask, { ...spec, z0: 0, H, base: clamp(Math.round(H * 0.07), 1, 6) }, mats);
    return m;
  }
  const deck = ctx.ramps("deck").length ? m.material(ctx.ramp("deck")) : mats.pillar;
  const rail = ctx.ramps("rail").length ? m.material(ctx.ramp("rail")) : mats.pillar;
  const zs = clamp(Math.round(H * stage), 2, H - 8);
  const sd = clamp(Math.round(mask.sy * param("stageDepth", 0.35)), 2, mask.sy - 4);
  const ys = mask.sy - sd; // the stage's first row
  const wx = Math.max(2, Math.round(mask.sx * 0.18));
  const inStage = (_x: number, y: number) => y >= ys;
  const isWing = (x: number) => x < wx || x >= mask.sx - wx;
  // the terrace under the hall, and the lattice of pillars and tie beams under the stage
  for (let y = 0; y < mask.sy; y++)
    for (let x = 0; x < mask.sx; x++) {
      if (!mask.on[y * mask.sx + x]) continue;
      if (!inStage(x, y)) {
        for (let z = 0; z < zs; z++) m.set(x, y, z, mats.base);
        continue;
      }
      const px = x % 3 === 0 || x === mask.sx - 1;
      const py = (y - ys) % 3 === 2 || y === mask.sy - 1;
      for (let z = 0; z < zs; z++) {
        const tie = z % 4 === 3 && (px || py);
        if ((px && py) || tie) m.set(x, y, z, mats.pillar);
      }
      if (!isWing(x)) {
        m.set(x, y, zs, deck);
        if (y === mask.sy - 1 || (x === wx || x === mask.sx - wx - 1)) m.set(x, y, zs + 1, rail);
      }
    }
  const Hh = H - zs;
  hall(m, subMask(mask, (x, y) => !inStage(x, y)), { ...spec, z0: zs, H: Hh, base: 1 }, mats);
  // the wings: small halls at the stage's ends
  for (const side of [0, 1])
    hall(
      m,
      subMask(mask, (x, y) => inStage(x, y) && (side === 0 ? x < wx : x >= mask.sx - wx)),
      { ...spec, z0: zs, H: Math.max(4, Math.round(Hh * 0.5)), base: 1, hip: 0.5, eave: 0.6 },
      mats,
    );
  return m;
};

/**
 * A two-storey gate on its footprint, or on a plan from its height: a stone
 * platform, a lower storey of bays between pillars (the middle ones open as
 * the passage, the end ones closed), and an upper storey under a deep
 * hip-and-gable roof (see `hall`). With `lowerRoof` (a temple's sanmon), a
 * tiled skirt roof runs round the lower storey's top; without it (a shrine's
 * rōmon), a balcony with a rail. A landmark: the passage is open under the
 * upper storey.
 * params: lowerRoof (0 or 1), bays (along the front; 3), width and depth (the
 * plan over the height, without a footprint; 0.9, 0.45).
 * roles: as templeHall's.
 */
export const towerGate: Generator = (ctx) => {
  const { param } = ctx;
  const H = clamp(Math.round(ctx.heightVox ?? param("height", 24)), 10, 400);
  const mask = ctx.mask ?? rectMask(Math.max(6, Math.round(H * param("width", 0.9))), Math.max(4, Math.round(H * param("depth", 0.45))));
  const m = new VoxelModel(mask.sx, mask.sy, H + 3);
  const mats = hallMats(ctx, m);
  const skirtRoof = param("lowerRoof", 0) >= 1;
  const nb = clamp(Math.round(param("bays", 3)), 1, 9);
  const { sx, sy, on } = mask;
  let x0 = sx;
  let x1 = -1;
  let y0 = sy;
  let y1 = -1;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (on[y * sx + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  const alongX = x1 - x0 >= y1 - y0;
  const dS = axisDistance(mask, alongX ? 0 : 1);
  const dFB = axisDistance(mask, alongX ? 1 : 0);
  let D = 1;
  for (let i = 0; i < on.length; i++) D = Math.max(D, dFB[i]!);
  const b = clamp(Math.round(H * 0.05), 1, 4);
  const z1 = Math.round(H * (skirtRoof ? 0.34 : 0.4));
  const inset = Math.max(1, Math.round(D * (skirtRoof ? 0.3 : 0.25)));
  const span = (alongX ? x1 - x0 : y1 - y0) + 1 - 2 * inset;
  const bay = span / nb;
  // the platform, and the lower storey inside the inset: pillars on the bay lines, closed end bays, the open passage
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = y * sx + x;
      if (!on[i]) continue;
      for (let z = 0; z < b; z++) m.set(x, y, z, mats.base);
      const f = dFB[i]!;
      const a = dS[i]!;
      if (f <= inset || a <= inset) continue;
      const pos = (alongX ? x - x0 : y - y0) - inset;
      const k = Math.min(nb - 1, Math.floor(pos / bay));
      const line = Math.abs(pos - Math.round(pos / bay) * bay) < 0.5 || a === inset + 1;
      const row = f === inset + 1 || f === D;
      const closed = nb >= 3 && (k === 0 || k === nb - 1);
      for (let z = b; z < z1; z++) {
        if (line && row) m.set(x, y, z, mats.pillar);
        else if (closed) m.set(x, y, z, f === inset + 1 || a === inset + 1 ? (pos % 2 === 0 ? mats.wall : mats.shadow) : mats.wall);
        else if (z >= z1 - 2) m.set(x, y, z, mats.bracket); // the lintel over the passage
      }
    }
  // the skirt roof, or the balcony
  let zu: number;
  if (skirtRoof) {
    const rr = Math.max(2, Math.round(inset * 0.8));
    for (let i = 0; i < on.length; i++) {
      if (!on[i]) continue;
      const x = i % sx;
      const y = (i - x) / sx;
      const near = Math.min(dFB[i]!, dS[i]!);
      const r = near > inset ? rr : Math.round(((near - 1) * rr) / Math.max(1, inset));
      for (let z = z1; z <= z1 + r; z++) m.set(x, y, z, z === z1 + r && near > inset ? mats.shadow : mats.roof);
    }
    zu = z1 + rr + 1;
  } else {
    for (let i = 0; i < on.length; i++) {
      if (!on[i]) continue;
      const x = i % sx;
      const y = (i - x) / sx;
      const near = Math.min(dFB[i]!, dS[i]!);
      if (near <= Math.max(1, inset - 1)) continue;
      m.set(x, y, z1, mats.bracket);
      if (near === Math.max(1, inset - 1) + 1 && (x + y) % 2 === 0) m.set(x, y, z1 + 1, mats.pillar);
    }
    zu = z1 + 1;
  }
  // the upper storey and its roof over the whole footprint
  hall(m, mask, { z0: zu, H: H - zu, base: 0, hip: 0.4, roof: 0.62, eave: 1.3, bays: nb, e: inset, open: true }, mats);
  return m;
};

/**
 * A pagoda of `tiers` storeys (three or five) on a square plan: a stone
 * platform; each storey a body of pillars and white walls with a door in the
 * middle bay, a band of brackets, and a square roof whose eaves reach far
 * out, flat at the eaves and steepening toward the body, lifted at the
 * corners and dark underneath; each storey smaller than the one below; on
 * top the finial (sōrin): a bronze mast with nine rings and a gilt top.
 * Its plan comes from the height (the lowest roof about a third of it
 * across). A landmark: the eaves overhang.
 * params: tiers (5), finial (its share of the height; 0.22).
 * roles: roof, pillar, wall, shadow, bracket, base, finial, ornament.
 */
export const pagoda: Generator = (ctx) => {
  const { param } = ctx;
  const H = clamp(Math.round(ctx.heightVox ?? param("height", 60)), 16, 600);
  const N = clamp(Math.round(param("tiers", 5)), 2, 9);
  // from the height alone: a pagoda's outline in the data is its body, not its eaves
  const R1 = Math.max(4, Math.round(H * 0.14));
  const size = 2 * R1 + 1;
  const c = R1;
  const m = new VoxelModel(size, size, H + 2);
  const mats = hallMats(ctx, m);
  const finial = ctx.ramps("finial").length ? m.material(ctx.ramp("finial")) : mats.roof;
  const plat = Math.max(1, Math.round(H * 0.03));
  const zf = Math.round(H * (1 - param("finial", 0.22)));
  const tierH = (zf - plat) / N;
  const B1 = Math.max(2, Math.round(R1 * 0.5));
  const cheb = (x: number, y: number) => Math.max(Math.abs(x - c), Math.abs(y - c));
  // the platform
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (cheb(x, y) <= B1 + 1) for (let z = 0; z < plat; z++) m.set(x, y, z, mats.base);
  let zb = plat;
  for (let k = 0; k < N; k++) {
    const top = k === N - 1;
    const B = Math.max(1, Math.round(B1 * (1 - (0.25 * k) / Math.max(1, N - 1))));
    const R = Math.max(B + 2, Math.round(R1 * (1 - (0.25 * k) / Math.max(1, N - 1))));
    const zTier = Math.round(plat + (k + 1) * tierH);
    const ze = Math.min(zTier - 2, zb + Math.max(2, Math.round(tierH * (k === 0 ? 0.62 : 0.55)))); // the eave's height
    const rise = Math.max(2, zTier - ze);
    // the body: pillars at the corners and bay lines, white walls, a dark door in the middle; brackets on top
    for (let y = c - B; y <= c + B; y++)
      for (let x = c - B; x <= c + B; x++) {
        const edge = cheb(x, y) === B;
        const along = Math.abs(x - c) === B ? y - c : x - c;
        for (let z = zb; z < ze; z++) {
          if (!edge) {
            m.set(x, y, z, mats.wall);
            continue;
          }
          const third = Math.max(1, Math.round(B / 3));
          const pillar = Math.abs(along) === B || (B >= 4 && Math.abs(along) === third);
          const brackets = z >= ze - 2;
          const door = Math.abs(along) < third && z < ze - 2;
          m.set(x, y, z, brackets ? (along % 2 === 0 ? mats.bracket : mats.shadow) : pillar ? mats.pillar : door ? mats.shadow : mats.wall);
        }
      }
    // the roof: flat at the eave, steepening toward the body (to a point on the top storey), lifted at the corners, dark underneath
    const zr = (d: number) => {
      const t = top ? (R - d) / R : Math.min(1, (R - d) / Math.max(1, R - B));
      return ze + Math.round(rise * Math.pow(Math.max(0, t), 1.7));
    };
    for (let y = c - R; y <= c + R; y++)
      for (let x = c - R; x <= c + R; x++) {
        const d = cheb(x, y);
        const lift = d >= R - 1 && Math.abs(Math.abs(x - c) - Math.abs(y - c)) <= 1 ? 1 : 0;
        const zt = zr(d) + lift;
        const from = d <= B ? ze : d === R ? zt - 1 : Math.min(zt - 1, zr(d + 1));
        for (let z = from; z <= zt; z++) m.set(x, y, z, z === from && d > B ? mats.shadow : mats.roof);
      }
    zb = zr(0) + (top ? 1 : 0);
  }
  // the finial: a base, nine rings on a mast, a gilt top
  const z0 = zb;
  for (let z = z0; z <= H; z++) {
    const t = z - z0;
    const ring = t >= 2 && t < 2 + Math.round((H - z0) * 0.65) && t % 2 === 0;
    const r = t < 2 ? 1 : ring ? 1 : 0;
    for (let y = c - r; y <= c + r; y++) for (let x = c - r; x <= c + r; x++) m.set(x, y, z, z >= H - 1 ? mats.ornament : finial);
  }
  return m;
};

/**
 * A slender white observation tower on its building (Kyoto Tower's type):
 * a round shaft, straight inside the building (`base`, its share of the
 * height) and tapering above it, a drum of an observation deck wider than
 * the shaft with a band of windows that glow at night and a vermilion rim
 * under it, then a tapering spire with vermilion bands and a vermilion tip.
 * A landmark standing in its building: the deck overhangs.
 * params: base (0.24), deck (the deck's foot over the height; 0.69).
 * roles: wall, detail (the rim, bands and tip), window, lit (window if absent).
 */
export const candleTower: Generator = (ctx) => {
  const { param } = ctx;
  const H = clamp(Math.round(ctx.heightVox ?? param("height", 200)), 20, 800);
  const zb = Math.round(H * param("base", 0.24));
  const zd = Math.round(H * param("deck", 0.69));
  const zt = zd + Math.max(3, Math.round(H * 0.07)); // the deck's top
  const R0 = Math.max(2, H * 0.042);
  const R1 = Math.max(1.5, H * 0.026);
  const Rd = Math.max(R1 + 2, H * 0.062);
  const half = Math.ceil(Rd) + 1;
  const size = 2 * half + 1;
  const m = new VoxelModel(size, size, H + 1);
  const wall = m.material(ctx.ramp("wall"));
  const detail = m.material(ctx.ramp("detail"));
  const glass = m.material(ctx.ramp("window"));
  const lit = ctx.ramps("lit").length ? m.material(ctx.ramp("lit")) : glass;
  const disc = (z: number, r: number, mat: (d: number) => number) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - half, y - half);
        if (d <= r + 0.35) m.set(x, y, z, mat(d));
      }
  };
  for (let z = 0; z <= H; z++) {
    if (z < zd) {
      const r = z < zb ? R0 : R0 + ((R1 - R0) * (z - zb)) / Math.max(1, zd - zb);
      disc(z, r, () => wall);
    } else if (z < zt) {
      // the deck: a vermilion rim, the windows' band, white above
      const k = z - zd;
      const win = k >= 2 && k < zt - zd - 1;
      disc(z, Rd, (d) => (k === 0 ? detail : win && d > Rd - 1 ? (k % 2 === 0 ? lit : glass) : wall));
    } else {
      // the spire, tapering to its tip, with two vermilion bands
      const t = (z - zt) / Math.max(1, H - zt);
      const r = Math.max(0, R1 * 0.9 * (1 - t));
      const band = (t > 0.55 && t < 0.62) || t > 0.8;
      disc(z, r, () => (band ? detail : wall));
    }
  }
  return m;
};

export const TEMPLE_GENERATORS: Record<string, Generator> = { templeHall, towerGate, pagoda, candleTower };
