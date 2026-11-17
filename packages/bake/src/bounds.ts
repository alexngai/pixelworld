import { DEPTH_PER_STEP, HALF_H, HALF_W, STEP_PX, STEP_WORLD, rotateXY, type Rotation } from "@pixelworlds/grid";
import { forEachFieldPoint, type CellRect, type InstancedBatch, type MeshData, type TerrainField } from "@pixelworlds/generators";

/**
 * What a bake draws: plain meshes, instanced batches of repeated objects, and
 * micro-terrain fields whose geometry the GPU builds.
 */
export interface BakeScene {
  meshes: MeshData[];
  batches: InstancedBatch[];
  fields?: TerrainField[];
}

export function asScene(s: MeshData | BakeScene): BakeScene {
  return "meshes" in s ? s : { meshes: [s], batches: [] };
}

/**
 * Visit every point that bounds the scene: mesh vertices, and the bounding-box
 * corners of each instance. fn receives (x, y, h, cellX, cellY).
 */
export function forEachScenePoint(
  scene: BakeScene,
  fn: (x: number, y: number, h: number, cx: number, cy: number) => void,
): void {
  for (const mesh of scene.meshes)
    for (let v = 0; v < mesh.vertexCount; v++)
      fn(mesh.position[v * 3]!, mesh.position[v * 3 + 1]!, mesh.position[v * 3 + 2]!, mesh.cell[v * 2]!, mesh.cell[v * 2 + 1]!);
  for (const b of scene.batches) {
    const p = b.mesh.position;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!);
      z0 = Math.min(z0, p[i + 2]!); z1 = Math.max(z1, p[i + 2]!);
    }
    for (let k = 0; k < b.offsets.length / 3; k++) {
      const ox = b.offsets[k * 3]!, oy = b.offsets[k * 3 + 1]!, oz = b.offsets[k * 3 + 2]!;
      const cx = b.cells[k * 2]!, cy = b.cells[k * 2 + 1]!;
      for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) fn(ox + x, oy + y, oz + z, cx, cy);
    }
  }
  for (const f of scene.fields ?? []) forEachFieldPoint(f, fn);
}

export interface ScreenBounds {
  minSx: number;
  maxSx: number;
  minSy: number;
  maxSy: number;
  minDepth: number;
  maxDepth: number;
}

export type Ownership = CellRect | "all";

function owns(owned: Ownership, cx: number, cy: number): boolean {
  return owned === "all" || (cx >= owned.x0 && cx < owned.x1 && cy >= owned.y0 && cy < owned.y1);
}

/**
 * How a bake lays the world out (D-155): screen x, screen y and depth (larger
 * nearer) as linear in a point's rotated (u, v) and height h (steps).
 */
export interface Projection {
  x: readonly [number, number, number];
  y: readonly [number, number, number];
  d: readonly [number, number, number];
}

/** The world's 2:1 view: sx = 16(u − v), sy = 8(u + v) − 8h, depth = u + v + h/3. */
export const ISO_PROJECTION: Projection = {
  x: [HALF_W, -HALF_W, 0],
  y: [HALF_H, HALF_H, -STEP_PX],
  d: [1, 1, DEPTH_PER_STEP],
};

/**
 * From above (D-155): `px` screen px per render cell, north up, the roofs
 * nearest; `tilt` px of a south wall per step (0 straight down, a little to
 * see the walls).
 */
export function topDownProjection(px: number, tilt = 0): Projection {
  return { x: [px, 0, 0], y: [0, px, -tilt], d: [0, tilt / (3 * px), DEPTH_PER_STEP] };
}

/** Screen-space bounds and depth range of the scene points selected by `owned`. */
export function screenBounds(
  scene: MeshData | BakeScene,
  r: Rotation,
  owned: Ownership,
  p: Projection = ISO_PROJECTION,
): ScreenBounds | null {
  const b: ScreenBounds = {
    minSx: Infinity,
    maxSx: -Infinity,
    minSy: Infinity,
    maxSy: -Infinity,
    minDepth: Infinity,
    maxDepth: -Infinity,
  };
  let any = false;
  forEachScenePoint(asScene(scene), (x, y, h, cx, cy) => {
    if (!owns(owned, cx, cy)) return;
    any = true;
    const [u, w] = rotateXY(x, y, r);
    const sx = p.x[0] * u + p.x[1] * w + p.x[2] * h;
    const sy = p.y[0] * u + p.y[1] * w + p.y[2] * h;
    const d = p.d[0] * u + p.d[1] * w + p.d[2] * h;
    if (sx < b.minSx) b.minSx = sx;
    if (sx > b.maxSx) b.maxSx = sx;
    if (sy < b.minSy) b.minSy = sy;
    if (sy > b.maxSy) b.maxSy = sy;
    if (d < b.minDepth) b.minDepth = d;
    if (d > b.maxDepth) b.maxDepth = d;
  });
  return any ? b : null;
}

/** Integer pixel rectangle covering the bounds. */
export function pixelRect(b: ScreenBounds): { left: number; top: number; width: number; height: number } {
  const left = Math.floor(b.minSx);
  const top = Math.floor(b.minSy);
  return { left, top, width: Math.ceil(b.maxSx) - left, height: Math.ceil(b.maxSy) - top };
}

export interface LightBasis {
  sun: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
}

export function lightBasis(sun: readonly [number, number, number]): LightBasis {
  const s: [number, number, number] = [sun[0], sun[1], sun[2]];
  // right = normalize(cross(zUp, sun)); up = cross(sun, right)
  let rx = -s[1];
  let ry = s[0];
  const rl = Math.hypot(rx, ry) || 1;
  rx /= rl;
  ry /= rl;
  const right: [number, number, number] = [rx, ry, 0];
  const up: [number, number, number] = [
    s[1] * 0 - s[2] * ry,
    s[2] * rx - s[0] * 0,
    s[0] * ry - s[1] * rx,
  ];
  return { sun: s, right, up };
}

export interface LightBounds {
  /** minX, minY, maxX, maxY of receivers in light space. */
  rect: [number, number, number, number];
  /** min/max distance toward the sun over all casters. */
  depth: [number, number];
}

/**
 * Light-space bounds: the XY extent only needs to cover the receivers (owned
 * vertices), because with an orthographic light nothing outside that column
 * can shadow them; the depth range must include every caster.
 */
export function lightBounds(
  scene: MeshData | BakeScene,
  r: Rotation,
  owned: Ownership,
  basis: LightBasis,
  pad = 0.5,
): LightBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minT = Infinity;
  let maxT = -Infinity;
  forEachScenePoint(asScene(scene), (x, y, h, cx, cy) => {
    const [u, w] = rotateXY(x, y, r);
    const z = h * STEP_WORLD;
    const t = u * basis.sun[0] + w * basis.sun[1] + z * basis.sun[2];
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (!owns(owned, cx, cy)) return;
    const lx = u * basis.right[0] + w * basis.right[1] + z * basis.right[2];
    const ly = u * basis.up[0] + w * basis.up[1] + z * basis.up[2];
    if (lx < minX) minX = lx;
    if (lx > maxX) maxX = lx;
    if (ly < minY) minY = ly;
    if (ly > maxY) maxY = ly;
  });
  return {
    rect: [minX - pad, minY - pad, maxX + pad, maxY + pad],
    depth: [minT - 0.5, maxT + 0.5],
  };
}
