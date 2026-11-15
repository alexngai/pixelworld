import { VoxelModel, type Generator } from "pixelworld/generators";
import { clamp } from "./facade";

/**
 * A southern Chinese temple, the type of Man Mo Temple on Hollywood Road and
 * the small Tin Hau temples (a generic depiction: no lettering, no names),
 * drawn on its footprint (24 × 12 voxels without one). Its front is a long
 * side, and its halls stand side by side along it: one on a small footprint,
 * two or three on a wide one (a hall to every 20 voxels of front), the middle
 * of three the widest and tallest, a strip of wall capped dark between each.
 * Each hall has walls of brick on a granite base course and a pitched roof of
 * glazed tile that steps up layer by layer from its front and rear eaves to a
 * ridge along the front, so nothing overhangs. Its gable walls stand a voxel
 * proud of the tiles under a dark coping, and a dark line runs under the
 * eaves. On the ridge sits a raised band of ceramic figures, speckled in the
 * accent colours, with a pearl at its middle and ends that turn up. On the
 * front is a recessed porch, drawn flush as its shadow between granite
 * columns, with a red door in it and a painted frieze over it. A granite step
 * runs along the front of a footprint 8 voxels deep or more.
 * params: maxHeight (voxels; 18: a temple is drawn no taller), front (the side the front faces, 0–7 in 45° steps from +x, y south,
 * rounded to a side; else the data's street front, else the long side: +y, or
 * +x when the footprint is deeper than wide), halls (1–3; 0, by the front's
 * length), side (the side halls' height over the middle's, with three; 0.85),
 * pitch (the roof's rise over its run, before the height caps it; 0.5).
 * roles: wall (the brick), base (granite: the base course, the step, the
 * porch's columns; trim if absent), roof, ridge (ridge.*: the band takes the
 * first by name, its figures and the frieze the rest; trim if absent), door,
 * trim (dark wood: the porch's shadow, the eave line, the copings; wall if
 * absent).
 */
export const chineseTemple: Generator = ({ rand, ramp, ramps, param, mask, heightVox, hints }) => {
  const { sx, sy, on } = mask ?? { sx: 24, sy: 12, on: new Uint8Array(24 * 12).fill(1) };
  const asked = Math.round(param("front", hints?.front ?? -1));
  const front = asked >= 0 ? (Math.round(asked / 2) % 4) * 2 : sx >= sy ? 2 : 0;
  const alongX = front === 2 || front === 6;
  const W = alongX ? sx : sy; // along the front
  const D = alongX ? sy : sx; // from the front back
  // (u along the front, v back from it) → (x, y)
  const xy = (u: number, v: number): [number, number] =>
    front === 2 ? [u, sy - 1 - v] : front === 6 ? [u, v] : front === 0 ? [sx - 1 - v, u] : [v, u];

  // a temple is low whatever the data says: a typology rule may type a building with its district's height
  const H = Math.max(8, Math.min(Math.round(param("maxHeight", 18)), Math.round(heightVox ?? 14)));
  const bh = H >= 14 ? 2 : 1; // the base course
  const s = D >= 20 ? 2 : D >= 8 ? 1 : 0; // the step
  const halfE = Math.floor((D - s - 1) / 2); // rows from an eave to the ridge
  const n = Math.min(clamp(Math.round(param("halls", 0)) || Math.floor(W / 20), 1, 3), Math.max(1, Math.floor((W + 1) / 7)));
  // the halls along the front, a voxel of wall between each; the middle of three a fifth wider
  const weight = (i: number) => (n === 3 && i === 1 ? 1.2 : 1);
  const wsum = n === 3 ? 3.2 : n;
  const avail = W - (n - 1);
  let acc = 0;
  const halls = Array.from({ length: n }, (_, i) => {
    const u0 = Math.round((avail * acc) / wsum) + i;
    acc += weight(i);
    const u1 = Math.round((avail * acc) / wsum) + i - 1;
    const Hh = n === 3 && i !== 1 ? Math.round(H * param("side", 0.85)) : H;
    // eaves at 40% of the height or more; the ridge 4 under the top (band, figures, upturned ends)
    const Emin = Math.max(bh + 3, Math.round(Hh * 0.4));
    const rise = halfE > 0 ? clamp(Math.round(halfE * param("pitch", 0.5)), 1, Math.max(1, Hh - 4 - Emin)) : 0;
    const E = Math.max(bh + 3, Hh - 4 - rise);
    const hw = u1 - u0 + 1;
    const pw = hw >= 5 ? clamp(Math.round(hw * 0.5), 3, hw - 2) : Math.max(1, hw - 2);
    const p0 = u0 + Math.floor((hw - pw) / 2);
    const dw = clamp(Math.round(pw * 0.35), 1, 4);
    return { u0, u1, E, rise, p0, p1: p0 + pw - 1, cols: pw >= 5, d0: p0 + Math.floor((pw - dw) / 2), dw, mid: (u0 + u1) >> 1 };
  });

  const m = new VoxelModel(sx, sy, Math.max(...halls.map((h) => h.E + h.rise)) + 4);
  const wall = m.material(ramp("wall"));
  const roof = m.material(ramp("roof"));
  const door = m.material(ramp("door"));
  const opt = (role: string, fallback: number) => {
    const r = ramps(role)[0];
    return r === undefined ? fallback : m.material(r);
  };
  const trim = opt("trim", wall);
  const base = opt("base", trim);
  const ridges = ramps("ridge").map((r) => m.material(r));
  const band = ridges[0] ?? trim;
  const accents = ridges.length > 1 ? ridges.slice(1) : [band];
  const accent = () => accents[Math.floor(rand() * accents.length)]!;

  for (let u = 0; u < W; u++) {
    const i = halls.findIndex((h) => u <= h.u1);
    const h = halls[i]!;
    const gutter = u < h.u0;
    const gable = u === h.u0 || u === h.u1;
    const k = Math.min(u - h.u0, h.u1 - u); // steps in from the nearer gable
    for (let v = 0; v < D; v++) {
      const [x, y] = xy(u, v);
      if (!on[y * sx + x]) continue;
      const set = (z: number, mat: number) => m.set(x, y, z, mat);
      if (v < s) {
        set(0, base);
        continue;
      }
      if (gutter) {
        const Eg = Math.min(h.E, halls[i - 1]!.E);
        for (let z = 0; z < Eg; z++) set(z, z < bh ? base : wall);
        set(Eg, trim);
        continue;
      }
      // every column solid from the ground: the roof steps up from the eaves (e = 0) to the ridge (e = halfE)
      const e = Math.min(v - s, D - 1 - v);
      const top = h.E + (halfE > 0 ? Math.round((e * h.rise) / halfE) : 0);
      for (let z = 0; z <= top; z++) set(z, z < bh ? base : z < h.E || gable ? wall : roof);
      if (gable) set(top + 1, trim);
      if (v === s || v === D - 1) set(h.E - 1, trim); // the eave line
      if (v === s && u >= h.p0 && u <= h.p1) {
        // the porch, flush: its shadow between granite columns, the door, the frieze
        const dh = Math.max(2, h.E - bh - 2);
        for (let z = bh; z < h.E - 1; z++)
          set(z, h.cols && (u === h.p0 || u === h.p1) ? base : u >= h.d0 && u < h.d0 + h.dw && z < bh + dh ? door : trim);
        set(h.E - 1, accent());
      }
      if (!gable && e === halfE) {
        // the ridge: a band, ends that turn up, figures on it and a pearl at its middle
        const up = k === 1 ? 3 : k === 2 ? 2 : 1;
        for (let z = 1; z <= up; z++) set(top + z, band);
        if (u === h.mid) {
          set(top + 2, accents[0]!);
          set(top + 3, accents[0]!);
        } else if (k >= 3 && rand() < 0.55) {
          set(top + 2, accent());
          if (rand() < 0.3) set(top + 3, accent());
        }
      }
    }
  }
  return m;
};

export const TEMPLE_GENERATORS = { chineseTemple };
