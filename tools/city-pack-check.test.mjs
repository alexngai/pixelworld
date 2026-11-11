import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKER_URL_LITERAL, checkCityPack, importsOf, knownGenerators, loadWorkerModule, sizes } from "./city-pack-check.mjs";

const NAME = "@pixelworlds/city-sf";
const GENERATORS = ["block", "rowhouse"];

/** A worker module as the build makes it: self-contained, announcing its plugin (definePlugin) and exporting it. */
const workerModule = ({ name = NAME, generators = GENERATORS, announce = true } = {}) =>
  `const p={name:${JSON.stringify(name)},register(a){a.registerGenerators({${generators.map((g) => `${g}(){}`).join(",")}})}};` +
  (announce ? `(globalThis[Symbol.for("pixelworld.plugins")]??=[]).push(p);` : "") +
  `export default p;export const name=p.name;export const register=p.register;`;

/** A tarball's files as pnpm would pack a good build of packages/city-sf. */
function goodPack() {
  const pkg = {
    name: NAME,
    version: "0.1.0",
    description: "San Francisco's city pack",
    license: "MIT OR Apache-2.0",
    type: "module",
    repository: { type: "git", url: "git+https://example.org/pixelworld.git" },
    keywords: ["pixelworld"],
    files: ["dist"],
    sideEffects: ["./dist/worker.js"],
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./worker.js": { types: "./dist/worker.d.ts", default: "./dist/worker.js" },
      "./package.json": "./package.json",
    },
    publishConfig: { access: "public" },
    peerDependencies: { pixelworld: "^0.1.0" },
    devDependencies: { pixelworld: "0.1.0", tsup: "9.0.0" },
  };
  const files = new Map([
    ["package.json", Buffer.from(JSON.stringify(pkg))],
    ["README.md", Buffer.from("# @pixelworlds/city-sf")],
    ["LICENSE-MIT", Buffer.from("MIT")],
    ["LICENSE-APACHE", Buffer.from("Apache")],
    [
      "dist/index.js",
      Buffer.from(
        `import { registerPlugin } from "pixelworld/generators";\n` +
          `/** import { cityPlugin } from "@pixelworlds/city-sf"; */\n` +
          `export const cityPlugin = { name: "${NAME}", url: ${WORKER_URL_LITERAL}.href };\n`,
      ),
    ],
    ["dist/index.js.map", Buffer.from("{}")],
    ["dist/index.d.ts", Buffer.from(`import { PluginDescriptor } from 'pixelworld/generators';\ndeclare const cityPlugin: PluginDescriptor;\n`)],
    ["dist/worker.js", Buffer.from(workerModule())],
    ["dist/worker.d.ts", Buffer.from(`import type { Plugin } from "pixelworld/generators";\n`)],
  ]);
  return { files, pkg };
}

const withManifest = (files, pkg) => new Map([...files, ["package.json", Buffer.from(JSON.stringify(pkg))]]);
const opts = { generators: GENERATORS, peerRange: "^0.1.0" };

describe("city-pack-check tool", () => {
  it("passes a good city pack", async () => {
    const { files } = goodPack();
    expect(await checkCityPack(files, { ...opts, licences: { "LICENSE-MIT": Buffer.from("MIT") } })).toEqual([]);
  });

  it("finds stray and missing files, and changed licences", async () => {
    const { files } = goodPack();
    files.set("src/index.ts", Buffer.from(""));
    files.delete("README.md");
    files.delete("dist/index.js.map");
    const problems = await checkCityPack(files, { ...opts, licences: { "LICENSE-MIT": Buffer.from("MIT, edited") } });
    expect(problems).toContain("unexpected file: src/index.ts");
    expect(problems).toContain("missing README.md");
    expect(problems).toContain("dist/index.js has no source map");
    expect(problems).toContain("LICENSE-MIT differs from the repository's");
  });

  it("wants pixelworld as the only peer, no dependencies, and a public, applied publishConfig", async () => {
    const { files, pkg } = goodPack();
    const bad = withManifest(files, {
      ...pkg,
      private: true,
      dependencies: { "@pixelworlds/generators": "workspace:*" },
      peerDependencies: { pixelworld: "workspace:^" },
      publishConfig: { exports: {} },
    });
    const problems = await checkCityPack(bad, opts);
    expect(problems).toContain("package.json is private");
    expect(problems).toContain(`"dependencies" isn't empty: the worker bundles what it uses, the entry imports pixelworld`);
    expect(problems).toContain("package.json still has workspace: ranges");
    expect(problems).toContain("peer pixelworld is workspace:^, not ^0.1.0");
    expect(problems).toContain("publishConfig.exports wasn't applied (pack with pnpm)");
    expect(problems).toContain('publishConfig.access isn\'t "public" (a scoped package is private by default)');
    const noPeer = await checkCityPack(withManifest(files, { ...pkg, peerDependencies: undefined }), opts);
    expect(noPeer).toContain("peerDependencies are [], not [pixelworld]");
  });

  it("checks the exports", async () => {
    const { files, pkg } = goodPack();
    const exports = { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" }, "./worker": "./src/worker.ts" };
    const problems = await checkCityPack(withManifest(files, { ...pkg, exports }), opts);
    expect(problems).toContain('".": "types" must come first');
    expect(problems).toContain('no export "./worker.js" of dist/worker.js');
  });

  it("wants the descriptor on new URL(\"./worker.js\", import.meta.url), and imports of the peer only", async () => {
    const { files } = goodPack();
    files.set(
      "dist/index.js",
      Buffer.from(`import { registerPlugin } from "@pixelworlds/generators";\nexport const cityPlugin = { url: "/assets/worker-sf.js?worker&url" };\n`),
    );
    files.set("dist/index.d.ts", Buffer.from(`import { Plugin } from "@pixelworlds/generators";\n`));
    const problems = await checkCityPack(files, opts);
    expect(problems).toContain(`dist/index.js has no ${WORKER_URL_LITERAL}`);
    expect(problems).toContain("dist/index.js names a Vite worker URL (?worker&url): an app wouldn't serve it");
    expect(problems).toContain("dist/index.js imports @pixelworlds/generators, which isn't its peer pixelworld");
    expect(problems).toContain("dist/index.d.ts imports @pixelworlds/generators, which isn't its peer pixelworld");
  });

  it("wants a self-contained worker module that defines the plugin and registers its generators", async () => {
    const { files } = goodPack();
    const check = async (code) => checkCityPack(new Map([...files, ["dist/worker.js", Buffer.from(code)]]), opts);
    expect(await check(`import{definePlugin as d}from"pixelworld/generators";export default d({})`)).toContain(
      "dist/worker.js imports a module: a bake worker can't resolve it (bundle it in)",
    );
    expect(await check(`const u="x.js";await import(u);`)).toContain(
      "dist/worker.js imports a module: a bake worker can't resolve it (bundle it in)",
    );
    expect(await check(workerModule({ name: "@pixelworlds/city-nyc" }))).toContain(
      "dist/worker.js defines the plugin @pixelworlds/city-nyc, not @pixelworlds/city-sf",
    );
    expect(await check(workerModule({ announce: false }))).toContain("dist/worker.js doesn't announce its plugin (definePlugin)");
    expect(await check(workerModule({ generators: ["rowhouse"] }))).toContain("dist/worker.js registers [rowhouse], not [block,rowhouse]");
    expect(await check(`export default 1;`)).toContain("dist/worker.js defines the plugin (none), not @pixelworlds/city-sf");
    const thrown = await check(`throw new Error("no window here");`);
    expect(thrown).toContain("dist/worker.js fails to load on its own: no window here");
  });

  it("loads a worker module as a bake worker would", async () => {
    const w = await loadWorkerModule(workerModule({ generators: ["gate", "block"] }));
    expect(w).toEqual({ exports: ["default", "name", "register"], name: NAME, announced: [NAME], generators: ["block", "gate"] });
  });

  it("reads imports but not doc comments", () => {
    const code = `/**\n * import { cityPlugin } from "@pixelworlds/city-sf";\n */\n// import "nope";\nimport{a as b}from"x";export*from"./y.js";import "z";\nconst m = import("w");`;
    expect(importsOf(code)).toEqual(["x", "./y.js", "z", "w"]);
  });

  it("knows the generators core expects of the pack, from the registry's table", () => {
    const registry = readFileSync(new URL("../packages/generators/src/registry.ts", import.meta.url), "utf8");
    expect(knownGenerators(registry, NAME).sort()).toEqual(["block", "decoTower", "gate", "lanterns", "rowhouse", "sfTower"]);
    expect(knownGenerators(registry, "@pixelworlds/city-nyc").sort()).toEqual(["brownstone", "castIronLoft", "prewarBlock", "tenement"]);
    expect(knownGenerators(registry, "@pixelworlds/city-paris").sort()).toEqual(["cathedral", "domedChurch", "faubourg", "glassPalace", "haussmann", "hbm", "latticeArchTower", "operaHouse", "palace", "steelArchBridge", "stoneArchBridge", "triumphalArch"]);
    expect(knownGenerators(registry, "@pixelworlds/city-kyoto").sort()).toEqual(["candleTower", "goldenPavilion", "kura", "machiya", "midrise", "pagoda", "templeHall", "torii", "towerGate", "utilityPole"]);
    expect(knownGenerators(registry, "@my-org/city-vegas")).toEqual([]);
  });

  it("measures sizes against the budgets", () => {
    const { files } = goodPack();
    const rows = Object.fromEntries(sizes(files, 999).map(([label, bytes]) => [label, bytes]));
    expect(rows["tarball (.tgz)"]).toBe(999);
    expect(rows["worker module"]).toBe(files.get("dist/worker.js").length);
  });
});
