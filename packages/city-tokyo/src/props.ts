import { VoxelModel, type Generator } from "pixelworld/generators";

/**
 * Utility poles and their wires over a residential street (D-092): placed
 * across the road (`streetProps` with `across: true`), so the model's x runs
 * across the street and its y along it, one pole a model, `length` voxels
 * apart. The pole stands at one kerb; a crossarm carries the power line, a
 * lower arm stands under it, and the telephone cable hangs below them;
 * each line sags to its lowest midway between poles, which is
 * where one model meets the next, so a straight street's lines run unbroken
 * from pole to pole. A transformer on some poles. Wires and arms overhang,
 * as the strung lanterns' wire does: a prop, not a building.
 * With `wires: 0` it is the pole alone, in the middle of a small model,
 * for streets whose wires are spans of their own (`wireSpan`, D-095).
 * params: span (voxels across the street; 12), length (voxels between poles;
 * 48, 30 m at the walking level), height (the pole's voxels; 26), sag (2),
 * transformer (the share of poles with one; 0.3), cable (0: no telephone
 * cable), wires (0: none).
 * roles: pole, wire, box (the transformer; pole if absent).
 */
export const utilityPoles: Generator = ({ rand, ramp, ramps, param }) => {
  const S = Math.max(5, Math.round(param("span", 12)));
  const L = Math.max(6, Math.round(param("length", 48)));
  const h = Math.max(8, Math.round(param("height", 26)));
  const sag = Math.max(0, Math.round(param("sag", 2)));
  const m = new VoxelModel(S, L, h + 1);
  const pole = m.material(ramp("pole"));
  const wire = m.material(ramp("wire"));
  const can = m.material(ramps("box")[0] ?? ramp("pole"));
  const wires = param("wires", 1) > 0;
  const px = wires ? S - 2 : Math.floor(S / 2);
  const py = Math.floor(L / 2);
  for (let z = 0; z < h; z++) m.set(px, py, z, pole);
  // the crossarm, across the street at the top; the low-voltage arm below it
  const zTop = h - 2;
  const zLow = h - 6;
  for (let x = px - 2; x <= px + 1; x++) m.set(x, py, zTop, pole);
  for (let x = px - 1; x <= px; x++) m.set(x, py, zLow, pole);
  // the lines along the street, lowest where they meet the next pole's
  const line = (x: number, z0: number) => {
    const zAt = (y: number) => z0 - Math.round(sag * ((y - py) / (L / 2)) ** 2);
    for (let y = 0; y < L; y++) {
      const z = zAt(y);
      const prev = y > 0 ? zAt(y - 1) : z;
      for (let zz = Math.min(z, prev); zz <= Math.max(z, prev); zz++) if (zz >= 0 && !m.get(x, y, zz)) m.set(x, y, zz, wire);
    }
  };
  // the power line from the crossarm's end, and the telephone cable lower down the pole
  if (wires) line(px - 2, zTop + 1);
  if (wires && param("cable", 1) > 0) line(px, Math.round(h * 0.55));
  // a transformer hung on the pole, on the street's side
  if (rand() < param("transformer", 0.3)) for (let z = zLow - 5; z < zLow - 1; z++) for (const y of [py - 1, py]) m.set(px - 1, y, z, can);
  return m;
};

/**
 * A wire's span from one utility pole to the next (D-095): a line object
 * (`frame.line`, its ends the poles' positions) drawn at any angle, a voxel
 * thick: from `height` voxels over the ground at one pole to the same over
 * the ground at the other, sagging between them. The pipeline places it
 * with the poles (`streetProps` with `wires`). A prop, not a building: it
 * hangs over the street.
 * params: height (voxels over the ground at each end; 25, a voxel over
 * `utilityPoles`' crossarm at its default height), sag (2).
 * roles: wire.
 */
export const wireSpan: Generator = ({ mask, frame, param, ramp }) => {
  if (!mask || !frame?.line) throw new Error("wireSpan needs a line object's footprint and frame");
  const h = Math.max(2, Math.round(param("height", 25)));
  const sag = Math.max(0, param("sag", 2));
  const { a, b } = frame.line;
  const [ra, rb] = frame.line.rise ?? [0, 0];
  const v = frame.voxel;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const ux = (b[0] - a[0]) / Math.max(len, 1e-9);
  const uy = (b[1] - a[1]) / Math.max(len, 1e-9);
  const major = Math.max(Math.abs(ux), Math.abs(uy));
  const zAt = (t: number) => ra + (rb - ra) * t + h - sag * 4 * t * (1 - t);
  const m = new VoxelModel(mask.sx, mask.sy, Math.ceil(Math.max(ra, rb, 0)) + h + 2);
  const wire = m.material(ramp("wire"));
  // half a column's step along the line, as a share of it: each column draws the wire from there to there
  const dt = (0.5 * v) / major / Math.max(len, 1e-9);
  for (let j = 0; j < mask.sy; j++)
    for (let i = 0; i < mask.sx; i++) {
      if (!mask.on[j * mask.sx + i]) continue;
      const px = frame.x0 + (i + 0.5) * v - a[0];
      const py = frame.y0 + (j + 0.5) * v - a[1];
      // one column per step along the line's major axis: a line a voxel thick (half-open, so a
      // line on a row boundary takes one row, not both)
      const across = px * uy - py * ux;
      if (across <= -0.5 * v * major || across > 0.5 * v * major) continue;
      const t = Math.min(1, Math.max(0, (px * ux + py * uy) / Math.max(len, 1e-9)));
      const z0 = zAt(Math.max(0, t - dt));
      const z1 = zAt(Math.min(1, t + dt));
      for (let z = Math.round(Math.min(z0, z1)); z <= Math.round(Math.max(z0, z1)); z++) if (z >= 0 && z < m.sz) m.set(i, j, z, wire);
    }
  return m;
};

export const PROP_GENERATORS: Record<string, Generator> = { utilityPoles, wireSpan };
