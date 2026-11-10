import type { BakedImage } from "@pixelworlds/bake";
import type { Rotation } from "@pixelworlds/grid";

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
