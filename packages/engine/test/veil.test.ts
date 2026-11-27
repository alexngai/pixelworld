import { readFileSync } from "node:fs";
import { buildPalette, type StylePack } from "@pixelworlds/style";
import { describe, expect, it } from "vitest";
import { veilLayer } from "../src/veil";
import type { FrameInfo, LayerContext } from "../src/types";

/** A veil over cells (D-125): a game's field, drawn by the fog pass over every height. */
describe("veilLayer", () => {
  const style = JSON.parse(readFileSync(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url), "utf8")) as StylePack;
  const palette = buildPalette(style);
  let redraws = 0;
  const ctx = { view: { world: { palette, style, renderScale: 1 } }, invalidate: () => redraws++ } as unknown as LayerContext;
  const frame = { rotation: 1, night: false } as FrameInfo;

  it("draws nothing until a field is set, then the field over its rectangle, darkening toward its ramp", () => {
    const veil = veilLayer({ id: "sight", ramp: "asphalt" });
    expect(veil.init(ctx)).toBe(true);
    expect(veil.screenPass(frame)).toBeNull();
    const values = new Uint8Array([0, 128, 255, 255, 0, 0]);
    veil.set({ x0: 10, y0: 20, w: 3, h: 2 }, values);
    expect(redraws).toBe(1);
    const pass = veil.screenPass(frame)!;
    expect(pass.field).toMatchObject({ width: 3, height: 2, cellsPerTexel: 1, x0: 10, y0: 20, data: values });
    expect(pass.frame).toMatchObject({ contrast: 0, strength: 1 });
    expect(pass.frame.lut.levels).toBe(3);
    // a light colour (the lawn's lightest) goes darker at each level
    const light = 1 + palette.rampIds.get("lawn")! * 6 + 5;
    const lum = (i: number) => palette.rgba[i * 4]! + palette.rgba[i * 4 + 1]! + palette.rgba[i * 4 + 2]!;
    const steps = [0, 1, 2].map((l) => pass.frame.lut.data[l * 256 + light]!);
    expect(lum(steps[0]!)).toBeLessThan(lum(light));
    expect(lum(steps[2]!)).toBeLessThanOrEqual(lum(steps[0]!));
    veil.setEnabled(false);
    expect(veil.screenPass(frame)).toBeNull();
    veil.setEnabled(true);
    veil.clear();
    expect(veil.screenPass(frame)).toBeNull();
  });

  it("veils below a height when asked (D-198), in render units, and updates dynamically", () => {
    const veil = veilLayer({ ramp: "asphalt", below: 12 });
    veil.init({ ...ctx, view: { world: { palette, style, renderScale: 2 } } } as unknown as LayerContext);
    veil.set({ x0: 0, y0: 0, w: 1, h: 1 }, new Uint8Array([255]));
    expect(veil.screenPass(frame)!.frame).toMatchObject({ ceiling: 24, fade: 2 });
    veil.below = 6;
    expect(veil.screenPass(frame)!.frame).toMatchObject({ ceiling: 12, fade: 2 });
    veil.set({ x0: 0, y0: 0, w: 1, h: 1 }, new Uint8Array([255]), { below: null });
    expect(veil.screenPass(frame)!.frame.ceiling).toBeGreaterThan(1e8);
    const everywhere = veilLayer({ ramp: "asphalt" });
    everywhere.init(ctx);
    everywhere.set({ x0: 0, y0: 0, w: 1, h: 1 }, new Uint8Array([255]));
    expect(everywhere.screenPass(frame)!.frame.ceiling).toBeGreaterThan(1e8);
  });

  it("refuses a field of the wrong size, and a ramp the style hasn't", () => {
    const veil = veilLayer({ ramp: "asphalt" });
    veil.init(ctx);
    expect(() => veil.set({ x0: 0, y0: 0, w: 2, h: 2 }, new Uint8Array(3))).toThrow(/3 values for 2 × 2/);
    expect(() => veilLayer({ ramp: "no-such" }).init(ctx)).toThrow(/no ramp "no-such"/);
  });
});
