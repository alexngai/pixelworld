import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { StartTiles } from "../packages/runtime/src/tileCache";
import { decodePackKeys, encodePack } from "./prebake.mjs";

describe("start tiles (tools/prebake.mjs)", () => {
  it("the engine reads back each tile the tool packs, and nothing else", async () => {
    const pixels = (n) => Uint8Array.from({ length: 16 }, (_, i) => (i * n) & 255);
    const file = encodePack([
      { key: "w|code1|0:1,2", left: -3, top: 4, width: 2, height: 2, depthBase: 7, pixels: gzipSync(pixels(3)) },
      { key: "w|code1|0:1,2:bare", left: 0, top: 0, width: 2, height: 2, depthBase: 1, pixels: gzipSync(pixels(5)) },
    ]);
    expect(decodePackKeys(file)).toEqual(["w|code1|0:1,2", "w|code1|0:1,2:bare"]);
    const pack = StartTiles.parse(new Uint8Array(file));
    expect(pack.size).toBe(2);
    expect(await pack.get("w|code1|0:1,2")).toEqual({ left: -3, top: 4, width: 2, height: 2, depthBase: 7, pixels: pixels(3) });
    expect((await pack.get("w|code1|0:1,2:bare")).pixels).toEqual(pixels(5));
    expect(await pack.get("w|code2|0:1,2")).toBeNull(); // baked by other code: not its tile
    // a dev server answers a missing pack with its index.html
    expect(StartTiles.parse(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
  });
});
