import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_FILE, REPO, TOKEN, bakeCode, bakeCodeHash, bakeCodeIdentity } from "./bake-code.mjs";

/**
 * The bake code's identity (D-072), which keys the tile cache: it changes with
 * the code that bakes a tile and with nothing else.
 */

/** The repository's files, with one edited. */
const editing = (file, edit = (text) => `${text}\n// an edit\n`) => (f) => {
  const text = readFileSync(f, "utf8");
  return f === join(REPO, file) ? edit(text) : text;
};

describe("the bake code's identity", () => {
  const { hash, files } = bakeCodeIdentity();

  it("hashes the bake worker's modules and the main-thread code that shapes a bake's input", () => {
    for (const f of [
      "packages/bake/src/baker.ts",
      "packages/bake/src/shaders.ts",
      "packages/generators/src/builtins.ts",
      "packages/generators/src/trees.ts",
      "packages/generators/src/assets.ts",
      "packages/grid/src/terrain.ts",
      "packages/style/src/index.ts",
      "packages/engine/src/runtime/bake.worker.ts",
      "packages/engine/src/runtime/bakeHost.ts",
      "packages/engine/src/runtime/heroPaint.ts",
      "packages/engine/src/runtime/chunkStore.ts",
      "packages/world-format/src/chunk.ts",
      "packages/engine/src/world.ts",
      CODE_FILE,
    ])
      expect(files, f).toContain(f);
    // what draws the baked tiles, or never reaches a bake
    for (const f of [
      "packages/engine/src/runtime/compositor.ts",
      "packages/engine/src/runtime/camera.ts",
      "packages/engine/src/runtime/tileCache.ts",
      "packages/engine/src/view.ts",
      "packages/engine/src/camera.ts",
      "packages/engine/src/rover.ts",
      "packages/city-sf/src/facades.ts",
      "packages/sim/src/sim.ts",
    ])
      expect(files, f).not.toContain(f);
    expect(files).toEqual([...files].sort());
  });

  it("is 16 hex digits, the same for the same code", () => {
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(bakeCodeHash()).toBe(hash);
  });

  it("changes when a generator, the baker, its shaders or the bake pipeline change", () => {
    for (const f of [
      "packages/generators/src/builtins.ts",
      "packages/generators/src/voxel.ts",
      "packages/bake/src/baker.ts",
      "packages/bake/src/shaders.ts",
      "packages/engine/src/runtime/bakeHost.ts",
      "packages/engine/src/world.ts",
      "packages/world-format/src/chunk.ts",
    ])
      expect(bakeCodeHash(REPO, editing(f)), f).not.toBe(hash);
  });

  it("stays the same when code outside the bake changes", () => {
    for (const f of ["packages/engine/src/runtime/compositor.ts", "packages/engine/src/view.ts", "packages/engine/src/rover.ts"])
      expect(bakeCodeHash(REPO, editing(f)), f).toBe(hash);
  });

  it("follows a new import into the bake", () => {
    // builtins.ts importing the compositor brings it into the bake's code
    const read = editing("packages/generators/src/builtins.ts", (t) => `import "../../engine/src/runtime/compositor";\n${t}`);
    expect(bakeCodeIdentity(REPO, read).files).toContain("packages/engine/src/runtime/compositor.ts");
  });
});

describe("the Vite plugin", () => {
  const plugin = bakeCode();

  it("sets the identity where the engine reads it, and nowhere else", () => {
    const code = `export const BAKE_CODE = typeof ${TOKEN} === "string" ? ${TOKEN} : null;`;
    const out = plugin.transform(code, join(REPO, CODE_FILE));
    expect(out.code).toBe(`export const BAKE_CODE = typeof "${bakeCodeHash()}" === "string" ? "${bakeCodeHash()}" : null;`);
    expect(plugin.transform("export const x = 1;", join(REPO, "packages/engine/src/view.ts"))).toBeNull();
  });

  it("transforms the identity's module again when a file of the bake changes, not otherwise", () => {
    const codeModule = { id: join(REPO, CODE_FILE) };
    const context = { environment: { moduleGraph: { getModulesByFile: (f) => (f === join(REPO, CODE_FILE) ? new Set([codeModule]) : undefined) } } };
    const edited = { id: "builtins" };
    plugin.transform(`export const c = ${TOKEN};`, join(REPO, CODE_FILE)); // what it hashed then
    const hot = (file) => plugin.hotUpdate.call(context, { file, modules: [edited] });
    expect(hot(join(REPO, "packages/generators/src/builtins.ts"))).toEqual([edited, codeModule]);
    expect(hot(join(REPO, "packages/engine/src/runtime/compositor.ts"))).toBeUndefined();
  });
});
