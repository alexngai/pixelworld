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
 * for streets whose wires are spans of their own (`wireSpan`, D-098).
 * params: span (voxels across the street; 12), length (voxels between poles;
 * 48, 30 m at the walking level), height (the pole's voxels; 26), sag (2),
 * transformer (the share of poles with one; 0.3), cable (0: no telephone
 * cable), wires (0: none), lines (1: the arms and wires one-pixel lines,
 * D-098, and a stay wire on some poles; 0), stay (the share of poles with
 * one; 0.35).
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
  const thin = param("lines", 0) > 0;
  if (thin) {
    // one-pixel lines (D-098): the arms, and on some poles a stay wire down to the ground along the street
    m.line([px - 2, py + 0.5, zTop + 0.5], [px + 2, py + 0.5, zTop + 0.5], pole);
    m.line([px - 1, py + 0.5, zLow + 0.5], [px + 1, py + 0.5, zLow + 0.5], pole);
    if (rand() < param("stay", 0.35)) m.line([px + 0.5, py + 0.5, zLow], [px + 0.5, py + 0.5 + Math.round(h * 0.3), 0], wire);
  } else {
    for (let x = px - 2; x <= px + 1; x++) m.set(x, py, zTop, pole);
    for (let x = px - 1; x <= px; x++) m.set(x, py, zLow, pole);
  }
  // the lines along the street, lowest where they meet the next pole's
  const line = (x: number, z0: number) => {
    const zAt = (y: number) => z0 - Math.round(sag * ((y - py) / (L / 2)) ** 2);
    if (thin) {
      const zf = (y: number) => z0 + 0.5 - sag * ((y - py) / (L / 2)) ** 2;
      for (let y = 1; y <= L; y++) m.line([x + 0.5, y - 1, zf(y - 1)], [x + 0.5, y, zf(y)], wire);
      return;
    }
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
 * A wire's span from one utility pole to the next (D-098): a line object
 * (`frame.line`, its ends the poles' positions) drawn as a one-pixel line
 * (VoxelModel.lines) at any angle: from `height` voxels over the ground at
 * one pole to the same over the ground at the other, sagging between them in
 * short straight pieces. The pipeline places it with the poles
 * (`streetProps` with `wires`). A prop, not a building: it hangs over the
 * street.
 * params: height (voxels over the ground at each end; 25, a voxel over
 * `utilityPoles`' crossarm at its default height), sag (2).
 * roles: wire.
 */
export const wireSpan: Generator = ({ mask, frame, param, ramp }) => {
  if (!mask || !frame?.line) throw new Error("wireSpan needs a line object's footprint and frame");
  const h = Math.max(2, param("height", 25));
  const sag = Math.max(0, param("sag", 2));
  const { a, b } = frame.line;
  const [ra, rb] = frame.line.rise ?? [0, 0];
  const v = frame.voxel;
  const m = new VoxelModel(mask.sx, mask.sy, Math.ceil(Math.max(ra, rb, 0) + h) + 1);
  const wire = m.material(ramp("wire"));
  // in the model's voxels: x and y from the frame's corner, z over the object's base
  const at = (t: number): [number, number, number] => [
    (a[0] + (b[0] - a[0]) * t - frame.x0) / v,
    (a[1] + (b[1] - a[1]) * t - frame.y0) / v,
    ra + (rb - ra) * t + h - sag * 4 * t * (1 - t),
  ];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) / v;
  const n = Math.max(2, Math.ceil(len / 6)); // a piece every six voxels or so
  for (let k = 0; k < n; k++) m.line(at(k / n), at((k + 1) / n), wire);
  return m;
};

export const PROP_GENERATORS: Record<string, Generator> = { utilityPoles, wireSpan };
