// Builds the publishable city pack `@pixelworlds/city-sf` into dist/ (docs/plugins.md §9.5, D-074).
//
// - dist/index.js (and index.d.ts): the main entry. `pixelworld` is a peer
//   dependency and stays external (`pixelworld/generators`), so `register()`
//   and the generators use the app's one copy of the registry. The worker's
//   URL, `?worker&url` for Vite in the workspace, becomes the standard
//   `new URL("./worker.js", import.meta.url)`, which Vite, webpack 5 and
//   Rollup follow, copying the file into the app's build.
// - dist/worker.js: the module the bake worker imports by URL, self-contained
//   (what it uses of pixelworld/generators is bundled in: a worker can't
//   resolve a bare specifier) and minified, since bundlers copy it as it is.
//
// Run: pnpm --filter @pixelworlds/city-sf build (`pnpm pack` runs it too, as prepack).
// Types are checked by the workspace's `pnpm typecheck`; the tarball by tools/city-pack-check.mjs.
import { copyFile, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const ROOT = here("../../");
const DIST = here("./dist/");
const pkg = JSON.parse(await readFile(here("package.json"), "utf8"));

export const WORKER_IMPORT = /import\s+(\w+)\s+from\s+(["'])\.\/worker\?worker&url\2;?/;
export const WORKER_URL_LITERAL = 'new URL("./worker.js", import.meta.url)';

/** The worker module's URL: Vite's `?worker&url` import becomes `new URL("./worker.js", import.meta.url)`. */
const workerUrlPlugin = {
  name: "city-pack-worker-url",
  setup(b) {
    b.onLoad({ filter: /[\\/]city-sf[\\/]src[\\/]index\.ts$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const out = src.replace(WORKER_IMPORT, (_, name) => `const ${name} = ${WORKER_URL_LITERAL}.href;`);
      if (out === src) throw new Error(`${args.path}: no import of "./worker?worker&url" to rewrite`);
      return { contents: out, loader: "ts" };
    });
  },
};

const common = {
  format: ["esm"],
  platform: "browser",
  target: "es2022",
  outDir: DIST,
  clean: false,
  tsconfig: here("tsconfig.build.json"),
};

await rm(DIST, { recursive: true, force: true });
await Promise.all(["LICENSE-MIT", "LICENSE-APACHE"].map((f) => copyFile(ROOT + f, here(f))));

await build({
  ...common,
  entry: { index: here("src/index.ts") },
  external: [/^pixelworld(\/|$)/],
  sourcemap: true,
  splitting: false,
  dts: { entry: { index: here("src/index.ts") } },
  esbuildPlugins: [workerUrlPlugin],
});
await build({
  ...common,
  entry: { worker: here("src/worker.ts") },
  noExternal: [/.*/],
  splitting: false,
  minify: true,
  sourcemap: false,
  dts: false,
});
await writeFile(
  DIST + "worker.d.ts",
  "// The city pack's worker module: a bake worker imports it by URL (cityPlugin.url); it defines the plugin.\n" +
    'import type { Plugin } from "pixelworld/generators";\n' +
    "declare const plugin: Plugin;\nexport default plugin;\nexport declare const name: string;\n" +
    'export declare const register: Plugin["register"];\n',
);

// What consumers depend on, checked here rather than found broken downstream (tools/city-pack-check.mjs checks more).
const files = await readdir(DIST);
for (const f of ["index.js", "index.d.ts", "worker.js", "worker.d.ts"]) if (!files.includes(f)) throw new Error(`dist/${f} is missing`);
const index = await readFile(DIST + "index.js", "utf8");
if (!index.includes(WORKER_URL_LITERAL)) throw new Error(`dist/index.js has no ${WORKER_URL_LITERAL}`);
if (/\?worker|\/assets\//.test(index)) throw new Error("dist/index.js still names a Vite worker URL");
const worker = await readFile(DIST + "worker.js", "utf8");
if (/(?:^|[;}\s])import\s*[\w{*"'(]|\bexport\s*\*\s*from|\bfrom\s*["']/.test(worker))
  throw new Error("dist/worker.js imports a module: it must be self-contained");
// the workspace's other @pixelworlds packages are private; the pack's own name may appear (its doc comments)
const PRIVATE_IMPORT = new RegExp(`(?:from|import)\\s*\\(?\\s*["']@pixelworlds/(?!${pkg.name.split("/")[1]}["'/])`);
for (const f of files.filter((f) => /\.(js|d\.ts)$/.test(f))) {
  const text = await readFile(DIST + f, "utf8");
  if (PRIVATE_IMPORT.test(text)) throw new Error(`dist/${f} imports a private @pixelworlds package`);
}
const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`${pkg.name}: dist/index.js (${kb(index)}), dist/worker.js (${kb(worker)}, self-contained)`);
