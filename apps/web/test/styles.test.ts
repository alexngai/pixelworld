import { readFileSync } from "node:fs";
import { StyleError, validateStyle, type StylePack } from "@pixelworlds/style";
import { describe, expect, it, vi } from "vitest";
import { styleLoader, stylePack } from "../src/styles";

/** The viewer's style packs (D-075): read when a world needs one, so a broken pack fails only its worlds. */

const desertText = readFileSync(new URL("../../../worlds/_styles/desert-southwest/style.json", import.meta.url), "utf8");
const adobeText = readFileSync(new URL("../../../packages/style/test/fixtures/desert-adobe.json", import.meta.url), "utf8");
const DIR = "../../../worlds/_styles/";

describe("the viewer's style packs", () => {
  it("reads a pack only when a world asks for it", async () => {
    const bay = vi.fn(async () => "{ not json");
    const load = styleLoader({ [`${DIR}desert-southwest/style.json`]: async () => desertText, [`${DIR}bay-area/style.json`]: bay });
    expect((await load("desert-southwest")) as StylePack).toMatchObject({ id: "desert-southwest" });
    expect(bay).not.toHaveBeenCalled();
  });

  it("names the file, line and column of a pack that isn't JSON, and fails only the worlds using it", async () => {
    const broken = desertText.replace('"name": "Desert Southwest",', '"name": "Desert Southwest",,');
    const load = styleLoader({
      [`${DIR}desert-southwest/style.json`]: async () => broken,
      [`${DIR}bay-area/style.json`]: async () => readFileSync(new URL("../../../worlds/_styles/bay-area/style.json", import.meta.url), "utf8"),
    });
    await expect(load("desert-southwest")).rejects.toThrow(StyleError);
    await expect(load("desert-southwest")).rejects.toThrow(
      /^worlds\/_styles\/desert-southwest\/style\.json: invalid JSON at line 4, column 30: /,
    );
    expect((await load("bay-area")) as StylePack).toMatchObject({ id: "bay-area" });
  });

  it("merges a pack's extends, and says which parent failed", async () => {
    const load = styleLoader({
      [`${DIR}desert-southwest/style.json`]: async () => desertText,
      [`${DIR}desert-adobe/style.json`]: async () => adobeText,
    });
    const pack = validateStyle(await load("desert-adobe"));
    expect(pack.assets!["building.residential"]!.generator).toBe("adobe");
    const orphan = styleLoader({ [`${DIR}desert-adobe/style.json`]: async () => adobeText });
    await expect(orphan("desert-adobe")).rejects.toThrow(
      'style pack "desert-adobe" extends "desert-southwest", which failed to load: no style pack "desert-southwest"; there are desert-adobe (worlds/_styles/)',
    );
  });

  it("lists the packs there are, and the one meant", async () => {
    await expect(stylePack("desert-southwst")).rejects.toThrow(
      /^no style pack "desert-southwst" \(did you mean "desert-southwest"\?\); there are .*bay-area/,
    );
  });

  it("finds every committed pack", async () => {
    for (const id of ["bay-area", "desert-southwest"]) expect(validateStyle(await stylePack(id)).id).toBe(id);
  });
});
