import type { Generator } from "./assets";
import { VoxelModel } from "./voxel";

/**
 * Street vehicles (M3.5): props the pipeline stands along rail lines (a cable
 * car, a streetcar). Generic shapes and paint: no lettering, numbers or
 * emblems. Like street lights they keep a fixed voxel size on every level.
 *
 * A vehicle is drawn along +x. With `turn: 1` it lies along the (1, 1)
 * diagonal instead (the pipeline's `.diagonal` groups); instances turn by
 * quarter turns, so the two cover the 8 grid directions a straightened street
 * runs in.
 */

/** What a vehicle puts at (u along, v across, z up) in its own frame, or 0 for nothing. */
type Plan = (u: number, v: number, z: number) => number;

/**
 * A model from a plan `length` × `width` × `height` voxels: as it is, or
 * turned 45° (lying along the (1, 1) diagonal) and sampled at voxel centres.
 */
function layOut(length: number, width: number, height: number, turn: boolean, plan: Plan, materials: number[]): VoxelModel {
  if (!turn) {
    const m = new VoxelModel(length, width, height, materials);
    for (let z = 0; z < height; z++)
      for (let v = 0; v < width; v++) for (let u = 0; u < length; u++) m.set(u, v, z, plan(u, v, z));
    return m;
  }
  // along the diagonal: a voxel at offset (dx, dy) from the centre sits
  // (dx + dy)/√2 along and (dy − dx)/√2 across
  const size = Math.ceil((length + width) / Math.SQRT2) + 2;
  const c = size / 2;
  const m = new VoxelModel(size, size, height, materials);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c;
      const dy = y + 0.5 - c;
      const u = Math.floor((dx + dy) / Math.SQRT2 + length / 2);
      const v = Math.floor((dy - dx) / Math.SQRT2 + width / 2);
      if (u < 0 || v < 0 || u >= length || v >= width) continue;
      for (let z = 0; z < height; z++) m.set(x, y, z, plan(u, v, z));
    }
  return m;
}

/** Material indices for a set of roles, in a shared materials list. */
function palette(roles: Record<string, number>): { materials: number[]; mat: Record<string, number> } {
  const materials = [0];
  const mat: Record<string, number> = {};
  for (const [role, rampId] of Object.entries(roles)) {
    let i = materials.indexOf(rampId, 1);
    if (i < 0) {
      i = materials.length;
      materials.push(rampId);
    }
    mat[role] = i;
  }
  return { materials, mat };
}

/**
 * A cable car: a small boxy car with open ends and an enclosed cabin between
 * them. The open ends have outward-facing benches, corner posts and running
 * boards along both sides, with riders standing on the boards; the cabin has
 * a row of windows; a roof with a raised clerestory covers the whole car.
 * params: length (14), width (4, the body; running boards add one each side),
 * open (3, each open end's length), riders (0.5, the chance of a rider at
 * each open end's side), turn (0).
 * roles: body (lower panels), trim (posts, letterboard), accent (a lining
 * along the cabin), roof, wood (benches, running boards), window, frame (the
 * undercarriage), rider.* (clothes, by seed), skin (riders' heads).
 */
const cableCar: Generator = (ctx) => {
  const { ramp, ramps, param, rand } = ctx;
  const L = Math.max(8, Math.round(param("length", 14)));
  const W = Math.max(3, Math.round(param("width", 4)));
  const open = Math.max(1, Math.min(Math.floor((L - 4) / 2), Math.round(param("open", 3))));
  const H = 8;
  const clothes = ramps("rider");
  const { materials, mat } = palette({
    body: ramp("body"),
    trim: ramp("trim"),
    accent: ramp("accent"),
    roof: ramp("roof"),
    wood: ramp("wood"),
    window: ramp("window"),
    frame: ramp("frame"),
    ...(clothes.length ? { skin: ramp("skin") } : {}),
    ...Object.fromEntries(clothes.map((id, i) => [`rider${i}`, id])),
  });
  const V = W + 2; // running boards outside the body
  // riders on the running boards: (u, v) → their clothes
  const riders = new Map<number, number>();
  if (clothes.length)
    for (const v of [0, V - 1])
      for (const u0 of [0, L - open])
        if (rand() < param("riders", 0.5)) {
          const u = u0 + Math.floor(rand() * open);
          riders.set(u * V + v, mat[`rider${Math.floor(rand() * clothes.length)}`]!);
        }
  const plan: Plan = (u, v, z) => {
    const rider = riders.get(u * V + v);
    if (rider !== undefined && z >= 2 && z <= 4) return z === 4 ? mat.skin! : rider;
    const inBody = v >= 1 && v <= W;
    const side = v === 1 || v === W; // the body's outer columns
    const end = u === 0 || u === L - 1;
    const isOpen = u < open || u >= L - open;
    const corner = (u === 0 || u === open - 1 || u === L - open || u === L - 1) && side;
    switch (z) {
      case 0: // the undercarriage, set in from the ends and sides
        return u >= 1 && u < L - 1 && v >= 2 && v <= W - 1 ? mat.frame! : 0;
      case 1: // the floor; running boards along the open ends
        if (inBody) return mat.body!;
        return isOpen ? mat.wood! : 0;
      case 2: // benches facing out at the open ends, low panels around the cabin
        if (!inBody) return 0;
        if (isOpen) return side ? mat.wood! : end ? mat.body! : 0;
        return side ? mat.accent! : 0;
      case 3:
      case 4: // corner posts at the open ends; the cabin's windows between posts
        if (!inBody) return 0;
        if (isOpen) return corner ? mat.trim! : 0;
        if (u === open || u === L - open - 1) return mat.body!; // the cabin's end walls
        return side ? ((u - open) % 2 === 1 ? mat.window! : mat.trim!) : 0;
      case 5: // the letterboard ring under the roof
        if (!inBody) return 0;
        return side || end || u === open || u === L - open - 1 ? mat.trim! : 0;
      case 6: // the roof, with eaves over the running boards at the open ends
        if (inBody) return mat.roof!;
        return isOpen ? mat.roof! : 0;
      case 7: // a raised clerestory along the middle
        return u >= 1 && u < L - 1 && v >= 2 && v <= W - 1 ? mat.roof! : 0;
      default:
        return 0;
    }
  };
  return layOut(L, V, H, param("turn", 0) >= 1, plan, materials);
};

/**
 * A heritage streetcar: a long car with rounded ends, a lower and an upper
 * colour, a band of large windows, a roof, and a trolley pole raised behind.
 * Its livery is one of the pairs `upper.<k>` / `lower.<k>` (by seed). With
 * `joints` it is an articulated light-rail car: its sections meet at dark
 * bellows, and a pantograph stands on its roof instead of the pole.
 * params: length (22), width (4), joints (0), turn (0).
 * roles: upper.*, lower.* (paired liveries), roof, window, frame (bogies,
 * pole, bellows).
 */
const streetcar: Generator = (ctx) => {
  const { ramp, ramps, param, rand } = ctx;
  const L = Math.max(10, Math.round(param("length", 22)));
  const W = Math.max(3, Math.round(param("width", 4)));
  const joints = Math.max(0, Math.round(param("joints", 0)));
  const H = 10;
  // bellows between sections, evenly along the car
  const joint = (u: number) => {
    for (let j = 1; j <= joints; j++) if (u === Math.round((j * L) / (joints + 1))) return true;
    return false;
  };
  const pantograph = (u: number, z: number) => {
    const u0 = Math.round(L / (2 * (joints + 1))) - 1;
    return (z === 7 && (u === u0 || u === u0 + 2)) || (z === 8 && u === u0 + 1);
  };
  const uppers = ramps("upper");
  const lowers = ramps("lower");
  const k = Math.floor(rand() * Math.min(uppers.length, lowers.length));
  const { materials, mat } = palette({
    upper: uppers[k] ?? ramp("roof"),
    lower: lowers[k] ?? ramp("roof"),
    roof: ramp("roof"),
    window: ramp("window"),
    frame: ramp("frame"),
  });
  const bogie = (u: number) => (u >= 2 && u <= 5) || (u >= L - 6 && u <= L - 3);
  const pole = (u: number, z: number) => {
    // from the roof near the rear, rising toward the front at a shallow angle
    const t = u - 4;
    return t >= 0 && t < 8 && z === 7 + Math.floor(t / 3);
  };
  const plan: Plan = (u, v, z) => {
    const side = v === 0 || v === W - 1;
    const end = u === 0 || u === L - 1;
    const nose = end && side; // rounded ends: the corners are cut
    if (z === 0) return (bogie(u) || joint(u)) && !side ? mat.frame! : 0;
    if (joint(u) && z <= 5) return mat.frame!;
    if (z <= 2) return nose ? 0 : mat.lower!;
    if (z <= 4) {
      if (nose) return 0;
      if (end) return v === Math.floor(W / 2) && z === 4 ? mat.window! : mat.upper!;
      if (!side) return 0;
      // large windows between narrow posts; doors toward each end
      const door = u === 2 || u === L - 3;
      if (door) return mat.window!;
      return (u - 1) % 3 === 0 ? mat.upper! : mat.window!;
    }
    if (z === 5) return nose ? 0 : side || end ? mat.upper! : mat.roof!;
    if (z === 6) {
      if (u === 0 || u === L - 1) return 0;
      return v >= 1 && v <= W - 2 ? mat.roof! : u >= 2 && u <= L - 3 ? mat.roof! : 0;
    }
    // the trolley pole along the middle, or a pantograph across the roof
    if (joints > 0) return pantograph(u, z) && v >= 1 && v <= W - 2 ? mat.frame! : 0;
    return v === Math.floor(W / 2) && pole(u, z) ? mat.frame! : 0;
  };
  return layOut(L, W, H, param("turn", 0) >= 1, plan, materials);
};

export const VEHICLE_GENERATORS: Record<string, Generator> = { cableCar, streetcar };
