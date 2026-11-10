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
}

/** Closed boxes as a mesh (all six faces; the depth test hides the rest). */
export function buildBoxesMesh(boxes: Box[]): MeshData {
  const mb = new MeshBuilder();
  for (const b of boxes) {
    const mat = DIRECT_RAMP_BASE + b.ramp;
    const cos = Math.cos(b.rot ?? 0);
    const sin = Math.sin(b.rot ?? 0);
    const turn = (v: [number, number, number]): [number, number, number] =>
      b.rot ? [v[0] * cos - v[1] * sin, v[0] * sin + v[1] * cos, v[2]] : v;
    const quad = (
      a: [number, number, number],
      c: [number, number, number],
      d: [number, number, number],
      e: [number, number, number],
      n: [number, number, number],
    ) => {
      for (const v of [a, c, d, a, d, e]) mb.vertex(turn(v), turn(n), mat, FACE_OBJECT, 1, 0, 0);
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
