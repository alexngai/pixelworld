import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PINS, pinProblems, pinned, versions } from "./version-pins.mjs";

const repo = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("version pins", () => {
  it("the consumer examples and the npm docs name the packages' versions", () => {
    // after `pnpm changeset version`: node tools/version-pins.mjs --write
    expect(pinProblems(repo, versions(repo))).toEqual([]);
    expect(new Set(PINS.map((p) => p.file)).size).toBe(6);
  });

  it("finds drifted and missing pins, and rewrites them", () => {
    const files = {
      "examples/consumers/vite/package.json": `{ "dependencies": { "@pixelworlds/city-sf": "^0.0.0", "pixelworld": "^0.1.0" } }`,
      "examples/consumers/webpack/package.json": `{ "dependencies": { "@pixelworlds/city-sf": "^0.2.0", "pixelworld": "^0.2.0" } }`,
      "examples/consumers/esm/package.json": `{ "dependencies": { "pixelworld": "^0.2.0" } }`,
      "examples/consumers/esm/cdn.html": `get("cdn") ?? "https://cdn.jsdelivr.net/npm/pixelworld@0.1/dist/";`,
      "docs/npm.md": "const cdn = `https://cdn.jsdelivr.net/npm/pixelworld@0.2.0/dist/`;",
      "docs/plugins.md": '"peerDependencies": { "pixelworld": "^0.2.0" }',
    };
    const read = (f) => files[f];
    const vers = { pixelworld: "0.2.0", "@pixelworlds/city-sf": "0.2.0" };
    expect(pinProblems(read, vers)).toEqual([
      "examples/consumers/vite/package.json pins pixelworld ^0.1.0, not ^0.2.0",
      "examples/consumers/vite/package.json pins @pixelworlds/city-sf ^0.0.0, not ^0.2.0",
      "examples/consumers/esm/package.json names no version of @pixelworlds/city-sf",
      "examples/consumers/esm/cdn.html pins pixelworld 0.1, not 0.2.0",
    ]);
    const out = pinned(read, vers);
    expect([...out.keys()]).toEqual(["examples/consumers/vite/package.json", "examples/consumers/esm/cdn.html"]);
    expect(out.get("examples/consumers/vite/package.json")).toBe(
      `{ "dependencies": { "@pixelworlds/city-sf": "^0.2.0", "pixelworld": "^0.2.0" } }`,
    );
    expect(out.get("examples/consumers/esm/cdn.html")).toContain("npm/pixelworld@0.2.0/dist/");
  });
});
