import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";
import { bays, bulkhead, clamp, eachSide, facadeOf, frontDir, frontPainter, massing, paints, pick, run, sideWindows, type Facade, type Mask } from "./facade";

/**
 * Tokyo's street fabric (D-092): the zakkyo, the narrow mixed-use mid-rise of
 * the entertainment districts, under its stacked signs; the mansion, the
 * apartment slab with balconies across its whole front; and the kodate, the
 * small detached house behind its block wall. Signs carry no lettering.
 */

/** Storeys: the record's (hints.floors) where it fits [lo, hi], else `typical`; never fewer voxels than three a storey. */
function storeys(ctx: GenContext, H: number, lo: number, hi: number, typical: number): number {
  const want = clamp(Math.round(ctx.hints?.floors ?? typical), lo, hi);
  return Math.max(1, Math.min(want, Math.floor(H / 3)));
}

/** A role's material, or `fallback` when the asset has none. */
const roleOr = (ctx: GenContext, m: VoxelModel, role: string, fallback: number): number => {
  const xs = ctx.ramps(role);
  return xs.length ? m.material(pick(ctx.rand, xs)) : fallback;
};

/**
 * A zakkyo (雑居ビル): a narrow mixed-use building of 4–10 storeys, a bar,
 * a clinic or an office on each floor. At the street, a shopfront under a
 * lit sign band; above, ribbon windows, punched windows or a glass front,
 * with a tenant's sign panel across the spandrel of most floors. On most, a
 * vertical sign board of stacked boxes, one a floor, stands on the shop's
 * canopy in front of an upper front set back a voxel for it, and rises past
 * the parapet; on some, a billboard on the roof. A stair and lift penthouse
 * on the roof. Any height: storeys come from the record, else from the
 * height (param `storey`, voxels a storey, default 8).
 * params: signs (share of floors with a sign panel; 1), vertical (chance of
 * the vertical sign; 0.75), billboard (chance of a roof billboard; 0.35),
 * office (1: ribbon or glass fronts, no vertical sign or billboard), storey,
 * litFraction.
 * roles: wall (tile and concrete variants), trim (mullions, piers, the
 * canopy), sign (sign.* variants: one picked per box and panel), frame (the
 * billboard's back; iron, else trim), accent (doors), roof, window, lit.
 */
export const zakkyo: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("zakkyo needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const H = Math.max(6, Math.round(ctx.heightVox ?? param("height", 48)));
  const floors = storeys(ctx, H, 1, 80, Math.max(1, Math.round(H / param("storey", 8))));
  const fh = Math.max(3, Math.floor(H / floors));
  const fine = fh >= 6;
  const office = param("office", 0) > 0;
  const m = new VoxelModel(f.sx, f.sy, H + fh + 4);
  const p = paints(ctx, m);
  const signRamps = ctx.ramps("sign");
  const signs = signRamps.map((r) => m.material(r));
  const sign = () => (signs.length ? pick(rand, signs) : p.accent);
  const frame = roleOr(ctx, m, "frame", p.trim);

  // a vertical sign board stands on the shop's canopy, in front of an upper front set back a voxel for it
  const vertical = !office && W >= 5 && f.maxDepth >= 6 && floors >= 3 && rand() < param("vertical", 0.75);
  const sd = vertical ? 1 : 0;
  massing(m, f, H, p.body, p.roof, sd);
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) if (f.depth[y * f.sx + x] === 0 && sd) for (let z = 0; z < fh; z++) m.set(x, y, z, z === fh - 1 ? p.trim : p.body);
  const street = frontPainter(m, f, 0);
  const upper = frontPainter(m, f, sd);

  // the street: a shopfront under a lit sign band, the stair's door on one side
  const band = fine ? 2 : 1;
  const doorA = rand() < 0.5 ? 1 : W - 2 - (fine ? 1 : 0);
  const shopSign = sign();
  for (let a = 0; a < W; a++)
    for (let z = 0; z < fh - (sd ? 1 : 0); z++) {
      const pier = a === 0 || a === W - 1;
      const door = W >= 4 && a >= doorA && a <= doorA + (fine ? 1 : 0) && z < fh - band - 1;
      if (z >= fh - band - (sd ? 1 : 0)) street.paint(a, z, pier ? p.trim : shopSign);
      else if (door) street.paint(a, z, p.accent);
      else if (pier || z === 0) street.paint(a, z, p.trim);
      else street.paint(a, z, p.pane());
    }

  // the vertical sign board: a box of its own colour each floor, rising past the parapet
  // (drawn before the front behind it is painted, so no glass hides behind it)
  if (vertical) {
    const aS = rand() < 0.5 ? 0 : W - 1;
    const wide = fine && W >= 10 ? 1 : 0;
    const top = H + Math.max(1, Math.round(fh * 0.6));
    let box = sign();
    for (let z = fh; z <= top; z++) {
      const zf = (z - fh) % fh;
      if (zf === 0) box = sign();
      for (const a of wide ? [aS, aS === 0 ? 1 : W - 2] : [aS])
        for (const [x, y] of street.cols[a] ?? []) if (m.get(x, y, z - 1)) m.set(x, y, z, zf === 0 && fine ? frame : box);
    }
  }

  // the floors above: ribbon windows, punched windows or a glass front
  const kind = office ? (rand() < 0.6 ? 0 : 2) : rand() < 0.45 ? 0 : rand() < 0.55 ? 1 : 2;
  const { spans } = bays(W, Math.max(1, Math.round(W / (fine ? 4 : 3))), fine ? 2 : 1);
  const inBay = (a: number) => spans.some(([s, e]) => a >= s && a <= e);
  const zTop = H - 1;
  const sp = fine ? 2 : 1; // the spandrel's rows
  const signShare = param("signs", 1);
  for (let k = 1; k < floors; k++) {
    const z0 = k * fh;
    const panel = rand() < signShare * 0.85 ? sign() : 0;
    // a panel over most of the front, clear of the vertical board's side
    const p0 = W >= 6 ? 1 : 0;
    const p1 = W >= 6 ? W - 2 : W - 1;
    for (let zf = 0; zf < fh; zf++) {
      const z = z0 + zf;
      if (z >= zTop) break;
      for (let a = 0; a < W; a++) {
        const pier = a === 0 || a === W - 1;
        if (panel && zf < sp && a >= p0 && a <= p1) {
          upper.paint(a, z, panel);
          continue;
        }
        if (kind === 0) {
          // ribbon windows: a band of glass between spandrels, mullions every few voxels
          const glass = zf >= sp && zf < fh - 1;
          upper.paint(a, z, !glass || pier ? p.body : a % (fine ? 4 : 3) === 0 ? p.trim : p.pane());
        } else if (kind === 1) {
          const glass = zf >= sp && zf < fh - 1 && inBay(a);
          if (glass) upper.paint(a, z, p.pane());
        } else {
          // a glass front between thin mullions and floor lines
          upper.paint(a, z, zf === 0 || pier ? p.trim : a % 3 === 0 ? p.trim : p.pane());
        }
      }
    }
  }
  // a parapet along the front
  for (let a = 0; a < W; a++) upper.raise(a, H, p.trim);

  // the roof: a billboard over the front, a stair and lift penthouse
  if (!office && W >= 6 && f.maxDepth >= 8 && rand() < param("billboard", 0.35)) {
    const bh = clamp(fh, 3, 10);
    const face = sign();
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const d = f.depth[i]! - sd;
        const a = f.along[i]!;
        if ((d !== 1 && d !== 2) || a < 1 || a > W - 2 || !m.get(x, y, H - 1)) continue;
        for (let z = H; z < H + bh; z++) m.set(x, y, z, d === 1 ? face : frame);
      }
  }
  if (W >= 5 && f.maxDepth >= 8) bulkhead(m, f, H, fh, rand() < 0.5 ? 1 : W - 4, Math.floor(f.maxDepth * 0.55), 3, 3, { body: p.body, roof: p.roof, door: p.accent });

  // the sides: few windows on the party walls; a corner lot's shop and signs wrap round
  if (hints?.corner === true)
    eachSide(f, sd, (x, y, nx, ny, d, rear) => {
      if (rear) return;
      for (let z = 1; z < fh; z++) if (m.get(x, y, z) && !m.get(nx, ny, z)) m.set(x, y, z, z >= fh - band ? shopSign : d % 4 === 0 ? p.trim : p.pane());
    });
  sideWindows(m, f, sd, fh, zTop, fh, p.pane, hints?.corner ? 3 : 6);
  return m;
};

/** The front of a slab: of the footprint's long sides, the one facing nearer south (+y), where its balconies look. */
export function slabFront(mask: Mask, hint?: number): number {
  const h = frontDir(mask, hint);
  const cands = [h, (h + 2) % 8, (h + 4) % 8, (h + 6) % 8];
  const widths = cands.map((d) => facadeOf(mask, d).width);
  const best = Math.max(...widths);
  const off = (d: number) => Math.min((d - 2 + 8) % 8, (2 - d + 8) % 8);
  return cands.filter((_, i) => widths[i]! >= best - 1).sort((a, b) => off(a) - off(b))[0]!;
}

/**
 * A mansion (マンション): an apartment slab of reinforced concrete under
 * tile, its long side to the south. Across that front, a balcony at every
 * floor: a parapet band in the trim's colour, the sliding doors' glass
 * behind it, partitions between the flats, and an air conditioner's outdoor
 * unit on some, all drawn flush. At the street, the entrance hall's glass in
 * the middle, or shops under signs on some. The back is the open corridor:
 * a parapet band at each floor over the flats' doors. A lift penthouse and
 * on some a water tank on the roof. Any height: storeys from the record,
 * else from the height (param `storey`, default 8).
 * params: storey, unit (a flat's frontage over the storey height; 1.3),
 * shops (chance of shops at the street; 0.15), litFraction.
 * roles: wall (wall.* variants), trim (the balcony parapets and partitions:
 * trim.* follows the wall), unit (the outdoor units; trim if absent), accent
 * (doors), sign (shops' bands), tank (the roof's water tank; none without),
 * frame (the tank's stand; iron, else trim), roof, window, lit.
 */
export const mansion: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("mansion needs a footprint");
  const f = facadeOf(mask, slabFront(mask, hints?.front));
  const W = f.width;
  const H = Math.max(6, Math.round(ctx.heightVox ?? param("height", 48)));
  const floors = storeys(ctx, H, 1, 120, Math.max(1, Math.round(H / param("storey", 8))));
  const fh = Math.max(3, Math.floor(H / floors));
  const fine = fh >= 6;
  const m = new VoxelModel(f.sx, f.sy, H + fh + 4);
  const p = paints(ctx, m);
  const unitMat = roleOr(ctx, m, "unit", p.trim);
  const frame = roleOr(ctx, m, "frame", p.trim);
  massing(m, f, H, p.body, p.roof);
  const { paint, raise } = frontPainter(m, f, 0);
  const U = Math.max(3, Math.round(fh * param("unit", 1.3))); // a flat's frontage
  const pr = fine ? 2 : 1; // the parapet's rows
  const zTop = H - 1;
  const ends = (a: number) => a === 0 || a === W - 1;

  // the street: the entrance hall in the middle flat's bay, or shops under signs
  const shops = W >= 8 && rand() < param("shops", 0.15);
  const signs = ctx.ramps("sign");
  const shopSign = signs.length ? m.material(pick(rand, signs)) : p.accent;
  const mid = Math.floor(W / 2);
  for (let a = 0; a < W; a++)
    for (let z = 1; z < fh && z < zTop; z++) {
      const hall = Math.abs(a - mid) <= (fine ? 2 : 1);
      if (ends(a)) continue;
      if (shops && !hall) paint(a, z, z >= fh - (fine ? 2 : 1) ? shopSign : a % U === 0 ? p.trim : p.pane());
      else if (hall) paint(a, z, z === fh - 1 ? p.trim : Math.abs(a - mid) <= (fine ? 1 : 0) && z < fh - 2 ? p.accent : p.pane());
      else if (z >= 2 && z < fh - 1 && a % U >= 2 && a % U <= 3) paint(a, z, p.pane());
    }

  // the balconies: parapet bands across the front, the glass behind them, partitions between the flats
  for (let k = 1; k < floors; k++) {
    const z0 = k * fh;
    for (let a = 0; a < W; a++) {
      const part = a % U === 0;
      const outdoor = !ends(a) && !part && fine && a % U === U - 2 && (Math.floor(a / U) * 7 + k * 3) % 5 < 2;
      for (let zf = 0; zf < fh; zf++) {
        const z = z0 + zf;
        if (z >= zTop) break;
        if (zf < pr || ends(a)) paint(a, z, ends(a) && zf >= pr ? p.body : p.trim);
        else if (part) paint(a, z, p.trim);
        else if (outdoor && zf === pr) paint(a, z, unitMat);
        else if (zf === fh - 1 && fh >= 5) paint(a, z, p.body); // the slab's edge over the doors
        else paint(a, z, (a % U) % 3 === 1 && fine ? frame : p.pane());
      }
    }
  }
  for (let a = 0; a < W; a++) raise(a, H, p.trim);

  // the back: the open corridor, a parapet band at each floor over the flats' doors
  eachSide(f, 0, (x, y, nx, ny, _d, rear) => {
    const a = f.along[y * f.sx + x]!;
    for (let z = fh; z < zTop; z++) {
      if (m.get(nx, ny, z) || !m.get(x, y, z)) continue;
      const zf = z % fh;
      if (!rear) {
        if (a % 5 === 2 && zf >= pr && zf < fh - 1 && fine) m.set(x, y, z, p.pane());
        continue;
      }
      if (zf < pr) m.set(x, y, z, p.trim);
      else if (zf < fh - 1) m.set(x, y, z, a % U === 2 || (fine && a % U === 3) ? p.accent : a % U === U - 2 ? p.pane() : p.body);
    }
  });

  // the roof: a lift penthouse, a water tank on a steel stand on some
  if (W >= 6 && f.maxDepth >= 6) {
    const pw = Math.max(3, Math.round(W / 6));
    bulkhead(m, f, H, fh, Math.floor(W * 0.2), Math.floor(f.maxDepth * 0.3), pw, Math.max(3, Math.round(f.maxDepth / 3)), { body: p.body, roof: p.roof, door: p.accent });
    const tank = ctx.ramps("tank");
    if (tank.length && rand() < 0.5 && fh >= 4) {
      const t = m.material(tank[0]!);
      const a0 = Math.floor(W * 0.62);
      const tw = Math.max(2, Math.round(fh * 0.5));
      for (let y = 0; y < f.sy; y++)
        for (let x = 0; x < f.sx; x++) {
          const i = y * f.sx + x;
          const a = f.along[i]!;
          const d = f.depth[i]!;
          if (a < a0 || a >= a0 + tw || d < 2 || d >= 2 + tw || !m.get(x, y, H - 1) || m.get(x, y, H)) continue;
          m.set(x, y, H, frame);
          for (let z = H + 1; z < H + 1 + tw; z++) m.set(x, y, z, t);
        }
    }
  }
  return m;
};

/** The roof shapes a kodate draws, and their shares when the record has none. */
const ROOFS = ["gabled", "hipped", "flat", "skillion"] as const;

/**
 * A kodate (戸建て): a small detached house of two storeys (one to three),
 * siding or mortar under a pitched roof of metal or tile, gabled (the ridge
 * along the longer side) or hipped, flat on the modern boxes, a shed roof on
 * a few. A yard in front for the car behind a low block wall, the door and a
 * window at the street, and a balcony's rail painted across the upper floor.
 * Everything stays inside the footprint: the roof steps in layer by layer.
 * With `shop`, the street floor is a shopfront under a sign band (a shop
 * house, 店舗併用住宅).
 * params: yard (0 for none), balcony (0 for none), shop (1 for a shop
 * house), pitch (rise per voxel in; 0.7), hipped / flat / skillion (shares
 * by seed; 0.3, 0.1, 0.05; the hint `roof` overrides), litFraction.
 * roles: wall (siding and mortar variants), trim (window frames and sills),
 * roof (metal and tile variants), fence (the block wall; trim if absent),
 * frame (the balcony rail; trim if absent), sign (a shop house's band;
 * accent if absent), accent (the door), window, lit.
 */
export const kodate: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("kodate needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const floors = clamp(Math.round(hints?.floors ?? (rand() < 0.8 ? 2 : rand() < 0.6 ? 1 : 3)), 1, 3);
  const total = ctx.heightVox ?? floors * 8 + 4;
  const fh = clamp(Math.round((total * 0.8) / floors), 3, 9);
  const Hw = floors * fh;
  const fine = fh >= 6;
  // a yard in front, for the car, behind a block wall
  const yard = param("yard", 1) > 0 && f.maxDepth >= 10 && W >= 5 ? clamp(Math.round(f.maxDepth * 0.2), 2, 5) : 0;
  const hinted = ROOFS.find((r) => r === hints?.roof);
  const r = rand();
  const roof = hinted ?? (r < param("skillion", 0.05) ? "skillion" : r < param("skillion", 0.05) + param("flat", 0.1) ? "flat" : r < param("skillion", 0.05) + param("flat", 0.1) + param("hipped", 0.3) ? "hipped" : "gabled");
  const pitch = param("pitch", 0.7);
  const half = Math.ceil(Math.max(W, f.maxDepth) / 2);
  const m = new VoxelModel(f.sx, f.sy, Hw + Math.ceil(half * pitch) + (roof === "skillion" ? half : 0) + 3);
  const p = paints(ctx, m);
  const fence = roleOr(ctx, m, "fence", p.trim);
  const rail = roleOr(ctx, m, "frame", p.trim);
  massing(m, f, Hw, p.body, p.body, yard);

  // the roof, layer by layer: each column rises by its distance in from the eaves
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < f.sx && y < f.sy && f.depth[y * f.sx + x]! >= yard;
  const [fx, fy] = f.front;
  const [lx, ly] = [fy, -fx];
  const along = W >= f.maxDepth + 1 - yard; // the ridge runs along the front
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      if (!inside(x, y)) continue;
      const toF = Math.min(run(inside, x, y, fx, fy), run(inside, x, y, -fx, -fy));
      const toL = Math.min(run(inside, x, y, lx, ly), run(inside, x, y, -lx, -ly));
      let dist = 0;
      let gable = false;
      if (roof === "hipped") dist = Math.min(toF, toL);
      else if (roof === "gabled") {
        dist = along ? toF : toL;
        gable = (along ? toL : toF) === 0;
      } else if (roof === "skillion") {
        dist = run(inside, x, y, fx, fy); // high at the back
        gable = toL === 0;
      }
      const top = Hw - 1 + (roof === "flat" ? 0 : Math.floor(dist * (roof === "skillion" ? pitch * 0.5 : pitch)));
      for (let z = Hw - 1; z <= top; z++) m.set(x, y, z, z === top || !gable ? p.roof : p.body);
      // a flat roof's parapet
      if (roof === "flat" && Math.min(toF, toL) === 0) m.set(x, y, Hw, p.body);
    }

  // the front: the door and a window at the street, windows above with a balcony's rail across them
  const { paint } = frontPainter(m, f, yard);
  const door = rand() < 0.5 ? 1 : Math.max(1, W - 3);
  const dw = fine && W >= 6 ? 2 : 1;
  const { spans } = bays(W, Math.max(1, Math.round(W / (fine ? 5 : 3))), fine ? 3 : 1);
  const balcony = param("balcony", 1) > 0 && floors >= 2 && W >= 6 && rand() < 0.6;
  // a shop house: a shopfront under a sign band across the street floor
  const shop = param("shop", 0) > 0 && W >= 3;
  const signs = ctx.ramps("sign");
  const shopSign = signs.length ? m.material(pick(rand, signs)) : p.accent;
  for (let k = 0; k < floors; k++)
    for (let zf = 1; zf < fh; zf++) {
      const z = k * fh + zf;
      if (z >= Hw - 1) break;
      for (let a = 0; a < W; a++) {
        if (shop && k === 0) {
          const end = a === 0 || a === W - 1;
          paint(a, z, zf >= fh - (fine ? 2 : 1) ? shopSign : end ? p.trim : a === door && zf < fh - 2 ? p.accent : p.pane());
          continue;
        }
        if (k === 0 && a >= door && a < door + dw && W >= 4) {
          paint(a, z, zf < fh - 1 ? p.accent : p.trim);
          continue;
        }
        const win = spans.some(([s, e]) => a >= s && a <= e) && !(k === 0 && a >= door - 1 && a < door + dw + 1);
        if (balcony && k === 1 && zf <= (fine ? 2 : 1) && a >= 1 && a <= W - 2) paint(a, z, rail);
        else if (win && zf >= (fine ? 2 : 1) && zf < fh - 1) paint(a, z, p.pane());
        else if (win && zf === fh - 1 && fine) paint(a, z, p.trim);
      }
    }
  sideWindows(m, f, yard, 0, Hw - 1, fh, p.pane, 4);

  // the block wall along the street, open for the car and the gate
  if (yard) {
    const wallH = fine ? 2 : 1;
    const gap0 = door - 1;
    const gap1 = door + Math.max(dw, Math.round(W * 0.35));
    for (let y = 0; y < f.sy; y++)
      for (let x = 0; x < f.sx; x++) {
        const i = y * f.sx + x;
        const a = f.along[i]!;
        if (f.depth[i] !== 0 || (a >= gap0 && a <= gap1)) continue;
        for (let z = 0; z < wallH; z++) m.set(x, y, z, fence);
      }
  }
  return m;
};

export const BUILDING_GENERATORS: Record<string, Generator> = { zakkyo, mansion, kodate };

/** For tests: the facade a building group draws on. */
export type { Facade };
