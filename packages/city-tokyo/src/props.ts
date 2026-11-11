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
 * params: span (voxels across the street; 12), length (voxels between poles;
 * 48, 30 m at the walking level), height (the pole's voxels; 26), sag (2),
 * transformer (the share of poles with one; 0.3), cable (0: no telephone
 * cable).
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
  const px = S - 2;
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
  line(px - 2, zTop + 1);
  if (param("cable", 1) > 0) line(px, Math.round(h * 0.55));
  // a transformer hung on the pole, on the street's side
  if (rand() < param("transformer", 0.3)) for (let z = zLow - 5; z < zLow - 1; z++) for (const y of [py - 1, py]) m.set(px - 1, y, z, can);
  return m;
};

export const PROP_GENERATORS: Record<string, Generator> = { utilityPoles };
