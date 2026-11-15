// pixelworld.site, built into one directory for GitHub Pages (D-142):
//
//   _site/              the site's pages (this app)
//   _site/view/         the viewer (apps/web)
//   _site/play/         the example game (apps/game)
//   _site/<world>/      each world package, once, where both look for it (`?world=/sf/`)
//
// The apps' own builds copy every world into each of them (their publicDir);
// here they are built without, and the worlds copied once beside them. Start
// tiles (tools/prebake.mjs) in fixtures/<world>/ are copied with their world.
//
//   pnpm site:build [--out <dir>]
import { cpSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const i = process.argv.indexOf("--out");
const out = `${i > 0 ? resolve(process.argv[i + 1]) : `${repo}_site`}/`;

rmSync(out, { recursive: true, force: true });
await build({ root: fileURLToPath(new URL(".", import.meta.url)), logLevel: "warn", build: { outDir: out, emptyOutDir: true } });
for (const [app, base] of [["web", "/view/"], ["game", "/play/"]])
  await build({ root: `${repo}apps/${app}`, base, publicDir: false, logLevel: "warn", build: { outDir: `${out}${base.slice(1)}`, emptyOutDir: true } });

// every world but the experiments (exp-*) and scratch packages (_try, …)
const worlds = readdirSync(`${repo}fixtures`, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("exp-") && !d.name.startsWith("_"))
  .map((d) => d.name);
for (const id of worlds) cpSync(`${repo}fixtures/${id}`, `${out}${id}`, { recursive: true });
console.log(`site: ${out} (the pages, /view/, /play/, ${worlds.length} worlds)`);
