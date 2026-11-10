#!/usr/bin/env node
/**
 * The versions of the published packages that the consumer examples and the
 * docs name (D-074). Each example depends on `^<version>` of `pixelworld` and
 * `@pixelworlds/city-sf`, the CDN recipes load `pixelworld@<version>`, and the
 * city pack quickstart (plugins.md §9.6) peers on `^<version>` of `pixelworld`,
 * where <version> is the one in the package's package.json: the last release
 * (or, before the first, the one it will be bumped from). The test
 * (version-pins.test.mjs) fails when they drift, as they do after
 * `pnpm changeset version`; this updates them.
 *
 *   node tools/version-pins.mjs           # list the pins and any that drifted
 *   node tools/version-pins.mjs --write   # set them to the packages' versions
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

/** The published packages, by name: where their package.json is. */
export const PACKAGES = { pixelworld: "packages/pixelworld", "@pixelworlds/city-sf": "packages/city-sf" };

const dependency = (name) => new RegExp(`("${name.replace("/", "\\/")}"\\s*:\\s*")([^"]*)(")`, "g");
const CDN = /(cdn\.jsdelivr\.net\/npm\/pixelworld@)([^/"'`\s]+)()/g;

/** Where a version is named: the file, the package, a pattern whose 2nd group is the pin, and the pin it should be. */
export const PINS = [
  ...["vite", "webpack", "esm"].flatMap((example) =>
    Object.keys(PACKAGES).map((pkg) => ({ file: `examples/consumers/${example}/package.json`, pkg, pattern: dependency(pkg), want: (v) => `^${v}` })),
  ),
  { file: "examples/consumers/esm/cdn.html", pkg: "pixelworld", pattern: CDN, want: (v) => v },
  { file: "docs/npm.md", pkg: "pixelworld", pattern: CDN, want: (v) => v },
  // the city pack quickstart's peer dependency (plugins.md §9.6)
  { file: "docs/plugins.md", pkg: "pixelworld", pattern: dependency("pixelworld"), want: (v) => `^${v}` },
];

/** The packages' versions in the workspace. */
export function versions(read = (f) => readFileSync(join(REPO, f), "utf8")) {
  return Object.fromEntries(Object.entries(PACKAGES).map(([name, dir]) => [name, JSON.parse(read(`${dir}/package.json`)).version]));
}

/** Pins that name another version, or that are missing: one line each. */
export function pinProblems(read, vers) {
  const problems = [];
  for (const { file, pkg, pattern, want } of PINS) {
    const found = [...read(file).matchAll(pattern)].map((m) => m[2]);
    if (!found.length) problems.push(`${file} names no version of ${pkg}`);
    for (const pin of found) if (pin !== want(vers[pkg])) problems.push(`${file} pins ${pkg} ${pin}, not ${want(vers[pkg])}`);
  }
  return problems;
}

/** The files with every pin set to the packages' versions: file → new text, for those that change. */
export function pinned(read, vers) {
  const texts = new Map();
  for (const { file, pkg, pattern, want } of PINS) {
    const text = texts.get(file) ?? read(file);
    texts.set(file, text.replace(pattern, (_, pre, _pin, post) => `${pre}${want(vers[pkg])}${post}`));
  }
  for (const [file, text] of texts) if (text === read(file)) texts.delete(file);
  return texts;
}

function main() {
  const read = (f) => readFileSync(join(REPO, f), "utf8");
  const vers = versions(read);
  console.log(Object.entries(vers).map(([n, v]) => `${n} ${v}`).join(", "));
  if (process.argv.includes("--write")) {
    const files = pinned(read, vers);
    for (const [file, text] of files) writeFileSync(join(REPO, file), text);
    console.log(files.size ? `updated ${[...files.keys()].join(", ")}` : "the pins are up to date");
    return;
  }
  const problems = pinProblems(read, vers);
  if (problems.length) {
    console.error(`${problems.map((p) => `  - ${p}`).join("\n")}\nrun node tools/version-pins.mjs --write`);
    process.exit(1);
  }
  console.log(`${PINS.length} pins name these versions`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
