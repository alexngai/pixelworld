import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  exports: Record<string, string>;
  publishConfig: { exports: Record<string, unknown> };
  sideEffects: string[];
  files: string[];
}
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Manifest;
const subpaths = Object.keys(pkg.exports).filter((k) => k !== "./package.json");
const ENTRIES = /const ENTRIES = (\[[^\]]*\])/.exec(readFileSync(new URL("../build.mjs", import.meta.url), "utf8"))?.[1];

describe("pixelworld's exports", () => {
  it("has the root and subpath exports, each a source file in the workspace", () => {
    expect(subpaths).toEqual([".", "./engine", "./boards", "./maps", "./format", "./grid", "./style", "./generators", "./traffic"]);
    for (const k of subpaths) {
      const name = k === "." ? "index" : k.slice(2);
      expect(pkg.exports[k]).toBe(`./src/${name}.ts`);
      expect(existsSync(new URL(`../src/${name}.ts`, import.meta.url))).toBe(true);
    }
  });

  it("publishes each from dist/, types first, plus the worker", () => {
    const pub = pkg.publishConfig.exports;
    for (const k of subpaths) {
      const name = k === "." ? "index" : k.slice(2);
      expect(pub[k]).toEqual({ types: `./dist/${name}.d.ts`, import: `./dist/${name}.js` });
      expect(Object.keys(pub[k] as object)[0]).toBe("types");
    }
    expect(pub["./bake.worker.js"]).toEqual({ types: "./dist/bake.worker.d.ts", default: "./dist/bake.worker.js" });
    // the style pack schema, for editors (D-075): build.mjs copies it from packages/style
    expect(pub["./style-pack.v1.schema.json"]).toBe("./dist/style-pack.v1.schema.json");
    expect(existsSync(new URL("../../style/schema/style-pack.v1.schema.json", import.meta.url))).toBe(true);
    expect(Object.keys(pub).sort()).toEqual([...subpaths, "./bake.worker.js", "./style-pack.v1.schema.json", "./package.json"].sort());
    expect(pkg.sideEffects).toEqual(["./dist/bake.worker.js"]);
    expect(pkg.files).toContain("dist");
  });

  it("builds every entry point", () => {
    expect(ENTRIES && (JSON.parse(ENTRIES) as string[]).map((e) => (e === "index" ? "." : `./${e}`))).toEqual(subpaths);
  });

  it("re-exports the workspace packages", async () => {
    const [root, engine, boards, maps, traffic, format, grid] = await Promise.all([
      import("../src/index"),
      import("../src/engine"),
      import("../src/boards"),
      import("../src/maps"),
      import("../src/traffic"),
      import("../src/format"),
      import("../src/grid"),
    ]);
    expect(typeof root.createWorldView).toBe("function");
    expect(typeof root.cameraController).toBe("function");
    expect(typeof root.trafficLayer).toBe("function");
    expect(typeof engine.createWorldView).toBe("function");
    expect(typeof engine.roverController).toBe("function");
    expect(typeof boards.Boards).toBe("function");
    expect(typeof boards.readCells).toBe("function");
    expect(typeof maps.Minimap).toBe("function");
    expect(typeof maps.TopDownMap).toBe("function");
    expect(typeof traffic.trafficLayer).toBe("function");
    expect(typeof format.parseManifest).toBe("function");
    expect(typeof grid.project).toBe("function");
  });
});
