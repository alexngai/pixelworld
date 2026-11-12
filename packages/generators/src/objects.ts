import { DIRECT_RAMP_BASE, FACE_OBJECT, MeshBuilder, type MeshData } from "./mesh";
import type { VoxelModel, VoxelScale } from "./voxel";

/** Axis-aligned box in object-local grid space (cells, cells, steps). */
export interface Box {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  ramp: number; // ramp id in the palette
  /** Turn about the vertical axis through the origin (radians, x toward y); vehicles. */
  rot?: number;
  /**
   * Tilt before the turn, about a point on the vertical axis at height `pivot`
   * (steps): `roll` about x (radians, +y down) then `pitch` about y (radians,
   * +x up); a plane banking and climbing. In cubic voxels (VOXEL: a cell is
   * as wide as 2 steps are tall).
   */
  pitch?: number;
  roll?: number;
  pivot?: number;
}

/** Steps as tall as a cell is wide, in cubic voxels: for tilting. */
const STEPS_PER_CELL = 2;

/** Closed boxes as a mesh (all six faces; the depth test hides the rest). */
export function buildBoxesMesh(boxes: Box[]): MeshData {
  const mb = new MeshBuilder();
  for (const b of boxes) {
    const mat = DIRECT_RAMP_BASE + b.ramp;
    const cos = Math.cos(b.rot ?? 0);
    const sin = Math.sin(b.rot ?? 0);
    const tilted = !!(b.pitch || b.roll);
    const cp = Math.cos(b.pitch ?? 0);
    const sp = Math.sin(b.pitch ?? 0);
    const cr = Math.cos(b.roll ?? 0);
    const sr = Math.sin(b.roll ?? 0);
    const pivot = b.pivot ?? 0;
    // roll, then pitch, about the pivot (in cubic units); a normal turns without the shift
    const tilt = (v: [number, number, number], normal: boolean): [number, number, number] => {
      if (!tilted) return v;
      const z = normal ? v[2] : (v[2] - pivot) / STEPS_PER_CELL;
      const y1 = v[1] * cr + z * sr;
      const z1 = -v[1] * sr + z * cr;
      const x2 = v[0] * cp - z1 * sp;
      const z2 = v[0] * sp + z1 * cp;
      return [x2, y1, normal ? z2 : z2 * STEPS_PER_CELL + pivot];
    };
    const turn = (v: [number, number, number], normal = false): [number, number, number] => {
      const t = tilt(v, normal);
      return b.rot ? [t[0] * cos - t[1] * sin, t[0] * sin + t[1] * cos, t[2]] : t;
    };
    const quad = (
      a: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
      e: [number, number, number],
      n: [number, number, number],
    ) => {
      for (const v of [a, c, d, a, d, e]) mb.vertex(turn(v), turn(n, true), mat, FACE_OBJECT, 1, 0, 0);
    };
    const { x0, y0, z0, x1, y1, z1 } = b;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
    quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [-1, 0, 0]);
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  }
  return mb.build();
}

/** M0 placeholder vehicle: a small rover with a cab, centred on the origin. */
export function roverBoxes(bodyRamp: number, cabRamp: number): Box[] {
  return [
    { x0: -0.375, y0: -0.25, z0: 0, x1: 0.375, y1: 0.25, z1: 0.75, ramp: bodyRamp },
    { x0: -0.125, y0: -0.25, z0: 0.75, x1: 0.25, y1: 0.25, z1: 1.5, ramp: cabRamp },
  ];
}

/**
 * A voxel model as boxes, for sprites baked from boxes (traffic vehicles,
 * D-064): runs of one material along x merge, and equal runs in neighbouring
 * rows merge across y. The model is centred on the origin and stands on z = 0;
 * `rot` turns every box with it.
 */
export function modelBoxes(model: VoxelModel, voxel: VoxelScale, rot = 0): Box[] {
  const out: Box[] = [];
  const ox = (model.sx * voxel.h) / 2;
  const oy = (model.sy * voxel.h) / 2;
  for (let z = 0; z < model.sz; z++) {
    let open = new Map<string, Box>();
    for (let y = 0; y < model.sy; y++) {
      const next = new Map<string, Box>();
      for (let x = 0; x < model.sx; ) {
        const m = model.get(x, y, z);
        if (!m) {
          x++;
          continue;
        }
        let x1 = x + 1;
        while (x1 < model.sx && model.get(x1, y, z) === m) x1++;
        const key = `${x},${x1},${m}`;
        const prev = open.get(key);
        if (prev) prev.y1 = (y + 1) * voxel.h - oy;
        const b = prev ?? {
          x0: x * voxel.h - ox,
          x1: x1 * voxel.h - ox,
          y0: y * voxel.h - oy,
          y1: (y + 1) * voxel.h - oy,
          z0: z * voxel.v,
          z1: (z + 1) * voxel.v,
          ramp: model.materials[m]!,
          rot,
        };
        if (!prev) out.push(b);
        next.set(key, b);
        x = x1;
      }
      open = next;
    }
  }
  return out;
}
