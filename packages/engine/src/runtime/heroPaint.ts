import type { BakedImage } from "@pixelworlds/bake";
import { ISO_PROJECTION, projectionInverse, projectionKey, type Projection, type Rotation } from "@pixelworlds/grid";

/**
 * A painted-over hero landmark for one rotation (M3, D-053). `bake` is the
 * landmark baked alone offline (RGBA: palette index, depth hi, depth lo,
 * coverage), `paint` an artist's indexed image of the same size (0 = keep the
 * baked pixel). Both sit at absolute screen pixels (left, top) of the rotation.
 */
export interface HeroPaint {
  id: string;
  rotation: Rotation;
  left: number;
  top: number;
  width: number;
  height: number;
  depthBase: number;
  bake: Uint8Array;
  paint: Uint8Array;
}

/** Depths closer than this (world depth units, 1/256 each) count as the same surface. */
const SAME_SURFACE = 3 / 256;

const depthAt = (px: Uint8Array, i: number, base: number) => base + (px[i * 4 + 1]! * 256 + px[i * 4 + 2]!) / 256;

/**
 * Stamp painted hero pixels into a freshly baked tile, in place. A painted
 * pixel on the hero's silhouette replaces the tile pixel only where the tile
 * shows the hero there (same depth), so anything in front still occludes it.
 * Pixels painted beyond the silhouette land on background or on what lies
 * behind the hero. Returns how many pixels changed.
 */
export function applyHeroPaint(img: BakedImage, rotation: Rotation, heroes: readonly HeroPaint[]): number {
  let changed = 0;
  for (const h of heroes) {
    if (h.rotation !== rotation) continue;
    const x0 = Math.max(img.left, h.left);
    const y0 = Math.max(img.top, h.top);
    const x1 = Math.min(img.left + img.width, h.left + h.width);
    const y1 = Math.min(img.top + img.height, h.top + h.height);
    if (x1 <= x0 || y1 <= y0) continue;
    let nearest = Infinity;
    for (let i = 0; i < h.width * h.height; i++) if (h.bake[i * 4 + 3]) nearest = Math.min(nearest, depthAt(h.bake, i, h.depthBase));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const hp = (y - h.top) * h.width + (x - h.left);
        const p = h.paint[hp]!;
        if (!p) continue;
        const ip = (y - img.top) * img.width + (x - img.left);
        const covered = img.pixels[ip * 4 + 3]! > 0;
        let apply: boolean;
        if (h.bake[hp * 4 + 3]) {
          apply = covered && Math.abs(depthAt(img.pixels, ip, img.depthBase) - depthAt(h.bake, hp, h.depthBase)) <= SAME_SURFACE;
        } else {
          apply = !covered || depthAt(img.pixels, ip, img.depthBase) < nearest - SAME_SURFACE;
        }
        if (!apply || img.pixels[ip * 4] === p) continue;
        img.pixels[ip * 4] = p;
        if (!covered) img.pixels[ip * 4 + 3] = 255;
        changed++;
      }
  }
  return changed;
}

/**
 * Depth within one pixel of the 2:1 bake: across a pixel of a roof or a wall
 * the surface's depth changes by up to ±1/16, so a point resampled from
 * another projection matches its pixel's centre within this (D-196).
 */
const RESAMPLED_SURFACE = 26 / 256;
/** How far (2:1 px) paint beyond the silhouette looks for the silhouette pixel whose depth places it. */
const BEYOND_REACH = 4;

/** A hero as another projection draws it (D-196). */
interface Placed {
  /** Its silhouette there: absolute screen px, the end exclusive, a pixel wider each way. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Its farthest depth there. */
  farthest: number;
  /** Paint beyond the silhouette, placed there: x, y and the index, in threes. */
  beyond: number[];
}

const placedFor = new WeakMap<HeroPaint, Map<string, Placed>>();

/** The view point (u, v, h) a screen point and depth of the 2:1 view show. */
const isoInverse = projectionInverse(ISO_PROJECTION);
function viewPoint(m: readonly number[], sx: number, sy: number, d: number): [number, number, number] {
  return [m[0]! * sx + m[3]! * sy + m[6]! * d, m[1]! * sx + m[4]! * sy + m[7]! * d, m[2]! * sx + m[5]! * sy + m[8]! * d];
}
const dot = (r: readonly [number, number, number], q: readonly [number, number, number]) => r[0] * q[0] + r[1] * q[1] + r[2] * q[2];

function place(h: HeroPaint, p: Projection): Placed {
  const key = projectionKey(p);
  let byProjection = placedFor.get(h);
  const known = byProjection?.get(key);
  if (known) return known;
  let [x0, y0, x1, y1, farthest] = [Infinity, Infinity, -Infinity, -Infinity, Infinity];
  const at = (x: number, y: number, d: number) => {
    const q = viewPoint(isoInverse, h.left + x + 0.5, h.top + y + 0.5, d);
    return [dot(p.x, q), dot(p.y, q), dot(p.d, q)] as const;
  };
  const covered = (x: number, y: number) => x >= 0 && y >= 0 && x < h.width && y < h.height && h.bake[(y * h.width + x) * 4 + 3]! > 0;
  for (let y = 0; y < h.height; y++)
    for (let x = 0; x < h.width; x++) {
      if (!covered(x, y)) continue;
      const [sx, sy, d] = at(x, y, depthAt(h.bake, y * h.width + x, h.depthBase));
      [x0, y0, x1, y1] = [Math.min(x0, sx), Math.min(y0, sy), Math.max(x1, sx), Math.max(y1, sy)];
      farthest = Math.min(farthest, d);
    }
  // paint beyond the silhouette (a beacon, an outline): at the depth of the silhouette pixel nearest it
  const beyond: number[] = [];
  for (let y = 0; y < h.height; y++)
    for (let x = 0; x < h.width; x++) {
      const paint = h.paint[y * h.width + x]!;
      if (!paint || covered(x, y)) continue;
      let d: number | null = null;
      for (let r = 1; r <= BEYOND_REACH && d === null; r++)
        for (let j = -r; j <= r && d === null; j++)
          for (let i = -r; i <= r; i++)
            if ((Math.abs(i) === r || Math.abs(j) === r) && covered(x + i, y + j)) {
              d = depthAt(h.bake, (y + j) * h.width + x + i, h.depthBase);
              break;
            }
      if (d === null) continue;
      const [sx, sy] = at(x, y, d);
      beyond.push(Math.floor(sx), Math.floor(sy), paint);
    }
  const placed: Placed = { x0: Math.floor(x0) - 1, y0: Math.floor(y0) - 1, x1: Math.floor(x1) + 2, y1: Math.floor(y1) + 2, farthest, beyond };
  if (!byProjection) placedFor.set(h, (byProjection = new Map()));
  byProjection.set(key, placed);
  return placed;
}

/**
 * Stamp painted hero pixels into a tile baked in another projection (D-196),
 * in place: the paint is made for the 2:1 view, so it is resampled. Each
 * pixel of the tile gives a point in the world (its screen position and depth,
 * the projection inverted); where the hero's 2:1 bake shows that same point,
 * its paint there is taken. What the 2:1 view never saw has no paint, and
 * anything in front of the hero still hides it. Paint beyond the silhouette
 * is placed at the depth of the silhouette pixel nearest it, onto background
 * or what lies behind the hero, as `applyHeroPaint` does. Returns how many
 * pixels changed.
 */
export function applyHeroPaintReprojected(img: BakedImage, rotation: Rotation, heroes: readonly HeroPaint[], p: Projection): number {
  const inverse = projectionInverse(p);
  let changed = 0;
  for (const h of heroes) {
    if (h.rotation !== rotation) continue;
    const at = place(h, p);
    const X0 = Math.max(img.left, at.x0);
    const Y0 = Math.max(img.top, at.y0);
    const X1 = Math.min(img.left + img.width, at.x1);
    const Y1 = Math.min(img.top + img.height, at.y1);
    for (let y = Y0; y < Y1; y++)
      for (let x = X0; x < X1; x++) {
        const ip = (y - img.top) * img.width + (x - img.left);
        if (!img.pixels[ip * 4 + 3]) continue;
        const d = depthAt(img.pixels, ip, img.depthBase);
        const q = viewPoint(inverse, x + 0.5, y + 0.5, d);
        // where the 2:1 view draws that point
        const i = Math.floor(dot(ISO_PROJECTION.x, q)) - h.left;
        const j = Math.floor(dot(ISO_PROJECTION.y, q)) - h.top;
        if (i < 0 || j < 0 || i >= h.width || j >= h.height) continue;
        const hp = j * h.width + i;
        const paint = h.paint[hp]!;
        if (!paint || !h.bake[hp * 4 + 3]) continue;
        if (Math.abs(depthAt(h.bake, hp, h.depthBase) - dot(ISO_PROJECTION.d, q)) > RESAMPLED_SURFACE) continue;
        if (img.pixels[ip * 4] === paint) continue;
        img.pixels[ip * 4] = paint;
        changed++;
      }
    for (let k = 0; k < at.beyond.length; k += 3) {
      const [x, y, paint] = [at.beyond[k]!, at.beyond[k + 1]!, at.beyond[k + 2]!];
      if (x < img.left || y < img.top || x >= img.left + img.width || y >= img.top + img.height) continue;
      const ip = (y - img.top) * img.width + (x - img.left);
      const covered = img.pixels[ip * 4 + 3]! > 0;
      if (covered && depthAt(img.pixels, ip, img.depthBase) >= at.farthest - SAME_SURFACE) continue;
      if (img.pixels[ip * 4] === paint) continue;
      img.pixels[ip * 4] = paint;
      if (!covered) img.pixels[ip * 4 + 3] = 255;
      changed++;
    }
  }
  return changed;
}
