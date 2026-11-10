import { readFileSync } from "node:fs";
import { hasGenerator, registerGenerators, unregisterGenerators, type Generator } from "@pixelworlds/generators";
import { StyleError, generatorIssues, type StylePack } from "@pixelworlds/style";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkGenerators, type ViewPlugins } from "../src/plugins";
import { resolveStyle } from "../src/world";

/** A view's style pack (D-075): resolved, extended, checked, and its generators checked against the registry. */

const read = (id: string) =>
  JSON.parse(readFileSync(new URL(`../../../worlds/_styles/${id}/style.json`, import.meta.url), "utf8")) as StylePack;
const desert = read("desert-southwest");
const bay = read("bay-area");
const adobe = JSON.parse(readFileSync(new URL("../../style/test/fixtures/desert-adobe.json", import.meta.url), "utf8")) as object;
const packs: Record<string, object> = { "desert-southwest": desert, "bay-area": bay, "desert-adobe": adobe };
const resolver = (id: string) => packs[id] as object;
const none: ViewPlugins = { descriptors: [], refs: [], missing: [] };

describe("resolving a view's style pack", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("takes the pack given, or the resolver's for the world's id", async () => {
    expect(await resolveStyle(desert, "desert-southwest")).toBe(desert);
    expect(await resolveStyle(resolver, "bay-area")).toBe(bay);
    expect(warn).not.toHaveBeenCalled();
  });

  it("merges a pack's extends, loading its parent through the resolver", async () => {
    const pack = (await resolveStyle(resolver, "desert-adobe")) as StylePack;
    expect(pack.id).toBe("desert-adobe");
    expect(pack.assets!["building.residential"]!.generator).toBe("adobe");
    expect(pack.strataSets).toEqual(desert.strataSets);
    await expect(resolveStyle(adobe, "desert-adobe")).rejects.toThrow(
      /extends "desert-southwest", which failed to load: createWorldView's style is a pack, not a resolver/,
    );
  });

  it("names the pack when the resolver fails or has none", async () => {
    const html = () => {
      throw new SyntaxError(`Unexpected token '<', "<!doctype "... is not valid JSON`);
    };
    await expect(resolveStyle(html, "bay-area")).rejects.toThrow(
      `style pack "bay-area" (from your style resolver): SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON (it got an HTML page, not JSON: is the pack's URL right?)`,
    );
    await expect(resolveStyle(() => undefined as unknown as object, "bay-ara")).rejects.toThrow(
      'style pack "bay-ara": your style resolver has no pack for it (it returned undefined)',
    );
    const own = new StyleError("worlds/_styles/bay-area/style.json: invalid JSON at line 3, column 1: …");
    await expect(
      resolveStyle(() => {
        throw own;
      }, "bay-area"),
    ).rejects.toBe(own);
  });

  it("checks the pack, naming it", async () => {
    const broken = { ...desert, ramps: { ...desert.ramps, sand: ["#ffffff"] } };
    await expect(resolveStyle(() => broken, "desert-southwest")).rejects.toThrow(
      /^style pack "desert-southwest": ramps\.sand: has 1 entry, want 6\./,
    );
    await expect(resolveStyle(() => "<!doctype html>" as unknown as object, "bay-area")).rejects.toThrow(
      /^style pack "bay-area": a style pack is a JSON object, not a string of HTML/,
    );
  });

  it("warns when the resolver answers with another pack", async () => {
    await resolveStyle(() => desert, "bay-area");
    expect(warn).toHaveBeenCalledWith(
      'the world names the style pack "bay-area", but the style resolver gave "desert-southwest": drawing it with that one',
    );
  });
});

describe("a pack's generators, when a view starts", () => {
  const typo = (generator: string): StylePack => ({
    ...desert,
    assets: { ...desert.assets, "building.residential": { ...desert.assets!["building.residential"]!, generator } },
  });

  it("are all registered for the Southwest", () => {
    expect(() => checkGenerators(desert, desert, none)).not.toThrow();
  });

  it("names a generator nobody registered, with a did-you-mean", () => {
    expect(() => checkGenerators(typo("buildng"), desert, none)).toThrow(StyleError);
    expect(() => checkGenerators(typo("buildng"), desert, none)).toThrow(
      'style pack "desert-southwest": assets["building.residential"].generator: no generator named "buildng" (did you mean "building"?): ' +
        "none is registered, and no plugin known here provides it (docs/plugins.md §9)",
    );
  });

  it("says which plugin a known generator comes with", () => {
    expect(() => checkGenerators(typo("rowhouse"), desert, none)).toThrow(
      `assets["building.residential"].generator: "rowhouse" comes with the plugin @pixelworlds/city-sf: add it to the pack's "plugins", and load it`,
    );
    expect(generatorIssues(bay, [])).toContainEqual({
      path: 'assets["building.rowhouse.victorian"].generator',
      message: expect.stringMatching(/^no generator named "rowhouse"/),
    });
  });

  it("leaves a pack alone while a plugin it names isn't loaded (that was warned about)", () => {
    expect(() => checkGenerators(bay, bay, none)).not.toThrow();
  });

  it("finds the generators a loaded plugin registered", () => {
    const fake: Generator = () => {
      throw new Error("not drawn here");
    };
    const city = { name: "@pixelworlds/city-sf", url: "/city.js" };
    const names = [...new Set(Object.values(bay.assets!).map((a) => a.generator))].filter((n) => !hasGenerator(n));
    registerGenerators(Object.fromEntries(names.map((n) => [n, fake])), { source: "styles-test" });
    try {
      // built-ins are already there: the plugin added only what was missing
      expect(() => checkGenerators(bay, bay, { descriptors: [city], refs: [], missing: [] })).not.toThrow();
    } finally {
      unregisterGenerators("styles-test");
    }
  });
});
