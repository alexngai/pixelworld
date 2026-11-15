import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  INDEX_SILHOUETTE,
  STYLE_SCHEMA_FILE,
  buildPalette,
  paletteIndex,
  resolveStyleExtends,
  styleIssues,
  validateStyle,
  type StylePack,
} from "../src/index";

const ROOT = join(__dirname, "../../../worlds/_styles");
const SCHEMA = resolve(__dirname, "../schema", STYLE_SCHEMA_FILE);
// every directory is a pack (the licence file beside them isn't)
const packs = readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => [e.name, JSON.parse(readFileSync(join(ROOT, e.name, "style.json"), "utf8"))] as const);
// a pack that extends another (D-139's `arches`) is checked with its parents merged in, as a viewer loads it
const merged = (json: unknown) => resolveStyleExtends(json, (id) => packs.find(([p]) => p === id)?.[1]);

describe("every style pack", () => {
  it("is found", () => expect(packs.map(([id]) => id)).toEqual(expect.arrayContaining(["bay-area", "desert-southwest"])));

  for (const [id, json] of packs)
    it(`${id}: names the schema, for editors, and has no problems against it`, async () => {
      expect(typeof json.$schema).toBe("string");
      expect(resolve(ROOT, id, json.$schema as string)).toBe(SCHEMA);
      expect(existsSync(SCHEMA)).toBe(true);
      expect(styleIssues(await merged(json))).toEqual([]);
    });

  for (const [id, json] of packs)
    it(`${id}: validates, fits the palette and has its id, the marker ramp and a night palette`, async () => {
      const style = validateStyle((await merged(json)) as StylePack);
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
