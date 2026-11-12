#!/usr/bin/env node
/**
 * Checks the npm tarballs of the city packs, `@pixelworlds/city-*` (D-074,
 * docs/plugins.md §9.5), before anyone publishes them, as pack-check.mjs does
 * for `pixelworld`: their files and manifest (`pixelworld` as their only peer,
 * no dependencies), their exports, the descriptor's
 * `new URL("./worker.js", import.meta.url)`, and the worker module: it must
 * be self-contained, define the plugin when imported, and register the
 * generators core expects of the pack (KNOWN_PLUGIN_GENERATORS). CI runs it on
 * every push.
 *
 *   node tools/city-pack-check.mjs [pixelworlds-city-*.tgz ...]
 *
 * Without tarballs it packs every packages/city-* (`pnpm pack` builds them)
 * into a temporary directory.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball } from "./pack-check.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** What the descriptor's URL must be built with, so that bundlers copy the worker module beside the entry. */
export const WORKER_URL_LITERAL = 'new URL("./worker.js", import.meta.url)';

/** Size budgets in bytes (the worker module is 28 KB minified, as Vite built it in the workspace, D-071). */
export const BUDGETS = {
  tarball: 160 * 1024, // gzipped .tgz, with the entry's source map
  unpacked: 480 * 1024, // everything, as installed
  worker: 40 * 1024, // dist/worker.js: what a page and each bake worker fetch
};

const ALLOWED = [/^package\.json$/, /^README\.md$/, /^LICENSE-(MIT|APACHE)$/, /^CHANGELOG\.md$/, /^dist\/[\w.-]+\.(js|js\.map|d\.ts)$/];

/** Code without its block comments and whole-line comments (doc comments show imports as examples). */
const uncommented = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The specifiers a module imports, statically or with a literal import() (not in its comments). */
export function importsOf(source) {
  const text = uncommented(source);
  const specs = [];
  for (const m of text.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]+?\s*from\s*)?["']([^"']+)["']/g)) specs.push(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g)) specs.push(m[1]);
  return specs;
}

/** Whether a module imports anything at all, a computed import() included. */
const importsAnything = (text) => importsOf(text).length > 0 || /(?<![\w$.])import\s*\(/.test(uncommented(text));

/**
 * Import the worker module as a bake worker would, from a URL with nothing
 * beside it: what it defines (its exports, and what it announced with
 * definePlugin) and what its plugin registers.
 */
export async function loadWorkerModule(code) {
  const ANNOUNCED = Symbol.for("pixelworld.plugins");
  const before = (globalThis[ANNOUNCED] ?? []).length;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const announced = (globalThis[ANNOUNCED] ?? []).slice(before);
  const plugin = mod.default ?? announced.at(-1);
  const generators = [];
  if (plugin && typeof plugin.register === "function") {
    await plugin.register({
      apiVersion: 1,
      hasGenerator: () => false,
      registerGenerators: (record) => void generators.push(...Object.keys(record)),
    });
  }
  return { exports: Object.keys(mod), name: plugin?.name, announced: announced.map((p) => p.name), generators: generators.sort() };
}

/**
 * Problems with a city pack's tarball (path → contents); empty when it is fit
 * to publish. `name`: the package; `generators`: what its worker must
 * register; `peerRange`: the range of `pixelworld` it must name.
 */
export async function checkCityPack(files, { name = "@pixelworlds/city-sf", generators = null, peerRange = null, licences = null } = {}) {
  const problems = [];
  const has = (f) => files.has(f);
  const text = (f) => files.get(f).toString("utf8");
  for (const f of files.keys()) if (!ALLOWED.some((re) => re.test(f))) problems.push(`unexpected file: ${f}`);
  for (const f of ["package.json", "README.md", "LICENSE-MIT", "LICENSE-APACHE", "dist/index.js", "dist/index.d.ts", "dist/worker.js"])
    if (!has(f)) problems.push(`missing ${f}`);
  if (!has("package.json")) return problems;

  const pkg = JSON.parse(text("package.json"));
  if (pkg.name !== name) problems.push(`name is ${pkg.name}, not ${name}`);
  if (pkg.private) problems.push("package.json is private");
  if (pkg.license !== "MIT OR Apache-2.0") problems.push(`license is ${pkg.license}`);
  if (pkg.type !== "module") problems.push("type is not module");
  for (const field of ["description", "repository", "keywords", "files", "sideEffects"])
    if (pkg[field] === undefined) problems.push(`no "${field}" in package.json`);
  if (pkg.publishConfig?.access !== "public") problems.push('publishConfig.access isn\'t "public" (a scoped package is private by default)');
  if (pkg.publishConfig?.exports) problems.push("publishConfig.exports wasn't applied (pack with pnpm)");
  if (JSON.stringify(pkg).includes("workspace:")) problems.push("package.json still has workspace: ranges");
  for (const field of ["dependencies", "optionalDependencies"])
    if (pkg[field] && Object.keys(pkg[field]).length) problems.push(`"${field}" isn't empty: the worker bundles what it uses, the entry imports pixelworld`);
  const peers = Object.keys(pkg.peerDependencies ?? {});
  if (peers.join() !== "pixelworld") problems.push(`peerDependencies are [${peers}], not [pixelworld]`);
  else if (peerRange && pkg.peerDependencies.pixelworld !== peerRange)
    problems.push(`peer pixelworld is ${pkg.peerDependencies.pixelworld}, not ${peerRange}`);

  const main = pkg.exports?.["."];
  if (!main || typeof main !== "object") problems.push('no export "."');
  else {
    if (Object.keys(main)[0] !== "types") problems.push('".": "types" must come first');
    for (const [cond, want] of [["types", "dist/index.d.ts"], ["import", "dist/index.js"]])
      if (main[cond]?.replace(/^\.\//, "") !== want) problems.push(`"." ${cond} is ${main[cond]}, not ./${want}`);
  }
  const worker = pkg.exports?.["./worker.js"];
  if ((worker?.default ?? worker) !== "./dist/worker.js") problems.push('no export "./worker.js" of dist/worker.js');

  // the entry: its descriptor names the worker beside it, and it imports only its peer
  if (has("dist/index.js")) {
    const index = text("dist/index.js");
    if (!index.includes(WORKER_URL_LITERAL)) problems.push(`dist/index.js has no ${WORKER_URL_LITERAL}`);
    if (/\?worker|["'`]\/assets\//.test(index)) problems.push("dist/index.js names a Vite worker URL (?worker&url): an app wouldn't serve it");
    if (!has("dist/index.js.map")) problems.push("dist/index.js has no source map");
  }
  for (const [f] of files) {
    if (!/^dist\/.*\.(js|d\.ts)$/.test(f) || f === "dist/worker.js") continue;
    for (const spec of importsOf(text(f)))
      if (!spec.startsWith(".") && !/^pixelworld(\/|$)/.test(spec)) problems.push(`${f} imports ${spec}, which isn't its peer pixelworld`);
  }

  // the worker module: loads with nothing beside it, and defines the plugin
  if (has("dist/worker.js")) {
    const code = text("dist/worker.js");
    if (importsAnything(code)) problems.push("dist/worker.js imports a module: a bake worker can't resolve it (bundle it in)");
    else {
      try {
        const w = await loadWorkerModule(code);
        if (w.name !== name) problems.push(`dist/worker.js defines the plugin ${w.name ?? "(none)"}, not ${name}`);
        if (!w.announced.includes(name)) problems.push("dist/worker.js doesn't announce its plugin (definePlugin)");
        if (generators && w.generators.join() !== [...generators].sort().join())
          problems.push(`dist/worker.js registers [${w.generators}], not [${[...generators].sort()}]`);
        else if (!w.generators.length) problems.push("dist/worker.js registers no generators");
      } catch (e) {
        problems.push(`dist/worker.js fails to load on its own: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (licences) for (const [f, body] of Object.entries(licences)) if (has(f) && !files.get(f).equals(body)) problems.push(`${f} differs from the repository's`);
  return problems;
}

/** Sizes against BUDGETS: [label, bytes, budget][]. */
export function sizes(files, tarballBytes) {
  const unpacked = [...files.values()].reduce((n, b) => n + b.length, 0);
  return [
    ["tarball (.tgz)", tarballBytes, BUDGETS.tarball],
    ["unpacked", unpacked, BUDGETS.unpacked],
    ["worker module", files.get("dist/worker.js")?.length ?? 0, BUDGETS.worker],
  ];
}

/** The generators core says the pack provides (KNOWN_PLUGIN_GENERATORS in packages/generators/src/registry.ts). */
export function knownGenerators(registrySource, name) {
  const table = registrySource.match(/KNOWN_PLUGIN_GENERATORS[^=]*=\s*\{([^}]*)\}/)?.[1] ?? "";
  return [...table.matchAll(/(\w+):\s*["']([^"']+)["']/g)].filter(([, , p]) => p === name).map(([, g]) => g);
}

/** Check one tarball; the problems found (printed with its listing and sizes). */
async function checkTarball(tarball) {
  const buf = readFileSync(resolve(tarball));
  const files = readTarball(buf);
  const name = JSON.parse(files.get("package.json")?.toString("utf8") ?? "{}").name ?? "(no package.json)";
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
  console.log(`${tarball}: ${name}, ${files.size} files`);
  for (const [f, b] of [...files].sort()) console.log(`  ${kb(b.length)}  ${f}`);

  const pixelworld = JSON.parse(readFileSync(join(REPO, "packages/pixelworld/package.json"), "utf8"));
  const generators = knownGenerators(readFileSync(join(REPO, "packages/generators/src/registry.ts"), "utf8"), name);
  if (!generators.length) return [`KNOWN_PLUGIN_GENERATORS names no generators of ${name}`];
  const licences = Object.fromEntries(["LICENSE-MIT", "LICENSE-APACHE"].map((f) => [f, readFileSync(join(REPO, f))]));
  const problems = await checkCityPack(files, { name, generators, peerRange: `^${pixelworld.version}`, licences });
  console.log("size budgets");
  for (const [label, bytes, budget] of sizes(files, buf.length)) {
    const over = bytes > budget;
    console.log(`  ${over ? "OVER" : "ok  "} ${label.padEnd(16)} ${kb(bytes)} of ${kb(budget).trim()}`);
    if (over) problems.push(`${label} is ${kb(bytes).trim()}, over its ${kb(budget).trim()} budget`);
  }
  console.log(problems.length ? "" : `passed: the worker registers ${generators.join(", ")}\n`);
  return problems.map((p) => `${name}: ${p}`);
}

async function main() {
  let tarballs = process.argv.slice(2);
  if (!tarballs.length) {
    const dir = mkdtempSync(join(tmpdir(), "city-pack-"));
    const r = spawnSync("pnpm", ["--filter", "@pixelworlds/city-*", "pack", "--pack-destination", dir], { cwd: REPO, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
    tarballs = readdirSync(dir).filter((f) => f.endsWith(".tgz")).map((f) => join(dir, f));
  }
  const problems = [];
  for (const t of tarballs) problems.push(...(await checkTarball(t)));
  if (problems.length) {
    console.error(`${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`city pack check passed: ${tarballs.length} tarball(s)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
