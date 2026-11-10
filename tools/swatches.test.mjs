import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPalette, mergeStylePacks, paletteIndex, validateStyle } from "../packages/style/src/index";
import { loadPack, merge, nightRamp, rampUses, render } from "./swatches.mjs";

const FIXTURE = "packages/style/test/fixtures/desert-adobe.json";
const hex = (rgba, i) => "#" + [...rgba.slice(i * 4, i * 4 + 3)].map((v) => v.toString(16).padStart(2, "0")).join("");

describe("swatches tool", () => {
  it("merges extends as the style package does", () => {
    const child = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const parent = JSON.parse(readFileSync("worlds/_styles/desert-southwest/style.json", "utf8"));
    const { extends: _e, ...own } = child;
    expect(merge(parent, own)).toEqual(mergeStylePacks(parent, child));
    expect(loadPack(FIXTURE)).toEqual(mergeStylePacks(parent, child));
  });

  it("dims night colours as the palette does, and keeps emissive ones", () => {
    const pack = loadPack("desert-southwest");
    const night = buildPalette(validateStyle(pack), "night");
    for (const ramp of ["desert", "lit", "marker"]) {
      const id = night.rampIds.get(ramp);
      expect(nightRamp(pack, ramp)).toEqual([0, 1, 2, 3, 4, 5].map((s) => hex(night.rgba, paletteIndex(id, s))));
    }
  });

  it("says what uses each ramp, and which nothing in the pack does", () => {
    const bay = loadPack("bay-area");
    const uses = rampUses(bay);
    expect(uses.get("marker")).toContain("the rover (by name)");
    expect(uses.get("asphalt")).toContain("roads.asphalt");
    const lines = render(bay, { colour: false });
    expect(lines[0]).toBe("bay-area (San Francisco Bay Area): 42 of 42 ramps, palette indices 1–252");
    expect(lines).toHaveLength(42 + 4);
    expect(lines.at(-1)).toMatch(/^(unused in the pack: |every ramp is used)/);
  });
});
