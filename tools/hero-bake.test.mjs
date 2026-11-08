import { describe, expect, it } from "vitest";
import { decodePng, demoPaint, encodePng, register, reregister } from "./hero-bake.mjs";

/** A bake with a w×h rectangle covered at (x, y) of a W×H image at screen (left, top). */
function bake(left, top, W, H, x, y, w, h, idx = 1 + 6 * 3 + 2) {
  const pixels = new Uint8Array(W * H * 4);
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) pixels.set([idx, 0, 0, 255], (j * W + i) * 4);
  return { left, top, width: W, height: H, depthBase: 0, pixels };
}

describe("hero-bake tool", () => {
  it("writes PNGs it (and the client) can read back", () => {
    const rgba = Uint8Array.from({ length: 5 * 3 * 4 }, (_, i) => (i * 37) & 255);
    expect(Array.from(decodePng(encodePng(5, 3, 4, rgba)).data)).toEqual(Array.from(rgba));
    const palette = Array.from({ length: 1024 }, (_, i) => i & 255);
    const idx = Uint8Array.from({ length: 15 }, (_, i) => i * 9);
    const png = encodePng(5, 3, 1, idx, palette);
    expect(png.includes(Buffer.from("tRNS"))).toBe(true);
    expect(decodePng(png)).toMatchObject({ width: 5, height: 3, channels: 1 });
    expect(Array.from(decodePng(png).data)).toEqual(Array.from(idx));
  });

  it("re-registers a paint-over when a re-bake moves the landmark", () => {
    const old = bake(100, 50, 8, 8, 2, 2, 3, 4);
    // the new bake is bigger and the landmark sits one pixel right, two down on screen
    const fresh = bake(98, 49, 12, 12, 5, 5, 3, 4);
    const reg = register(old, fresh);
    expect(reg).toEqual({ dx: 1, dy: 2, iou: 1 });
    const paint = new Uint8Array(64);
    paint[2 * 8 + 2] = 7; // the old silhouette's top-left pixel
    paint[0] = 9; // painted far outside, dropped if it leaves the new frame
    const moved = reregister(paint, old, fresh, reg.dx, reg.dy);
    expect(moved.paint[5 * 12 + 5]).toBe(7);
    expect(moved.paint.filter((v) => v).length + moved.dropped).toBe(2);
  });

  it("demo paint: selective outline, a beacon above tall landmarks, textures on the main ramp", () => {
    const ramps = { marker: 1 + 6 * 15, lit: 1 + 6 * 33 };
    const idx = 1 + 6 * 3 + 3; // ramp 3, shade 3
    const b = bake(0, 0, 8, 14, 2, 2, 4, 10, idx);
    const sel = demoPaint(b, ["selout"], ramps);
    expect(sel[2 * 8 + 3]).toBe(idx - 1); // top edge: the inner shade, one darker, not the outline
    expect(sel[11 * 8 + 3]).toBe(0); // bottom edge untouched
    const beacon = demoPaint(b, ["beacon"], ramps);
    expect(beacon[1 * 8 + 2]).toBe(ramps.marker + 4);
    expect(beacon.filter((v) => v).length).toBe(1);
    const lifts = demoPaint(b, ["lifts"], ramps);
    for (let y = 0; y < 14; y++)
      expect(lifts[y * 8 + 3]).toBe(y % 6 === 0 && y > 2 && y < 11 ? idx - 1 : 0); // interior rows only
    const masonry = demoPaint(b, ["masonry"], ramps);
    expect(masonry[3 * 8 + 3]).toBe(idx - 1); // a mortar row
    expect(masonry[7 * 8 + 4]).toBe(idx - 1); // a joint, staggered from row to row of stones
    expect(masonry[7 * 8 + 3]).toBe(0);
    expect(masonry[4 * 8 + 4]).toBe(0);
    expect(() => demoPaint(b, ["sparkles"], ramps)).toThrow("unknown");
  });
});
