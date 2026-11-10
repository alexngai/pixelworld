import { describe, expect, it } from "vitest";
import { args, benchUrl } from "./bench.mjs";

describe("bench tool", () => {
  it("defaults to every case on a 1280×720 canvas in software rendering", () => {
    const opt = args([]);
    expect(opt).toMatchObject({ gpu: false, headed: false, cases: null, size: "1280x720" });
    expect(benchUrl("http://localhost:5196", opt)).toBe("http://localhost:5196/bench.html?auto=1&w=1280&h=720");
  });

  it("passes cases and size to the page", () => {
    const opt = args(["--gpu", "--cases", "sf-walk,sw-drive", "--size", "960x540"]);
    expect(opt.gpu).toBe(true);
    expect(benchUrl("http://x", opt)).toBe("http://x/bench.html?auto=1&w=960&h=540&cases=sf-walk%2Csw-drive");
  });

  it("rejects unknown arguments and malformed sizes", () => {
    expect(() => args(["--fast"])).toThrow(/unknown argument/);
    expect(() => args(["--size", "big"])).toThrow(/WxH/);
  });
});
