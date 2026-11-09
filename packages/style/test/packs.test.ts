import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INDEX_SILHOUETTE, buildPalette, paletteIndex, validateStyle, type StylePack } from "../src/index";

const ROOT = join(__dirname, "../../../worlds/_styles");
const packs = readdirSync(ROOT).map((id) => [id, JSON.parse(readFileSync(join(ROOT, id, "style.json"), "utf8"))] as const);

describe("every style pack", () => {
  it("is found", () => expect(packs.map(([id]) => id)).toEqual(expect.arrayContaining(["bay-area", "desert-southwest"])));

  for (const [id, json] of packs)
    it(`${id}: validates, fits the palette and has its id, the marker ramp and a night palette`, () => {
      const style = validateStyle(json as StylePack);
      expect(style.id).toBe(id);
      const day = buildPalette(style);
      expect(paletteIndex(day.rampIds.size - 1, 5)).toBeLessThan(INDEX_SILHOUETTE);
      expect(day.rampIds.has("marker")).toBe(true); // the rover
      expect(buildPalette(style, "night").rgba).toHaveLength(1024);
      // the building groups every world may name have assets
      for (const g of ["building.residential", "building.commercial", "building.tower", "tree", "shrub"])
        expect(Object.keys(style.assets ?? {})).toContain(g);
    });

  it("lights San Francisco's smoothed lawns by slope and keeps the Southwest's terraces", () => {
    const lit = (id: string) =>
      Object.entries((packs.find(([p]) => p === id)![1] as StylePack).surfaces)
        .filter(([, s]) => s.light === "slope")
        .map(([name]) => name);
    expect(lit("bay-area")).toEqual(["lawn"]);
    expect(lit("desert-southwest")).toEqual([]);
  });
});
