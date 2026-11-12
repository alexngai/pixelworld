import { VoxelModel, type Generator } from "pixelworld/generators";
import { DIRS, SIDES, clamp, facadeOf, massing, paints, roleOr } from "./facade";

/**
 * Two landmark shapes of Tsim Sha Tsui's waterfront (D-108), drawn on their
 * footprints (generic depictions, D-051: no names, logos or lettering).
 */

const dir = (v: number) => DIRS[((Math.round(v) % 8) + 8) % 8]!;

/**
 * A windowless hall under a curved roof, the Hong Kong Cultural Centre's
 * type: on its footprint, walls of tile with no windows, a joint line every
 * few courses, and a roof that sweeps up from `low` of the height at one end
 * to the full height at the other, flat at its foot and steepening toward
 * its crest, as a ski slope does.
 * params: low (the roof's foot over the height; 0.3), rise (the direction it
 * rises toward, 0–7 in 45° steps from +x, y south; 6, north).
 * roles: wall, trim (the joints; wall if absent), roof.
 */
export const curvedRoofHall: Generator = ({ mask, heightVox, param, ramp, ramps }) => {
  if (!mask) throw new Error("curvedRoofHall needs a footprint");
  const { sx, sy, on } = mask;
  const H = Math.max(8, Math.round(heightVox ?? 60));
  const low = Math.max(3, Math.round(H * param("low", 0.3)));
  const [dx, dy] = dir(param("rise", 6));
  const m = new VoxelModel(sx, sy, H + 1);
  const wall = m.material(ramp("wall"));
  const joint = m.material(ramps("trim")[0] ?? ramp("wall"));
  const roof = m.material(ramp("roof"));
  let lo = Infinity;
  let hi = -Infinity;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (on[y * sx + x]) {
        lo = Math.min(lo, x * dx + y * dy);
        hi = Math.max(hi, x * dx + y * dy);
      }
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < sx && y < sy && on[y * sx + x] === 1;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) {
      if (!inside(x, y)) continue;
      const t = (x * dx + y * dy - lo) / Math.max(1, hi - lo);
      const top = Math.round(low + (H - low) * t * t);
      const skin = SIDES.some(([ex, ey]) => !inside(x + ex, y + ey));
      for (let z = 0; z < top; z++) m.set(x, y, z, skin && z % 5 === 4 ? joint : wall);
      m.set(x, y, top, roof);
    }
  return m;
};

/**
 * A grand hotel of the 1920s with the tower built behind it, The
 * Peninsula's type: on its footprint (wings round a forecourt at the
 * front), the old hotel `wings` of the height tall, a rusticated ground
 * storey, windows in pairs, a cornice and a balustrade on its flat roof; and
 * across the back of its main block, a tower to the full height, windows in
 * pairs of bands, its top storey glazed, a helipad's ring on its roof.
 * params: wings (the old hotel's height over the whole; 0.35), tower (the
 * tower's width over the front's; 0.67), front (the direction the forecourt
 * faces, 0–7 in 45° steps from +x, y south; 2, south), litFraction.
 * roles: wall, trim (cornices, the balustrade, rustication: trim.* follows
 * the wall), base (the ground storey; trim if absent), pad (the helipad's
 * ring; trim if absent), roof, window, lit.
 */
export const grandHotel: Generator = (ctx) => {
  const { mask, heightVox, param } = ctx;
  if (!mask) throw new Error("grandHotel needs a footprint");
  const f = facadeOf(mask, ((Math.round(param("front", 2)) % 8) + 8) % 8);
  const { sx, sy } = f;
  const H = Math.max(16, Math.round(heightVox ?? 180));
  const Hw = Math.max(6, Math.round(H * param("wings", 0.35)));
  const fh = clamp(Math.round(Hw / 7), 3, 8);
  const m = new VoxelModel(sx, sy, H + 2);
  const p = paints(ctx, m);
  const base = roleOr(ctx, m, "base", p.trim);
  const pad = roleOr(ctx, m, "pad", p.trim);
  massing(m, f, Hw, p.body, p.roof);
  // the tower: across the back of the main block, from 60% to 92% of the way back from the front line, centred
  // (measured from the footprint's front-most line, not each column's front, which the forecourt pushes back)
  const [fx, fy] = f.front;
  let front = -Infinity;
  for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) if (f.depth[y * sx + x]! >= 0) front = Math.max(front, x * fx + y * fy);
  const back = (x: number, y: number) => front - (x * fx + y * fy);
  const span = f.maxDepth;
  const tw = Math.max(2, Math.round(f.width * param("tower", 0.67)));
  const t0 = Math.floor((f.width - tw) / 2);
  const d0 = Math.floor(span * 0.6);
  const d1 = Math.max(d0 + 2, Math.round(span * 0.92));
  const tower = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= sx || y >= sy || f.depth[y * sx + x]! < 0) return false;
    const a = f.along[y * sx + x]!;
    const d = back(x, y);
    return d >= d0 && d <= d1 && a >= t0 && a < t0 + tw;
  };
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++) if (tower(x, y)) for (let z = Hw - 1; z < H; z++) m.set(x, y, z, z === H - 1 ? p.roof : p.body);

  // every face: rusticated ground storey, paired windows, the cornice; the tower's bands of windows and glazed top
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      for (const [dx, dy] of SIDES) {
        const u = dx !== 0 ? y : x;
        for (let z = 0; z < H - 1; z++) {
          if (!m.get(x, y, z) || m.get(x + dx, y + dy, z)) continue;
          const zf = z % fh;
          let mat = p.body;
          if (z < Hw - 1) {
            if (z < fh) mat = z % 2 === 0 ? base : p.trim;
            else if (z === Hw - 2) mat = p.trim; // the cornice
            else if (zf >= 1 && zf < fh - 1 && u % 3 !== 0) mat = p.pane();
          } else if (z >= H - 1 - fh) mat = u % 4 === 0 ? p.trim : p.pane();
          else if (zf >= 1 && zf < fh - 1 && u % 4 !== 0 && u % 4 !== 3) mat = p.pane();
          m.set(x, y, z, mat);
        }
        // the balustrade on the old hotel's roof edge
        if (!tower(x, y) && m.get(x, y, Hw - 1) && !m.get(x + dx, y + dy, Hw - 1) && u % 2 === 0) m.set(x, y, Hw, p.trim);
      }

  // the helipad: a ring on the tower's roof
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (let y = 0; y < sy; y++)
    for (let x = 0; x < sx; x++)
      if (tower(x, y)) {
        cx += x;
        cy += y;
        n++;
      }
  const r = Math.min(d1 - d0, tw) / 2 - 1;
  if (n && r >= 2)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++)
        if (tower(x, y) && Math.abs(Math.hypot(x - cx / n, y - cy / n) - r * 0.7) < 0.6) m.set(x, y, H - 1, pad);
  return m;
};

export const LANDMARK_GENERATORS: Record<string, Generator> = { curvedRoofHall, grandHotel };
