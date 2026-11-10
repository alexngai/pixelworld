import { describe, expect, it } from "vitest";
import { resolveStyle } from "../src/world";

describe("loading a world for a view", () => {
  it("names the style pack when the app's resolver fails, and what an HTML answer means (D-072)", async () => {
    const pack = { id: "bay-area" };
    expect(await resolveStyle(pack, "bay-area")).toBe(pack);
    expect(await resolveStyle(async () => pack, "bay-area")).toBe(pack);
    // a resolver that fetched the pack from a wrong URL and parsed the dev server's index.html
    const fetched = async () => JSON.parse("<!doctype html><html></html>") as object;
    await expect(resolveStyle(fetched, "bay-area")).rejects.toThrow(
      /^style pack bay-area: the style resolver failed: SyntaxError: .*\(it got an HTML page, not JSON: is the pack's URL right\?\)$/,
    );
    await expect(
      resolveStyle(() => {
        throw new Error("no style pack bay-aera");
      }, "bay-area"),
    ).rejects.toThrow("style pack bay-area: the style resolver failed: no style pack bay-aera");
  });
});
