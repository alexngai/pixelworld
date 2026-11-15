import { VoxelModel, type Generator } from "pixelworld/generators";
import { SIDES, clamp, paints, roleOr, type Mask } from "./facade";

/** Steps from each cell of a footprint to its edge: 1 on the edge, 0 outside. */
function edgeDistance({ sx, sy, on }: Mask): Int16Array {
  const dist = new Int16Array(sx * sy);
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < sx && y < sy ? y * sx + x : -1);
  const queue: number[] = [];
  for (let i = 0; i < sx * sy; i++)
    if (on[i] && SIDES.some(([dx, dy]) => !on[at((i % sx) + dx, Math.floor(i / sx) + dy)])) {
      dist[i] = 1;
      queue.push(i);
    }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    for (const [dx, dy] of SIDES) {
      const j = at((i % sx) + dx, Math.floor(i / sx) + dy);
      if (j >= 0 && on[j] && !dist[j]) {
        dist[j] = dist[i]! + 1;
        queue.push(j);
      }
    }
  }
  return dist;
}

interface Box {
  x0: number;
  y0: number;
  s: number;
}

/**
 * Two square boxes for the roof at most, two steps in from the parapet and a
 * voxel apart, each as large as fits up to a quarter of the footprint's
 * square root (3 to 8): the first nearest the footprint's middle (the core),
 * the second as far from it as it fits (a wing's end).
 */
function roofBoxes(mask: Mask, dist: Int16Array): Box[] {
  const { sx, sy, on } = mask;
  let cx = 0;
  let cy = 0;
  let cells = 0;
  for (let i = 0; i < sx * sy; i++)
    if (on[i]) {
      cx += (i % sx) + 0.5;
      cy += Math.floor(i / sx) + 0.5;
      cells++;
    }
  if (!cells) return [];
  const s0 = clamp(Math.round(Math.sqrt(cells) / 4), 3, 8);
  const boxes: Box[] = [];
  const fits = (x0: number, y0: number, s: number) => {
    for (const b of boxes) if (x0 <= b.x0 + b.s && b.x0 <= x0 + s && y0 <= b.y0 + b.s && b.y0 <= y0 + s) return false;
    for (let y = y0; y < y0 + s; y++) for (let x = x0; x < x0 + s; x++) if (dist[y * sx + x]! < 3) return false;
    return true;
  };
  for (let k = 0; k < 2; k++) {
    const [ax, ay] = k === 0 ? [cx / cells, cy / cells] : [boxes[0]!.x0 + boxes[0]!.s / 2, boxes[0]!.y0 + boxes[0]!.s / 2];
    let best: Box | undefined;
    let score = Infinity;
    for (let s = s0; s >= 2 && !best; s--)
      for (let y0 = 0; y0 + s <= sy; y0++)
        for (let x0 = 0; x0 + s <= sx; x0++) {
          if (!fits(x0, y0, s)) continue;
          const d = (x0 + s / 2 - ax) ** 2 + (y0 + s / 2 - ay) ** 2;
          if ((k === 0 ? d : -d) < score) {
            score = k === 0 ? d : -d;
            best = { x0, y0, s };
          }
        }
    if (!best) break;
    boxes.push(best);
  }
  return boxes;
}

/**
 * The public estate's block (公屋): the Housing Authority's standard
 * designs, Trident, Harmony, cruciform and slab, 25 to 40 storeys, on
 * whatever footprint the data gives (a cross, a Y or a slab arrives as the
 * mask), so the look is the façade's. Every face (a block is seen from all
 * round) is white or off-white wall gridded with small windows on every
 * storey (pairs between piers, or singles, by seed), air conditioners
 * speckled beside them. The estate's colour, one per block by seed, in one of
 * three ways: vertical stripes at the ends of each face (the corners and the
 * wings' ends), bands of whole storeys every few, or coloured panels round
 * the windows of every other bay (and the corridors' rails). Open corridors
 * and lift lobbies as dark slots up the middle of the faces toward one axis
 * (by seed), drawn flush with a slab line at every storey. At the street, the
 * lobby: glass between piers under a band, the ground storey and what height
 * the storeys leave over. A parapet round the roof; on the roof, the lift
 * machine rooms, a box in the middle and another toward a wing's end where
 * they fit, the water tanks on them (always on the middle one). The model's
 * height is the record's: storeys from the record (hints.floors), else
 * `stories`, else the height over `storey` voxels.
 * params: storey (voxels a storey without a record; 4.5, 2.8 m at 0.625 m a
 * voxel), stories (storeys without a record, 0: from the height),
 * accentShare (how much the colour takes: a stripe's share of its face, one
 * storey in 1/share banded, panels on one bay in 1/(2 share); 0.25), ac (of
 * walls beside a window with an air conditioner, a storey; 0.3),
 * litFraction.
 * roles: wall (wall.* variants), trim (lobby's piers and band, parapet,
 * tanks: trim.* follows the wall), accent (accent.* variants: one a block),
 * window, lit, lobby (the lobby's glass), shade (the corridors' slots), ac
 * (air conditioners), roof.
 */
export const estateTower: Generator = (ctx) => {
  const { rand, hints, param } = ctx;
  const mask = ctx.mask ?? { sx: 24, sy: 24, on: new Uint8Array(24 * 24).fill(1) };
  const { sx, sy, on } = mask;
  const onAt = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  const H = Math.max(12, Math.round(ctx.heightVox ?? param("height", 120)));
  const boxes = roofBoxes(mask, edgeDistance(mask));
  const mh = clamp(Math.round(H * 0.05), 3, 7); // the machine rooms
  const th = clamp(Math.round(H * 0.03), 2, 4); // the tanks on them
  const Hb = H - (boxes.length ? mh + th : 1); // the roof's top, under the parapet
  const stories = param("stories", 0);
  const want = hints?.floors ?? (stories > 0 ? stories : (Hb - 1) / param("storey", 4.5));
  const fh = clamp(Math.round((Hb - 1) / Math.max(1, want)), 3, 8);
  const floors = Math.max(1, Math.floor((Hb - 1) / fh));
  const g = Hb - 1 - (floors - 1) * fh; // the lobby: the ground storey and what is left over
  const lo = fh >= 5 ? 2 : 1; // a window's rows in a storey
  const hi = Math.min(fh - 2, lo + 2);

  const m = new VoxelModel(sx, sy, H + 1);
  const c = paints(ctx, m);
  const accent = roleOr(ctx, m, "accent", c.trim);
  const lobby = roleOr(ctx, m, "lobby", c.glass);
  const shade = roleOr(ctx, m, "shade", c.glass);
  const ac = roleOr(ctx, m, "ac", c.trim);
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (onAt(x, y)) {
        m.fill(x, y, 0, x + 1, y + 1, Hb - 1, c.body);
        m.set(x, y, Hb - 1, c.roof);
      }

  const P = rand() < 0.5 ? 3 : 2; // pairs of windows between piers, or singles
  const isWin = (u: number) => (P === 3 ? u % 3 !== 0 : u % 2 === 1);
  const scheme = Math.floor(rand() * 3); // the colour: stripes, bands or panels
  const share = clamp(param("accentShare", 0.25), 0.05, 0.5);
  const bandEvery = Math.max(2, Math.round(1 / share));
  const panelEvery = Math.max(1, Math.round(1 / (2 * share)));
  const slotX = rand() < 0.5; // the corridors on the faces toward ±x, else ±y
  const acShare = param("ac", 0.3);

  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!onAt(x, y)) continue;
      for (const [dx, dy] of SIDES) {
        if (onAt(x + dx, y + dy)) continue;
        // where the column stands in its run of wall: e1 from one end, e2 from the other
        const [tx, ty] = dx !== 0 ? [0, 1] : [1, 0];
        const face = (k: number) => onAt(x + tx * k, y + ty * k) && !onAt(x + tx * k + dx, y + ty * k + dy);
        let e1 = 0;
        while (face(-e1 - 1)) e1++;
        let e2 = 0;
        while (face(e2 + 1)) e2++;
        const run = e1 + e2 + 1;
        const u = run >= 4 ? e1 : dx !== 0 ? y : x; // a diagonal's short steps keep the grid across them
        const sw = Math.max(1, Math.round((share * run) / 2));
        const stripe = scheme === 0 && run >= 2 * sw + 3 && Math.min(e1, e2) < sw;
        const slots = Math.max(1, Math.round(run / 30));
        const slot = (dx !== 0) === slotX && run >= 11 && [...Array(slots).keys()].some((k) => Math.abs(e1 - Math.floor(((k + 0.5) * run) / slots)) <= 1);
        const win = !stripe && !slot && isWin(u);
        const panel = scheme === 2 && win && Math.floor(u / P) % panelEvery === 0;
        const beside = !win && !stripe && !slot && (isWin(u - 1) || isWin(u + 1));

        for (let z = 0; z < g; z++) m.set(x, y, z, z === g - 1 || u % 4 === 0 ? c.trim : lobby);
        for (let k = 1; k < floors; k++) {
          const z0 = g + (k - 1) * fh;
          const wall = stripe || (scheme === 1 && k % bandEvery === 0) ? accent : c.body;
          const unit = beside && rand() < acShare;
          for (let zf = 0; zf < fh; zf++) {
            let mat = wall;
            if (slot) mat = zf > 0 ? shade : scheme === 2 ? accent : c.body;
            else if (win && zf >= lo && zf <= hi) mat = c.pane();
            else if (panel) mat = accent;
            else if (unit && zf === lo) mat = ac;
            m.set(x, y, z0 + zf, mat);
          }
        }
        m.set(x, y, Hb - 1, c.trim);
        m.set(x, y, Hb, c.trim);
      }
    }

  // the roof: the machine rooms, the tanks on them a voxel in from their edge
  boxes.forEach(({ x0, y0, s }, k) => {
    const tank = k === 0 || rand() < 0.5;
    const t = s >= 4 ? 1 : 0;
    for (let y = y0; y < y0 + s; y++)
      for (let x = x0; x < x0 + s; x++) {
        m.fill(x, y, Hb, x + 1, y + 1, Hb + mh - 1, c.body);
        m.set(x, y, Hb + mh - 1, c.roof);
        if (tank && x >= x0 + t && x < x0 + s - t && y >= y0 + t && y < y0 + s - t) m.fill(x, y, Hb + mh, x + 1, y + 1, Hb + mh + th, c.trim);
      }
  });
  return m;
};

export const ESTATE_GENERATORS: Record<string, Generator> = { estateTower };
