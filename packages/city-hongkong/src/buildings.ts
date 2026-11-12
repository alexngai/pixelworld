import { VoxelModel, type GenContext, type Generator } from "pixelworld/generators";
import { SIDES, bulkhead, clamp, eachSide, facadeOf, frontDir, frontPainter, massing, paints, pick, roleOr, schemeRole, sideWindows, type Facade } from "./facade";

/**
 * Kowloon's street fabric (D-108): the tong lau, the tenement of the 1950s
 * and 60s, in rows; the composite building of the 60s to 80s, slender, its
 * front a grid of small windows and air conditioners over shops (and the low
 * malls and podiums, `mall`); and the pencil tower, the slim residential
 * tower of bay windows under a crown. Signs carry no lettering.
 */

/** Storeys: the record's (hints.floors) within [lo, hi], else the height over `storey` voxels; never fewer than three voxels a storey. */
function storeys(ctx: GenContext, H: number, lo: number, hi: number, storey: number): number {
  const want = clamp(Math.round(ctx.hints?.floors ?? H / storey), lo, hi);
  return Math.max(1, Math.min(want, Math.floor(H / 3)));
}

/** A one-pixel line (D-098) out of the front from the face of the front column at position a: a laundry pole. */
function pole(m: VoxelModel, f: Facade, col: [number, number] | undefined, z: number, out: number, mat: number): void {
  if (!col) return;
  const [fx, fy] = f.front;
  const [x, y] = col;
  m.line([x + 0.5 + fx * 0.5, y + 0.5 + fy * 0.5, z], [x + 0.5 + fx * (0.5 + out), y + 0.5 + fy * (0.5 + out), z + 0.5], mat);
}

/** An aerial on the roof: a one-pixel mast and a crossbar. */
function aerial(m: VoxelModel, x: number, y: number, z: number, h: number, mat: number): void {
  m.line([x + 0.5, y + 0.5, z], [x + 0.5, y + 0.5, z + h], mat);
  m.line([x - 0.5, y + 0.5, z + h - 1], [x + 1.5, y + 0.5, z + h - 1], mat);
}

/** A water tank on a steel stand, `w` voxels square, at (a, d) on the roof at height H, in the columns of `keep`. */
function tank(m: VoxelModel, f: Facade, H: number, a0: number, d0: number, w: number, mats: { stand: number; tank: number }, keep = (_a: number) => true): void {
  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      const i = y * f.sx + x;
      const a = f.along[i]!;
      const d = f.depth[i]!;
      if (a < a0 || a >= a0 + w || d < d0 || d >= d0 + w || !keep(a) || !m.get(x, y, H - 1) || m.get(x, y, H)) continue;
      m.set(x, y, H, mats.stand);
      for (let z = H + 1; z < H + 1 + w; z++) m.set(x, y, z, mats.tank);
    }
}

/**
 * The tong lau (唐樓): the tenement of the 1950s and 60s, four to nine
 * storeys on a narrow deep lot, in rows that share party walls. A footprint
 * wider than a lot is drawn as a row of them (lots of `lot` voxels), each
 * with its own colour, height (a storey more or less than the record on
 * some) and details. At the street, an open shop under its signboard, or its
 * roller shutter down or half up, and the stair's steel gate at one side.
 * Above, a balcony at every storey: the slab's edge, a railing (a solid
 * parapet, balusters or a steel grille), and over it the balcony's shadow
 * with a door's glass, laundry along its top and an air conditioner on the
 * rail, whose drips stain the rail under it; or the balcony closed in with
 * windows. All flush: nothing projects but laundry poles, one-pixel lines
 * out of some balconies. Painted render in faded pastels or white mosaic
 * tile. A parapet on the flat roof, the party walls' piers a voxel higher; a
 * hut on the roof behind it, a water tank on a stand and an aerial on some.
 * params: lot (voxels a house; 7), storey (voxels a storey without a
 * record; 5.5), open (the share of balconies left open; 0.55), ac (of
 * storeys with an air conditioner; 0.5), poles (of open balconies with a
 * laundry pole; 0.5), hut (of houses with a roof hut; 0.65), litFraction.
 * roles: wall (wall.* variants: one a house), trim (railings, piers and
 * sills: trim.* follows the wall), sign (sign.* variants: the signboards),
 * shade (a balcony's and a shop's shadow), shutter and frame (the roller
 * shutter's ribs; frame also the stair's gate, grilles, poles and aerials),
 * unit (air conditioners), grime (drip stains), cloth (cloth.* variants:
 * laundry), hut (hut.* variants), tank, accent, roof, window, lit.
 */
export const tongLau: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("tongLau needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const D = f.maxDepth;
  const H = Math.max(8, Math.round(ctx.heightVox ?? param("height", 36)));
  const floors = storeys(ctx, H - 1, 2, 12, param("storey", 5.5));
  const fh = Math.max(3, Math.floor((H - 1) / floors));
  const g = Math.min(H - (floors - 1) * fh, fh + 2); // the shop's storey, a voxel or two taller
  const fine = fh >= 5;
  const band = fine ? 2 : 1; // the signboard's rows
  const rr = fh >= 7 ? 2 : 1; // the railing's rows (a metre or so)
  const m = new VoxelModel(f.sx, f.sy, H + 3 * fh + 8);
  const p = paints(ctx, m);
  const walls = ctx.ramps("wall");
  const shade = roleOr(ctx, m, "shade", p.glass);
  const frame = roleOr(ctx, m, "frame", p.trim);
  const shutter = roleOr(ctx, m, "shutter", frame);
  const unit = roleOr(ctx, m, "unit", p.trim);
  const grime = roleOr(ctx, m, "grime", shade);
  const tankMat = roleOr(ctx, m, "tank", p.trim);
  const signs = ctx.ramps("sign").map((r) => m.material(r));
  const cloth = ctx.ramps("cloth").map((r) => m.material(r));
  const huts = ctx.ramps("hut").map((r) => m.material(r));

  // the row: lots of about `lot` voxels, cut at party walls
  const n = Math.max(1, Math.round(W / Math.max(4, param("lot", 7))));
  const cuts = [0];
  for (let k = 1; k < n; k++) cuts.push(clamp(Math.round((k * W) / n) + Math.floor(rand() * 3) - 1, cuts[k - 1]! + 3, W - 3 * (n - k)));
  cuts.push(W);
  const lots = cuts.slice(0, -1).map((a0, k) => {
    const wk = Math.floor(rand() * walls.length);
    const body = m.material(walls[wk]!);
    const fl = clamp(floors + (n > 1 && rand() < 0.35 ? (rand() < 0.5 ? -1 : 1) : 0), 2, 12);
    return {
      a0,
      a1: cuts[k + 1]! - 1,
      body,
      trim: schemeRole(ctx, m, wk, walls.length, "trim", body),
      sign: signs.length ? pick(rand, signs) : p.accent,
      fl,
      top: g + (fl - 1) * fh + 1, // the roof slab is the voxel under it
    };
  });
  const lotAt = new Int16Array(W);
  lots.forEach((L, k) => lotAt.fill(k, L.a0, L.a1 + 1));
  const lotOf = (x: number, y: number) => lots[lotAt[f.along[y * f.sx + x]!]!]!;

  for (let y = 0; y < f.sy; y++)
    for (let x = 0; x < f.sx; x++) {
      if (f.depth[y * f.sx + x]! < 0) continue;
      const L = lotOf(x, y);
      for (let z = 0; z < L.top - 1; z++) m.set(x, y, z, L.body);
      m.set(x, y, L.top - 1, p.roof);
    }

  const { paint, raise, cols } = frontPainter(m, f, 0);
  for (const L of lots) {
    const w = L.a1 - L.a0 + 1;
    const pier = (a: number) => a === L.a0 || a === L.a1;
    // the shop: open, its shutter down or half up; the stair's gate at one side
    const shop = rand();
    const stair = w >= 5 ? (rand() < 0.5 ? L.a0 + 1 : L.a1 - 1) : -1;
    for (let a = L.a0; a <= L.a1; a++)
      for (let z = 0; z < g; z++) {
        let mat: number;
        if (pier(a)) mat = L.trim;
        else if (z >= g - band) mat = L.sign;
        else if (a === stair) mat = z < g - band - 1 ? frame : L.trim;
        else if (shop < 0.3 || (shop < 0.5 && z >= (g - band) / 2)) mat = z % 2 === 0 ? shutter : frame;
        else mat = z === 0 || rand() < 0.3 ? shade : p.pane();
        paint(a, z, mat);
      }

    // the balconies: the slab's edge, a railing, and over it the balcony's shadow or windows
    const r = rand();
    const rail = r < 0.5 ? 0 : r < 0.75 ? 1 : 2; // a solid parapet, balusters, a steel grille
    const top = fh >= 7 ? fh - 2 : fh - 1; // the opening's top row (a lintel over it on tall storeys)
    for (let k = 1; k < L.fl; k++) {
      const z0 = g + (k - 1) * fh;
      const open = rand() < param("open", 0.55);
      const ac = w >= 4 && rand() < param("ac", 0.5) ? L.a0 + 1 + Math.floor(rand() * (w - 2)) : -1;
      const drip = rand() < 0.6;
      for (let a = L.a0; a <= L.a1; a++) {
        const i = a - L.a0;
        for (let zf = 0; zf < fh; zf++) {
          let mat: number;
          if (zf === 0 || pier(a) || zf > top) mat = L.body;
          else if (zf <= rr) {
            if (a === ac && zf === rr && drip) mat = grime;
            else if (rail === 0) mat = L.trim;
            else if (rail === 1) mat = zf === rr && rr > 1 ? L.trim : i % 2 === 1 ? L.trim : shade;
            else mat = frame;
          } else if (a === ac && zf === rr + 1) mat = unit;
          else if (!open) mat = i % 3 === 0 ? L.trim : p.pane();
          else if (zf === top && cloth.length && rand() < 0.5) mat = pick(rand, cloth);
          else mat = i % 3 === 2 ? p.pane() : shade;
          paint(a, z0 + zf, mat);
        }
      }
      if (open && w >= 3 && rand() < param("poles", 0.5)) pole(m, f, cols[L.a0 + 1 + Math.floor(rand() * (w - 2))]?.[0], z0 + top + 0.5, 3, frame);
    }
    // the parapet, the party walls' piers a voxel higher
    for (let a = L.a0; a <= L.a1; a++) {
      raise(a, L.top, pier(a) ? L.body : L.trim);
      if (pier(a)) raise(a, L.top + 1, L.body);
    }

    // the roof: a hut behind the parapet, a water tank on a stand, an aerial
    const inLot = (a: number) => a >= L.a0 && a <= L.a1;
    if (D >= 8 && w >= 4 && huts.length && rand() < param("hut", 0.65)) {
      const hut = pick(rand, huts);
      const d0 = Math.floor(D * (0.35 + rand() * 0.2));
      const d1 = Math.min(D - 1, d0 + Math.max(3, Math.round(D * 0.3)));
      const hh = Math.max(2, fh - 1);
      const door = L.a0 + Math.floor(w / 2);
      for (let y = 0; y < f.sy; y++)
        for (let x = 0; x < f.sx; x++) {
          const ii = y * f.sx + x;
          const a = f.along[ii]!;
          const d = f.depth[ii]!;
          if (!inLot(a) || pier(a) || d < d0 || d > d1 || !m.get(x, y, L.top - 1) || m.get(x, y, L.top)) continue;
          for (let z = L.top; z < L.top + hh; z++) m.set(x, y, z, z === L.top + hh - 1 ? p.roof : d === d0 && a === door && z < L.top + hh - 1 ? shade : hut);
        }
    }
    if (D >= 5 && w >= 4 && rand() < 0.5) tank(m, f, L.top, L.a1 - 2, 1 + Math.floor(rand() * 2), 2, { stand: frame, tank: tankMat }, inLot);
    const col = cols[L.a0 + Math.floor(w / 2)]?.[0];
    if (col && D >= 4 && rand() < 0.35) {
      const [fx, fy] = f.front;
      const at = Math.min(D - 1, Math.floor(D * 0.25));
      aerial(m, col[0] - fx * at, col[1] - fy * at, L.top, 4 + Math.floor(rand() * 3), frame);
    }
  }

  // the sides: few windows on party walls and at the back; a corner lot's shop and signboard wrap round
  if (hints?.corner === true)
    eachSide(f, 0, (x, y, nx, ny, d, rear) => {
      if (rear) return;
      const L = lotOf(x, y);
      for (let z = 1; z < g; z++) if (m.get(x, y, z) && !m.get(nx, ny, z)) m.set(x, y, z, z >= g - band ? L.sign : d % 4 === 0 ? L.trim : p.pane());
    });
  // (sideWindows, with each house's own roof line)
  const every = hints?.corner ? 3 : 6;
  eachSide(f, 1, (x, y, nx, ny) => {
    if ((x + y) % every !== 0) return;
    for (let z = g + 1; z < lotOf(x, y).top - 1; z++) {
      const zf = (z - g) % fh;
      if (zf === 0 || zf === fh - 1 || (fh >= 6 && zf === 1)) continue;
      if (!m.get(nx, ny, z) && m.get(x, y, z)) m.set(x, y, z, p.pane());
    }
  });
  return m;
};

/**
 * The composite building (商住大廈) of the 1960s to 80s: slender, ten to
 * twenty-five storeys of flats over shops. At the street, shops between
 * piers under their signboards, a shutter down on some, and the lobby's
 * door; on most, billboards across the mezzanine over them. Above, the dense
 * grid of small windows: pairs, ribbons between mullions or narrow slots,
 * and air conditioners under many, their drips staining the spandrel under
 * them; grey, beige or white tile. A parapet, a lift machine room, a water
 * tank and aerials on the roof; small windows up the side walls. With `mall`,
 * the low mall or podium of two to six storeys instead: shops at the street,
 * big sign bands across the storeys above, few windows. Any height: storeys
 * from the record, else from the height (`storey`).
 * params: storey (voxels a storey; 5, 7 with mall), signs (the chance of the
 * mezzanine's billboards, or a mall storey's band; 0.6), ac (the share of
 * windows with an air conditioner; 0.35), mall (1: a mall), litFraction.
 * roles: wall (wall.* tile variants), trim (piers and mullions: trim.*
 * follows the wall), sign (sign.* variants), unit, grime, shade, shutter,
 * frame, tank, accent, roof, window, lit.
 */
export const compositeTower: Generator = (ctx) => {
  const { rand, mask, hints, param } = ctx;
  if (!mask) throw new Error("compositeTower needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const W = f.width;
  const D = f.maxDepth;
  const mall = param("mall", 0) > 0;
  const H = Math.max(6, Math.round(ctx.heightVox ?? param("height", 60)));
  const floors = storeys(ctx, H - 1, 1, 80, param("storey", mall ? 7 : 5));
  const fh = Math.max(3, Math.floor((H - 1) / floors));
  const Hr = floors * fh + 1; // the roof slab's top
  const fine = fh >= 5;
  const band = fine ? 2 : 1;
  const m = new VoxelModel(f.sx, f.sy, Hr + 2 * fh + 8);
  const p = paints(ctx, m);
  const signs = ctx.ramps("sign").map((r) => m.material(r));
  const sign = () => (signs.length ? pick(rand, signs) : p.accent);
  const unit = roleOr(ctx, m, "unit", p.trim);
  const shade = roleOr(ctx, m, "shade", p.glass);
  const grime = roleOr(ctx, m, "grime", shade);
  const frame = roleOr(ctx, m, "frame", p.trim);
  const shutter = roleOr(ctx, m, "shutter", frame);
  const tankMat = roleOr(ctx, m, "tank", p.trim);
  massing(m, f, Hr, p.body, p.roof);
  const { paint, raise, cols } = frontPainter(m, f, 0);
  const signShare = param("signs", 0.6);

  // the street: shops between piers under their signboards; the lobby's door
  const bay = clamp(Math.round(W / Math.max(1, Math.round(W / 7))), 4, 9);
  const shops = Array.from({ length: Math.ceil(W / bay) + 1 }, () => ({ sign: sign(), shut: rand() < 0.2 }));
  const lobby = !mall && W >= 6 ? Math.floor(rand() * Math.floor(W / bay)) * bay + 2 : -1;
  for (let a = 0; a < W; a++) {
    const s = shops[Math.floor(a / bay)]!;
    for (let z = 0; z < Math.min(fh, Hr - 1); z++) {
      let mat: number;
      if (a % bay === 0 || a === W - 1) mat = p.trim;
      else if (z >= fh - band) mat = s.sign;
      else if (a >= lobby && a < lobby + 2) mat = z < fh - band - 1 ? p.accent : p.trim;
      else if (s.shut) mat = z % 2 === 0 ? shutter : frame;
      else mat = z === 0 ? shade : p.pane();
      paint(a, z, mat);
    }
  }

  /** Sign panels across the front at storey k (rows 1 to fh-2), a colour each, `bay` or so wide. */
  const billboards = (k: number) => {
    let face = sign();
    for (let a = 1; a < W - 1; a++) {
      if (a % (bay * (mall ? 2 : 1)) === 0) face = sign();
      for (let zf = 1; zf < fh - 1; zf++) paint(a, k * fh + zf, zf === fh - 2 && fine ? frame : face);
    }
  };

  // the storeys above: the grid of small windows and air conditioners, or a mall's sign bands
  const kind = Math.floor(rand() * 3); // pairs, ribbons, slots
  const acShare = param("ac", 0.35);
  const winAt = (a: number) => (kind === 0 ? a % 3 !== 0 : kind === 1 ? a % 4 !== 0 : a % 2 === 1);
  for (let k = 1; k < floors; k++) {
    if ((mall || k === 1) && floors >= (mall ? 2 : 3) && rand() < signShare) {
      billboards(k);
      continue;
    }
    for (let a = 0; a < W; a++) {
      const edge = a === 0 || a === W - 1;
      const win = !edge && winAt(a) && (!mall || a % 6 !== 0);
      const ac = win && !mall && !winAt(a - 1) && rand() < acShare;
      const drip = ac && rand() < 0.6;
      for (let zf = 0; zf < fh; zf++) {
        const z = k * fh + zf;
        if (z >= Hr - 1) break;
        let mat: number;
        if (edge) mat = p.body;
        else if (zf === 0) mat = drip ? grime : kind === 1 ? p.trim : p.body;
        else if (fine && zf === fh - 1) mat = p.body;
        else if (!win) mat = kind === 1 ? p.trim : p.body;
        else if (mall) mat = zf >= 2 && zf <= 3 ? p.pane() : p.body;
        else if (ac && zf === 1) mat = unit;
        else mat = p.pane();
        paint(a, z, mat);
      }
    }
  }
  for (let a = 0; a < W; a++) raise(a, Hr, p.trim);

  // the roof: a lift machine room, a water tank, aerials
  if (W >= 5 && D >= 6) {
    const a0 = Math.floor(W * (0.15 + rand() * 0.3));
    const d0 = Math.floor(D * 0.35);
    const bw = Math.max(3, Math.round(W / (mall ? 3 : 4)));
    bulkhead(m, f, Hr, fh, a0, d0, bw, Math.max(3, Math.round(D / (mall ? 4 : 3))), { body: p.body, roof: p.roof, door: p.accent });
    if (!mall && rand() < 0.6) tank(m, f, Hr, Math.min(W - 3, a0 + bw + 1), Math.max(1, d0 - 1), Math.max(2, Math.round(fh * 0.5)), { stand: frame, tank: tankMat });
  }
  for (const a of [1, W - 2]) {
    const col = cols[a]?.[0];
    if (col && !mall && D >= 6 && rand() < 0.5) {
      const [fx, fy] = f.front;
      aerial(m, col[0] - fx * 2, col[1] - fy * 2, Hr, 4 + Math.floor(rand() * 4), frame);
    }
  }

  // the sides: small windows up the party walls; a corner lot's shops wrap round
  if (hints?.corner === true)
    eachSide(f, 0, (x, y, nx, ny, d, rear) => {
      if (rear) return;
      for (let z = 1; z < fh; z++) if (m.get(x, y, z) && !m.get(nx, ny, z)) m.set(x, y, z, z >= fh - band ? shops[0]!.sign : d % bay === 0 ? p.trim : p.pane());
    });
  sideWindows(m, f, 0, fh, Hr - 1, fh, p.pane, mall ? 8 : hints?.corner ? 3 : 4);
  return m;
};

/**
 * The pencil tower and the private estate's tower (1980s on): slim, 25 to
 * 60 storeys, white, cream or beige tile. Every face (a tower is seen from
 * all round) in units of `unit` voxels: a bay window framed in the trim, and
 * an air conditioner's ledge, its box over a grille, between them. A lobby
 * of glass two storeys tall at the street. The crown: a parapet round the
 * roof with fins rising from it, and in the middle, on a roof wide enough,
 * the water tanks' enclosure, louvred near its top. Storeys from the record,
 * else from the height (`storey`).
 * params: storey (voxels a storey; 5), unit (voxels a bay; 7), litFraction.
 * roles: wall (wall.* variants), trim (window frames, the lobby's mullions,
 * the crown: trim.* follows the wall), unit, frame (grilles, louvres),
 * accent (the lobby's door), roof, window, lit.
 */
export const pencilTower: Generator = (ctx) => {
  const { mask, hints, param } = ctx;
  if (!mask) throw new Error("pencilTower needs a footprint");
  const f = facadeOf(mask, frontDir(mask, hints?.front));
  const { sx, sy } = f;
  const H = Math.max(12, Math.round(ctx.heightVox ?? param("height", 150)));
  const crown = clamp(Math.round(H * 0.04), 3, 9);
  const floors = storeys(ctx, H - crown - 1, 2, 120, param("storey", 5));
  const fh = Math.max(3, Math.floor((H - crown - 1) / floors));
  const Hr = floors * fh + 1;
  const lobby = Math.min(2 * fh, Hr - 1 - fh);
  const m = new VoxelModel(sx, sy, Hr + crown + 4);
  const p = paints(ctx, m);
  const unit = roleOr(ctx, m, "unit", p.trim);
  const frame = roleOr(ctx, m, "frame", p.trim);
  massing(m, f, Hr, p.body, p.roof);
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && f.depth[y * sx + x]! >= 0;
  const U = Math.max(4, Math.round(param("unit", 7)));

  // every face: bay windows framed in the trim, an air conditioner's ledge between them; the crown's parapet and fins
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!on(x, y)) continue;
      for (const [dx, dy] of SIDES) {
        if (on(x + dx, y + dy)) continue;
        const u = (dx !== 0 ? y : x) % U;
        for (let z = lobby; z < Hr - 1; z++) {
          const zf = (z - lobby) % fh;
          let mat = p.body;
          if (u >= 1 && u <= 3) mat = zf === 0 || (fh >= 5 && zf === fh - 1) ? p.trim : p.pane();
          else if (u === 5 && fh >= 4) mat = zf === 1 ? unit : zf === 2 ? frame : p.body;
          m.set(x, y, z, mat);
        }
        for (let z = Hr; z < Hr + 2; z++) m.set(x, y, z, p.trim);
        if ((x + y) % 3 === 0) for (let z = Hr + 2; z < Hr + crown; z++) m.set(x, y, z, p.trim);
      }
    }

  // the lobby: glass between mullions under a band, the door in the middle
  const { paint } = frontPainter(m, f, 0);
  const mid = Math.floor(f.width / 2);
  for (let a = 0; a < f.width; a++)
    for (let z = 0; z < lobby; z++)
      paint(a, z, z === lobby - 1 || a === 0 || a === f.width - 1 || a % 3 === 0 ? p.trim : Math.abs(a - mid) <= 1 && z < lobby - 2 ? p.accent : p.pane());

  // the water tanks' enclosure in the middle, about a third of the roof across
  const K = Math.max(2, Math.round(Math.min(sx, sy) * 0.3));
  const inner = (x: number, y: number) => SIDES.every(([dx, dy]) => [...Array(K).keys()].every((k) => on(x + dx * (k + 1), y + dy * (k + 1))));
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (on(x, y) && inner(x, y))
        for (let z = Hr; z < Hr + crown + 2; z++) m.set(x, y, z, z === Hr + crown + 1 ? p.roof : z >= Hr + crown - 2 ? frame : p.body);
  return m;
};

export const BUILDING_GENERATORS: Record<string, Generator> = { tongLau, compositeTower, pencilTower };
