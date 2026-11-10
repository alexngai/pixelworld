import { describe, expect, it } from "vitest";
import { SCHEMAS, SUBPATHS, WORKER_LITERAL, checkPackage, sizes } from "./pack-check.mjs";

/** A tarball's files as pnpm would pack a good build of packages/pixelworld. */
function goodPackage() {
  const exports = Object.fromEntries(
    SUBPATHS.map((s) => [`./${s}`, { types: `./dist/${s}.d.ts`, import: `./dist/${s}.js` }]),
  );
  exports["./bake.worker.js"] = { types: "./dist/bake.worker.d.ts", default: "./dist/bake.worker.js" };
  for (const f of SCHEMAS) exports[`./${f}`] = `./dist/${f}`;
  const pkg = {
    name: "pixelworld",
    version: "0.1.0",
    description: "worlds",
    license: "MIT OR Apache-2.0",
    type: "module",
    repository: { type: "git", url: "git+https://example.org/pixelworld.git" },
    keywords: ["pixel-art"],
    files: ["dist"],
    sideEffects: ["./dist/bake.worker.js"],
    exports,
    devDependencies: { tsup: "9.0.0" },
  };
  const files = new Map([
    ["package.json", Buffer.from(JSON.stringify(pkg))],
    ["README.md", Buffer.from("# pixelworld")],
    ["LICENSE-MIT", Buffer.from("MIT")],
    ["LICENSE-APACHE", Buffer.from("Apache")],
    ["dist/bake.worker.js", Buffer.from("self.onmessage = () => {};")],
    ["dist/chunk-ABC.js", Buffer.from(`export const x = 1;`)],
  ]);
  for (const f of SCHEMAS) files.set(`dist/${f}`, Buffer.from("{}"));
  for (const s of SUBPATHS) {
    const body = s === "engine" ? `export function make() { return ${WORKER_LITERAL}; }` : `export * from "./chunk-ABC.js";`;
    files.set(`dist/${s}.js`, Buffer.from(body));
    files.set(`dist/${s}.js.map`, Buffer.from("{}"));
    files.set(`dist/${s}.d.ts`, Buffer.from("export {};"));
  }
  return { files, pkg };
}

const withManifest = (files, pkg) => new Map([...files, ["package.json", Buffer.from(JSON.stringify(pkg))]]);

describe("pack-check tool", () => {
  it("passes a good package", () => {
    const { files } = goodPackage();
    expect(checkPackage(files, { licences: { "LICENSE-MIT": Buffer.from("MIT") } })).toEqual([]);
  });

  it("finds stray files, missing files and changed licences", () => {
    const { files } = goodPackage();
    files.set("src/engine.ts", Buffer.from(""));
    files.delete("dist/traffic.d.ts");
    files.delete("LICENSE-APACHE");
    const problems = checkPackage(files, { licences: { "LICENSE-MIT": Buffer.from("MIT, edited") } });
    expect(problems).toContain("unexpected file: src/engine.ts");
    expect(problems).toContain("missing LICENSE-APACHE");
    expect(problems).toContain('"./traffic" types → dist/traffic.d.ts, which isn\'t in the tarball');
    expect(problems).toContain("LICENSE-MIT differs from the repository's");
  });

  it("finds workspace dependencies, unapplied publishConfig and private imports", () => {
    const { files, pkg } = goodPackage();
    const bad = withManifest(files, {
      ...pkg,
      dependencies: { "@pixelworlds/engine": "workspace:*" },
      publishConfig: { exports: {} },
    });
    bad.set("dist/traffic.d.ts", Buffer.from(`import { Layer } from "@pixelworlds/engine";`));
    const problems = checkPackage(bad);
    expect(problems).toContain('"dependencies" isn\'t empty: the build bundles everything');
    expect(problems).toContain("package.json still has workspace: ranges");
    expect(problems).toContain("publishConfig.exports wasn't applied (pack with pnpm)");
    expect(problems).toContain("dist/traffic.d.ts imports a private @pixelworlds package");
  });

  it("requires the worker's literal URL in exactly one file", () => {
    const { files } = goodPackage();
    files.set("dist/engine.js", Buffer.from(`new Worker(new URL("./bake.worker.ts", import.meta.url))`));
    const problems = checkPackage(files);
    expect(problems).toContain("the worker literal is in 0 files, not one");
    expect(problems).toContain("dist/engine.js loads bake.worker.ts");
  });

  it("requires the style pack schema, exported", () => {
    const { files, pkg } = goodPackage();
    const bad = withManifest(files, { ...pkg, exports: { ...pkg.exports, "./style-pack.v1.schema.json": undefined } });
    bad.delete("dist/style-pack.v1.schema.json");
    expect(checkPackage(bad)).toEqual([
      'no export "./style-pack.v1.schema.json" of dist/style-pack.v1.schema.json',
      "missing dist/style-pack.v1.schema.json",
    ]);
  });

  it("measures sizes against the budgets", () => {
    const { files } = goodPackage();
    const rows = Object.fromEntries(sizes(files, 1234).map(([label, bytes]) => [label, bytes]));
    expect(rows["tarball (.tgz)"]).toBe(1234);
    expect(rows["bake worker"]).toBe(files.get("dist/bake.worker.js").length);
  });
});
