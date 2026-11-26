import type { BakedImage } from "@pixelworlds/bake";
import { ISO_PROJECTION, STEEP_PROJECTION, projectView, unprojectView, type Projection } from "@pixelworlds/grid";
import { describe, expect, it } from "vitest";
import { applyHeroPaint, applyHeroPaintReprojected, type HeroPaint } from "../src/heroPaint";

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

describe("applyHeroPaintReprojected (D-196)", () => {
  // a flat roof at 10 steps over the view cells u, v in [0, 4), drawn by a projection: each pixel whose centre's
  // ray meets it shows it, at its depth; the paint marks the half with u < 2
  const H = 10;
  const SIDE = 4;
  type Drawn = { img: BakedImage; uv: Map<number, [number, number]> };
  function roof(p: Projection, index: number): Drawn {
    const corners = [0, SIDE].flatMap((u) => [0, SIDE].map((v) => projectView(u, v, H, p)));
    const left = Math.floor(Math.min(...corners.map((c) => c.sx))) - 2;
    const top = Math.floor(Math.min(...corners.map((c) => c.sy))) - 2;
    const width = Math.ceil(Math.max(...corners.map((c) => c.sx))) + 2 - left;
    const height = Math.ceil(Math.max(...corners.map((c) => c.sy))) + 2 - top;
    const pixels = new Uint8Array(width * height * 4);
    const uv = new Map<number, [number, number]>();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const [u, v] = unprojectView(left + x + 0.5, top + y + 0.5, H, p);
        if (u < 0 || v < 0 || u >= SIDE || v >= SIDE) continue;
        const d = Math.round(projectView(u, v, H, p).depth * 256);
        pixels.set([index, d >> 8, d & 255, 255], (y * width + x) * 4);
        uv.set(y * width + x, [u, v]);
      }
    return { img: { left, top, width, height, depthBase: 0, pixels }, uv };
  }
  function paintedHero(): HeroPaint {
    const { img, uv } = roof(ISO_PROJECTION, 20);
    const paint = new Uint8Array(img.width * img.height);
    for (const [i, [u]] of uv) if (u < SIDE / 2) paint[i] = 9;
    return { id: "roof", rotation: 0, left: img.left, top: img.top, width: img.width, height: img.height, depthBase: 0, bake: img.pixels, paint };
  }

  it("carries the 2:1 paint onto the same half of the roof drawn at 4:3", () => {
    const hero = paintedHero();
    const tile = roof(STEEP_PROJECTION, 20);
    expect(applyHeroPaintReprojected(tile.img, 0, [hero], STEEP_PROJECTION)).toBeGreaterThan(0);
    let inside = 0;
    for (const [i, [u, v]] of tile.uv) {
      const index = tile.img.pixels[i * 4];
      // away from the paint's edge and the roof's, the paint is where its half of the roof is, and only there
      const edge = Math.abs(u - SIDE / 2) < 0.1 || u < 0.1 || v < 0.1 || v > SIDE - 0.1;
      if (edge) continue;
      expect(index).toBe(u < SIDE / 2 ? 9 : 20);
      if (u < SIDE / 2) inside++;
    }
    // the 4:3 roof is half again as tall on screen: more painted pixels than the 2:1 paint has
    expect(inside).toBeGreaterThan([...hero.paint].filter((p) => p).length);
  });

  it("leaves what stands in front of the hero", () => {
    const hero = paintedHero();
    const tile = roof(STEEP_PROJECTION, 20);
    // every pixel shows something nearer the camera than the roof
    for (let i = 0; i < tile.img.pixels.length; i += 4) if (tile.img.pixels[i + 3]) tile.img.pixels[i + 1]! += 4;
    expect(applyHeroPaintReprojected(tile.img, 0, [hero], STEEP_PROJECTION)).toBe(0);
  });

  it("in the 2:1 view itself, paints as applyHeroPaint does", () => {
    const hero = paintedHero();
    const a = roof(ISO_PROJECTION, 20).img;
    const b = roof(ISO_PROJECTION, 20).img;
    expect(applyHeroPaintReprojected(a, 0, [hero], ISO_PROJECTION)).toBe(applyHeroPaint(b, 0, [hero]));
    expect(a.pixels).toEqual(b.pixels);
  });

  it("places paint beyond the silhouette by its nearest silhouette pixel", () => {
    // the 3×1 hero above: (7,5) is painted beyond the silhouette, beside (6,5); in the 2:1 view it lands where it is painted
    const tile = image(0, 0, 10, 10, { "5,5": [20, 1000] });
    expect(applyHeroPaintReprojected(tile, 0, [hero([0, 0, 9])], ISO_PROJECTION)).toBe(1);
    expect(at(tile, 7, 5)).toEqual([9, 255]);
  });
});
