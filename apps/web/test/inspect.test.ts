import { describe, expect, it } from "vitest";
import type { ObjectHit } from "@pixelworlds/engine";
import { project, type Rotation } from "@pixelworlds/grid";
import { SHADES, buildPalette, paletteIndex, parseHex, validateStyle, type StylePack } from "@pixelworlds/style";
import southwest from "../../../worlds/_styles/desert-southwest/style.json";
import { objectsOnRay, paletteMatches, rampUses, rayPerStep } from "../src/inspect";

const style = validateStyle(southwest as unknown as StylePack);

describe("the pixel inspector", () => {
  it("finds a colour's ramp and shade in the day and the night palette", () => {
    const day = buildPalette(style);
    const tonto = day.rampIds.get("tonto")!;
    expect(paletteMatches(day, parseHex(style.ramps.tonto![3]!))).toContainEqual({
      index: paletteIndex(tonto, 3),
      ramp: "tonto",
      shade: 3,
    });
    expect(paletteMatches(day, parseHex(style.background))[0]).toEqual({ index: 0, ramp: "background", shade: null });
    expect(paletteMatches(day, parseHex(style.silhouette))).toContainEqual({ index: 253, ramp: "silhouette", shade: null });
    expect(paletteMatches(day, [1, 2, 3])).toEqual([]);
    // by night an emissive ramp has its own colours
    const night = buildPalette(style, "night");
    const lit = parseHex(style.night!.emissive.lit![SHADES - 1]!);
    expect(paletteMatches(night, lit).map((m) => m.ramp)).toContain("lit");
  });

  it("says where the style pack uses a ramp", () => {
    expect(rampUses(style, "tonto")).toContain("strata:grand-canyon/Bright Angel shale");
    expect(rampUses(style, "stucco")).toEqual(expect.arrayContaining(["asset:building.residential/wall", "asset:building.commercial/wall"]));
    expect(rampUses(style, "conifer")).toEqual(expect.arrayContaining(["surface:forest", "asset:tree.conifer/crown"]));
    expect(rampUses(style, style.roads!.asphalt)).toContain("roads.asphalt");
    expect(rampUses(style, "no-such-ramp")).toEqual([]);
  });

  it("follows the view ray: every point on it draws at the ground point's pixel", () => {
    for (const rs of [1, 0.25])
      for (const rot of [0, 1, 2, 3] as Rotation[]) {
        const [dx, dy] = rayPerStep(rot, rs);
        const g = { x: 40.3, y: 17.8, h: 5 };
        const at = project(g.x * rs, g.y * rs, g.h * rs, rot);
        for (const k of [1, 7.5, 30]) {
          const p = project((g.x + k * dx) * rs, (g.y + k * dy) * rs, (g.h + k) * rs, rot);
          expect(p.sx).toBeCloseTo(at.sx, 9);
          expect(p.sy).toBeCloseTo(at.sy, 9);
        }
      }
  });

  it("lists the objects the ray passes through, nearest the viewer first", () => {
    const hit = (group: string, bounds: [number, number, number, number], top: number | null): ObjectHit => ({
      group,
      id: group === "landmark.tower" ? "the-tower" : null,
      x: (bounds[0] + bounds[2]) / 2,
      y: (bounds[1] + bounds[3]) / 2,
      bounds,
      footprint: top !== null,
      base: 0,
      top,
    });
    const objects = [
      hit("building.residential", [7, 7, 8, 8], 10), // on the ray from h = 4 to 6
      hit("tree.conifer", [6, 6, 7, 7], null), // h = 2 to 4, drawn up to 3 steps
      hit("landmark.tower", [20, 20, 21, 21], 50), // ray reaches it at h = 30 to 32
      hit("building.parking", [5.6, 5.6, 6, 6], 0.1), // under the ray: too low where it passes
    ];
    const query = {
      objectsAt: (x: number, y: number) =>
        objects.filter(({ bounds: [x0, y0, x1, y1] }) => x >= x0 && y >= y0 && x <= x1 && y <= y1),
    };
    const ground = { x: 5, y: 5, h: 0 };
    const found = objectsOnRay(query, ground, rayPerStep(0, 1), { renderScale: 1, top: 10 });
    expect(found.map((f) => f.hit.group)).toEqual(["landmark.tower", "building.residential", "tree.conifer"]);
    // where the ray enters each: the tower's top at h = 32, the building's side at h = 6, the tree's top at h = 3
    expect(found.map((f) => f.at.h)).toEqual([32, 6, 3]);
    expect(found[1]!.at).toEqual({ x: 8, y: 8, h: 6 });
  });
});
