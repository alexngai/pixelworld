import type { BakedImage } from "@pixelworld/bake";
import { describe, expect, it } from "vitest";
import { applyHeroPaint, type HeroPaint } from "../src/heroPaint";

/** An RGBA bake image; `px` maps "x,y" to [index, depth in 1/256 units above depthBase]. */
function image(left: number, top: number, w: number, h: number, px: Record<string, [number, number]>): BakedImage {
  const pixels = new Uint8Array(w * h * 4);
  for (const [k, [idx, d]] of Object.entries(px)) {
    const [x, y] = k.split(",").map(Number) as [number, number];
    const i = ((y - top) * w + (x - left)) * 4;
    pixels.set([idx, d >> 8, d & 255, 255], i);
  }
  return { left, top, width: w, height: h, depthBase: 10, pixels };
}

/** A hero 3×1 at screen (5, 5): its silhouette covers (5,5) and (6,5); (7,5) lies beyond it. */
function hero(paint: number[]): HeroPaint {
  const bake = image(5, 5, 3, 1, { "5,5": [20, 1000], "6,5": [20, 1000] });
  return { id: "h", rotation: 0, left: 5, top: 5, width: 3, height: 1, depthBase: 10, bake: bake.pixels, paint: Uint8Array.from(paint) };
}

const at = (img: BakedImage, x: number, y: number) => {
  const i = ((y - img.top) * img.width + (x - img.left)) * 4;
  return [img.pixels[i], img.pixels[i + 3]];
};

describe("applyHeroPaint", () => {
  it("paints the hero where the tile shows it, not where something stands in front", () => {
    // (5,5) shows the hero at its own depth; (6,5) shows something closer (larger depth)
    const tile = image(0, 0, 10, 10, { "5,5": [20, 1001], "6,5": [30, 1400] });
    expect(applyHeroPaint(tile, 0, [hero([9, 9, 0])])).toBe(1);
    expect(at(tile, 5, 5)).toEqual([9, 255]);
    expect(at(tile, 6, 5)).toEqual([30, 255]);
  });

  it("paints beyond the silhouette onto background and what lies behind, never over what is in front", () => {
    const behind = image(0, 0, 10, 10, { "5,5": [20, 1000], "7,5": [40, 200] });
    expect(applyHeroPaint(behind, 0, [hero([0, 0, 9])])).toBe(1);
    expect(at(behind, 7, 5)).toEqual([9, 255]);
    const empty = image(0, 0, 10, 10, { "5,5": [20, 1000] });
    expect(applyHeroPaint(empty, 0, [hero([0, 0, 9])])).toBe(1);
    expect(at(empty, 7, 5)).toEqual([9, 255]); // background becomes covered
    const front = image(0, 0, 10, 10, { "5,5": [20, 1000], "7,5": [40, 1500] });
    expect(applyHeroPaint(front, 0, [hero([0, 0, 9])])).toBe(0);
  });

  it("skips other rotations and tiles the hero does not reach, and clips to the tile", () => {
    const tile = image(0, 0, 10, 10, { "5,5": [20, 1000] });
    expect(applyHeroPaint(tile, 1, [hero([9, 9, 9])])).toBe(0);
    expect(applyHeroPaint(image(20, 20, 4, 4, {}), 0, [hero([9, 9, 9])])).toBe(0);
    // a tile whose right edge cuts the hero after (5,5)
    const cut = image(0, 0, 6, 10, { "5,5": [20, 1000] });
    expect(applyHeroPaint(cut, 0, [hero([9, 9, 9])])).toBe(1);
    expect(at(cut, 5, 5)).toEqual([9, 255]);
  });

  it("leaves pixels that already hold the painted index (a re-bake is idempotent)", () => {
    const tile = image(0, 0, 10, 10, { "5,5": [20, 1000], "6,5": [20, 1000] });
    expect(applyHeroPaint(tile, 0, [hero([9, 9, 0])])).toBe(2);
    expect(applyHeroPaint(tile, 0, [hero([9, 9, 0])])).toBe(0);
  });
});
