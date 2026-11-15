#!/usr/bin/env node
/**
 * Checks the npm tarball of `pixelworld` before anyone publishes it
 * (docs/npm.md, "Releases"): what's in it, its manifest, the bake worker's
 * literal URL, and its size budgets. CI runs it on every push.
 *
 *   node tools/pack-check.mjs [pixelworld-x.y.z.tgz]
 *
 * Without a tarball it packs packages/pixelworld (`pnpm pack` builds it) into
 * a temporary directory. The gzipped size of what a consumer bundles is
 * size-limit's job (packages/pixelworld/.size-limit.json).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The subpath exports, each with ESM and declarations. */
export const SUBPATHS = ["engine", "format", "grid", "style", "generators", "traffic"];
export const WORKER_LITERAL = 'new Worker(new URL("./bake.worker.js", import.meta.url), { type: "module" })';

/**
 * Size budgets in bytes for what the tarball ships (D3: ~260 KB of JS and a 145 KB worker, minified;
 * here the library is unminified and the worker minified but for whitespace, see build.mjs).
 */
export const BUDGETS = {
  tarball: 800 * 1024, // gzipped .tgz, with source maps (769.3 KB with the national parks, D-136–D-141)
  unpacked: 2.75 * 1024 * 1024, // everything, as installed
  js: 740 * 1024, // dist/*.js without maps: the library chunks and the worker (702.8 KB with D-124/D-125's edits, cells and veil)
  worker: 210 * 1024, // dist/bake.worker.js (Vite and webpack minify it to ~145 KB)
};

/** JSON Schemas shipped for editors (D-075), each exported as `./<file>`. */
export const SCHEMAS = ["style-pack.v1.schema.json"];

const ALLOWED = [
  /^package\.json$/,
  /^README\.md$/,
  /^LICENSE-(MIT|APACHE)$/,
  /^CHANGELOG\.md$/,
  /^dist\/[\w.-]+\.(js|js\.map|d\.ts)$/,
  /^dist\/[\w.-]+\.schema\.json$/,
];

/** Files in a .tgz: path (without the `package/` prefix) → contents. */
export function readTarball(buf) {
  const tar = gunzipSync(buf);
  const files = new Map();
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const name = [str(345, 500), str(0, 100)].filter(Boolean).join("/");
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") files.set(name.replace(/^package\//, ""), tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Problems with a tarball's files (path → contents); empty when it is fit to publish. */
export function checkPackage(files, { licences = null } = {}) {
  const problems = [];
  const has = (f) => files.has(f);
  for (const f of files.keys()) if (!ALLOWED.some((re) => re.test(f))) problems.push(`unexpected file: ${f}`);
  for (const f of ["package.json", "README.md", "LICENSE-MIT", "LICENSE-APACHE", "dist/bake.worker.js"])
    if (!has(f)) problems.push(`missing ${f}`);
  if (!has("package.json")) return problems;

  const pkg = JSON.parse(files.get("package.json").toString("utf8"));
  if (pkg.name !== "pixelworld") problems.push(`name is ${pkg.name}`);
  if (pkg.private) problems.push("package.json is private");
  if (pkg.license !== "MIT OR Apache-2.0") problems.push(`license is ${pkg.license}`);
  if (pkg.type !== "module") problems.push("type is not module");
  for (const field of ["description", "repository", "keywords", "files", "sideEffects"])
    if (pkg[field] === undefined) problems.push(`no "${field}" in package.json`);
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"])
    if (pkg[field] && Object.keys(pkg[field]).length) problems.push(`"${field}" isn't empty: the build bundles everything`);
  if (JSON.stringify(pkg).includes("workspace:")) problems.push("package.json still has workspace: ranges");
  if (pkg.publishConfig?.exports) problems.push("publishConfig.exports wasn't applied (pack with pnpm)");

  for (const sub of SUBPATHS) {
    const exp = pkg.exports?.[`./${sub}`];
    if (!exp || typeof exp !== "object") {
      problems.push(`no export "./${sub}"`);
      continue;
    }
    const keys = Object.keys(exp);
    if (keys[0] !== "types") problems.push(`"./${sub}": "types" must come first`);
    for (const cond of ["types", "import"]) {
      const target = exp[cond]?.replace(/^\.\//, "");
      if (!target) problems.push(`"./${sub}" has no "${cond}"`);
      else if (!has(target)) problems.push(`"./${sub}" ${cond} → ${target}, which isn't in the tarball`);
    }
    if (has(`dist/${sub}.js`) && !has(`dist/${sub}.js.map`)) problems.push(`dist/${sub}.js has no source map`);
  }
  const worker = pkg.exports?.["./bake.worker.js"];
  if ((worker?.default ?? worker) !== "./dist/bake.worker.js") problems.push('no export "./bake.worker.js" of dist/bake.worker.js');
  for (const schema of SCHEMAS) {
    if (pkg.exports?.[`./${schema}`] !== `./dist/${schema}`) problems.push(`no export "./${schema}" of dist/${schema}`);
    if (!has(`dist/${schema}`)) problems.push(`missing dist/${schema}`);
  }

  // the worker: created with a literal URL from a file beside it, so bundlers pick it up
  const creators = [...files].filter(([f, b]) => /^dist\/[^/]+\.js$/.test(f) && b.toString("utf8").includes(WORKER_LITERAL));
  if (creators.length !== 1) problems.push(`the worker literal is in ${creators.length} files, not one`);
  for (const [f, b] of files) {
    if (!/\.(js|d\.ts)$/.test(f)) continue;
    const text = b.toString("utf8");
    if (/(?:from|import)\s*\(?\s*["']@pixelworlds\//.test(text)) problems.push(`${f} imports a private @pixelworlds package`);
    if (/["'`][^"'`]*bake\.worker\.ts["'`]/.test(text)) problems.push(`${f} loads bake.worker.ts`);
  }

  if (licences) for (const [f, text] of Object.entries(licences)) if (has(f) && !files.get(f).equals(text)) problems.push(`${f} differs from the repository's`);
  return problems;
}

/** Sizes against BUDGETS: [label, bytes, budget][]. */
export function sizes(files, tarballBytes) {
  const sum = (pred) => [...files].filter(([f]) => pred(f)).reduce((n, [, b]) => n + b.length, 0);
  return [
    ["tarball (.tgz)", tarballBytes, BUDGETS.tarball],
    ["unpacked", sum(() => true), BUDGETS.unpacked],
    ["JS (dist/*.js, no maps)", sum((f) => /^dist\/.*\.js$/.test(f)), BUDGETS.js],
    ["bake worker", files.get("dist/bake.worker.js")?.length ?? 0, BUDGETS.worker],
  ];
}

function main() {
  let tarball = process.argv[2];
  if (!tarball) {
    const dir = mkdtempSync(join(tmpdir(), "pixelworld-pack-"));
    const r = spawnSync("pnpm", ["--filter", "pixelworld", "pack", "--pack-destination", dir], { cwd: REPO, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
    tarball = join(dir, readdirSync(dir).find((f) => f.endsWith(".tgz")));
  }
  const buf = readFileSync(resolve(tarball));
  const files = readTarball(buf);
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`.padStart(10);
  console.log(`${tarball}: ${files.size} files`);
  for (const [f, b] of [...files].sort()) console.log(`  ${kb(b.length)}  ${f}`);
  const licences = Object.fromEntries(["LICENSE-MIT", "LICENSE-APACHE"].map((f) => [f, readFileSync(join(REPO, f))]));
  const problems = checkPackage(files, { licences });
  console.log("\nsize budgets");
  for (const [label, bytes, budget] of sizes(files, buf.length)) {
    const over = bytes > budget;
    console.log(`  ${over ? "OVER" : "ok  "} ${label.padEnd(26)} ${kb(bytes)} of ${kb(budget).trim()}`);
    if (over) problems.push(`${label} is ${kb(bytes).trim()}, over its ${kb(budget).trim()} budget`);
  }
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\npack check passed");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
