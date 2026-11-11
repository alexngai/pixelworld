import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";
import { bays, clamp, eachSide, edgeDistance, facadeOf, frontDir, frontPainter, pick, schemeRole, type Facade } from "./kit";

/**
 * Kyoto's street fabric (D-090): the machiya and the later wooden town house
 * (`machiya`), and the modest modern block of the wide streets (`midrise`).
 * Storeys are counted as in Japan and in PLATEAU: the ground floor is the
 * first. Shop curtains and signs carry no lettering.
 */

/** Roof shapes drawn pitched. */
const PITCHED = new Set(["gabled", "hipped", "half_hipped", "pyramidal"]);

/** A role's material if the asset has it, else `fallback`. */
function optional(ctx: GenContext, m: VoxelModel, role: string, fallback: number): number {
  const xs = ctx.ramps(role);
  return xs.length ? m.material(pick(ctx.rand, xs)) : fallback;
}

/** Glass, lit at night in a share of windows. */
function glazing(ctx: GenContext, m: VoxelModel) {
  const glass = m.material(ctx.ramp("window"));
  const lits = ctx.ramps("lit");
  const lit = lits.length ? m.material(pick(ctx.rand, lits)) : glass;
  const share = ctx.param("litFraction", 0.3);
  return { glass, lit, pane: () => (ctx.rand() < share ? lit : glass) };
}

/**
 * Each column's distance under a roof whose ridges run along the street: from
 * the front (past `from`), the rear and, on a deep lot, the walls between its
 * wings (the front house, then wings of about `wing` voxels each), 0 on an
 * eave. A hipped roof also falls to the sides (`edge`, the steps to the outside).
 */
function roofDistance(f: Facade, from: number, wing: number, hipped: boolean, edge: Int16Array): Int16Array {
  const out = new Int16Array(f.sx * f.sy).fill(-1);
  const L = f.maxDepth + 1 - from;
  // wing boundaries: one roof if the lot is shallow, else the front house and wings behind it
  const cuts = [from];
  if (L > wing * 1.5) {
    let s = from + wing;
    while (f.maxDepth + 1 - s > wing * 1.5) {
      cuts.push(s);
      s += wing;
    }
    cuts.push(s);
  }
  cuts.push(f.maxDepth + 1);
  for (let i = 0; i < out.length; i++) {
    const d = f.depth[i]!;
    if (d < from) continue;
    let k = 0;
    while (k + 1 < cuts.length - 1 && d >= cuts[k + 1]!) k++;
    let r = Math.min(d - cuts[k]!, cuts[k + 1]! - 1 - d, f.back[i]!);
    if (hipped) r = Math.min(r, edge[i]! - 1);
    out[i] = Math.max(0, r);
  }
  return out;
}

/**
 * A Kyoto town house on any footprint: the machiya, narrow and deep, and the
 * wooden houses after it. Two storeys (one to three by the record): a taller
 * ground storey whose front is a lattice (koshi) of slats, under a beam and a
 * pent roof of grey tile (the eave over the ground floor, drawn by setting the
 * low upper storey back a voxel or two behind it); a door at one end, with a
 * noren curtain on some; a bamboo fence (inuyarai) at the foot of the
 * lattice on some. The upper storey's plaster front has mushiko-mado: a band
 * of plastered bars with dark slits between. A gabled tile roof whose ridge
 * runs along the street, rising a voxel for every two in (about 27°);
 * a deep lot has the front house and wings behind it under roofs of their
 * own. Party walls show dark boards below and plaster above. Later houses
 * have glass windows in place of the lattice and slits, and some a hipped
 * roof. The roof follows the data's shape where the hints give one (gabled,
 * hipped, a shed rising to the rear, and flat only with `flat`), else `hip`.
 * Nothing projects: the pent roof stands on the ground storey's front.
 * params: koshi (share of fronts with a lattice; 1), mushiko (share of upper
 * storeys with mushiko-mado; 0.85), fences (share with an inuyarai; 0.4),
 * noren (share with a noren; 0.35), lanterns (share with a red paper lantern
 * beside the door; 0), udatsu (share whose party walls rise through the pent
 * roof as firewalls; 0), hip (share with hipped roofs where the
 * data gives no shape; 0), flat (1: draw a flat roof where the data says
 * flat; 0, the default, keeps the group's: wooden houses' flat LoD2 roofs
 * are mostly unmodelled pitched ones), pitch
 * (voxels in for each up; 2), wing (the front house's depth in voxels; 16),
 * litFraction.
 * roles: wall (wall.* variants: the ground storey and its sides), upper
 * (upper.*: the upper storey's plaster, following the wall's variants),
 * timber (pillars and beams), lattice (lattice.* variants), gap (the dark
 * between slats and in doors), base, fence, noren (noren.* variants),
 * lantern (the chōchin; it glows at night where the pack makes it emissive), roof
 * (roof.* variants), ridge (roof if absent), window, lit.
 */
export const machiya: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("machiya needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round((ctx.heightVox ?? param("height", 18)) * (1 + (rand() - 0.5) * 0.06)), 5, 200);
  const m = new VoxelModel(f.sx, f.sy, H + 2);
  const walls = ctx.ramps("wall");
  const k = Math.floor(rand() * walls.length);
  const body = m.material(walls[k]!);
  const upper = schemeRole(ctx, m, k, walls.length, "upper", body);
  const timber = optional(ctx, m, "timber", body);
  const gap = optional(ctx, m, "gap", timber);
  const lattice = optional(ctx, m, "lattice", timber);
  const base = optional(ctx, m, "base", body);
  const roof = optional(ctx, m, "roof", body);
  const ridge = optional(ctx, m, "ridge", roof);
  const { pane, lit } = glazing(ctx, m);
  const koshi = rand() < param("koshi", 1);
  const mushiko = rand() < param("mushiko", 0.85);
  const fence = rand() < param("fences", 0.4) ? optional(ctx, m, "fence", 0) : 0;
  const noren = rand() < param("noren", 0.35) ? optional(ctx, m, "noren", 0) : 0;
  const lantern = rand() < param("lanterns", 0) ? optional(ctx, m, "lantern", 0) : 0;
  const udatsu = rand() < param("udatsu", 0);
  // the roof's shape: the data's (PLATEAU's LoD2 roofs, D-094) where it gives one, else the group's
  const shape = hints?.roof;
  const flat = shape === "flat" && param("flat", 0) >= 1;
  const shed = shape === "skillion";
  const hipped =
    shape === "hipped" || shape === "half_hipped" || shape === "pyramidal" ? true : shape === "gabled" || flat || shed ? false : rand() < param("hip", 0);
  const run = Math.max(0.5, param("pitch", 2));

  // the upper storey stands back behind the pent roof: a voxel, two on a larger house
  const want = clamp(Math.round(hints?.floors ?? 2), 1, 3);
  const sb = want >= 2 && f.maxDepth >= 5 && H >= 10 ? (H >= 16 && f.maxDepth >= 12 && W >= 4 ? 2 : 1) : 0;
  const edge = edgeDistance(mask);
  const dist = roofDistance(f, sb, clamp(Math.round(param("wing", 16)), 6, 60), hipped, edge);
  // a flat roof: one layer; a shed roof: rising from the front to the rear
  for (let i = 0; i < dist.length; i++) if (dist[i]! >= 0 && (flat || shed)) dist[i] = flat ? 0 : f.depth[i]! - sb;
  // the roof: as high as the front house's half-depth gives, at most 40% of the height
  let rMax = 0;
  for (let i = 0; i < dist.length; i++) if (f.depth[i]! < sb + 24) rMax = Math.max(rMax, dist[i]!);
  const cap = Math.max(1, Math.round(H * 0.4));
  const rf = (d: number) => Math.min(cap, Math.floor(d / run));
  const Hw = Math.max(4, H - 1 - rf(rMax));
  const n = Math.max(1, Math.min(sb ? want : 1, Math.floor(Hw / 4)));
  const g = n === 1 ? Hw : clamp(Math.round(Hw / (1 + 0.75 * (n - 1))), 4, Hw - 2);

  // the body: the ground storey, the upper storeys and the roof; the pent roof in front of the upper storey
  const top = new Int16Array(f.sx * f.sy).fill(-1);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const d = f.depth[i]!;
      if (d < 0) continue;
      let z = 0;
      for (; z < Math.min(g, Hw); z++) m.set(x, y, z, body);
      if (d < sb) {
        if (udatsu && W >= 5 && (f.along[i] === 0 || f.along[i] === W - 1)) {
          // an udatsu: the party wall carried up through the pent roof in plaster, capped in tile
          for (; z <= g + sb; z++) m.set(x, y, z, upper);
          m.set(x, y, z++, roof);
        } else {
          // the pent roof: a tile at the front, rising a voxel for each step back
          for (let t = 0; t <= d; t++, z++) m.set(x, y, z, roof);
        }
      } else {
        for (; z < Hw; z++) m.set(x, y, z, upper);
        const r = rf(dist[i]!);
        for (let t = 0; t <= r; t++, z++) m.set(x, y, z, roof);
      }
      top[i] = z - 1;
    }
  // the ridge: a roof top no lower than its neighbours toward the front and rear
  const [fx, fy] = f.front;
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const t = top[i]!;
      if (t <= Hw || f.depth[i]! < sb) continue;
      const tf = x + fx >= 0 && y + fy >= 0 && x + fx < f.sx && y + fy < f.sy ? top[(y + fy) * f.sx + x + fx]! : -1;
      const tb = x - fx >= 0 && y - fy >= 0 && x - fx < f.sx && y - fy < f.sy ? top[(y - fy) * f.sx + x - fx]! : -1;
      if (t >= tf && t >= tb) m.set(x, y, t, ridge);
    }
  // a gabled roof's ends: plaster under the tiles where a side is open
  if (!hipped)
    eachSide(f, (x, y, _nx, _ny, d, rear) => {
      if (rear || d < sb) return;
      const t = top[y * f.sx + x]!;
      for (let z = Hw; z < t; z++) m.set(x, y, z, upper);
    });

  // the ground storey's front: a stone sill, pillars at the ends, a beam under the pent roof
  const ground = frontPainter(m, f, 0);
  const left = rand() < 0.5;
  const dw = W >= 7 ? 2 : W >= 3 ? 1 : 0;
  const isDoor = (a: number) => dw > 0 && (left ? a >= 1 && a <= dw : a <= W - 2 && a >= W - 1 - dw);
  const glow = rand() < param("litFraction", 0.3) * 0.6 ? lit : gap;
  if (W >= 2 && g >= 4)
    for (let a = 0; a < W; a++) {
      ground(a, 0, base);
      ground(a, g - 1, timber);
      const end = a === 0 || a === W - 1;
      for (let z = 1; z < g - 1; z++) {
        if (end) ground(a, z, timber);
        else if (isDoor(a)) ground(a, z, noren && z >= g - 1 - Math.max(1, Math.round((g - 2) * 0.45)) ? noren : gap);
        else if (koshi) ground(a, z, fence && (z === 1 || (z === 2 && g >= 7)) ? fence : z === 1 || z === g - 2 || a % 2 === 0 ? lattice : glow);
        else if (z >= 2 && z < g - 2 && a > 1 && a < W - 2) ground(a, z, pane());
      }
    }
  // a red paper lantern (chōchin) beside the door, lit at night
  if (lantern && dw > 0 && g >= 6) {
    const a = left ? dw + 1 : W - 2 - dw;
    if (a > 0 && a < W - 1) for (const z of [g - 3, g - 2]) ground(a, z, lantern);
  }
  // the upper storey's front, from above the pent roof to the beam under the eaves
  if (sb > 0 && n >= 2 && W >= 3) {
    const face = frontPainter(m, f, sb);
    const z0 = g + sb;
    const zb = Hw - 1;
    const rows = zb - z0;
    for (let a = 0; a < W; a++) {
      const end = a === 0 || a === W - 1;
      if (rows >= 1) face(a, zb, timber);
      for (let z = z0; z < zb; z++) {
        if (end) {
          face(a, z, timber);
          continue;
        }
        const inner = a >= (W >= 7 ? 2 : 1) && a <= W - (W >= 7 ? 3 : 2);
        const slit = rows >= 3 ? z > z0 && z < zb - 1 : true;
        if (!inner || !slit) continue;
        if (mushiko) face(a, z, a % 2 === 1 ? gap : upper);
        else if (koshi) face(a, z, a % 2 === 0 ? lattice : glow);
        else if (a > 1 && a < W - 2) face(a, z, pane());
      }
    }
  }
  // windows on a corner lot's side and on the rear, one per storey, glass only where it shows
  eachSide(f, (x, y, nx, ny, d, rear) => {
    if (d < sb + 1 || (!rear && !hints?.corner) || (x + y) % 4 !== 1) return;
    for (const z of [Math.floor(g / 2), g + Math.floor((Hw - g) / 2)])
      if (z > 1 && z < Hw - 1 && !m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
  });
  return m;
};

/**
 * A modest modern block of Kyoto's wide streets, under the city's height
 * limits: tile or concrete under a flat roof with a parapet, and a stair and
 * lift house on the roof. Flats (the "mansion"): a balcony across the front
 * on every storey (a solid parapet, glass doors behind it, the units'
 * partitions) over an entrance at the street. Offices and shops: windows in
 * bays between spandrels, a shopfront under a sign band at the street and a
 * vertical sign board on a front corner, both without lettering. On some a
 * rim of grey tile round the roof, as Kyoto's landscape rules ask of new
 * buildings, or a pitched tile roof where the data gives one (gabled or
 * hipped). Nothing projects: balconies and signs are painted flush.
 * params: flats (share that are flats; 0.5), shops (share with shopfronts;
 * 0.6), eaves (share with a tile rim; 0.35), litFraction.
 * roles: wall (wall.* variants), trim (trim.*, following the wall's), shop
 * (shopfront glass; window if absent), sign (sign.* variants), rail, roof,
 * eave, window, lit.
 */
export const midrise: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("midrise needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round((ctx.heightVox ?? param("height", 40)) * (1 + (rand() - 0.5) * 0.04)), 5, 400);
  const walls = ctx.ramps("wall");
  const k = Math.floor(rand() * walls.length);
  const pent = W >= 8 && f.maxDepth >= 8 && H >= 18 && !PITCHED.has(hints?.roof ?? "");
  const m = new VoxelModel(f.sx, f.sy, H + (pent ? Math.round(H * 0.2) + 6 : 2));
  const body = m.material(walls[k]!);
  const trim = schemeRole(ctx, m, k, walls.length, "trim", body);
  const roof = optional(ctx, m, "roof", body);
  const eave = optional(ctx, m, "eave", roof);
  const rail = optional(ctx, m, "rail", trim);
  const sign = optional(ctx, m, "sign", trim);
  const { pane, glass } = glazing(ctx, m);
  const shopGlass = optional(ctx, m, "shop", glass);
  const flats = rand() < param("flats", 0.5);
  const shops = rand() < param("shops", 0.6);
  const edge = edgeDistance(mask);
  // a pitched tile roof where the data gives one (D-094), rising a voxel for every two in
  const pitched = PITCHED.has(hints?.roof ?? "") && H >= 6;
  const inFrom = (i: number) => (hints?.roof === "gabled" ? Math.min(f.depth[i]!, f.back[i]!) : edge[i]! - 1);
  let dMax = 0;
  for (let i = 0; i < edge.length; i++) if (edge[i]) dMax = Math.max(dMax, inFrom(i));
  const Hr = pitched ? clamp(Math.floor(dMax / 2), 1, Math.max(1, Math.round(H * 0.3))) : 0;
  const Hb = H - Hr; // the walls' top
  const rim = !pitched && rand() < param("eaves", 0.35) && H >= 10;
  const n = clamp(Math.round(hints?.floors ?? Hb / 7), 1, 60);
  const fh = Math.max(3, Math.floor(Hb / n));
  const g = Math.max(fh, Hb - fh * (n - 1));
  // the body: walls to the parapet's top, the roof a voxel lower inside; a tile rim steps up from the wall
  const Hp = Hb - 1;
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const e = edge[i]!;
      if (!e) continue;
      if (pitched) {
        let z = 0;
        for (; z < Hb - 1; z++) m.set(x, y, z, body);
        for (let t = Math.min(Hr, Math.floor(inFrom(i) / 2)); t >= 0; t--, z++) m.set(x, y, z, eave);
        continue;
      }
      const t = rim ? (e === 1 ? Hp - 1 : e === 2 ? Hp : Hp - 1) : e === 1 ? Hp : Hp - 1;
      for (let z = 0; z <= t; z++) m.set(x, y, z, body);
      if (rim && e <= 2) {
        m.set(x, y, t, eave);
        if (e === 1) m.set(x, y, t - 1, eave);
      } else m.set(x, y, t, e === 1 ? trim : roof);
    }
  // the stair and lift house, toward the rear
  if (pent) {
    const ph = Math.max(3, Math.min(fh, 8));
    const d0 = Math.floor(f.maxDepth * 0.55);
    const a0 = Math.floor(W * 0.35);
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        const d = f.depth[i]!;
        if (d < d0 || d >= d0 + Math.min(5, Math.floor(f.maxDepth * 0.3)) || a < a0 || a >= a0 + Math.max(3, Math.floor(W * 0.25)) || edge[i]! < 3) continue;
        for (let z = Hp; z < Hp + ph; z++) m.set(x, y, z, body);
        m.set(x, y, Hp + ph, roof);
      }
  }
  const paint = frontPainter(m, f, 0);
  const zTop = rim ? Hp - 2 : Hp;
  // the street: a shopfront under a sign band, or an entrance
  const door = Math.floor(W / 2);
  for (let a = 0; a < W; a++) {
    const end = a === 0 || a === W - 1;
    for (let z = 0; z < g && z < zTop; z++) {
      if (shops) {
        if (z >= g - 2 && g >= 5) paint(a, z, sign);
        else if (z >= 1 && !end) paint(a, z, shopGlass);
        else paint(a, z, trim);
      } else if (z >= 1 && z < g - 1 && Math.abs(a - door) <= (W >= 8 ? 1 : 0)) paint(a, z, glass);
    }
  }
  // the storeys
  const spans = bays(W, Math.max(1, Math.round(W / 4)), W >= 8 ? 2 : 1);
  const unit = clamp(Math.round(W / Math.max(1, Math.round(W / 9))), 5, 12);
  for (let s = 1; s < n; s++) {
    const z0 = g + (s - 1) * fh;
    for (let a = 0; a < W; a++) {
      const end = a === 0 || a === W - 1;
      for (let zf = 0; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        if (flats && fh >= 4) {
          // the balcony: the slab and a solid parapet, glass doors behind, partitions between units
          if (zf <= 1) paint(a, z, zf === 0 ? trim : end ? trim : rail);
          else if (end || a % unit === 0) paint(a, z, trim);
          else if (zf < fh - 1) paint(a, z, pane());
        } else if (zf >= 1 && zf < fh - 1 && spans.some(([a0, a1]) => a >= a0 && a <= a1)) paint(a, z, pane());
      }
    }
  }
  // a vertical sign board on a front corner
  if (shops && W >= 6 && n >= 3) {
    const a = rand() < 0.5 ? 1 : W - 2;
    const z1 = Math.min(zTop - 1, g + fh * Math.min(n - 1, 3));
    for (let z = g; z < z1; z++) paint(a, z, sign);
  }
  // windows on the rear, and on a corner lot's side, every three voxels on each storey
  eachSide(f, (x, y, nx, ny, d, rear) => {
    if (d < 1 && !rear) return;
    if ((!rear && !hints?.corner) || (x + y) % 3 !== 0) return;
    for (let s = 1; s < n; s++)
      for (let zf = 1; zf < fh - 1; zf++) {
        const z = g + (s - 1) * fh + zf;
        if (z < zTop && !m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, pane());
      }
  });
  return m;
};

/**
 * A kura (dozō), the storehouse of the old town: thick white plaster walls
 * over a skirt of namako (dark tiles in a diagonal grid of white joints), a
 * door at the street and one small window high on the front behind a heavy
 * shutter, under a steep gabled tile roof whose ridge runs along the longer
 * side, its gable ends plastered. Nothing projects.
 * params: pitch (voxels in for each up; 1.4).
 * roles: wall (plaster), namako (the skirt's tiles; wall if absent), door
 * (and the shutter; namako if absent), base, roof, ridge (roof if absent).
 */
export const kura: Generator = (ctx) => {
  const { mask, hints, param } = ctx;
  if (!mask) throw new Error("kura needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = clamp(Math.round(ctx.heightVox ?? param("height", 14)), 5, 120);
  const m = new VoxelModel(f.sx, f.sy, H + 2);
  const wall = m.material(ctx.ramp("wall"));
  const namako = optional(ctx, m, "namako", wall);
  const door = optional(ctx, m, "door", namako);
  const base = optional(ctx, m, "base", namako);
  const roof = optional(ctx, m, "roof", wall);
  const ridge = optional(ctx, m, "ridge", roof);
  const run = Math.max(0.5, param("pitch", 1.4));
  // the ridge along the longer side: from the front and rear on a wide store, from the sides on a deep one
  const wide = W >= f.maxDepth + 1;
  const dist = (i: number) => (wide ? Math.min(f.depth[i]!, f.back[i]!) : Math.min(f.along[i]!, W - 1 - f.along[i]!));
  let rMax = 0;
  for (let i = 0; i < f.depth.length; i++) if (f.depth[i]! >= 0) rMax = Math.max(rMax, dist(i));
  const cap = Math.max(1, Math.round(H * 0.45));
  const rf = (d: number) => Math.min(cap, Math.floor(d / run));
  const Hw = Math.max(4, H - 1 - rf(rMax));
  const nk = Math.max(2, Math.round(Hw * 0.3)); // the skirt's top
  const edge = edgeDistance(mask);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      if (f.depth[i]! < 0) continue;
      const out = edge[i] === 1; // on the outer wall
      let z = 0;
      for (; z < Hw; z++) {
        const pos = x + y;
        const joint = (pos + z) % 3 === 0 || (pos - z + 3 * H) % 3 === 0;
        m.set(x, y, z, z === 0 ? base : z < nk && out && !joint ? namako : wall);
      }
      const r = rf(dist(i));
      for (let t = 0; t <= r; t++, z++) m.set(x, y, z, t === r && dist(i) === rMax ? ridge : t < r && out ? wall : roof);
    }
  // the door at the street and the shuttered window high above it
  const paint = frontPainter(m, f, 0);
  const mid = Math.floor((W - 1) / 2);
  if (W >= 4)
    for (let a = mid; a <= mid + 1 && a < W - 1; a++) {
      for (let z = 1; z < Math.min(Hw - 3, Math.max(3, nk + 2)); z++) paint(a, z, door);
      if (Hw >= 9) for (let z = Hw - 4; z < Hw - 2; z++) paint(a, z, door);
    }
  return m;
};

/**
 * A concrete utility pole (denchū): a slim pole, a steel crossarm near its
 * top with an insulator at each end, and on some a transformer drum. The
 * wires between poles aren't drawn.
 * params: height (16 voxels), transformers (share with a transformer; 0.3).
 * roles: pole, arm (pole if absent), transformer (arm if absent).
 */
export const utilityPole: Generator = (ctx) => {
  const { rand, param } = ctx;
  const H = Math.max(6, Math.round(param("height", 16) * (0.9 + rand() * 0.2)));
  const m = new VoxelModel(5, 5, H + 1);
  const pole = m.material(ctx.ramp("pole"));
  const arm = optional(ctx, m, "arm", pole);
  const drum = optional(ctx, m, "transformer", arm);
  for (let z = 0; z < H; z++) m.set(2, 2, z, pole);
  for (let x = 0; x < 5; x++) m.set(x, 2, H - 2, arm);
  m.set(0, 2, H - 1, arm);
  m.set(4, 2, H - 1, arm);
  if (rand() < param("transformers", 0.3)) for (let z = Math.round(H * 0.55); z < Math.round(H * 0.55) + 3; z++) m.set(2, 3, z, drum);
  return m;
};

export const BUILDING_GENERATORS: Record<string, Generator> = { machiya, midrise, kura, utilityPole };
