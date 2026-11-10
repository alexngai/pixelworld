import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import desertJson from "../../../worlds/_styles/desert-southwest/style.json";
import {
  MAX_RAMPS,
  MAX_STRATA,
  MAX_STRATA_SETS,
  PATTERNS,
  SCHEMA_KEYWORDS,
  SHADES,
  STYLE_PACK_DOCS,
  STYLE_PACK_SCHEMA,
  STYLE_SCHEMA_FILE,
  StyleError,
  checkSchema,
  didYouMean,
  documented,
  formatPath,
  styleIssues,
  styleSchemaDocument,
  validateStyle,
  type JsonSchema,
  type StylePack,
} from "../src/index";

const desert = desertJson as unknown as StylePack;
const SCHEMA_PATH = `../schema/${STYLE_SCHEMA_FILE}`;
/** Any part of a pack, to break on purpose. */
const L = (o: unknown) => o as Record<string, unknown>;
/** A copy of the desert pack with a change (the pack is JSON: structuredClone is a deep copy). */
const edit = (change: (p: StylePack) => void): unknown => {
  const p = structuredClone(desertJson) as unknown as StylePack;
  change(p);
  return p;
};
const messages = (pack: unknown) => styleIssues(pack).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message));

describe("the style pack schema", () => {
  it("is the file editors read, generated from schema.ts (update: pnpm vitest run packages/style -u)", async () => {
    await expect(JSON.stringify(styleSchemaDocument(), null, 2) + "\n").toMatchFileSnapshot(SCHEMA_PATH);
  });

  it("uses only the keywords the loader's checker reads", () => {
    const seen = new Set<string>();
    const walk = (s: JsonSchema) => {
      for (const [k, v] of Object.entries(s)) {
        seen.add(k);
        if (k === "properties" || k === "definitions") Object.values(v as Record<string, JsonSchema>).forEach(walk);
        else if (k === "anyOf") (v as JsonSchema[]).forEach(walk);
        else if ((k === "items" || k === "additionalProperties") && typeof v === "object") walk(v as JsonSchema);
      }
    };
    walk(STYLE_PACK_SCHEMA);
    expect([...seen].filter((k) => !SCHEMA_KEYWORDS.includes(k))).toEqual([]);
  });

  it("describes every key for editors, from docs that name only keys there are", () => {
    const used = new Set<string>();
    const doc = documented(STYLE_PACK_SCHEMA, STYLE_PACK_DOCS, "", used);
    expect(Object.keys(STYLE_PACK_DOCS).filter((k) => !used.has(k))).toEqual([]);
    const undocumented: string[] = [];
    const walk = (s: JsonSchema, at: string) => {
      for (const [k, p] of Object.entries(s.properties ?? {})) {
        if (!p.description) undocumented.push(`${at}${k}`);
        walk(p, `${at}${k}.`);
      }
      if (typeof s.additionalProperties === "object") walk(s.additionalProperties, `${at}*.`);
      if (s.items) walk(s.items, `${at.slice(0, -1)}[].`);
      for (const [k, d] of Object.entries(s.definitions ?? {})) walk(d, `#${k}.`);
    };
    walk(doc, "");
    expect(undocumented).toEqual([]);
    // the schema the loader walks has none: they stay out of app bundles
    expect(JSON.stringify(STYLE_PACK_SCHEMA)).not.toContain('"description"');
  });

  it("has the limits index.ts draws with", () => {
    const p = STYLE_PACK_SCHEMA.properties!;
    expect(p.ramps!.maxProperties).toBe(MAX_RAMPS);
    expect(p.shades!.const).toBe(SHADES);
    expect(STYLE_PACK_SCHEMA.definitions!.ramp!.minItems).toBe(SHADES);
    expect(p.strataSets!.maxProperties).toBe(MAX_STRATA_SETS);
    expect((p.strataSets!.additionalProperties as JsonSchema).maxItems).toBe(MAX_STRATA);
    const pattern = STYLE_PACK_SCHEMA.definitions!.surface!.properties!.pattern!;
    expect(pattern.enum).toEqual(Object.keys(PATTERNS));
  });

  it("lets a pack that extends another leave keys out and delete its parent's with null", () => {
    const doc = styleSchemaDocument() as unknown as JsonSchema & { definitions: Record<string, JsonSchema> };
    const child = JSON.parse(readFileSync(new URL("fixtures/desert-adobe.json", import.meta.url), "utf8")) as unknown;
    expect(checkSchema(child, doc.definitions.variant, [], [], doc)).toEqual([]);
    // still strict about names and shapes
    const typo = { ...(child as object), pallete: {}, ramps: { adobe: ["#000"] } };
    expect(checkSchema(typo, doc.definitions.variant, [], [], doc).map((i) => i.path)).toEqual(["ramps.adobe", "ramps.adobe[0]", ""]);
    // and a full pack doesn't pass as one that extends nothing
    expect(checkSchema(child, doc.definitions.pack, [], [], doc).length).toBeGreaterThan(0);
  });
});

describe("validating a style pack", () => {
  it("accepts the committed packs", () => {
    expect(styleIssues(desert)).toEqual([]);
  });

  it("names the pack, the path and the problem", () => {
    const bad = edit((p) => (p.ramps.desert![0] = "#3a2f3"));
    expect(() => validateStyle(bad)).toThrow(StyleError);
    expect(() => validateStyle(bad)).toThrow('style pack "desert-southwest": ramps.desert[0]: bad colour "#3a2f3": want "#rrggbb"');
    try {
      validateStyle(bad);
    } catch (e) {
      expect((e as StyleError).pack).toBe("desert-southwest");
      expect((e as StyleError).issues).toEqual([{ path: "ramps.desert[0]", message: 'bad colour "#3a2f3": want "#rrggbb"' }]);
    }
  });

  it("flags unknown keys, with a did-you-mean", () => {
    const typo = edit((p) => {
      const a = L(p.assets!["building.residential"]);
      a.generater = a.generator;
      delete a.generator;
      L(p.surfaces.grass).centerline = true;
    });
    expect(messages(typo)).toEqual([
      'surfaces.grass: unknown key "centerline"; known here: ramp, pattern, density, light',
      'assets["building.residential"]: missing "generator"',
      'assets["building.residential"]: unknown key "generater" (did you mean "generator"?)',
    ]);
    expect(messages(edit((p) => (L(p).pallete = {})))[0]).toMatch(/^unknown key "pallete"; a pack's keys: \$schema, extends, id, name, plugins/);
    expect(messages(edit((p) => (L(p.roads!.classes.motorway).centreLine = true)))).toEqual([
      'roads.classes.motorway: unknown key "centreLine" (did you mean "centerLine"?)',
    ]);
  });

  it("checks types and ranges", () => {
    expect(messages(edit((p) => (L(p).plugins = "@pixelworlds/city-sf")))).toEqual(['plugins: want an array, not the string "@pixelworlds/city-sf"']);
    expect(messages(edit((p) => (p.shades = 5)))).toEqual(["shades: must be 6, not the number 5"]);
    expect(messages(edit((p) => p.ramps.sand!.pop()))).toEqual([
      "ramps.sand: has 5 entries, want 6. A ramp is 6 colours, from shade 0 (the outline, darkest) to 5 (the lightest).",
    ]);
    expect(messages(edit((p) => (L(p.assets!.tree).params = { reach: "far" })))).toEqual([
      'assets.tree.params.reach: want a number or an array, not the string "far"',
    ]);
    expect(messages(edit((p) => (L(p.surfaces.grass).pattern = "speckel")))).toEqual([
      'surfaces.grass.pattern: want one of "none", "trees", "speckle", "sparkle", "fields", "blocks", not the string "speckel" (did you mean "speckle"?)',
    ]);
  });

  it("says why a pack holds at most 42 ramps", () => {
    const full = edit((p) => {
      for (let i = 0; Object.keys(p.ramps).length <= MAX_RAMPS; i++) p.ramps[`extra-${i}`] = p.ramps.sand!;
    });
    expect(messages(full)).toEqual([
      "ramps: has 43 entries, want at most 42. A pack holds at most 42 ramps: the palette is 256 indexed colours, " +
        "index 0 the background, 6 shades a ramp from index 1, and 253 the silhouette, so 1 + 42 × 6 = 253 (docs/style-guide.md §2).",
    ]);
  });

  it("checks the names a pack refers to, with a did-you-mean", () => {
    expect(messages(edit((p) => (p.assets!["building.residential"]!.ramps.wall = "stuco")))).toEqual([
      'assets["building.residential"].ramps.wall: no ramp named "stuco" (did you mean "stucco"?)',
    ]);
    expect(messages(edit((p) => (p.defaultStrata = "grand-canyn")))).toEqual([
      'defaultStrata: no strata set named "grand-canyn" (did you mean "grand-canyon"?)',
    ]);
    expect(messages(edit((p) => (p.scatter!.woodland![0]!.group = "tre.pinyon-juniper")))).toEqual([
      'scatter.woodland[0].group: no asset for "tre.pinyon-juniper" (did you mean "tree.pinyon-juniper"?)',
    ]);
    const swapped = edit((p) => {
      const bands = p.strataSets["grand-canyon"]!;
      [bands[0], bands[1]] = [bands[1]!, bands[0]!];
    });
    expect(messages(swapped)[0]).toMatch(/^strataSets\.grand-canyon\[1\]\.aboveMeters: bands run from the highest down, so want < /);
  });

  it("lists several problems at once", () => {
    const bad = edit((p) => {
      p.ramps.sand![1] = "sand";
      p.ramps.desert![2] = "#12345";
    });
    expect(() => validateStyle(bad)).toThrow(
      'style pack "desert-southwest" has 2 problems:\n  ramps.sand[1]: bad colour "sand": want "#rrggbb"\n  ramps.desert[2]: bad colour "#12345": want "#rrggbb"',
    );
  });

  it("says when what it was given isn't a style pack", () => {
    expect(messages("<!doctype html><html>")).toEqual([expect.stringContaining("not a string of HTML (is the URL right?")]);
    expect(messages({ default: desertJson })).toEqual(["this is a JSON module, not a style pack: pass its default export"]);
    expect(messages({ id: "x", tiles: [] })).toEqual([
      "this isn't a style pack: it has none of ramps, surfaces, strataSets or shades (its keys: id, tiles)",
    ]);
    expect(messages(null)).toEqual(["a style pack is a JSON object, not null"]);
  });

  it("rejects a pack for another version of the schema, and one with its extends unmerged", () => {
    expect(messages(edit((p) => (p.$schema = "https://example.org/style-pack.v2.schema.json")))).toEqual([
      "$schema: the pack is written for style pack schema v2; this pixelworld reads v1",
    ]);
    expect(messages({ id: "x", extends: "desert-southwest" })).toEqual([
      expect.stringMatching(/^extends: "desert-southwest" isn't merged in: load the pack with resolveStyleExtends/),
    ]);
  });
});

describe("paths and suggestions", () => {
  it("formats paths as people read them", () => {
    expect(formatPath(["ramps", "roof-tile", 2])).toBe("ramps.roof-tile[2]");
    expect(formatPath(["assets", "building.residential", "ramps", "wall.gold"])).toBe('assets["building.residential"].ramps["wall.gold"]');
    expect(formatPath(["$schema"])).toBe("$schema");
    expect(formatPath([])).toBe("");
  });

  it("suggests only close names", () => {
    expect(didYouMean("generater", ["generator", "ramps", "params"])).toBe("generator");
    expect(didYouMean("rmaps", ["generator", "ramps", "params"])).toBe("ramps"); // a swap
    expect(didYouMean("CenterLine", ["centerLine"])).toBe("centerLine");
    expect(didYouMean("pallete", ["ramps", "surfaces"])).toBeNull();
    expect(didYouMean("ramps", ["ramps"])).toBeNull();
  });
});
