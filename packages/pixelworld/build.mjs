// Builds the publishable `pixelworld` package into dist/ (docs/library.md §3.5).
//
// - The library: one esbuild build (through tsup) of every subpath entry with
//   code splitting, so `pixelworld/engine` and `pixelworld/traffic` share one
//   copy of what they have in common (one generator registry, one set of
//   classes). The private workspace packages (@pixelworlds/*) are bundled in,
//   and their declarations are bundled into dist/*.d.ts (tsconfig.build.json
//   maps them to source). Not minified: consumers' bundlers minify, and
//   readable chunks tree-shake and debug better.
// - The bake worker: a second build, one self-contained module worker,
//   dist/bake.worker.js, beside the engine's chunks. The engine creates it
//   with a literal
//   `new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })`,
//   which Vite, webpack 5 and plain ESM all resolve. In the workspace the same
//   line names ./bake.worker.ts; the plugin below rewrites only that URL.
//   Its syntax and names are minified, not its whitespace: esbuild drops
//   comments when it minifies whitespace, and a dynamic import(url) (plugins)
//   needs its /* webpackIgnore: true */ to reach webpack. Consumers' bundlers
//   minify it fully (Vite's build: 145 KB).
//
// Run: pnpm --filter pixelworld build (`pnpm pack` runs it too, as prepack).
// Types are checked by the workspace's `pnpm typecheck`, not here.
import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../../");
const DIST = here("./dist/");

/** The subpath exports: `pixelworld/<name>` is built from src/<name>.ts. */
const ENTRIES = ["engine", "format", "grid", "style", "generators", "traffic"];
const entry = Object.fromEntries(ENTRIES.map((e) => [e, here(`src/${e}.ts`)]));
const WORKER_ENTRY = here("../runtime/src/bake.worker.ts");
const WORKER_SRC = /new URL\(\s*(["'])\.\/bake\.worker\.ts\1\s*,\s*import\.meta\.url\s*\)/g;
const WORKER_LITERAL = 'new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })';
const PRIVATE_IMPORT = /(?:from|import)\s*\(?\s*["']@pixelworlds\//;
/** A dynamic import: its leading comments, and the quote if its specifier is a literal. */
const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(((?:\s|\/\*[\s\S]*?\*\/)*)(["'`])?/g;

/** Rewrites the worker's source URL (.ts) to the built file (.js) in the one module that names it. */
const workerUrlPlugin = {
  name: "pixelworld-worker-url",
  setup(b) {
    b.onLoad({ filter: /[\\/]runtime[\\/]src[\\/]bakeService\.ts$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const out = src.replace(WORKER_SRC, 'new URL("./bake.worker.js", import.meta.url)');
      if (out === src) throw new Error(`${args.path}: no new URL("./bake.worker.ts", import.meta.url) to rewrite`);
      return { contents: out, loader: "ts" };
    });
  },
};

const common = {
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outDir: DIST,
  clean: false,
  // the private workspace packages are bundled in: the published package has no dependencies
  noExternal: [/^@pixelworlds\//],
  tsconfig: here("tsconfig.build.json"),
};

await rm(DIST, { recursive: true, force: true });
await Promise.all(["LICENSE-MIT", "LICENSE-APACHE"].map((f) => copyFile(ROOT + f, here(f))));
// the style pack schema, for editors: `"$schema": "…/node_modules/pixelworld/dist/style-pack.v1.schema.json"` (D-075)
const SCHEMA = "style-pack.v1.schema.json";

await build({ ...common, entry, splitting: true, dts: { entry }, esbuildPlugins: [workerUrlPlugin] });
await build({
  ...common,
  entry: { "bake.worker": WORKER_ENTRY },
  splitting: false,
  minifySyntax: true,
  minifyIdentifiers: true,
  dts: false,
});
await copyFile(here(`../style/schema/${SCHEMA}`), DIST + SCHEMA);
// `pixelworld/bake.worker.js` is exported for copying (workerUrl), not importing; it still declares itself
await writeFile(
  DIST + "bake.worker.d.ts",
  "// The bake worker: a module worker script to start, not a module to import. Start it with\n" +
    '// new Worker(url, { type: "module" }), or pass its URL to createWorldView as `workerUrl`.\nexport {};\n',
);

// What consumers depend on, checked here rather than found broken downstream.
const files = await readdir(DIST);
const withLiteral = [];
for (const f of files.filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
  const text = await readFile(DIST + f, "utf8");
  if (text.includes(WORKER_LITERAL)) withLiteral.push(f);
  if (/["'`][^"'`]*bake\.worker\.ts["'`]/.test(text)) throw new Error(`dist/${f} still loads bake.worker.ts`);
  if (PRIVATE_IMPORT.test(text)) throw new Error(`dist/${f} imports a private @pixelworlds package`);
  // webpack would make import(url) a context module of dist/ and fail at run time
  for (const [, comments, quote] of f.endsWith(".js") ? text.matchAll(DYNAMIC_IMPORT) : []) {
    if (!quote && !/webpackIgnore:\s*true/.test(comments))
      throw new Error(`dist/${f}: a dynamic import(url) needs /* @vite-ignore */ /* webpackIgnore: true */ before its URL`);
  }
}
if (withLiteral.length !== 1) throw new Error(`expected the worker literal in one file, found it in [${withLiteral}]`);
for (const f of [...ENTRIES.flatMap((n) => [`${n}.js`, `${n}.d.ts`]), "bake.worker.js", SCHEMA]) {
  if (!files.includes(f)) throw new Error(`dist/${f} is missing`);
}
console.log(`pixelworld: dist/ has ${ENTRIES.join(", ")} and bake.worker; the worker is created in dist/${withLiteral[0]}`);
