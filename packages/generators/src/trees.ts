import type { Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Broadleaf trees (M3.5): a round, full crown on a short trunk, the shape of
 * a city's street and backyard trees (plane trees, ficus, brisbane box) from
 * above. A crown is a dome of a few overlapping lobes, wider than it is tall,
 * so it reads as a canopy rather than a ball on a stick (a palm). Like all
 * vegetation it keeps a fixed voxel size on every level.
 *
 * Params (voxels): `radius` (+ up to `radiusJitter`) the crown's half-width,
 * `height` its half-height, `trunk` the bare trunk under it, `lobes` how many
 * bulges round its edge, `holes` the share of the crown's skin left open.
 */
export const TREE_GENERATORS: Record<string, Generator> = {
  roundTree: ({ rand, ramp, param }) => {
    const r = param("radius", 2) + rand() * param("radiusJitter", 0.5);
    const rz = param("height", 1.5) + rand() * 0.3;
    const trunkH = Math.max(0, Math.round(param("trunk", 1)));
    const nLobes = Math.max(0, Math.round(param("lobes", 4)));
    const holes = param("holes", 0.06);
    // lobes bulge the crown's edge: about half way out, a little lower or higher
    const turn = rand() * Math.PI * 2;
    const lobes: [number, number, number, number, number][] = [[0, 0, 0, r, rz]];
    for (let i = 0; i < nLobes; i++) {
      const a = turn + (i / nLobes) * Math.PI * 2 + (rand() - 0.5) * 0.8;
      const d = r * (0.45 + rand() * 0.2);
      lobes.push([Math.cos(a) * d, Math.sin(a) * d, (rand() - 0.6) * rz * 0.5, r * 0.62, rz * 0.75]);
    }
    const reach = Math.max(...lobes.map(([x, y, , lr]) => Math.hypot(x, y) + lr));
    const half = Math.max(1, Math.ceil(reach - 0.5));
    const size = 2 * half + 1;
    const zc = trunkH + rz; // the crown's centre: its bottom sits on the trunk
    const m = new VoxelModel(size, size, Math.ceil(zc + rz) + 1);
    const body = m.material(ramp("body"));
    const inCrown = (x: number, y: number, z: number) => {
      if (z < trunkH) return false;
      const px = x - half;
      const py = y - half;
      const pz = z + 0.5 - zc;
      return lobes.some(([lx, ly, lz, lr, lh]) => ((px - lx) / lr) ** 2 + ((py - ly) / lr) ** 2 + ((pz - lz) / lh) ** 2 <= 1);
    };
    for (let z = 0; z < m.sz; z++)
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (inCrown(x, y, z)) m.set(x, y, z, body);
    // gaps in the skin only (an inner voxel shows through, a shade apart), never the top's middle
    const skin = (x: number, y: number, z: number) =>
      !m.get(x + 1, y, z) || !m.get(x - 1, y, z) || !m.get(x, y + 1, z) || !m.get(x, y - 1, z) || !m.get(x, y, z + 1);
    const open: [number, number, number][] = [];
    for (let z = 0; z < m.sz; z++)
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          if (m.get(x, y, z) && skin(x, y, z) && Math.hypot(x - half, y - half) > 1 && rand() < holes) open.push([x, y, z]);
    for (const [x, y, z] of open) m.set(x, y, z, 0);
    if (trunkH > 0) {
      const trunk = m.material(ramp("trunk"));
      for (let z = 0; z < trunkH; z++) m.set(half, half, z, trunk);
    }
    if (!m.count()) m.set(half, half, trunkH, body);
    return m;
  },
};
