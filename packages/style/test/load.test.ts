import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import desertJson from "../../../worlds/_styles/desert-southwest/style.json";
import {
  StyleError,
  buildPalette,
  jsonErrorOffset,
  mergeStylePacks,
  parseStyleJson,
  resolveStyleExtends,
  validateStyle,
  type StylePack,
} from "../src/index";

const desert = desertJson as unknown as StylePack;
const adobe = JSON.parse(readFileSync(new URL("fixtures/desert-adobe.json", import.meta.url), "utf8")) as Record<string, unknown>;
const packs: Record<string, unknown> = { "desert-southwest": desertJson, "desert-adobe": adobe };
const load = (id: string) => packs[id];

describe("parsing a pack's JSON", () => {
  it("names the file, the line and the column", () => {
    const text = '{\n  "id": "x",\n  "ramps": {\n    "a": ["#000000",],\n  }\n}';
    expect(() => parseStyleJson(text, "worlds/_styles/x/style.json")).toThrow(StyleError);
    expect(() => parseStyleJson(text, "worlds/_styles/x/style.json")).toThrow(/^worlds\/_styles\/x\/style\.json: invalid JSON at line 4, column 21: /);
  });

  it("finds where any JSON stops being JSON", () => {
    const at = (text: string) => jsonErrorOffset(text);
    expect(at('{"a": [1, 2], "b": {"c": null}}')).toBe(-1);
    expect(at('{"a": 1,}')).toBe(8); // a trailing comma
    expect(at('{"a": 1 "b": 2}')).toBe(8); // a missing comma
    expect(at('{"a": }')).toBe(6);
    expect(at('{"a": tru}')).toBe(6);
    expect(at('{"a": "b')).toBe(8); // runs off the end
    expect(at("")).toBe(0);
    expect(at('{"a": 1} x')).toBe(9);
    expect(at('"tab\there"')).toBe(4); // a control character in a string
  });

  it("parses a good pack", () => {
    expect(parseStyleJson('{"id": "x"}', "x.json")).toEqual({ id: "x" });
  });
});

describe("extends", () => {
  it("merges objects key by key, replaces anything else, and deletes on null", () => {
    const parent = { id: "p", a: { x: 1, y: [1, 2], z: { k: 1 } }, b: [1], c: "keep", d: 1 };
    const child = { extends: "p", id: "c", a: { y: [3], z: null, w: { n: null, m: 2 } }, b: [2, 3], d: null };
    expect(mergeStylePacks(parent, child)).toEqual({ id: "c", a: { x: 1, y: [3], w: { m: 2 } }, b: [2, 3], c: "keep" });
  });

  it("keeps the parent's ramps where they were, and puts the child's after them", async () => {
    const merged = (await resolveStyleExtends(adobe, load)) as StylePack;
    const names = Object.keys(merged.ramps);
    expect(names.slice(0, -1)).toEqual(Object.keys(desert.ramps));
    expect(names.at(-1)).toBe("adobe");
    expect(buildPalette(validateStyle(merged)).rampIds.get("sand")).toBe(buildPalette(desert).rampIds.get("sand"));
  });

  it("builds the content review's desert-adobe variant from a few lines", async () => {
    const merged = (await resolveStyleExtends(adobe, load)) as StylePack;
    expect(validateStyle(merged).id).toBe("desert-adobe");
    expect("extends" in merged).toBe(false);
    expect(merged.plugins).toEqual(["@pixelworlds/city-demo"]);
    expect(merged.ramps.asphalt![2]).toBe("#5a4a44"); // caliche roads
    expect(Object.keys(merged.ramps)).toHaveLength(42); // the last free slot
    const house = merged.assets!["building.residential"]!;
    const parent = desert.assets!["building.residential"]!;
    expect(house.generator).toBe("adobe");
    expect(house.ramps).toEqual({ ...parent.ramps, wall: "adobe", "wall.sand": "sand", trim: "bark", door: "bark", lit: "lit" });
    const { style: _style, ...params } = parent.params ?? {};
    expect(house.params).toEqual({ ...params, litFraction: 0.4 });
    // everything else is the parent's
    for (const k of ["strataSets", "surfaces", "roads", "night", "scatter"] as const) expect(merged[k]).toEqual(desert[k]);
    expect(JSON.stringify(adobe).length).toBeLessThan(JSON.stringify(desert).length / 10);
  });

  it("resolves a chain, and leaves a pack without extends as it is", async () => {
    const night = { extends: "desert-adobe", id: "desert-adobe-night", night: { saturation: 0.3 } };
    const merged = (await resolveStyleExtends(night, (id) => (id === "desert-adobe" ? adobe : load(id)))) as StylePack;
    expect(validateStyle(merged).night!.saturation).toBe(0.3);
    expect(merged.night!.emissive).toEqual(desert.night!.emissive);
    expect(merged.assets!["building.residential"]!.generator).toBe("adobe");
    expect(await resolveStyleExtends(desertJson, load)).toBe(desertJson);
  });

  it("loads parents through an async resolver", async () => {
    const merged = await resolveStyleExtends(adobe, async (id) => Promise.resolve(load(id)));
    expect((merged as StylePack).id).toBe("desert-adobe");
  });

  it("names the chain when a parent is missing, fails or goes round in a circle", async () => {
    await expect(resolveStyleExtends({ ...adobe, extends: "desert-southwst" }, load)).rejects.toThrow(
      'style pack "desert-adobe" extends "desert-southwst", which there\'s no pack for',
    );
    const failing = () => {
      throw new Error("worlds/_styles/desert-southwest/style.json: invalid JSON at line 3, column 1: …");
    };
    await expect(resolveStyleExtends(adobe, failing)).rejects.toThrow(
      'style pack "desert-adobe" extends "desert-southwest", which failed to load: worlds/_styles/desert-southwest/style.json: invalid JSON',
    );
    const a = { id: "a", extends: "b" };
    const b = { id: "b", extends: "a" };
    await expect(resolveStyleExtends(a, (id) => (id === "a" ? a : b))).rejects.toThrow(
      'style pack "a": extends: the packs extend each other in a circle: a → b → a',
    );
    await expect(resolveStyleExtends({ extends: "desert-southwest" }, load)).rejects.toThrow(
      'style pack: id: a pack that extends another needs its own id (this one extends "desert-southwest")',
    );
  });

  it("checks the merged pack, with the child's paths", async () => {
    const typo = { ...adobe, ramps: { adobe: ["#3a2a30", "#62423f", "#8b5d4c", "#b86c5a", "#d4886c", "#e0b08"] } };
    const merged = await resolveStyleExtends(typo, load);
    expect(() => validateStyle(merged)).toThrow('style pack "desert-adobe": ramps.adobe[5]: bad colour "#e0b08": want "#rrggbb"');
  });
});
