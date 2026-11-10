/**
 * The bake code's identity (D-072): a hash of the source of everything that
 * turns a world package and a style pack into tile pixels. Baked tiles are
 * cached by it (packages/engine/src/world.ts `tileCacheKey`), so a change to
 * that code makes every tile baked before it unreachable, and nothing else
 * does: editing the compositor, the camera or the app keeps the cache.
 *
 * The code is the bake worker's module graph, followed from
 * packages/runtime/src/bake.worker.ts through relative and @pixelworlds/*
 * imports (the baker and its shaders, the built-in generators, the grid, the
 * style's tables, the bake host and hero paint), plus the main-thread code
 * that decides what a tile bake is given: the world format's decoding
 * (followed from its index), the chunk store's slices and the engine's bake
 * init and tile slices (`world.ts`).
 *
 * It reaches the engine as the constant `__PIXELWORLD_BAKE_CODE__`
 * (packages/bake/src/code.ts):
 *   - the npm build defines it (packages/pixelworld/build.mjs);
 *   - the Vite plugin below sets it in the apps' dev servers and builds, and
 *     sets it again when a file it hashes changes, so a page reloaded after
 *     an edit to a generator or the baker never draws the old tiles.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The repository root. */
export const REPO = fileURLToPath(new URL("..", import.meta.url));
/** The constant the engine reads its bake code identity from. */
export const TOKEN = "__PIXELWORLD_BAKE_CODE__";
/** Where the engine declares it. */
export const CODE_FILE = "packages/bake/src/code.ts";

/** Module graphs that make up the bake: followed through their imports. */
export const ROOTS = ["packages/runtime/src/bake.worker.ts", "packages/world-format/src/index.ts"];
/** Main-thread modules that shape a bake's input: hashed, not followed (they import the rest of the engine). */
export const FILES = ["packages/engine/src/world.ts", "packages/runtime/src/chunkStore.ts"];

const posix = (p) => p.split(sep).join("/");
const isFile = (f) => existsSync(f) && statSync(f).isFile();
const readText = (f) => readFileSync(f, "utf8");

/** The file a specifier names from `from` (a workspace package's export, or a relative path), or null for others. */
function resolveImport(spec, from, root) {
  const path = spec.replace(/\?.*$/, "");
  const ws = /^@pixelworlds\/([\w-]+)(\/.*)?$/.exec(path);
  if (ws) {
    const dir = join(root, "packages", ws[1]);
    const pkg = JSON.parse(readText(join(dir, "package.json")));
    const target = pkg.exports?.[ws[2] ? `.${ws[2]}` : "."];
    return typeof target === "string" ? join(dir, target) : null;
  }
  if (!path.startsWith(".")) return null; // a dependency from npm: none in the bake today
  const base = resolve(dirname(from), path);
  const found = [base, `${base}.ts`, join(base, "index.ts")].find(isFile);
  if (!found) throw new Error(`${posix(relative(root, from))}: can't resolve "${spec}"`);
  return found;
}

/**
 * The bake's source files (repository-relative, sorted) and their hash: 16 hex
 * digits of a SHA-256 of each file's path and text. `read` reads a file (tests
 * give their own).
 */
export function bakeCodeIdentity(root = REPO, read = readText) {
  const files = new Set(FILES.map((f) => join(root, f)));
  const visited = new Set();
  const queue = ROOTS.map((f) => join(root, f));
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    files.add(file);
    for (const { fileName } of ts.preProcessFile(read(file), true, true).importedFiles) {
      const dep = resolveImport(fileName, file, root);
      if (dep && !visited.has(dep)) queue.push(dep);
    }
  }
  const list = [...files].map((f) => posix(relative(root, f))).sort();
  const h = createHash("sha256");
  for (const f of list) h.update(`${f}\n`).update(read(join(root, f))).update("\0");
  return { hash: h.digest("hex").slice(0, 16), files: list };
}

/** The bake code's identity (bakeCodeIdentity's hash). */
export function bakeCodeHash(root = REPO, read = readText) {
  return bakeCodeIdentity(root, read).hash;
}

/**
 * A Vite plugin that sets the bake code identity in the module that reads it
 * (CODE_FILE), and, in a dev server, transforms that module again when a file
 * the identity hashes changes, so the reload that follows the edit has it.
 */
export function bakeCode({ root = REPO } = {}) {
  let files = new Set();
  const pattern = new RegExp(`\\b${TOKEN}\\b`, "g");
  return {
    name: "pixelworld-bake-code",
    transform(code, id) {
      if (!code.includes(TOKEN) || id.includes("/node_modules/")) return null;
      const { hash, files: list } = bakeCodeIdentity(root);
      files = new Set(list.map((f) => join(root, f)));
      return { code: code.replace(pattern, JSON.stringify(hash)), map: null };
    },
    hotUpdate({ file, modules }) {
      if (!files.has(resolve(file))) return;
      const mods = this.environment.moduleGraph.getModulesByFile(join(root, CODE_FILE));
      return mods ? [...modules, ...mods] : undefined;
    },
  };
}
