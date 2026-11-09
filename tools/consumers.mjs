#!/usr/bin/env node
/**
 * Proves the packed `pixelworld` works outside this workspace (docs/npm.md).
 *
 * Each consumer in examples/consumers/ is copied to a scratch directory with
 * the Grand Canyon slice (fixtures/grand-canyon-m0) and its style pack,
 * installs the tarball with npm as any project would, is built and served,
 * and renders in headless Chromium (SwiftShader). A run passes when the page
 * draws with its tiles baked in the bake worker (not the main-thread
 * fallback), the worker's script loaded, and nothing failed.
 *
 *   node tools/consumers.mjs [--tarball pixelworld-x.y.z.tgz] [--out dir] [vite webpack esm]
 *
 * Without --tarball it packs packages/pixelworld first (`pnpm pack`, which
 * builds it). Needs network for npm installs. Screenshots go to <out>/screenshots.
 */
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value;
};
const OUT = resolve(flag("--out") ?? join(tmpdir(), "pixelworld-consumers"));
let tarball = flag("--tarball");
const SHOTS = join(OUT, "screenshots");
const only = args.length ? args : ["vite", "webpack", "esm"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".css": "text/css",
  ".png": "image/png",
};

function run(cmd, argv, cwd) {
  console.log(`  $ ${cmd} ${argv.join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed in ${cwd}`);
}

async function freePort() {
  return new Promise((ok) => {
    const s = createNetServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** A static file server over one or more roots, as a CDN or `python -m http.server` would serve them. */
async function serve(roots) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    for (const root of roots) {
      let file = join(root, path);
      if (!file.startsWith(root)) break;
      try {
        if ((await stat(file)).isDirectory()) file = join(file, "index.html");
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
        return;
      } catch {
        // try the next root
      }
    }
    res.writeHead(404).end("not found");
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { url: `http://localhost:${server.address().port}/`, close: () => server.close() };
}

/** `vite` (dev server) in the background; resolves once it answers. */
async function viteDev(cwd) {
  const port = await freePort();
  const child = spawn("npx", ["vite", "--port", String(port), "--strictPort"], { cwd, detached: true, stdio: "ignore" });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return { url, close: () => process.kill(-child.pid) };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  process.kill(-child.pid);
  throw new Error("vite dev server did not start");
}

/** Open a page, wait for the view to be ready, check the worker baked, screenshot. */
async function check(browser, name, url, { expectWorker } = {}) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const problems = [];
  const workers = [];
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("worker", (w) => workers.push(w.url()));
  page.on("response", (r) => r.status() >= 400 && problems.push(`HTTP ${r.status()} ${r.url()}`));
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.bakeMode || document.body.dataset.error, null, {
    timeout: 180_000,
  });
  const ms = Date.now() - t0;
  const { bakeMode, error } = await page.evaluate(() => ({ ...document.body.dataset }));
  const status = await page.textContent("#status");
  const shot = join(SHOTS, `${name}.png`);
  await page.screenshot({ path: shot });
  await page.close();
  if (error) problems.push(`view error: ${error}`);
  if (bakeMode !== "worker") problems.push(`baked in "${bakeMode}", not in the worker`);
  if (!workers.length) problems.push("no worker was created");
  if (expectWorker && !workers.some((w) => expectWorker.test(w))) problems.push(`worker ${workers} is not ${expectWorker}`);
  const result = { name, ok: problems.length === 0, ms, worker: workers[0] ?? "-", status, shot, problems };
  console.log(`  ${result.ok ? "ok  " : "FAIL"} ${name}: ${status} (${ms} ms; worker ${result.worker})`);
  for (const p of problems) console.log(`       ${p}`);
  return result;
}

/** Copy a consumer's sources, add the world and style pack it draws, install the tarball. */
async function prepare(name, dataDir) {
  const dir = join(OUT, name);
  await rm(dir, { recursive: true, force: true });
  await cp(join(ROOT, "examples/consumers", name), dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|dist|package-lock\.json)$/.test(src),
  });
  const data = join(dir, dataDir);
  await cp(join(ROOT, "fixtures/grand-canyon-m0"), join(data, "worlds/grand-canyon-m0"), { recursive: true });
  await mkdir(join(data, "styles/desert-southwest"), { recursive: true });
  await cp(join(ROOT, "worlds/_styles/desert-southwest/style.json"), join(data, "styles/desert-southwest/style.json"));
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball], dir);
  return dir;
}

const consumers = {
  async vite(browser) {
    const dir = await prepare("vite", "public");
    run("npx", ["tsc", "--noEmit"], dir); // the package's types, with skipLibCheck off
    const results = [];
    const dev = await viteDev(dir);
    try {
      results.push(await check(browser, "vite-dev", dev.url, { expectWorker: /bake\.worker\.js/ }));
    } finally {
      dev.close();
    }
    run("npx", ["vite", "build", "--logLevel", "warn"], dir);
    const assets = await readdir(join(dir, "dist/assets"));
    if (!assets.some((f) => /^bake\.worker-.*\.js$/.test(f))) throw new Error(`vite build emitted no worker: ${assets}`);
    const built = await serve([join(dir, "dist")]);
    try {
      results.push(await check(browser, "vite-build", built.url, { expectWorker: /assets\/bake\.worker-/ }));
    } finally {
      built.close();
    }
    return results;
  },

  async webpack(browser) {
    const dir = await prepare("webpack", "public");
    run("npx", ["webpack", "--no-stats"], dir);
    const built = await serve([join(dir, "dist"), join(dir, "public")]);
    try {
      return [await check(browser, "webpack-build", built.url)];
    } finally {
      built.close();
    }
  },

  async esm(browser) {
    const dir = await prepare("esm", ".");
    // the workerUrl option: a copy of the worker somewhere else on the origin
    await mkdir(join(dir, "vendor"), { recursive: true });
    await cp(join(dir, "node_modules/pixelworld/dist/bake.worker.js"), join(dir, "vendor/bake.worker.js"));
    const site = await serve([dir]);
    try {
      return [
        await check(browser, "esm", site.url, { expectWorker: /node_modules\/pixelworld\/dist\/bake\.worker\.js$/ }),
        await check(browser, "esm-workerUrl", `${site.url}?workerUrl=/vendor/bake.worker.js`, {
          expectWorker: /\/vendor\/bake\.worker\.js$/,
        }),
      ];
    } finally {
      site.close();
    }
  },
};

await mkdir(SHOTS, { recursive: true });
if (!tarball) {
  console.log("packing packages/pixelworld");
  run("pnpm", ["--filter", "pixelworld", "pack", "--pack-destination", OUT], ROOT);
  const tgz = (await readdir(OUT)).filter((f) => /^pixelworld-.*\.tgz$/.test(f)).sort();
  tarball = join(OUT, tgz.at(-1));
}
tarball = resolve(tarball);
console.log(`consumers of ${tarball} in ${OUT}`);

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const results = [];
try {
  for (const name of only) {
    if (!consumers[name]) throw new Error(`no consumer "${name}" (have ${Object.keys(consumers)})`);
    console.log(`\n${name}`);
    results.push(...(await consumers[name](browser)));
  }
} finally {
  await browser.close();
}

console.log("\nconsumer          ready     bake worker");
for (const r of results) console.log(`${(r.ok ? "ok   " : "FAIL ") + r.name.padEnd(14)} ${String(r.ms).padStart(6)} ms  ${r.worker}`);
console.log(`screenshots: ${SHOTS}`);
if (results.some((r) => !r.ok)) process.exit(1);
