import { DEPTH_PER_STEP, HALF_H, HALF_W, STEP_PX, STEP_WORLD, rotateXY, type Rotation } from "@pixelworld/grid";
import type { CellRect, MeshData } from "@pixelworld/generators";

export interface ScreenBounds {
  minSx: number;
  maxSx: number;
  minSy: number;
  maxSy: number;
  minDepth: number;
  maxDepth: number;
}

export type Ownership = CellRect | "all";

function isOwned(mesh: MeshData, v: number, owned: Ownership): boolean {
  if (owned === "all") return true;
  const cx = mesh.cell[v * 2]!;
  const cy = mesh.cell[v * 2 + 1]!;
  return cx >= owned.x0 && cx < owned.x1 && cy >= owned.y0 && cy < owned.y1;
}

/** Screen-space bounds and depth range of the vertices selected by `owned`. */
export function screenBounds(mesh: MeshData, r: Rotation, owned: Ownership): ScreenBounds | null {
  const b: ScreenBounds = {
    minSx: Infinity,
    maxSx: -Infinity,
    minSy: Infinity,
    maxSy: -Infinity,
    minDepth: Infinity,
    maxDepth: -Infinity,
  };
  let any = false;
  for (let v = 0; v < mesh.vertexCount; v++) {
    if (!isOwned(mesh, v, owned)) continue;
    any = true;
    const [u, w] = rotateXY(mesh.position[v * 3]!, mesh.position[v * 3 + 1]!, r);
    const h = mesh.position[v * 3 + 2]!;
    const sx = HALF_W * (u - w);
    const sy = HALF_H * (u + w) - STEP_PX * h;
    const d = u + w + h * DEPTH_PER_STEP;
    if (sx < b.minSx) b.minSx = sx;
    if (sx > b.maxSx) b.maxSx = sx;
    if (sy < b.minSy) b.minSy = sy;
    if (sy > b.maxSy) b.maxSy = sy;
    if (d < b.minDepth) b.minDepth = d;
    if (d > b.maxDepth) b.maxDepth = d;
  }
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
  mesh: MeshData,
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
  for (let v = 0; v < mesh.vertexCount; v++) {
    const [u, w] = rotateXY(mesh.position[v * 3]!, mesh.position[v * 3 + 1]!, r);
    const z = mesh.position[v * 3 + 2]! * STEP_WORLD;
    const t = u * basis.sun[0] + w * basis.sun[1] + z * basis.sun[2];
    if (t < minT) minT = t;
    if (t > maxT) maxT = t;
    if (!isOwned(mesh, v, owned)) continue;
    const lx = u * basis.right[0] + w * basis.right[1] + z * basis.right[2];
    const ly = u * basis.up[0] + w * basis.up[1] + z * basis.up[2];
    if (lx < minX) minX = lx;
    if (lx > maxX) maxX = lx;
    if (ly < minY) minY = ly;
    if (ly > maxY) maxY = ly;
  }
  return {
    rect: [minX - pad, minY - pad, maxX + pad, maxY + pad],
    depth: [minT - 0.5, maxT + 0.5],
  };
}
